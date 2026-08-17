#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const { loadConfig } = require('../codex/config');
const { readState, recordIncident, resolveSessionId } = require('../codex/runtime-state');

function deny(reason) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason
    }
  });
}

function branchAt(cwd, env) {
  const result = spawnSync('git', ['branch', '--show-current'], { cwd, env, encoding: 'utf8', timeout: 5000, windowsHide: true });
  return result.status === 0 ? String(result.stdout || '').trim() : '';
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
  if (state.delivery.status !== 'ready') {
    const toolName = String(input.tool_name || '');
    const command = String(input.tool_input && input.tool_input.command || '');
    const isPrepareCommand = toolName === 'Bash' &&
      /scripts[\\/]codex[\\/]delivery-lifecycle\.js["']?\s+prepare(?:\s|$)/i.test(command);
    if (isPrepareCommand) return rawInput;
    const sessionId = resolveSessionId(input, env);
    return deny(
      '[ECC Delivery Gate] Repository tools are blocked until duplicate Issue search, Issue selection/creation, and issue-linked branch creation complete. ' +
        `Run node \"$CLAUDE_PLUGIN_ROOT/scripts/codex/delivery-lifecycle.js\" prepare --session \"${sessionId}\" first, then retry the tool call.`
    );
  }

  const actualBranch = branchAt(cwd, env);
  if (!actualBranch || actualBranch !== state.delivery.branch) {
    recordIncident(
      { type: 'delivery_branch_mismatch', severity: 'critical', message: `expected ${state.delivery.branch}; actual ${actualBranch || '<none>'}` },
      { cwd, env }
    );
    return deny(`[ECC Delivery Gate] Expected issue-linked branch ${state.delivery.branch}, but current branch is ${actualBranch || '<none>'}. Restore the recorded branch before editing.`);
  }
  return rawInput;
}

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { raw += chunk; });
  process.stdin.on('end', () => process.stdout.write(run(raw)));
}

module.exports = { branchAt, run };
