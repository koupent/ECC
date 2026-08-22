#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`✓ ${name}`); }
  catch (error) { failed += 1; console.error(`✗ ${name}\n${error.stack}`); }
}
const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('Python guidance does not unconditionally require black or isort', () => {
  for (const file of [
    'rules/python/coding-style.md',
    'rules/python/hooks.md',
    'commands/python-review.md',
    'agents/python-reviewer.md',
    '.cursor/rules/python-coding-style.md',
    '.cursor/rules/python-hooks.md',
    'docs/ja-JP/agents/python-reviewer.md',
    'docs/ja-JP/commands/python-review.md',
    'docs/zh-CN/agents/python-reviewer.md',
    'docs/zh-CN/commands/python-review.md',
    'docs/es/agents/python-reviewer.md',
    'docs/tr/agents/python-reviewer.md',
    'docs/es/rules/python/hooks.md',
    'docs/ja-JP/rules/python/hooks.md',
    'docs/tr/rules/python/hooks.md',
    'docs/zh-CN/rules/python/hooks.md'
  ]) {
    const text = read(file);
    assert.doesNotMatch(text, /^\s*(?:black|isort)(?:\s|$)/m, file);
    assert.doesNotMatch(text, /black\/ruff/i, file);
  }
  assert.match(read('rules/python/coding-style.md'), /project/i);
  assert.match(read('docs/ja-JP/rules/python/coding-style.md'), /プロジェクト/);
});

test('FastAPI rules cover common api and router Python layouts', () => {
  for (const file of ['rules/python/fastapi.md', 'docs/ja-JP/rules/python/fastapi.md']) {
    const text = read(file);
    for (const glob of ['**/api/**/*.py', '**/routers/**/*.py', '**/routes/**/*.py']) {
      assert.ok(text.includes(glob), `${file}: ${glob}`);
    }
  }
});

console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exit(failed ? 1 : 0);
