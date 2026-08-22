#!/usr/bin/env node
'use strict';

const { loadConfig } = require('./config');
const { explicitIssueNumber, explicitPrNumber, titleFromRequest } = require('./delivery-lifecycle');
const { hash, readState, writeState } = require('./runtime-state');

const MAX_DELIVERIES = 12;

function transition(input, action, summary, options = {}) {
  const env = options.env || process.env;
  const cwd = options.cwd || input.cwd || process.cwd();
  const state = readState(input, env);
  const delivery = state.delivery;
  if (!delivery || delivery.status !== 'merged') throw new Error('The current Delivery is not merged.');
  const count = Number(state.task_delivery_count || 1);
  if (action === 'complete') {
    writeState(input, { task_status: 'complete', task_completed_at: new Date().toISOString(), task_completion_head: delivery.merged_head }, env);
    return { status: 'complete', count };
  }
  if (action !== 'continue') throw new Error('action must be continue or complete');
  const request = String(summary || '').trim();
  if (!request) throw new Error('continue requires a concrete next Delivery summary.');
  if (count >= MAX_DELIVERIES) throw new Error(`A single user task is limited to ${MAX_DELIVERIES} Deliveries.`);
  const config = loadConfig(cwd, env);
  if (config.projectConfigStatus === 'invalid') throw new Error('The ECC project configuration is invalid.');
  const requestHash = hash(request, 32);
  const next = {
    status: 'pending', workflow_mode: 'required', delivery_worktree: config.deliveryWorktree,
    request_hash: requestHash, revision: 1, title: titleFromRequest(request, requestHash),
    requested_issue_number: explicitIssueNumber(request), requested_pr_number: explicitPrNumber(request),
    base_branch: config.deliveryBaseBranch, issue_number: null, issue_url: null, branch: null, draft_pr_url: null,
    completion_method: config.deliveryCompletion, previous_merged_pr_url: delivery.merged_pr_url, next_summary: request
  };
  writeState(input, {
    previous_delivery: delivery, delivery: next, task_status: 'active', task_delivery_count: count + 1,
    review_role: null, review_status: null, review_complete: null, review_head: null,
    review_worktree_clean: false, review_blocking_findings: null
  }, env);
  return { status: 'continue', count: count + 1, delivery: next };
}

function main() {
  const action = process.argv[2];
  const summary = process.argv.slice(3).join(' ');
  const sessionId = process.env.CLAUDE_SESSION_ID;
  if (!sessionId) throw new Error('CLAUDE_SESSION_ID is required.');
  process.stdout.write(`${JSON.stringify(transition({ session_id: sessionId, cwd: process.cwd() }, action, summary), null, 2)}\n`);
}

if (require.main === module) {
  try { main(); } catch (error) { process.stderr.write(`[ECC Delivery Continuation] ${error.message}\n`); process.exit(1); }
}

module.exports = { MAX_DELIVERIES, transition };
