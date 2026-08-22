#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const { loadConfig } = require('../codex/config');
const { deliveryWorkspace, readState, writeState } = require('../codex/runtime-state');

function gitValue(cwd, env, args) {
  const result = spawnSync('git', args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true
  });
  return result.status === 0 ? String(result.stdout || '').trim() : '';
}

// gitのglobal optionは値を別tokenに取る（`git -C <path> commit`）。隔離されたDeliveryは
// 払い出したworktreeでコミットするため、手順書が案内する形がまさにこれである。optionを
// 「`-` で始まる語の並び」とだけ読むと、この形のコミットを一つも観測できず、レビュー要求も
// コミット後の編集を止めるGateも働かないまま完了へ進んでしまう。
const GIT_VALUE_OPTIONS = new Set([
  '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env', '--super-prefix'
]);

// 引用の中の区切り文字までは追わない。ここは隔離境界ではなくコミットの観測であり、
// 取りこぼさないことを優先する。Deliveryの成果として記録してよいかどうかは、このあと
// 記録済みworktreeのbranch・HEAD・cleanさで判定する。
function runsGitCommit(command) {
  return String(command || '').split(/[;&|\n]+/).some(segment => {
    const tokens = segment.match(/"[^"]*"|'[^']*'|\S+/g) || [];
    if (!/^git(?:\.exe)?$/i.test(tokens[0] || '')) return false;
    let index = 1;
    while (index < tokens.length && tokens[index].startsWith('-')) {
      index += GIT_VALUE_OPTIONS.has(tokens[index]) ? 2 : 1;
    }
    return tokens[index] === 'commit';
  });
}

function isSuccessfulCommit(input) {
  const command = String(input.tool_input && input.tool_input.command || '');
  if (!runsGitCommit(command)) return false;
  const response = input.tool_response || input.tool_result || {};
  if (response && typeof response === 'object') {
    const status = [response.exit_code, response.exitCode, response.status, response.code]
      .find(value => typeof value === 'number');
    if (typeof status === 'number' && status !== 0) return false;
  }
  const text = typeof response === 'string' ? response : JSON.stringify(response);
  return !/(?:exit(?:ed)?\s+(?:code\s*)?[1-9]\d*|fatal:|error:)/i.test(text);
}

function run(rawInput, options = {}) {
  let input;
  try {
    input = typeof rawInput === 'string' ? JSON.parse(rawInput) : rawInput;
  } catch {
    return rawInput;
  }
  if (String(input.tool_name || '') !== 'Bash' || !isSuccessfulCommit(input)) return rawInput;

  const env = options.env || process.env;
  const cwd = options.cwd || input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const config = loadConfig(cwd, env);
  if (config.deliveryWorkflow !== 'required') return rawInput;
  const state = readState(input, env);
  if (!state.delivery || state.delivery.status !== 'ready') return rawInput;

  // コミットは払い出したworktreeで行われる。共有ツリーのHEADを読むと、Deliveryの
  // コミットを取り逃してレビュー要求が出ないまま進む。
  const workspace = deliveryWorkspace(state, cwd);
  if (!workspace) {
    // 記録済みworktreeが失われている間と、worktreeへ移していないDeliveryの間は、共有ツリーの
    // HEADをDeliveryのコミットとして記録しない。ここで拾うと、別作業のコミットに
    // レビュー証拠が結び付く。
    return {
      additionalContext: [
        '[ECC Delivery Progress]',
        state.delivery.worktree_path
          ? `The worktree recorded for Issue #${state.delivery.issue_number} (${state.delivery.worktree_path}) is missing or belongs to another repository.`
          : `Issue #${state.delivery.issue_number} has no delivery worktree bound to it yet, so this commit is not read as delivery evidence.`,
        'The shared working tree is never read as delivery evidence. ' +
          'Run `/ecc:delivery-prepare` to move the recorded Issue and branch into their own worktree, or restore the recorded worktree, before continuing.'
      ].join('\n')
    };
  }
  const branch = gitValue(workspace, env, ['branch', '--show-current']);
  const head = gitValue(workspace, env, ['rev-parse', 'HEAD']);
  const dirty = gitValue(workspace, env, ['status', '--porcelain']);
  if (!head || dirty || branch !== state.delivery.branch || head === state.delivery.committed_head) return rawInput;

  writeState(input, {
    delivery: {
      ...state.delivery,
      committed_head: head,
      committed_at: new Date().toISOString(),
      completion_stage: 'review-required'
    },
    review_role: null,
    review_status: null,
    review_complete: null,
    review_head: null,
    review_worktree_clean: false,
    review_blocking_findings: null,
    review_owner_actions: [],
    review_result: null,
    review_snapshot: null,
    review_request_hash: null
  }, env);

  return {
    additionalContext: [
      '[ECC Delivery Progress]',
      `Current clean commit ${head} is recorded.`,
      'Run the independent Codex review now. Do not begin another edit cycle before that review.',
      config.deliveryCompletion === 'squash-merge'
        ? `If the review has no critical/high findings, push this branch, create the linked Draft PR, and run ${config.mergeGate.command}. The Completion Gate will Ready and squash merge it.`
        : 'If the review has no critical/high findings, push this branch and create the linked Draft PR.'
    ].join('\n')
  };
}

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { raw += chunk; });
  process.stdin.on('end', () => {
    const output = run(raw);
    if (typeof output === 'string') process.stdout.write(output === raw ? '' : output);
    else if (output && output.additionalContext) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: output.additionalContext
        }
      }));
    }
  });
}

module.exports = { gitValue, isSuccessfulCommit, run, runsGitCommit };
