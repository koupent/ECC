#!/usr/bin/env node
'use strict';

const { loadConfig, squashMergeCompletion } = require('../codex/config');
const { extractInvocations } = require('../lib/shell-invocations');

// Publishing a commit status and merging a PR are HTTP calls, so what is judged
// is the client that makes one and the endpoint it is pointed at — never the
// request payload, and never a document that quotes one. `-f state=success`,
// `--input status.json` and a JSON body all reach the same endpoint, so reading
// the payload would only decide which spellings of the same call get caught.
const HTTP_CLIENTS = new Set(['curl', 'http', 'httpie', 'wget']);
// `POST /repos/{owner}/{repo}/statuses/{sha}` is the only way to publish a commit
// status. The Completion Gate's own read, `/commits/{ref}/status`, is a different
// path and stays allowed.
const STATUS_PUBLICATION = /\/statuses\/[^/\s'"]+/i;
// A merge does not need `gh pr merge`: the REST endpoint and the GraphQL mutation
// perform it with the same credentials.
const REST_MERGE = /\/pulls\/\d+\/merge(?:$|[/?#])/i;
const GRAPHQL_MERGE = /\b(?:mergePullRequest|enablePullRequestAutoMerge)\b/;
const GITHUB_API_URL = /(?:^|\/\/|@)api\.github\.com(?:[:/]|$)|\/api\/v3\//i;
// Fields and bodies are what turn `gh api` into a write. Refusing writes as a
// class keeps this policy from depending on a list of merge-shaped endpoints:
// an endpoint nobody enumerated here is refused too.
const GH_FIELD_FLAG = /^(?:-f|-F|--field|--raw-field|--input)(?:=|$)/;
const READ_METHODS = new Set(['GET', 'HEAD']);

function deny(reason) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `[ECC Local Merge Policy] ${reason}`
    }
  });
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

/**
 * The words a client hands to GitHub: the endpoint and field values of
 * `gh api`, or the URLs an HTTP client is pointed at. Arguments of any other
 * command — a PR body, an Issue title — are not endpoints and are not read.
 */
function githubTargets(invocation) {
  if (invocation.command === 'gh') {
    const values = operands(invocation.args);
    return values[0] === 'api' ? values.slice(1) : [];
  }
  if (!HTTP_CLIENTS.has(invocation.command)) return [];
  return invocation.args.filter(arg => /^(?:https?:)?\/\//i.test(arg) || GITHUB_API_URL.test(arg));
}

function isStatusPublication(invocation) {
  return githubTargets(invocation).some(target => STATUS_PUBLICATION.test(target));
}

function isApiMerge(invocation) {
  return githubTargets(invocation).some(target => REST_MERGE.test(target) || GRAPHQL_MERGE.test(target));
}

function isGitHubApiWrite(invocation) {
  if (invocation.command !== 'gh') return false;
  const args = invocation.args;
  if (operands(args)[0] !== 'api') return false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (GH_FIELD_FLAG.test(arg)) return true;
    const method = arg === '--method' || arg === '-X'
      ? args[index + 1]
      : (/^(?:--method|-X)=(.+)$/.exec(arg) || [])[1];
    if (method !== undefined && !READ_METHODS.has(String(method).toUpperCase())) return true;
  }
  return false;
}

// `gh` carries the session's GitHub credentials, so an HTTP client aimed at the
// API is the same authority with none of the subcommand structure to judge.
function isDirectGitHubApiCall(invocation) {
  return HTTP_CLIENTS.has(invocation.command) && invocation.args.some(arg => GITHUB_API_URL.test(arg));
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
  if (!squashMergeCompletion(config)) return rawInput;

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
  if (invocations.some(invocation => isPullRequestMerge(invocation) || isApiMerge(invocation))) {
    return deny('PRのmergeはCompletion Gateだけが実行できます。REST/GraphQLのmerge endpointも同じ操作です。Local Merge Gateを通し、通常のStopフローへ戻ってください。');
  }
  if (invocations.some(isStatusPublication)) {
    return deny('commit statusの直接投稿は禁止です。payloadの形に関わらず、engineering-kit-merge-gateが検査結果に基づいて投稿します。');
  }
  if (invocations.some(invocation => isGitHubApiWrite(invocation) || isDirectGitHubApiCall(invocation))) {
    return deny('GitHub APIへの直接書き込みは禁止です。merge・statusを含む書き込みはCompletion Gateとmerge gateが実行します。読み取りや通常の `gh` subcommandを使ってください。');
  }
  return rawInput;
}

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { raw += chunk; });
  process.stdin.on('end', () => process.stdout.write(run(raw)));
}

module.exports = {
  deny,
  githubTargets,
  isApiMerge,
  isCodexRoleRunner,
  isDirectGitHubApiCall,
  isGitHubApiWrite,
  isPullRequestMerge,
  isStatusPublication,
  run
};
