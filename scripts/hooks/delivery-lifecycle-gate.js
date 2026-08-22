#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const { loadConfig } = require('../codex/config');
const { readState, recordIncident, resolveSessionId, writeState } = require('../codex/runtime-state');

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

// `allowQuotedExpansion` は、`node "$CLAUDE_PLUGIN_ROOT/scripts/codex/reset.js" "<session>"` の
// ように全体の形をregexで固定できる呼び出し専用である。double quoteの中の `$NAME` は語分割も
// command substitutionも起こさないため、argument列は展開後も変わらない。allowlistで
// option単位に判定する経路（isReadOnlyBashCommand）では、展開後に別のargumentへ化けるため使わない。
function hasExecutableShellControl(command, options = {}) {
  const allowQuotedExpansion = options.allowQuotedExpansion === true;
  let quote = null;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    // backslashは次の1文字をリテラル化する（single quoteの中を除く）。ここを読み飛ばすと
    // `echo \"; touch x; echo \"` のescapeされた引用符でquote状態を取り違え、その後の `;`
    // を引用符の中と誤判定して任意コマンドを通してしまう。行末のbackslashは行継続なので拒否する。
    if (character === '\\' && quote !== "'") {
      const next = command[index + 1];
      if (next === undefined || next === '\n' || next === '\r') return true;
      index += 1;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else if (quote === '"' && character === '`') return true;
      // double quoteの中でも `$(` と `${` は実行・置換に化ける。plainな `$NAME` だけは、
      // 呼び出し側が明示的に許可したときに通す。
      else if (quote === '"' && character === '$') {
        if (!allowQuotedExpansion) return true;
        if (!/[A-Za-z_]/.test(command[index + 1] || '')) return true;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    // quoteの外の `$` は常に拒否する。`$(` と `${` だけを見ると、`rg $IFS--pre=rm` や
    // `gh api ... $IFS-X PUT` のように展開結果が語分割されて新しいoptionになり、token検査では
    // 位置引数に見えるまま外部process起動やGitHub書き込みへ到達する。
    if ('\r\n;&|<>`(){}^$'.includes(character)) return true;
  }
  return quote !== null;
}

// draft-prのDeliveryで通してよいのは、状態を変えない参照だけである。read-onlyと断定できない
// binaryやsubcommandは拒否する（fail-close）。ここを広くすると、Edit/Writeを止めても
// shell経由のファイル変更・branch切替・commitでGateを迂回できてしまう。
// subcommandがread-onlyでも、optionひとつで外部processを起動できる。`cat-file --filters`
// と `--filters-path` は設定済みのclean/smudge filterを、`--textconv` はtextconv programを
// そのまま実行する。そのためread-onlyと確認したoptionだけをsubcommandごとに列挙し、
// 未知のoptionは拒否する。
const GIT_HISTORY_OPTION = String.raw`-\d+|-[nU]\d*|-[psz]|--(?:abbrev-commit|all|author=\S*|date=\S+|decorate(?:=\S+)?|first-parent|follow|format=\S*|graph|grep=\S*|max-count=\d+|merges|name-only|name-status|no-color|no-merges|no-ext-diff|no-patch|no-renames|no-textconv|numstat|oneline|patch|pretty(?:=\S*)?|reverse|shortstat|since=\S+|stat(?:=\S+)?|summary|unified=\d+|until=\S+)`;
const READ_ONLY_GIT_OPTIONS = new Map([
  ['blame', /^(?:-[ltefnswb]|-L\S*|--(?:abbrev=\d+|date=\S+|incremental|line-porcelain|porcelain|root|show-stats))$/],
  // `--filters` / `--filters-path` / `--textconv` は外部programを起動するため載せない。
  ['cat-file', /^(?:-[tsep]|--(?:allow-unknown-type|batch(?:=\S*)?|batch-all-objects|batch-check(?:=\S*)?|buffer|follow-symlinks))$/],
  ['describe', /^(?:--(?:abbrev=\d+|all|always|contains|dirty(?:=\S*)?|exclude=\S+|long|match=\S+|tags))$/],
  ['diff', new RegExp(String.raw`^(?:${GIT_HISTORY_OPTION}|-[MRw]|--(?:cached|check|diff-filter=\S+|dst-prefix=\S+|find-renames(?:=\S+)?|ignore-all-space|no-index|src-prefix=\S+|staged))$`)],
  ['log', new RegExp(String.raw`^(?:${GIT_HISTORY_OPTION})$`)],
  ['ls-files', /^(?:-[socmdiz]+|--(?:cached|deleted|directory|error-unmatch|exclude-standard|full-name|modified|others|stage))$/],
  ['ls-tree', /^(?:-[rdtlz]+|--(?:abbrev=\d+|format=\S*|full-name|full-tree|name-only|name-status))$/],
  ['name-rev', /^(?:--(?:all|always|name-only|refs=\S+|tags))$/],
  ['rev-list', new RegExp(String.raw`^(?:${GIT_HISTORY_OPTION}|--(?:count|left-right|objects))$`)],
  ['rev-parse', /^(?:-q|--(?:abbrev-ref(?:=\S+)?|absolute-git-dir|all|git-dir|is-inside-work-tree|quiet|short(?:=\d+)?|show-cdup|show-toplevel|symbolic-full-name|verify))$/],
  ['shortlog', /^(?:-[sne]+|--(?:email|no-merges|numbered|summary))$/],
  ['show', new RegExp(String.raw`^(?:${GIT_HISTORY_OPTION}|-s|--(?:diff-filter=\S+|no-notes))$`)],
  ['status', /^(?:-[sbz]+|-u(?:all|no|normal)?|--(?:branch|ignored(?:=\S+)?|long|no-color|porcelain(?:=\S+)?|short|untracked-files(?:=\S+)?))$/],
  ['whatchanged', new RegExp(String.raw`^(?:${GIT_HISTORY_OPTION})$`)]
]);
// `git branch` は列挙flagだけなら参照だが、位置引数が付くと作成・削除・改名になる。
const GIT_BRANCH_OPTION = /^(?:-a|-r|-v|-vv|--all|--list|--show-current|--verbose|--(?:no-)?color|--format=.*|--sort=.*)$/i;
const READ_ONLY_GH_SUBCOMMANDS = new Map([
  ['pr', new Set(['view', 'list', 'status', 'diff', 'checks'])],
  ['issue', new Set(['view', 'list', 'status'])],
  ['repo', new Set(['view'])],
  ['run', new Set(['view', 'list'])],
  ['auth', new Set(['status'])]
]);
// binary名だけを許可すると、引数で外部コマンドを起動できるoption（`rg --pre <cmd>`、
// `rg --search-zip`、`file -C` など）まで通り、Draft PR後でもファイルやGit状態を変更できる。
// read-onlyと確認したoptionだけをbinaryごとに列挙し、未知のoptionは拒否する。option以外の
// 位置引数はpattern/pathとして渡るだけで実行されない。
const READ_ONLY_BINARY_OPTIONS = new Map([
  ['cat', /^-(?:[AbEnsTv]+|-(?:number|number-nonblank|squeeze-blank|show-all|show-ends|show-tabs|show-nonprinting))$/],
  ['date', /^(?:-[uR]|-I[a-z]*|--(?:utc|universal|rfc-email|iso-8601(?:=[a-z]+)?|rfc-3339=[a-z]+))$/],
  ['echo', /^-[neE]+$/],
  ['file', /^-(?:[bhikLNprsv]+|-(?:brief|mime|mime-type|mime-encoding|no-pad|preserve-date|raw|dereference|keep-going))$/],
  [
    'grep',
    /^(?:-[abcdeEFGHhIiLlnPqRrsUvwxZz]+|-[ABCm]\d*|--(?:after-context|before-context|context|binary-files|colou?r|exclude|exclude-dir|include|max-count|regexp)=\S*|--(?:count|dereference-recursive|extended-regexp|files-with-matches|files-without-match|fixed-strings|ignore-case|invert-match|line-number|line-regexp|no-filename|no-messages|null|only-matching|perl-regexp|quiet|recursive|silent|text|with-filename|word-regexp))$/
  ],
  ['head', /^(?:-[qvz]+|-[cn][0-9+-]*|-\d+|--(?:bytes|lines)=\S+|--(?:quiet|silent|verbose|zero-terminated))$/],
  [
    'ls',
    /^(?:-[1AaBbCcdFfGghHiklLmNnpQqRrSsTtUuvXx]+|--(?:colou?r|hide|ignore|sort|time|time-style)=\S*|--(?:all|almost-all|classify|directory|full-time|group-directories-first|human-readable|inode|literal|numeric-uid-gid|recursive|reverse|si|size))$/
  ],
  ['pwd', /^-[LP]$/],
  [
    'rg',
    /^(?:-[eg]|-[ABCm]\d*|-[TtP]\S*|-[cFHhIiLlNnpSsUvwx]+|--(?:after-context|before-context|context|colou?r|colors|engine|glob|iglob|max-columns|max-count|max-depth|max-filesize|regexp|sort|sortr|type|type-not)=\S+|--(?:byte-offset|case-sensitive|column|count|count-matches|crlf|files|files-with-matches|files-without-match|fixed-strings|follow|heading|hidden|ignore-case|invert-match|json|line-number|line-regexp|multiline|multiline-dotall|no-column|no-filename|no-heading|no-ignore|no-ignore-vcs|no-line-number|no-messages|null|null-data|one-file-system|only-matching|passthru|pcre2|pretty|quiet|smart-case|sort-files|stats|text|trim|vimgrep|with-filename|word-regexp))$/
  ],
  ['stat', /^(?:-[cfLt]|--(?:cached=[a-z]+|dereference|file-system|format=\S*|printf=\S*|terse))$/],
  ['tail', /^(?:-[qvz]+|-[cn][0-9+-]*|-\d+|--(?:bytes|lines)=\S+|--(?:quiet|silent|verbose|zero-terminated))$/],
  ['wc', /^(?:-[cLlmw]+|--(?:bytes|chars|lines|max-line-length|words))$/]
]);
// subcommandがread-onlyでも、外部コマンドを起動できるoptionは拒否する。`git -c` /
// `--config-env` / `--exec-path` はpagerやdiff.externalを差し替えられ、`--ext-diff` と
// `--textconv` は設定済みの外部filterをそのまま実行する。
const GIT_EXEC_FLAG = /^(?:-c|-C|--config-env|--exec-path|--ext-diff|--textconv|--upload-pack|--receive-pack)(?:=|$)/i;
// `gh ... --web` はブラウザ起動コマンドを実行する。
const GH_EXEC_FLAG = /^(?:-w|--web)(?:=|$)/i;
const GH_WRITE_FLAG = /^(?:-X|--method|-f|-F|--field|--raw-field|--input)(?:=|$)/i;
const OUTPUT_FLAG = /^(?:-o|--output)(?:=|$)/i;
// このGateは全PreToolUseを検査する。変更系toolを列挙する形にすると、NotebookEditや
// 書き込みMCP toolのような列挙漏れがそのまま素通りし、「Draft PR後は参照だけ」という
// 保証を破る。そこでrepositoryを変更しないと確認できたtoolだけを許可し、未知のtoolと
// MCP toolは既定で拒否する。
// Taskはsubagentのtool呼び出しが同じPreToolUse Gateを通るため、ここでは止めない。
const NON_MUTATING_TOOLS = new Set([
  'Read',
  'NotebookRead',
  'Glob',
  'Grep',
  'LS',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'BashOutput',
  'KillShell',
  'ExitPlanMode',
  'Task'
]);
// SlashCommandはcommand定義に埋め込まれたshell実行までは検査できないため、参照だけを
// 保証したいdraft-pr / prepare前では拒否する。一方 `ready` のDeliveryでblockする理由は
// fresh reviewの要求であり、そこで止めると `/ecc:code-review` へ進めずデッドロックになる。
const REVIEW_ENTRY_TOOL = 'SlashCommand';

// shellはquoteとbackslashをコマンドへ渡す前に取り除く。両端の引用符だけを落とすと、
// `''--pre=rm` や `\-\-pre=rm` が位置引数に見えたまま `--pre=rm` として渡り、option検査を
// 素通りする。ここでshellと同じ順にquoteを解いてからoptionを判定する。展開文字や制御文字は
// hasExecutableShellControl()が先に拒否するため、ここではquote除去だけを再現すればよい。
function commandTokens(command) {
  const value = String(command || '');
  const tokens = [];
  let current = '';
  let started = false;
  let quote = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote === "'") {
      if (character === "'") quote = null;
      else current += character;
      continue;
    }
    // double quoteの中のbackslashをshellは一部しか外さないが、外す側に寄せるとoptionとして
    // 検査されるだけなので安全側に倒れる。
    if (character === '\\' && index + 1 < value.length) {
      current += value[index + 1];
      started = true;
      index += 1;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = null;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    current += character;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

function isReadOnlyGitCommand(args) {
  if (args.some(argument => GIT_EXEC_FLAG.test(argument))) return false;
  // subcommandより前に置けるgit本体のoptionは、pagerを起動しない `--no-pager` だけ許す。
  const rest = args[0] === '--no-pager' ? args.slice(1) : args;
  const subcommand = String(rest[0] || '').toLowerCase();
  const options = rest.slice(1);
  if (subcommand === 'branch') return options.every(argument => GIT_BRANCH_OPTION.test(argument));
  const allowed = READ_ONLY_GIT_OPTIONS.get(subcommand);
  if (!allowed) return false;
  // option以外の位置引数はrevisionやpathとして渡るだけで実行されない。
  return options.every(argument => !/^-./.test(argument) || argument === '--' || allowed.test(argument));
}

function isReadOnlyGhCommand(args) {
  if (args.some(argument => GH_EXEC_FLAG.test(argument))) return false;
  const group = String(args[0] || '').toLowerCase();
  // `gh api` は既定でGETだが、method指定やfield付与は書き込みになり得る。
  if (group === 'api') return !args.slice(1).some(argument => GH_WRITE_FLAG.test(argument));
  const subcommands = READ_ONLY_GH_SUBCOMMANDS.get(group);
  return Boolean(subcommands && subcommands.has(String(args[1] || '').toLowerCase()));
}

function isReadOnlyArguments(binary, args) {
  const allowed = READ_ONLY_BINARY_OPTIONS.get(binary);
  if (!allowed) return false;
  // `-`（stdin）と `--`（option終端）以外のoptionは、許可listに載るものだけ通す。
  return args.every(argument => !/^-./.test(argument) || argument === '--' || allowed.test(argument));
}

function isReadOnlyBashCommand(command) {
  const value = String(command || '').trim();
  if (!value || hasExecutableShellControl(value)) return false;
  const tokens = commandTokens(value);
  const executable = String(tokens[0] || '');
  // basenameだけで許可すると、`./git status` や `/tmp/gh pr view 274` が同名の任意の
  // ローカル実行ファイルへ制御を渡す。PATH解決されるbare nameだけを許す。
  if (/[\\/]/.test(executable)) return false;
  const binary = executable.replace(/\.(?:exe|cmd|bat)$/i, '').toLowerCase();
  const args = tokens.slice(1);
  if (args.some(argument => OUTPUT_FLAG.test(argument))) return false;
  if (binary === 'git') return isReadOnlyGitCommand(args);
  if (binary === 'gh') return isReadOnlyGhCommand(args);
  return isReadOnlyArguments(binary, args);
}

function isExactLifecycleCommand(command, action) {
  const value = String(command || '').trim();
  // 記録済みのprepare / resetは `"$CLAUDE_PLUGIN_ROOT/scripts/codex/..."` の形で案内される。
  // 全体をregexで固定するため、double quoteの中の変数展開だけは許す。
  if (!value || hasExecutableShellControl(value, { allowQuotedExpansion: true })) return false;
  const node = String.raw`(?:node(?:\.exe)?|"[^"]*node(?:\.exe)?"|'[^']*node(?:\.exe)?')`;
  const scriptName = action === 'prepare' ? 'delivery-lifecycle\\.js' : 'reset\\.js';
  const script = String.raw`(?:"[^"]*scripts[\\/]codex[\\/]${scriptName}"|'[^']*scripts[\\/]codex[\\/]${scriptName}'|[^\s]+scripts[\\/]codex[\\/]${scriptName})`;
  const argument = String.raw`(?:"[^"]+"|'[^']+'|[^\s]+)`;
  const tail = action === 'prepare'
    ? String.raw`prepare(?:\s+--session\s+${argument})?`
    : argument;
  return new RegExp(String.raw`^${node}\s+${script}\s+${tail}\s*$`, 'i').test(value);
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
  if (state.delivery.status === 'merged') return rawInput;
  if (state.delivery.status === 'draft-pr') {
    // Draft PRまで到達したDeliveryの参照は保持するが、その状態のまま変更を続けると
    // commit記録もfresh reviewもStop Gateも適用されない。次の変更要求で
    // initializeDelivery()が同じIssue/branchのままreadyへ戻すため、変更はそこまで待たせる。
    // Edit/Writeだけを止めてもshell経由で同じことができるため、Bashもread-only参照と
    // 記録済みresetコマンドだけに絞る。
    const toolName = String(input.tool_name || '');
    const command = String(input.tool_input && input.tool_input.command || '');
    if (toolName === 'Bash' && (isExactLifecycleCommand(command, 'reset') || isReadOnlyBashCommand(command))) return rawInput;
    if (toolName !== 'Bash' && NON_MUTATING_TOOLS.has(toolName)) return rawInput;
    return deny(
      `[ECC Delivery Gate] The delivery for Issue #${state.delivery.issue_number || '<unknown>'} already reached its Draft PR ` +
        `(${state.delivery.draft_pr_url || 'recorded in ECC state'}). Only read-only inspection is allowed until it resumes. ` +
        `Ask for the follow-up change explicitly so the delivery resumes on ${state.delivery.branch || 'the recorded branch'} ` +
        `with a fresh review, or reset it with node "${path.resolve(__dirname, '../codex/reset.js')}" "${resolveSessionId(input, env)}".`
    );
  }
  if (state.delivery.status !== 'ready') {
    const toolName = String(input.tool_name || '');
    const command = String(input.tool_input && input.tool_input.command || '');
    const permissionMode = String(input.permission_mode || input.permissionMode || '').toLowerCase();
    // Plan mode中はClaude自身のread-only制約に任せて調査を許可する。承認後は同じ
    // deferred stateが残るため、最初のBash/Edit/Writeをprepare完了までfail-closeする。
    if (state.delivery.status === 'deferred' && permissionMode === 'plan') return rawInput;
    if (toolName !== 'Bash' && NON_MUTATING_TOOLS.has(toolName)) return rawInput;
    const isPrepareCommand = toolName === 'Bash' && isExactLifecycleCommand(command, 'prepare');
    const isResetCommand = toolName === 'Bash' && isExactLifecycleCommand(command, 'reset');
    if (isPrepareCommand || isResetCommand) return rawInput;
    const sessionId = resolveSessionId(input, env);
    const prepareScript = path.resolve(__dirname, '../codex/delivery-lifecycle.js');
    const resetScript = path.resolve(__dirname, '../codex/reset.js');
    return deny(
      '[ECC Delivery Gate] Repository tools are blocked until duplicate Issue search, Issue selection/creation, and issue-linked branch creation complete. ' +
        `Run node "${prepareScript}" prepare --session "${sessionId}" first, then retry the tool call. ` +
        `If the recorded Delivery is stale or unrecoverable, explicitly reset it with node "${resetScript}" "${sessionId}".`
    );
  }

  const inspectedTool = String(input.tool_name || '');
  // 参照だけのtoolはbranch一致もfresh reviewも要求しない。調査まで止めると、branch不一致や
  // review待ちの原因を確かめる手段まで塞いでしまう。
  if (NON_MUTATING_TOOLS.has(inspectedTool) || inspectedTool === REVIEW_ENTRY_TOOL) return rawInput;

  const actualBranch = branchAt(cwd, env);
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
    return deny(`[ECC Delivery Gate] Expected issue-linked branch ${state.delivery.branch}, but current branch is ${actualBranch || '<none>'}. Restore the recorded branch before editing.`);
  }

  if (state.delivery.branch_mismatch_actual) {
    writeState(input, {
      delivery: {
        ...state.delivery,
        branch_mismatch_actual: null,
        branch_mismatch_recorded_at: null
      }
    }, env);
  }

  // clean commit後の追加変更は、Edit/Write以外のtoolでも同じくfresh reviewを要する。
  // NotebookEditや書き込みMCP toolを列挙から落とすと、そこだけreviewを飛ばせてしまう。
  // Bashのcommitやpushは delivery-progress / pre-bash 側の記録に任せる。
  const isEdit = inspectedTool !== 'Bash';
  const head = gitValue(cwd, env, ['rev-parse', 'HEAD']);
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

module.exports = { NON_MUTATING_TOOLS, branchAt, gitValue, isExactLifecycleCommand, isReadOnlyBashCommand, run };
