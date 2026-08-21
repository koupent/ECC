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
      stdout: JSON.stringify([{ number: 24, url: 'https://example.invalid/pull/24', isDraft: true, body: 'Closes #11', baseRefName: 'main', headRefOid: 'abc123' }]),
      stderr: ''
    };
  }
  return { ok: false, stdout: '', stderr: `unexpected command: ${key}` };
}

// 監査は「どの設定に照らして合格なのか」を言えなければならない。fixtureも実装と
// 同じ契約（squash-merge は required workflow とセット）で設定を明示する。
function projectConfig(overrides) {
  return {
    deliveryWorkflow: 'required',
    deliveryCompletion: 'draft-pr',
    projectConfigPath: '/project/.ecc/config.json',
    projectConfigFailure: null,
    ...overrides
  };
}

function runAudit(entry, command = executor, config = projectConfig()) {
  return audit({ cwd: path.resolve('.'), issueNumber: 11 }, { entry, command, config });
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
      review_complete: true,
      review_head: 'abc123',
      review_worktree_clean: true,
      review_blocking_findings: 0,
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

function mergedEntry() {
  const entry = validEntry();
  entry.state.delivery = {
    ...entry.state.delivery,
    status: 'merged',
    merged_pr_url: 'https://example.invalid/pull/24',
    merged_head: 'abc123'
  };
  return entry;
}

function mergedExecutor(binary, args) {
  const key = `${binary} ${args.join(' ')}`;
  if (key.startsWith('gh issue view 11')) {
    return { ok: true, stdout: JSON.stringify({ number: 11, state: 'CLOSED', url: 'https://example.invalid/issues/11' }), stderr: '' };
  }
  if (key.startsWith('gh pr list --head codex/issue-11-lock')) {
    return {
      ok: true,
      stdout: JSON.stringify([{ number: 24, url: 'https://example.invalid/pull/24', isDraft: false, state: 'MERGED', headRefOid: 'abc123', body: 'Closes #11', baseRefName: 'main' }]),
      stderr: ''
    };
  }
  return executor(binary, args);
}

process.stdout.write('\n=== ECC acceptance audit tests ===\n');

test('passes only when external state, Git, and GitHub agree', () => {
  const report = runAudit(validEntry());
  assert.strictEqual(report.status, 'PASS');
  assert.ok(report.checks.every(item => item.pass));
});

test('fails when Stop Gate has not persisted draft-pr state', () => {
  const entry = validEntry();
  entry.state.delivery.status = 'ready';
  entry.state.delivery.completed_at = null;
  const report = runAudit(entry);
  assert.strictEqual(report.status, 'FAIL');
  assert.strictEqual(report.checks.find(item => item.id === 'delivery-stop-gate').pass, false);
});

test('fails when an explicitly requested Issue was replaced', () => {
  const entry = validEntry();
  entry.state.delivery.issue_number = 22;
  const report = runAudit(entry);
  assert.strictEqual(report.status, 'FAIL');
  assert.strictEqual(report.checks.find(item => item.id === 'explicit-issue-reused').pass, false);
});

test('fails when a nominally successful review still records a release blocker', () => {
  const entry = validEntry();
  entry.state.review_blocking_findings = 1;
  const report = runAudit(entry);
  assert.strictEqual(report.status, 'FAIL');
  assert.strictEqual(report.checks.find(item => item.id === 'commit-bound-review').pass, false);
});

test('fails closed when release-blocker evidence is missing or malformed', () => {
  for (const value of [undefined, null, '0', Number.NaN]) {
    const entry = validEntry();
    entry.state.review_blocking_findings = value;
    const report = runAudit(entry);
    assert.strictEqual(report.status, 'FAIL');
    assert.strictEqual(report.checks.find(item => item.id === 'commit-bound-review').pass, false);
  }
});

test('fails when the project config that names the completion method cannot be read', () => {
  const report = runAudit(validEntry(), executor, projectConfig({ projectConfigFailure: 'invalid-json' }));
  assert.strictEqual(report.status, 'FAIL');
  const projectCheck = report.checks.find(item => item.id === 'project-config');
  assert.strictEqual(projectCheck.pass, false);
  assert.match(projectCheck.actual, /invalid-json/);
});

test('fails when a Draft PR is not bound to the reviewed HEAD', () => {
  const staleExecutor = (binary, args) => {
    const key = `${binary} ${args.join(' ')}`;
    if (key.startsWith('gh pr list --head codex/issue-11-lock')) {
      return {
        ok: true,
        stdout: JSON.stringify([{ number: 24, url: 'https://example.invalid/pull/24', isDraft: true, body: 'Closes #11', baseRefName: 'main', headRefOid: 'stale' }]),
        stderr: ''
      };
    }
    return executor(binary, args);
  };
  const report = runAudit(validEntry(), staleExecutor);
  assert.strictEqual(report.status, 'FAIL');
  assert.strictEqual(report.checks.find(item => item.id === 'github-delivery-pr').pass, false);
});

test('accepts squash-merged delivery evidence bound to the reviewed HEAD', () => {
  const report = runAudit(mergedEntry(), mergedExecutor);
  assert.strictEqual(report.status, 'PASS');
});

test('a squash-merge project does not accept an unmerged draft-pr Delivery as complete', () => {
  const report = runAudit(validEntry(), executor, projectConfig({ deliveryCompletion: 'squash-merge' }));
  assert.strictEqual(report.status, 'FAIL');
  const stopGate = report.checks.find(item => item.id === 'delivery-stop-gate');
  assert.strictEqual(stopGate.pass, false);
  assert.strictEqual(stopGate.expected, 'merged with completed_at');
  assert.strictEqual(report.checks.find(item => item.id === 'github-delivery-pr').pass, false);
});

test('a squash-merge project accepts the merged Delivery', () => {
  const report = runAudit(mergedEntry(), mergedExecutor, projectConfig({ deliveryCompletion: 'squash-merge' }));
  assert.strictEqual(report.status, 'PASS');
});

test('a Delivery recorded as squash-merge still requires merge evidence when the config no longer says so', () => {
  const entry = validEntry();
  entry.state.delivery.completion_method = 'squash-merge';
  const report = runAudit(entry, executor, projectConfig({ deliveryCompletion: 'draft-pr' }));
  assert.strictEqual(report.status, 'FAIL');
  assert.strictEqual(report.checks.find(item => item.id === 'delivery-stop-gate').pass, false);
});

test('squash-merge that never entered the required workflow is not treated as active', () => {
  // schemaが拒否する組合せ。監査だけが取り込みを要求すると、Completion Gateが
  // 決してmergeしないDeliveryを永久にFAILさせることになる。
  const report = runAudit(validEntry(), executor, projectConfig({
    deliveryWorkflow: 'advisory',
    deliveryCompletion: 'squash-merge'
  }));
  assert.strictEqual(report.status, 'PASS');
});

test('parses the explicit issue argument', () => {
  assert.deepStrictEqual(parseArgs(['--issue', '11']), { issueNumber: 11 });
});

process.stdout.write(`\nPassed: ${passed}\nFailed: ${failed}\n`);
process.exitCode = failed ? 1 : 0;
