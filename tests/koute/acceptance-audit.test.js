#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { audit, parseArgs } = require('../../scripts/codex/acceptance-audit');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (error) {
    failed += 1;
    process.stderr.write(`  ✗ ${name}: ${error.message}\n`);
  }
}

function executor(binary, args) {
  const key = `${binary} ${args.join(' ')}`;
  if (key === 'git status --porcelain') return { ok: true, stdout: '', stderr: '' };
  if (key === 'git branch --show-current') return { ok: true, stdout: 'codex/issue-11-lock', stderr: '' };
  if (key === 'git rev-parse HEAD') return { ok: true, stdout: 'abc123', stderr: '' };
  if (key.startsWith('gh issue view 11')) {
    return { ok: true, stdout: JSON.stringify({ number: 11, state: 'OPEN', url: 'https://example.invalid/issues/11' }), stderr: '' };
  }
  if (key.startsWith('gh pr list --head codex/issue-11-lock')) {
    return {
      ok: true,
      stdout: JSON.stringify([{ number: 24, url: 'https://example.invalid/pull/24', isDraft: true, body: 'Closes #11', baseRefName: 'main' }]),
      stderr: ''
    };
  }
  return { ok: false, stdout: '', stderr: `unexpected command: ${key}` };
}

function validEntry() {
  return {
    file: '/state/session.json',
    state: {
      session_id: 'session',
      project: 'project',
      context_status: 'ready',
      codex_calls: 2,
      codex_failures: 0,
      waste_loops: 0,
      review_role: 'review',
      review_status: 'ok',
      review_head: 'abc123',
      review_worktree_clean: true,
      delivery: {
        status: 'draft-pr',
        requested_issue_number: 11,
        issue_number: 11,
        branch: 'codex/issue-11-lock',
        base_branch: 'main',
        draft_pr_url: 'https://example.invalid/pull/24',
        completed_at: '2026-08-18T00:00:00.000Z'
      }
    }
  };
}

process.stdout.write('\n=== ECC acceptance audit tests ===\n');

test('passes only when external state, Git, and GitHub agree', () => {
  const report = audit({ cwd: path.resolve('.') , issueNumber: 11 }, { entry: validEntry(), command: executor });
  assert.strictEqual(report.status, 'PASS');
  assert.ok(report.checks.every(item => item.pass));
});

test('fails when Stop Gate has not persisted draft-pr state', () => {
  const entry = validEntry();
  entry.state.delivery.status = 'ready';
  entry.state.delivery.completed_at = null;
  const report = audit({ cwd: path.resolve('.'), issueNumber: 11 }, { entry, command: executor });
  assert.strictEqual(report.status, 'FAIL');
  assert.strictEqual(report.checks.find(item => item.id === 'delivery-stop-gate').pass, false);
});

test('fails when an explicitly requested Issue was replaced', () => {
  const entry = validEntry();
  entry.state.delivery.issue_number = 22;
  const report = audit({ cwd: path.resolve('.'), issueNumber: 11 }, { entry, command: executor });
  assert.strictEqual(report.status, 'FAIL');
  assert.strictEqual(report.checks.find(item => item.id === 'explicit-issue-reused').pass, false);
});

test('parses the explicit issue argument', () => {
  assert.deepStrictEqual(parseArgs(['--issue', '11']), { issueNumber: 11 });
});

process.stdout.write(`\nPassed: ${passed}\nFailed: ${failed}\n`);
process.exitCode = failed ? 1 : 0;
