#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const { loadConfig } = require('../codex/config');
const { isSafeGitRef } = require('../codex/delivery-lifecycle');
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

function unquoteToken(value) {
  const token = String(value || '');
  const quoted = token.match(/^"([^"]*)"$/) || token.match(/^'([^']*)'$/);
  return quoted ? quoted[1] : token;
}

function isExactBranchSwitchCommand(command, delivery) {
  const value = String(command || '').trim();
  const handoff = delivery && delivery.branch_switch;
  if (!value || !handoff || !handoff.to || hasExecutableShellControl(value)) return false;
  // 記録済みhandoffでも、shellが複数commandへ分割しうるrefの切替は許可しない。
  // prepareの検証を通らないstateが残っていても、ここが実行経路にはならない。
  if (!isSafeGitRef(handoff.to)) return false;
  if (handoff.create && !isSafeGitRef(handoff.base_branch)) return false;
  const expected = handoff.create
    ? ['git', 'switch', '-c', handoff.to, handoff.base_branch]
    : ['git', 'switch', handoff.to];
  if (!expected.every(Boolean)) return false;
  const tokens = value.split(/\s+/).map(unquoteToken);
  return tokens.length === expected.length && tokens.every((token, index) => token === expected[index]);
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
    // prepareが自動切替をやめた分、記録したbranchへの切替だけはエージェントに許可する。
    // ここを拒否すると、awaiting-branchのDeliveryはreadyへ進めないまま手詰まりになる。
    const isRecordedBranchSwitch = toolName === 'Bash' && isExactBranchSwitchCommand(command, state.delivery);
    if (isPrepareCommand || isResetCommand || isRecordedBranchSwitch) return rawInput;
    const sessionId = resolveSessionId(input, env);
    const prepareScript = path.resolve(__dirname, '../codex/delivery-lifecycle.js');
    const resetScript = path.resolve(__dirname, '../codex/reset.js');
    if (state.delivery.status === 'awaiting-branch' && state.delivery.branch_switch) {
      const actualBranch = branchAt(cwd, env);
      return deny(
        `[ECC Delivery Gate] Issue #${state.delivery.issue_number} and branch ${state.delivery.branch} are recorded, but this delivery is not ready yet. ` +
          (actualBranch === state.delivery.branch
            ? `The current branch already matches, so run node "${prepareScript}" prepare --session "${sessionId}" once more to record it as ready, then retry the tool call.`
            : 'Preparation no longer switches branches on its own, so a build or test that is still running is never moved onto another commit. ' +
              `The current branch is ${actualBranch || '<none>'}. Finish or stop any running verification, run \`${state.delivery.branch_switch.command}\` yourself, ` +
              `then run node "${prepareScript}" prepare --session "${sessionId}" again.`)
      );
    }
    return deny(
      '[ECC Delivery Gate] Repository tools are blocked until duplicate Issue search, Issue selection/creation, and the issue-linked branch are recorded. ' +
        'Preparation records that branch without switching to it; if the current branch differs, it will ask you to run one exact switch command yourself. ' +
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

module.exports = { branchAt, gitValue, isExactBranchSwitchCommand, isExactLifecycleCommand, run };
