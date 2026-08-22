#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { deliveryBranch, selectDeliveryBranch, titleFromRequest } = require('../../scripts/codex/delivery-lifecycle');

let passed = 0;
let failed = 0;
function test(name, fn) { try { fn(); passed += 1; console.log(`✓ ${name}`); } catch (error) { failed += 1; console.error(`✗ ${name}\n${error.stack}`); } }

test('meaningful title uses the request first line without secrets or URLs', () => {
  const title = titleFromRequest('音声入力の不具合を修正してください https://example.com ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abc', 'meaningful');
  assert.match(title, /^音声入力の不具合/);
  assert.ok(!title.includes('https://'));
  assert.ok(!title.includes('ghp_'));
});

test('branch prefix is configurable and existing issue branch is reused', () => {
  assert.strictEqual(deliveryBranch(78, '日本語タイトル', '', 'task'), 'task/issue-78-task');
  assert.strictEqual(selectDeliveryBranch(78, 'title', '', ['task/issue-78-existing'], 'task'), 'task/issue-78-existing');
});

test('unsafe branch prefix is rejected before reaching the shell', () => {
  assert.throws(() => deliveryBranch(78, 'title', '', 'task;rm'), /not shell-safe/);
});

console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exit(failed ? 1 : 0);
