#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const { loadConfig } = require('../codex/config');
const { deliveryWorkspace, readState, recordIncident, resolveSessionId, writeState } = require('../codex/runtime-state');

// worktreeの外で走らせるとDeliveryのbranchではなく共有ツリーを変更してしまうGit操作。
// 判定は読み取り側を列挙するfail-closeにする。書き込み側を列挙すると、列挙から漏れた
// `git mv` のようなsubcommandがそのまま共有ツリーへ届いてしまう。
const GIT_READ_SUBCOMMANDS = new Set([
  'blame', 'cat-file', 'check-attr', 'check-ignore', 'check-mailmap', 'check-ref-format',
  'count-objects', 'describe', 'diff', 'diff-files', 'diff-index', 'diff-tree', 'for-each-ref',
  'grep', 'help', 'log', 'ls-files', 'ls-remote', 'ls-tree', 'merge-base', 'name-rev',
  'rev-list', 'rev-parse', 'shortlog', 'show', 'show-branch', 'show-ref', 'status', 'var',
  'verify-commit', 'verify-tag', 'version', 'whatchanged'
]);
// subcommand単位では書き込みもするが、引数がこの列挙だけなら一覧表示しかしない形。
// 引数にoperandを取る形は読み取りだと確認できないので対象にしない。
const GIT_READ_ONLY_FORMS = new Map([
  ['branch', new Set(['', '-a', '--all', '-r', '--remotes', '-l', '--list', '-v', '-vv', '--verbose', '--show-current'])],
  ['config', new Set(['-l', '--list'])],
  ['reflog', new Set(['show'])],
  ['remote', new Set(['', '-v', '--verbose'])],
  ['stash', new Set(['list'])],
  ['submodule', new Set(['', 'status'])],
  ['tag', new Set(['', '-l', '--list', '-n'])],
  ['worktree', new Set(['list', '--porcelain'])]
]);
// gitの作業ツリーやgit dirを実行directoryから引き剥がすglobal option。どのツリーを
// 書き換えるかコマンド文字列からは追えない。
const GIT_UNTRACEABLE_OPTIONS = new Set(['--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env']);
// gitを間接的に起動できるcommand。実際に走るgitのdirectoryもsubcommandも追跡できない。
const GIT_WRAPPERS = new Set([
  'bash', 'busybox', 'command', 'dash', 'doas', 'env', 'eval', 'exec', 'find', 'fish', 'ionice', 'ksh',
  'nice', 'nohup', 'parallel', 'script', 'setsid', 'sh', 'stdbuf', 'sudo', 'time', 'timeout',
  'watch', 'xargs', 'zsh'
]);
// 展開してからでないと中身が決まらない記法。
const UNTRACEABLE_EXPANSION = /\$\(|\$\{|`|<\(|>\(/;
const SEGMENT_SEPARATORS = ';&|\n\r';

function deny(reason) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason
    }
  });
}

function gitValue(cwd, env, args) {
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8', timeout: 5000, windowsHide: true });
  return result.status === 0 ? String(result.stdout || '').trim() : '';
}

function branchAt(cwd, env) {
  return gitValue(cwd, env, ['branch', '--show-current']);
}

function hasExecutableShellControl(command) {
  let quote = null;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote) {
      if (character === quote) quote = null;
      else if (
        quote === '"' &&
        (character === '`' || (character === '$' && ['(', '{'].includes(command[index + 1])))
      ) return true;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if ('\r\n;&|<>`(){}^'.includes(character) || (character === '$' && command[index + 1] === '(')) return true;
  }
  return quote !== null;
}

function isExactLifecycleCommand(command, action) {
  const value = String(command || '').trim();
  if (!value || hasExecutableShellControl(value)) return false;
  const node = String.raw`(?:node(?:\.exe)?|"[^"]*node(?:\.exe)?"|'[^']*node(?:\.exe)?')`;
  const scriptName = action === 'prepare' ? 'delivery-lifecycle\\.js' : 'reset\\.js';
  const script = String.raw`(?:"[^"]*scripts[\\/]codex[\\/]${scriptName}"|'[^']*scripts[\\/]codex[\\/]${scriptName}'|[^\s]+scripts[\\/]codex[\\/]${scriptName})`;
  const argument = String.raw`(?:"[^"]+"|'[^']+'|[^\s]+)`;
  const tail = action === 'prepare'
    ? String.raw`prepare(?:\s+--session\s+${argument})?`
    : argument;
  return new RegExp(String.raw`^${node}\s+${script}\s+${tail}\s*$`, 'i').test(value);
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

// commandをshellの区切り文字で分ける。引用符の中の区切り文字はコマンド境界ではない。
// 各segmentには後続の区切り演算子を添える。`&&` と `||` は `&` `|` と意味が違い、
// 直前のcommandが成功したかどうかで次のcommandの実行directoryが変わる。
function splitCommand(command) {
  const value = String(command || '');
  const segments = [];
  let current = '';
  let quote = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (SEGMENT_SEPARATORS.includes(character)) {
      const doubled = value[index + 1] === character;
      segments.push({ text: current, separator: doubled ? character + character : character });
      if (doubled) index += 1;
      current = '';
      continue;
    }
    current += character;
  }
  segments.push({ text: current, separator: '' });
  return segments.filter(segment => segment.text.trim());
}

function splitSegments(command) {
  return splitCommand(command).map(segment => segment.text);
}

function tokenize(segment) {
  const tokens = [];
  let current = null;
  let quote = null;
  for (const character of String(segment || '')) {
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      if (current === null) current = '';
      continue;
    }
    if (/\s/.test(character)) {
      if (current !== null) tokens.push(current);
      current = null;
      continue;
    }
    current = current === null ? character : current + character;
  }
  if (current !== null) tokens.push(current);
  return tokens;
}

// 展開が必要なtokenは実際のdirectoryを決められない。追跡不能をnullで表し、
// worktreeの中だと決めつけない。
function resolveDirectory(base, target) {
  const value = String(target || '');
  if (!value || /[$`~*?]/.test(value)) return null;
  if (path.isAbsolute(value)) return path.resolve(value);
  return base ? path.resolve(base, value) : null;
}

function mentionsGit(text) {
  return /\bgit\b/i.test(String(text || ''));
}

// `/usr/bin/git` や `"git.exe"` も同じgitである。判定はcommand名だけで行う。
function commandName(token) {
  const value = String(token || '').replace(/^[({]+/, '');
  return String(value.split(/[\\/]/).pop() || '').replace(/\.exe$/i, '').toLowerCase();
}

function isReadOnlyGit(subcommand, args) {
  if (!subcommand) return false;
  if (GIT_READ_SUBCOMMANDS.has(subcommand)) return true;
  const forms = GIT_READ_ONLY_FORMS.get(subcommand);
  if (!forms) return false;
  return args.length === 0 ? forms.has('') : args.every(arg => forms.has(arg));
}

// gitの実行directoryと、そのsubcommandが書き込むかどうかを読む。追跡できない指定が
// 混じった書き込みはlocationをnullにして、呼び出し側でfail-closeさせる。
function gitInvocation(args, cwd) {
  let location = cwd;
  let index = 0;
  while (index < args.length && args[index].startsWith('-')) {
    const arg = args[index];
    // `-C <path>` と `-C<path>` はどちらもgitの実行directoryを移す。複数指定は累積する。
    if (arg === '-C') {
      location = resolveDirectory(location, args[index + 1]);
      index += 2;
      continue;
    }
    if (arg.startsWith('-C') && arg.length > 2) {
      location = resolveDirectory(location, arg.slice(2));
      index += 1;
      continue;
    }
    // `-c core.worktree=...` はgitの書き込み先を実行directoryから引き剥がせる。
    if (arg === '-c' || arg === '--config-env') {
      if (/^core\./i.test(String(args[index + 1] || ''))) location = null;
      index += 2;
      continue;
    }
    if (arg.startsWith('-c') && arg.length > 2) {
      if (/^core\./i.test(arg.slice(2))) location = null;
      index += 1;
      continue;
    }
    if (GIT_UNTRACEABLE_OPTIONS.has(arg.split('=')[0])) {
      location = null;
      index += arg.includes('=') ? 1 : 2;
      continue;
    }
    index += 1;
  }
  const subcommand = args[index];
  const rest = args.slice(index + 1);
  if (isReadOnlyGit(subcommand, rest)) return { write: false, location };
  // subcommandより前の引数に展開が残っていると、どのツリーを書き換えるか決まらない。
  // subcommand以降はcommit messageなどが入るため、実行directoryの判定には使わない。
  if (args.slice(0, index + 1).some(arg => /[$`]/.test(arg))) return { write: true, location: null };
  return { write: true, location };
}

// worktreeを払い出しても、親CLIのcwdは共有ツリーのままである。書き込み系のGit操作は、
// 実行directoryがworktreeへ移っているか（`cd <worktree> && git ...`）、git自身が
// `-C <worktree>` でそこを指しているときだけ許可する。commandの中にworktree pathの
// 文字列が現れるだけでは、そのgitが共有ツリーを書き換えないことの証明にならない。
// 追跡できない起動の仕方（wrapper、command置換、`||` を挟んだcd）は、共有ツリーを
// 書き換えないと言い切れないので拒否する。
function targetsWorkspace(command, workspace, cwd = process.cwd()) {
  let current = path.resolve(cwd || process.cwd());
  for (const { text, separator } of splitCommand(command)) {
    const tokens = tokenize(text);
    while (tokens.length > 0 && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]) || /^\d*[<>]/.test(tokens[0]))) {
      // GIT_DIR や GIT_WORK_TREE はgit自身の書き込み先を差し替える。
      if (/^GIT_/i.test(tokens[0]) && mentionsGit(text)) return false;
      tokens.shift();
    }
    const name = commandName(tokens[0]);
    if (!name) continue;
    if (UNTRACEABLE_EXPANSION.test(text) && mentionsGit(text)) return false;
    if (name === 'cd' || name === 'pushd') {
      // subshellの中のcdは呼び出し元のdirectoryを動かさない。
      const target = /[(){}]/.test(text) ? null : resolveDirectory(current, tokens[1]);
      // cdの結果を次のcommandへ引き継げるのは `&&` のときだけ。`||` は cd が失敗した
      // 経路なので直前のdirectoryのまま、`;` `|` `&` は成否が分からず追跡不能になる。
      if (separator === '&&') current = target;
      else if (separator !== '||') current = null;
      continue;
    }
    if (name === 'popd') {
      current = null;
      continue;
    }
    if (GIT_WRAPPERS.has(name) && mentionsGit(text)) return false;
    if (name !== 'git') continue;
    const { write, location } = gitInvocation(tokens.slice(1), current);
    if (write && !(location && isInside(workspace, location))) return false;
  }
  return true;
}

function run(rawInput, options = {}) {
  let input;
  try {
    input = typeof rawInput === 'string' ? JSON.parse(rawInput) : rawInput;
  } catch {
    return rawInput;
  }
  const env = options.env || process.env;
  const cwd = options.cwd || input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const config = loadConfig(cwd, env);
  if (config.deliveryWorkflow !== 'required') return rawInput;

  const state = readState(input, env);
  if (!state.delivery) return rawInput;
  if (state.delivery.status === 'draft-pr' || state.delivery.status === 'merged') return rawInput;
  if (state.delivery.status !== 'ready') {
    const toolName = String(input.tool_name || '');
    const command = String(input.tool_input && input.tool_input.command || '');
    const permissionMode = String(input.permission_mode || input.permissionMode || '').toLowerCase();
    // Plan mode中はClaude自身のread-only制約に任せて調査を許可する。承認後は同じ
    // deferred stateが残るため、最初のBash/Edit/Writeをprepare完了までfail-closeする。
    if (state.delivery.status === 'deferred' && permissionMode === 'plan') return rawInput;
    const isPrepareCommand = toolName === 'Bash' && isExactLifecycleCommand(command, 'prepare');
    const isResetCommand = toolName === 'Bash' && isExactLifecycleCommand(command, 'reset');
    if (isPrepareCommand || isResetCommand) return rawInput;
    const sessionId = resolveSessionId(input, env);
    const prepareScript = path.resolve(__dirname, '../codex/delivery-lifecycle.js');
    const resetScript = path.resolve(__dirname, '../codex/reset.js');
    return deny(
      '[ECC Delivery Gate] Repository tools are blocked until duplicate Issue search, Issue selection/creation, and the issue-linked worktree are recorded. ' +
        'Preparation never switches the shared working tree; it checks the issue-linked branch out in a separate worktree and reports that path. ' +
        `Run node "${prepareScript}" prepare --session "${sessionId}" first, then continue this delivery inside the reported worktree path. ` +
        `If the recorded Delivery is stale or unrecoverable, explicitly reset it with node "${resetScript}" "${sessionId}".`
    );
  }

  const workspace = deliveryWorkspace(state, cwd);
  if (!workspace) {
    // 隔離済みDeliveryのworktreeが失われた。ここで共有ツリーへ戻すと、他の作業を
    // 抱えたツリーをDeliveryのbranchとして扱ってしまう。復旧かresetまで停止する。
    if (!state.delivery.worktree_missing_recorded_at) {
      recordIncident(
        {
          type: 'delivery_worktree_missing',
          severity: 'minor',
          target: 'ecc',
          hook_id: 'delivery-lifecycle-gate',
          message: 'The worktree recorded for the active Delivery is missing or belongs to another repository.',
          metadata: { issue_number: state.delivery.issue_number || null }
        },
        { cwd, env }
      );
      writeState(input, {
        delivery: { ...state.delivery, worktree_missing_recorded_at: new Date().toISOString() }
      }, env);
    }
    return deny(
      `[ECC Delivery Gate] Issue #${state.delivery.issue_number} is bound to the delivery worktree ${state.delivery.worktree_path}, ` +
        'but that path is no longer a working tree of this repository. ' +
        'Restore it with `git worktree add` or reset the delivery; this gate never falls back to the shared working tree.'
    );
  }
  const actualBranch = branchAt(workspace, env);
  if (!actualBranch || actualBranch !== state.delivery.branch) {
    // Gateがfail-closeしている復旧可能な不一致は、即criticalではない。同じDeliveryで
    // 同じ不一致を繰り返し記録せず、複数回の独立発生だけを中央昇格の対象にする。
    if (state.delivery.branch_mismatch_actual !== (actualBranch || '<none>')) {
      recordIncident(
        {
          type: 'delivery_branch_mismatch',
          severity: 'minor',
          target: 'ecc',
          hook_id: 'delivery-lifecycle-gate',
          message: 'The current branch did not match the branch recorded for the active Delivery.',
          metadata: { expected: state.delivery.branch, actual: actualBranch || '<none>' }
        },
        { cwd, env }
      );
      writeState(input, {
        delivery: {
          ...state.delivery,
          branch_mismatch_actual: actualBranch || '<none>',
          branch_mismatch_recorded_at: new Date().toISOString()
        }
      }, env);
    }
    return deny(
      `[ECC Delivery Gate] Expected issue-linked branch ${state.delivery.branch} in ${workspace}, but its current branch is ${actualBranch || '<none>'}. ` +
        'Restore the recorded branch in the delivery worktree before editing.'
    );
  }

  if (state.delivery.branch_mismatch_actual || state.delivery.worktree_missing_recorded_at) {
    writeState(input, {
      delivery: {
        ...state.delivery,
        branch_mismatch_actual: null,
        branch_mismatch_recorded_at: null,
        worktree_missing_recorded_at: null
      }
    }, env);
  }

  const toolName = String(input.tool_name || '');
  const isEdit = ['Edit', 'Write', 'MultiEdit'].includes(toolName);
  const isolated = workspace !== path.resolve(cwd);
  if (isolated) {
    // 払い出したworktreeの外へ書くと、隔離したはずの共有ツリーを再び変更してしまう。
    // 共有ツリー配下だけを拒否し、リポジトリ外のファイルは従来どおり素通しする。
    const filePath = String(input.tool_input && input.tool_input.file_path || '');
    if (isEdit && filePath && isInside(path.resolve(cwd), path.resolve(filePath)) && !isInside(workspace, path.resolve(filePath))) {
      return deny(
        `[ECC Delivery Gate] Issue #${state.delivery.issue_number} is checked out in the delivery worktree ${workspace}. ` +
          `Edit ${path.join(workspace, path.relative(path.resolve(cwd), path.resolve(filePath)))} instead; the shared working tree keeps its own branch and uncommitted changes.`
      );
    }
    if (toolName === 'Bash' && !targetsWorkspace(input.tool_input && input.tool_input.command, workspace, cwd)) {
      return deny(
        `[ECC Delivery Gate] This delivery is isolated in the worktree ${workspace}, but the command is not provably a Git operation on that worktree. ` +
          `Write it as \`cd "${workspace}" && git ...\` or \`git -C "${workspace}" ...\`. ` +
          'Forms whose target working tree cannot be read from the command itself are rejected: wrappers such as `sh -c` or `xargs`, ' +
          'command substitution, `--git-dir`/`--work-tree`/`GIT_DIR` overrides, and a `cd` that is not chained with `&&`.'
      );
    }
  }
  const head = gitValue(workspace, env, ['rev-parse', 'HEAD']);
  if (
    isEdit &&
    state.delivery.committed_head &&
    state.delivery.committed_head === head &&
    !(
      ['review', 'security-review'].includes(state.review_role) &&
      state.review_status === 'blocked' &&
      state.review_complete === true &&
      state.review_head === head &&
      state.review_worktree_clean === true &&
      Number.isInteger(state.review_blocking_findings) &&
      state.review_blocking_findings > 0
    )
  ) {
    return deny(
      '[ECC Delivery Gate] The clean implementation commit is waiting for an independent Codex review. ' +
      'Run `/ecc:code-review` for the current HEAD before further edits. If the review has no critical/high findings, push and create the Draft PR instead of starting another edit loop.'
    );
  }
  return rawInput;
}

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { raw += chunk; });
  process.stdin.on('end', () => process.stdout.write(run(raw)));
}

module.exports = { branchAt, gitValue, isExactLifecycleCommand, isInside, run, splitSegments, targetsWorkspace, tokenize };
