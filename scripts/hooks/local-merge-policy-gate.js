#!/usr/bin/env node
'use strict';

const { loadConfig } = require('../codex/config');

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
  if (/\bgh\s+pr\s+merge\b/i.test(command)) {
    return deny('PRのmergeはCompletion Gateだけが実行できます。Local Merge Gateを通し、通常のStopフローへ戻ってください。');
  }
  if (isDirectSuccessStatus(command)) {
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

module.exports = { deny, isCodexRoleRunner, isDirectSuccessStatus, run };
