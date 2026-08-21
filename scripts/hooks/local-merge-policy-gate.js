#!/usr/bin/env node
'use strict';

const { loadConfig } = require('../codex/config');
const { extractInvocations } = require('../lib/shell-invocations');

// Publishing a commit status is an HTTP call. Restricting the status check to
// the clients that can make one keeps documents that quote such a call — the
// Issue body describing this very policy, for instance — out of scope.
const STATUS_CLIENTS = new Set(['curl', 'gh', 'http', 'httpie', 'wget']);

function deny(reason) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `[ECC Local Merge Policy] ${reason}`
    }
  });
}

function isDirectSuccessStatus(command) {
  const value = String(command || '');
  const statusEndpoint = /(?:\/statuses\/|\/status(?:\s|["']|$))/i.test(value);
  const successState = /(?:state(?:=|\s+)["']?success\b|["']state["']\s*:\s*["']success["'])/i.test(value);
  return statusEndpoint && successState;
}

function isCodexRoleRunner(command) {
  return /(?:^|[\\/])run-role\.js(?:["']?\s|$)/i.test(String(command || ''));
}

// `gh` accepts only `--repo/-R` before the subcommand, so the merge subcommand
// is identified by the first two operands rather than by position in the line.
function operands(args) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--repo' || arg === '-R') {
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) continue;
    values.push(arg);
  }
  return values;
}

function isPullRequestMerge(invocation) {
  if (invocation.command !== 'gh') return false;
  const values = operands(invocation.args);
  return values[0] === 'pr' && values[1] === 'merge';
}

function run(rawInput, options = {}) {
  let input;
  try {
    input = typeof rawInput === 'string' ? JSON.parse(rawInput) : rawInput;
  } catch {
    return rawInput;
  }
  if (String(input.tool_name || '') !== 'Bash') return rawInput;

  const cwd = options.cwd || input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const env = options.env || process.env;
  const config = loadConfig(cwd, env);
  if (config.deliveryCompletion !== 'squash-merge') return rawInput;

  const command = String(input.tool_input && input.tool_input.command || '');
  if (input.tool_input && input.tool_input.run_in_background === true && isCodexRoleRunner(command)) {
    return deny('必須Codex roleはforegroundで完了させてください。backgroundではClaude CLI終了時に子processと外部state証拠が失われます。');
  }
  // 判定対象は実際に実行されるコマンド語と引数だけにする。heredoc本文やquoted
  // `--body` はmerge操作を「記述した文書」であって、merge操作ではない。
  let invocations;
  try {
    invocations = extractInvocations(command);
  } catch (error) {
    // 解析できないコマンドは許可しない。深い入れ子や展開後にしか決まらないコマンド語
    // など、実行されるものを列挙できない形をそのまま通すと、merge禁止が黙って外れる。
    return deny(`コマンドを解析できませんでした（${error.message}）。単純な形へ分けて実行してください。`);
  }
  if (invocations.some(isPullRequestMerge)) {
    return deny('PRのmergeはCompletion Gateだけが実行できます。Local Merge Gateを通し、通常のStopフローへ戻ってください。');
  }
  if (invocations.some(invocation => STATUS_CLIENTS.has(invocation.command) && isDirectSuccessStatus(invocation.text))) {
    return deny('success commit statusの直接投稿は禁止です。engineering-kit-merge-gateが検査結果に基づいて投稿します。');
  }
  return rawInput;
}

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { raw += chunk; });
  process.stdin.on('end', () => process.stdout.write(run(raw)));
}

module.exports = { deny, isCodexRoleRunner, isDirectSuccessStatus, isPullRequestMerge, run };
