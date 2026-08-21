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

// draft-prのDeliveryで通してよいのは、状態を変えない参照だけである。read-onlyと断定できない
// binaryやsubcommandは拒否する（fail-close）。ここを広くすると、Edit/Writeを止めても
// shell経由のファイル変更・branch切替・commitでGateを迂回できてしまう。
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'blame', 'cat-file', 'describe', 'diff', 'log', 'ls-files', 'ls-tree',
  'name-rev', 'rev-list', 'rev-parse', 'shortlog', 'show', 'status', 'whatchanged'
]);
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

function commandTokens(command) {
  return String(command || '')
    .trim()
    .split(/\s+/)
    .map(token => token.replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

function isReadOnlyGitCommand(args) {
  if (args.some(argument => GIT_EXEC_FLAG.test(argument))) return false;
  const rest = args[0] === '--no-pager' ? args.slice(1) : args;
  const subcommand = String(rest[0] || '').toLowerCase();
  if (READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) return true;
  // `git branch` は列挙flagだけなら参照だが、位置引数が付くと作成・削除・改名になる。
  if (subcommand !== 'branch') return false;
  return rest.slice(1).every(argument => /^(?:-a|-r|-v|-vv|--all|--list|--show-current|--verbose|--(?:no-)?color|--format=.*|--sort=.*)$/i.test(argument));
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
  const binary = String(tokens[0] || '').replace(/\.(?:exe|cmd|bat)$/i, '').split(/[\\/]/).pop().toLowerCase();
  const args = tokens.slice(1);
  if (args.some(argument => OUTPUT_FLAG.test(argument))) return false;
  if (binary === 'git') return isReadOnlyGitCommand(args);
  if (binary === 'gh') return isReadOnlyGhCommand(args);
  return isReadOnlyArguments(binary, args);
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
    if (!['Bash', 'Edit', 'Write', 'MultiEdit'].includes(toolName)) return rawInput;
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

  const toolName = String(input.tool_name || '');
  const isEdit = ['Edit', 'Write', 'MultiEdit'].includes(toolName);
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

module.exports = { branchAt, gitValue, isExactLifecycleCommand, isReadOnlyBashCommand, run };
