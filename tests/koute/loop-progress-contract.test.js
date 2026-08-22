#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { detectLoop } = require('../../scripts/hooks/ecc-context-monitor');
const { hashToolOutcome, madeProgress } = require('../../scripts/hooks/ecc-metrics-bridge');

let passed = 0;
let failed = 0;
function test(name, fn) { try { fn(); passed += 1; console.log(`✓ ${name}`); } catch (error) { failed += 1; console.error(`✗ ${name}\n${error.stack}`); } }
const entry = (progress, outcome = 'same') => ({ tool: 'Read', hash: 'input', outcome, progress });

test('same input and same outcome without progress is a loop', () => {
  const result = detectLoop([entry(0), entry(0), entry(0), entry(0)]);
  assert.strictEqual(result.detected, true);
  assert.ok(result.fingerprint);
});

test('progress or a changed outcome prevents a false loop', () => {
  assert.strictEqual(detectLoop([entry(0), entry(1), entry(2), entry(3)]).detected, false);
  assert.strictEqual(detectLoop([entry(0, 'a'), entry(0, 'b'), entry(0, 'c'), entry(0, 'd')]).detected, false);
});

test('tool outcomes are hashed and write operations advance progress', () => {
  const secret = 'do-not-persist-this-output';
  const digest = hashToolOutcome({ tool_response: { output: secret } });
  assert.ok(!digest.includes(secret));
  assert.strictEqual(madeProgress('Write', {}, {}), true);
  assert.strictEqual(madeProgress('Read', {}, {}), false);
});

console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exit(failed ? 1 : 0);
