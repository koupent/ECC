#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { transition, MAX_DELIVERIES } = require('../../scripts/codex/delivery-continuation');
const { readState, writeState } = require('../../scripts/codex/runtime-state');

let passed = 0;
let failed = 0;
function test(name, fn) { try { fn(); passed += 1; console.log(`✓ ${name}`); } catch (error) { failed += 1; console.error(`✗ ${name}\n${error.stack}`); } }
function fixture(name, count = 1) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-continuation-'));
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, '.ecc'));
  fs.writeFileSync(path.join(root, '.ecc', 'config.json'), JSON.stringify({ deliveryWorkflow: 'required', deliveryCompletion: 'squash-merge' }));
  const env = { ...process.env, ECC_KOUTE_STATE_DIR: path.join(root, 'state') };
  const input = { session_id: name, cwd: root };
  writeState(input, { task_delivery_count: count, task_status: 'active', delivery: { status: 'merged', merged_head: 'abc', merged_pr_url: 'https://example/pr/1' } }, env);
  return { root, env, input };
}

test('continue creates one pending Delivery and increments the bounded task count', () => {
  const { root, env, input } = fixture('next');
  const result = transition(input, 'continue', 'Issue #97 の次段階を実装する', { cwd: root, env });
  assert.strictEqual(result.status, 'continue');
  const state = readState(input, env);
  assert.strictEqual(state.delivery.status, 'pending');
  assert.strictEqual(state.delivery.workflow_mode, 'required');
  assert.strictEqual(state.delivery.completion_method, 'squash-merge');
  assert.strictEqual(state.delivery.requested_issue_number, 97);
  assert.strictEqual(state.task_delivery_count, 2);
});

test('complete binds task completion to the merged reviewed head', () => {
  const { root, env, input } = fixture('complete');
  transition(input, 'complete', '', { cwd: root, env });
  const state = readState(input, env);
  assert.strictEqual(state.task_status, 'complete');
  assert.strictEqual(state.task_completion_head, 'abc');
});

test('continue fails closed at the Delivery limit', () => {
  const { root, env, input } = fixture('limit', MAX_DELIVERIES);
  assert.throws(() => transition(input, 'continue', 'another delivery', { cwd: root, env }), /limited/);
});

console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exit(failed ? 1 : 0);
