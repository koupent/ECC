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
    const isPrepareCommand = toolName === 'Bash' &&
      /scripts[\\/]codex[\\/]delivery-lifecycle\.js["']?\s+prepare(?:\s|$)/i.test(command);
    const isResetCommand = toolName === 'Bash' &&
      /scripts[\\/]codex[\\/]reset\.js["']?(?:\s|$)/i.test(command);
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
      state.review_status === 'ok' &&
      state.review_head === head &&
      state.review_worktree_clean === true &&
      Number(state.review_blocking_findings || 0) > 0
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

module.exports = { branchAt, gitValue, run };
