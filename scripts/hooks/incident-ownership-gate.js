#!/usr/bin/env node
'use strict';

const { loadConfig } = require('../codex/config');
const { assertCentralRemediationAllowed } = require('../codex/incident-ownership');

function deny(reason) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `[ECC Incident Ownership] ${reason}`
    }
  });
}

function isCentralRemediationCommand(command) {
  const value = String(command || '');
  if (/(?:^|\s)engineering-kit-incident-operator(?:\s|$)/i.test(value)) return true;
  const target = /koupent\/(?:engineering-environment-kit|ECC)(?:\.git)?\b/i.test(value);
  const mutation = /\b(?:gh\s+repo\s+clone|git\s+clone|gh\s+(?:pr|issue)\s+(?:create|edit|close|merge|ready)|git\s+push)\b/i.test(value);
  return target && mutation;
}

function run(rawInput, options = {}) {
  let input;
  try {
    input = typeof rawInput === 'string' ? JSON.parse(rawInput) : rawInput;
  } catch {
    return rawInput;
  }
  if (String(input.tool_name || '') !== 'Bash') return rawInput;
  const command = String(input.tool_input && input.tool_input.command || '');
  if (!isCentralRemediationCommand(command)) return rawInput;

  const cwd = options.cwd || input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const env = options.env || process.env;
  const config = loadConfig(cwd, env);
  try {
    assertCentralRemediationAllowed({
      mode: config.incidentHandling.mode,
      targetRepository: env.ECC_OPERATOR_TARGET_REPOSITORY,
      env
    });
    return rawInput;
  } catch (error) {
    return deny(error.message || String(error));
  }
}

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { raw += chunk; });
  process.stdin.on('end', () => process.stdout.write(run(raw)));
}

module.exports = { deny, isCentralRemediationCommand, run };
