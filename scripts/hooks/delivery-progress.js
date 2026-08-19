#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const { loadConfig } = require('../codex/config');
const { readState, writeState } = require('../codex/runtime-state');

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

function isSuccessfulCommit(input) {
  const command = String(input.tool_input && input.tool_input.command || '');
  if (!/(?:^|[;&|]\s*)git\s+(?:-[^\s]+\s+)*commit(?:\s|$)/i.test(command)) return false;
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
  if (loadConfig(cwd, env).deliveryWorkflow !== 'required') return rawInput;
  const state = readState(input, env);
  if (!state.delivery || state.delivery.status !== 'ready') return rawInput;

  const branch = gitValue(cwd, env, ['branch', '--show-current']);
  const head = gitValue(cwd, env, ['rev-parse', 'HEAD']);
  const dirty = gitValue(cwd, env, ['status', '--porcelain']);
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
    review_head: null,
    review_worktree_clean: false,
    review_blocking_findings: null
  }, env);

  return {
    additionalContext: [
      '[ECC Delivery Progress]',
      `Current clean commit ${head} is recorded.`,
      'Run the independent Codex review now. Do not begin another edit cycle before that review.',
      'If the review has no critical/high findings, push this branch and create the linked Draft PR.'
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

module.exports = { gitValue, isSuccessfulCommit, run };
