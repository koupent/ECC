#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const lifecycle = require('../../scripts/codex/delivery-lifecycle');
const completionGate = require('../../scripts/hooks/delivery-completion-gate');
const lifecycleGate = require('../../scripts/hooks/delivery-lifecycle-gate');
const finalizer = require('../../scripts/hooks/delivery-session-finalizer');
const {
  hash,
  projectFingerprint,
  projectFingerprintCandidates,
  projectRootFromCommonDir,
  projectStateMatches,
  readState,
  writeState
} = require('../../scripts/codex/runtime-state');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`✓ ${name}`); }
  catch (error) { failed += 1; console.error(`✗ ${name}\n${error.stack}`); }
}

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return String(result.stdout || '').trim();
}

test('main worktree and linked worktree are distinguished by git common dir', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-delivery-wt-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(root, 'README.md'), 'fixture\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'fixture');
  const linked = path.join(root, '.claude', 'worktrees', 'issue-67');
  fs.mkdirSync(path.dirname(linked), { recursive: true });
  git(root, 'worktree', 'add', '-b', 'worktree-issue-67', linked, 'HEAD');
  assert.strictEqual(lifecycle.worktreeIdentity(root).isolated, false);
  const identity = lifecycle.worktreeIdentity(linked);
  assert.strictEqual(identity.isolated, true);
  assert.strictEqual(identity.root, path.resolve(linked));
  assert.strictEqual(projectFingerprint(root), projectFingerprint(linked));
  assert.strictEqual(projectFingerprint(root), hash(path.resolve(root)));
  assert.strictEqual(projectStateMatches({ project: hash(linked), delivery: { worktree: linked } }, root), true);
});

test('worktree identity falls back on Git without path-format support', () => {
  const root = path.resolve(os.tmpdir(), 'ecc-old-git');
  const cwd = path.join(root, 'packages', 'app');
  const calls = [];
  const execute = (_binary, args) => {
    calls.push(args.join(' '));
    if (args.includes('--path-format=absolute')) throw new Error('unknown option: --path-format');
    if (args.includes('--show-toplevel')) return root;
    if (args.includes('--git-dir')) return '../../.git/worktrees/issue-67';
    if (args.includes('--git-common-dir')) return '../../.git';
    throw new Error(`unexpected args: ${args.join(' ')}`);
  };
  const identity = lifecycle.worktreeIdentity(cwd, process.env, execute);
  assert.strictEqual(identity.git_dir, path.join(root, '.git', 'worktrees', 'issue-67'));
  assert.strictEqual(identity.common_dir, path.join(root, '.git'));
  assert.strictEqual(identity.isolated, true);
  assert.ok(calls.some(call => call.includes('--path-format=absolute')));
});

test('worktree lookup preserves non-ASCII paths from porcelain -z output', () => {
  const root = path.resolve(os.tmpdir(), '開発-worktree');
  const branch = 'codex/issue-67-unicode';
  const execute = (_binary, args) => {
    assert.deepStrictEqual(args, ['worktree', 'list', '--porcelain', '-z']);
    return `worktree ${root}\0HEAD abc123\0branch refs/heads/${branch}\0\0`;
  };
  assert.deepStrictEqual(
    lifecycle.worktreeForBranch(branch, root, process.env, execute),
    { worktree: root, branch }
  );
});

test('legacy and modern common-dir paths preserve the original repository fingerprint', () => {
  const root = path.resolve(os.tmpdir(), 'ecc-fingerprint-repo');
  assert.strictEqual(projectRootFromCommonDir(path.join(root, '.git')), root);
  assert.strictEqual(projectRootFromCommonDir(root), root);
});

test('prepared project fingerprints can be reused across state scans', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-fingerprint-scan-'));
  git(root, 'init', '-b', 'main');
  const candidates = projectFingerprintCandidates(root);
  assert.strictEqual(projectStateMatches({ project: projectFingerprint(root) }, root, candidates), true);
  assert.strictEqual(projectStateMatches({ project: 'not-this-project' }, root, candidates), false);
});

test('draft-pr is an active delivery and resumes without losing issue or branch', () => {
  assert.strictEqual(lifecycle.isActiveDelivery({ status: 'draft-pr' }), true);
});

test('completed draft-pr remains resumable without being reported as incomplete', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-delivery-finalizer-'));
  const env = { ...process.env, ECC_KOUTE_STATE_DIR: `${root}-state` };
  const input = { session_id: 'completed-draft', cwd: root };
  const state = {
    delivery: {
      status: 'draft-pr',
      issue_number: 67,
      committed_head: 'abc123',
      completed_at: new Date().toISOString()
    }
  };
  assert.strictEqual(finalizer.reportIncomplete(input, state, { cwd: root, env }), false);
});

test('Stop is blocked until the required worktree has been entered', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-delivery-stop-'));
  fs.mkdirSync(path.join(root, '.ecc'), { recursive: true });
  fs.writeFileSync(path.join(root, '.ecc', 'config.json'), JSON.stringify({ deliveryWorkflow: 'required' }));
  const env = { ...process.env, ECC_KOUTE_STATE_DIR: path.join(root, 'state') };
  const input = { session_id: 'awaiting-worktree', cwd: root };
  writeState(input, {
    delivery: { status: 'awaiting-worktree', issue_number: 67, worktree_name: 'issue-67-delivery' }
  }, env);
  const result = JSON.parse(completionGate.run(JSON.stringify(input), { cwd: root, env }));
  assert.strictEqual(result.decision, 'block');
  assert.match(result.reason, /EnterWorktree/);
});

test('explicit different PR does not resume the previous draft delivery', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-delivery-explicit-pr-'));
  fs.mkdirSync(path.join(root, '.ecc'), { recursive: true });
  fs.writeFileSync(path.join(root, '.ecc', 'config.json'), JSON.stringify({ deliveryWorkflow: 'required' }));
  const env = { ...process.env, ECC_KOUTE_STATE_DIR: path.join(root, 'state') };
  const input = { session_id: 'explicit-pr', cwd: root };
  writeState(input, {
    delivery: {
      status: 'draft-pr',
      issue_number: 67,
      draft_pr_url: 'https://github.com/example/repo/pull/10',
      branch: 'codex/issue-67-old'
    }
  }, env);
  const next = lifecycle.initializeDelivery(input, 'PR #99 を修正してください', { cwd: root, env });
  assert.strictEqual(next.requested_pr_number, 99);
  assert.strictEqual(next.status, 'pending');
  assert.notStrictEqual(readState(input, env).delivery.branch, 'codex/issue-67-old');
});

test('generic continuation cannot override a conflicting explicit PR or Issue', () => {
  for (const [index, prompt] of [
    'resume PR #99',
    'continue pull request #99',
    'continue https://github.com/example/repo/pull/99',
    'continue Issue #99'
  ].entries()) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `ecc-delivery-conflict-${index}-`));
    fs.mkdirSync(path.join(root, '.ecc'), { recursive: true });
    fs.writeFileSync(path.join(root, '.ecc', 'config.json'), JSON.stringify({ deliveryWorkflow: 'required' }));
    const env = { ...process.env, ECC_KOUTE_STATE_DIR: path.join(root, 'state') };
    const input = { session_id: `conflict-${index}`, cwd: root };
    writeState(input, {
      delivery: {
        status: 'draft-pr',
        issue_number: 67,
        pr_number: 10,
        branch: 'codex/issue-67-old'
      }
    }, env);
    const next = lifecycle.initializeDelivery(input, prompt, { cwd: root, env });
    assert.strictEqual(next.status, 'pending', prompt);
    assert.notStrictEqual(next.issue_number, 67, prompt);
  }
});

test('explicit matching PR resumes from the persisted Draft PR URL', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-delivery-resume-pr-'));
  fs.mkdirSync(path.join(root, '.ecc'), { recursive: true });
  fs.writeFileSync(path.join(root, '.ecc', 'config.json'), JSON.stringify({ deliveryWorkflow: 'required' }));
  const env = { ...process.env, ECC_KOUTE_STATE_DIR: path.join(root, 'state') };
  const input = { session_id: 'resume-pr', cwd: root };
  writeState(input, {
    delivery: {
      status: 'draft-pr',
      issue_number: 67,
      draft_pr_url: 'https://github.com/example/repo/pull/10',
      branch: 'codex/issue-67-old'
    }
  }, env);
  const resumed = lifecycle.initializeDelivery(input, 'PR #10 を修正してください', { cwd: root, env });
  assert.strictEqual(resumed.status, 'awaiting-branch');
  assert.strictEqual(resumed.issue_number, 67);
  assert.strictEqual(resumed.branch, 'codex/issue-67-old');
});

test('persisted and URL-derived PR identity wins over a stale requested number', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-delivery-pr-precedence-'));
  fs.mkdirSync(path.join(root, '.ecc'), { recursive: true });
  fs.writeFileSync(path.join(root, '.ecc', 'config.json'), JSON.stringify({ deliveryWorkflow: 'required' }));
  const env = { ...process.env, ECC_KOUTE_STATE_DIR: path.join(root, 'state') };
  const input = { session_id: 'pr-precedence', cwd: root };
  writeState(input, {
    delivery: {
      status: 'draft-pr',
      issue_number: 67,
      requested_pr_number: 99,
      draft_pr_url: 'https://github.com/example/repo/pull/10',
      branch: 'codex/issue-67-old'
    }
  }, env);
  const resumed = lifecycle.initializeDelivery(input, 'continue PR #10', { cwd: root, env });
  assert.strictEqual(resumed.status, 'awaiting-branch');
});

test('an unrelated mutation after a Draft PR starts a new delivery', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-delivery-unrelated-'));
  fs.mkdirSync(path.join(root, '.ecc'), { recursive: true });
  fs.writeFileSync(path.join(root, '.ecc', 'config.json'), JSON.stringify({ deliveryWorkflow: 'required' }));
  const env = { ...process.env, ECC_KOUTE_STATE_DIR: path.join(root, 'state') };
  const input = { session_id: 'unrelated-pr', cwd: root };
  writeState(input, {
    delivery: {
      status: 'draft-pr',
      issue_number: 67,
      draft_pr_url: 'https://github.com/example/repo/pull/10',
      branch: 'codex/issue-67-old'
    }
  }, env);
  const next = lifecycle.initializeDelivery(input, '新しい認証機能を追加してください', { cwd: root, env });
  assert.strictEqual(next.status, 'pending');
  assert.strictEqual(next.issue_number, null);
  assert.notStrictEqual(next.branch, 'codex/issue-67-old');
});

test('repeating the original request does not silently reopen a completed Draft PR', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-delivery-repeat-'));
  fs.mkdirSync(path.join(root, '.ecc'), { recursive: true });
  fs.writeFileSync(path.join(root, '.ecc', 'config.json'), JSON.stringify({ deliveryWorkflow: 'required' }));
  const env = { ...process.env, ECC_KOUTE_STATE_DIR: path.join(root, 'state') };
  const input = { session_id: 'repeat-pr', cwd: root };
  const prompt = '新しい認証機能を追加してください';
  writeState(input, {
    delivery: {
      status: 'draft-pr',
      request_hash: hash(prompt, 32),
      issue_number: 67,
      branch: 'codex/issue-67-old'
    }
  }, env);
  const next = lifecycle.initializeDelivery(input, prompt, { cwd: root, env });
  assert.strictEqual(next.status, 'pending');
  assert.strictEqual(next.issue_number, null);
});

test('an explicit continuation resumes the current Draft PR', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-delivery-continuation-'));
  fs.mkdirSync(path.join(root, '.ecc'), { recursive: true });
  fs.writeFileSync(path.join(root, '.ecc', 'config.json'), JSON.stringify({ deliveryWorkflow: 'required' }));
  const env = { ...process.env, ECC_KOUTE_STATE_DIR: path.join(root, 'state') };
  const input = { session_id: 'continue-pr', cwd: root };
  writeState(input, {
    delivery: {
      status: 'draft-pr',
      issue_number: 67,
      branch: 'codex/issue-67-old',
      revision: 2,
      review_cycle: { round: 3, limit_reached: true }
    },
    review_round: 3,
    review_limit_reached: true,
    review_followups: [{ fingerprint: 'old', title: '旧改善候補' }],
    review_followup_issue_url: 'https://example.invalid/issues/1'
  }, env);
  const resumed = lifecycle.initializeDelivery(input, 'このPRのレビュー指摘を修正してください', { cwd: root, env });
  assert.strictEqual(resumed.status, 'awaiting-branch');
  assert.strictEqual(resumed.issue_number, 67);
  assert.strictEqual(resumed.revision, 3);
  assert.strictEqual(resumed.review_cycle, null);
  const state = readState(input, env);
  assert.strictEqual(state.review_round, 0);
  assert.strictEqual(state.review_limit_reached, false);
  assert.deepStrictEqual(state.review_followups, []);
  assert.strictEqual(state.review_followup_issue_url, null);
});

test('common English Draft PR continuation prompts enter the recoverable resume state', () => {
  for (const [index, prompt] of ['continue', 'resume the current PR', 'Fix the review findings'].entries()) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `ecc-delivery-english-${index}-`));
    fs.mkdirSync(path.join(root, '.ecc'), { recursive: true });
    fs.writeFileSync(path.join(root, '.ecc', 'config.json'), JSON.stringify({ deliveryWorkflow: 'required' }));
    const env = { ...process.env, ECC_KOUTE_STATE_DIR: path.join(root, 'state') };
    const input = { session_id: `english-${index}`, cwd: root };
    writeState(input, {
      delivery: { status: 'draft-pr', issue_number: 67, branch: 'codex/issue-67-old' }
    }, env);
    const resumed = lifecycle.initializeDelivery(input, prompt, { cwd: root, env });
    assert.strictEqual(resumed.status, 'awaiting-branch', prompt);
  }
});

test('read-only Draft PR questions do not reopen implementation', () => {
  for (const [index, prompt] of ['review this PR', 'what is the current PR?'].entries()) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `ecc-delivery-question-${index}-`));
    fs.mkdirSync(path.join(root, '.ecc'), { recursive: true });
    fs.writeFileSync(path.join(root, '.ecc', 'config.json'), JSON.stringify({ deliveryWorkflow: 'required' }));
    const env = { ...process.env, ECC_KOUTE_STATE_DIR: path.join(root, 'state') };
    const input = { session_id: `question-${index}`, cwd: root };
    writeState(input, {
      delivery: { status: 'draft-pr', issue_number: 67, branch: 'codex/issue-67-old' }
    }, env);
    assert.strictEqual(lifecycle.initializeDelivery(input, prompt, { cwd: root, env }), null, prompt);
    assert.strictEqual(readState(input, env).delivery.status, 'draft-pr', prompt);
  }
});

test('Plan mode continuation keeps the resumed Draft PR deferred', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-delivery-plan-resume-'));
  fs.mkdirSync(path.join(root, '.ecc'), { recursive: true });
  fs.writeFileSync(path.join(root, '.ecc', 'config.json'), JSON.stringify({ deliveryWorkflow: 'required' }));
  const env = { ...process.env, ECC_KOUTE_STATE_DIR: path.join(root, 'state') };
  const input = { session_id: 'plan-resume', cwd: root };
  writeState(input, {
    delivery: { status: 'draft-pr', issue_number: 67, branch: 'codex/issue-67-old' }
  }, env);
  const resumed = lifecycle.initializeDelivery(input, 'continue', { cwd: root, env, deferred: true });
  assert.strictEqual(resumed.status, 'deferred');
});

test('approved deferred continuation reuses its recorded Issue and branch', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-delivery-deferred-identity-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  fs.mkdirSync(path.join(root, '.ecc'), { recursive: true });
  fs.writeFileSync(path.join(root, '.ecc', 'config.json'), JSON.stringify({ deliveryWorkflow: 'required' }));
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'fixture');
  const branch = 'codex/issue-67-deferred';
  git(root, 'switch', '-c', branch);
  const env = { ...process.env, ECC_KOUTE_STATE_DIR: `${root}-state` };
  const input = { session_id: 'deferred-identity', cwd: root };
  writeState(input, {
    delivery: {
      status: 'deferred',
      workflow_mode: 'required',
      delivery_worktree: 'advisory',
      issue_number: 67,
      issue_url: 'https://example.invalid/issues/67',
      branch,
      base_branch: 'main'
    }
  }, env);
  const prepared = lifecycle.prepareDelivery(input, { cwd: root, env });
  assert.strictEqual(prepared.status, 'ready');
  assert.strictEqual(prepared.issue_number, 67);
  assert.strictEqual(prepared.branch, branch);
});

test('persisted required modes stay active when the linked checkout lacks config', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-delivery-sticky-mode-'));
  const env = { ...process.env, ECC_KOUTE_STATE_DIR: path.join(root, 'state') };
  const input = { session_id: 'sticky-mode', cwd: root };
  writeState(input, {
    delivery: {
      status: 'pending',
      workflow_mode: 'required',
      delivery_worktree: 'required',
      request_hash: 'fixture'
    }
  }, env);
  const edit = JSON.stringify({ ...input, tool_name: 'Edit', tool_input: { file_path: path.join(root, 'x.js') } });
  const denied = JSON.parse(require('../../scripts/hooks/delivery-lifecycle-gate').run(edit, { cwd: root, env }));
  assert.strictEqual(denied.hookSpecificOutput.permissionDecision, 'deny');
});

test('required worktree blocks NotebookEdit and Edit targets outside the recorded checkout', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-delivery-edit-boundary-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(root, 'README.md'), 'fixture\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'fixture');
  const linked = path.join(root, '.claude', 'worktrees', 'issue-67-boundary');
  fs.mkdirSync(path.dirname(linked), { recursive: true });
  const branch = 'codex/issue-67-boundary';
  git(root, 'worktree', 'add', '-b', branch, linked, 'HEAD');
  const env = { ...process.env, ECC_KOUTE_STATE_DIR: `${root}-state` };
  const input = { session_id: 'edit-boundary', cwd: linked };
  writeState(input, {
    delivery: {
      status: 'ready',
      workflow_mode: 'required',
      delivery_worktree: 'required',
      branch,
      worktree: linked,
      git_common_dir: path.join(root, '.git')
    }
  }, env);

  const outside = JSON.parse(lifecycleGate.run(JSON.stringify({
    ...input,
    tool_name: 'Edit',
    tool_input: { file_path: path.join(root, 'README.md') }
  }), { cwd: linked, env }));
  assert.strictEqual(outside.hookSpecificOutput.permissionDecision, 'deny');

  const notebook = JSON.parse(lifecycleGate.run(JSON.stringify({
    ...input,
    tool_name: 'NotebookEdit',
    tool_input: { notebook_path: path.join(root, 'analysis.ipynb') }
  }), { cwd: linked, env }));
  assert.strictEqual(notebook.hookSpecificOutput.permissionDecision, 'deny');

  const inside = lifecycleGate.run(JSON.stringify({
    ...input,
    tool_name: 'Edit',
    tool_input: { file_path: path.join(linked, 'README.md') }
  }), { cwd: linked, env });
  assert.strictEqual(inside.hookSpecificOutput, undefined);

  for (const command of [
    `git -C "${root}" status`,
    `printf fixture > "${path.join(root, 'README.md')}"`,
    'cd .. && git status',
    'git --work-tree=.. status'
  ]) {
    const denied = JSON.parse(lifecycleGate.run(JSON.stringify({
      ...input,
      tool_name: 'Bash',
      tool_input: { command }
    }), { cwd: linked, env }));
    assert.strictEqual(denied.hookSpecificOutput.permissionDecision, 'deny', command);
  }
  const safeBash = lifecycleGate.run(JSON.stringify({
    ...input,
    tool_name: 'Bash',
    tool_input: { command: 'git status --short' }
  }), { cwd: linked, env });
  assert.strictEqual(safeBash.hookSpecificOutput, undefined);
});

test('preparation from an existing linked worktree persists its re-entry name', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-delivery-linked-ready-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  fs.mkdirSync(path.join(root, '.ecc'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.ecc', 'config.json'),
    JSON.stringify({ deliveryWorkflow: 'required', deliveryWorktree: 'required', deliveryBaseBranch: 'main' })
  );
  fs.writeFileSync(path.join(root, '.gitignore'), '.claude/worktrees/\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'fixture');
  const linked = path.join(root, '.claude', 'worktrees', 'issue-67-existing');
  fs.mkdirSync(path.dirname(linked), { recursive: true });
  const branch = 'codex/issue-67-existing';
  git(root, 'worktree', 'add', '-b', branch, linked, 'HEAD');
  const env = { ...process.env, ECC_KOUTE_STATE_DIR: `${root}-state` };
  const input = { session_id: 'linked-ready', cwd: linked };
  writeState(input, {
    delivery: {
      status: 'awaiting-worktree',
      request_hash: 'fixture',
      title: '既存Worktreeを再利用',
      base_branch: 'main',
      issue_number: 67,
      issue_url: 'https://example.invalid/issues/67',
      branch
    }
  }, env);
  const prepared = lifecycle.prepareDelivery(input, { cwd: linked, env });
  assert.strictEqual(prepared.status, 'ready');
  assert.strictEqual(prepared.worktree_name, 'issue-67-existing');
});

test('preparation reuses the official worktree that already owns the Issue branch', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-delivery-owned-worktree-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  fs.mkdirSync(path.join(root, '.ecc'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.ecc', 'config.json'),
    JSON.stringify({ deliveryWorkflow: 'required', deliveryWorktree: 'required', deliveryBaseBranch: 'main' })
  );
  fs.writeFileSync(path.join(root, '.gitignore'), '.claude/worktrees/\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'fixture');
  const linked = path.join(root, '.claude', 'worktrees', 'issue-67-owned');
  fs.mkdirSync(path.dirname(linked), { recursive: true });
  const branch = 'codex/issue-67-owned';
  git(root, 'worktree', 'add', '-b', branch, linked, 'HEAD');
  const env = { ...process.env, ECC_KOUTE_STATE_DIR: `${root}-state` };
  const input = { session_id: 'owned-worktree', cwd: root };
  writeState(input, {
    delivery: {
      status: 'awaiting-worktree',
      request_hash: 'fixture',
      title: '既存Worktreeを選択',
      base_branch: 'main',
      issue_number: 67,
      issue_url: 'https://example.invalid/issues/67',
      branch
    }
  }, env);
  const waiting = lifecycle.prepareDelivery(input, { cwd: root, env });
  assert.strictEqual(waiting.status, 'awaiting-worktree');
  assert.strictEqual(waiting.worktree_name, 'issue-67-owned');
  assert.strictEqual(waiting.worktree, path.resolve(linked));
  assert.strictEqual(waiting.branch, branch);
});

test('an unrelated linked worktree hands off to the official owner of the Issue branch', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-delivery-two-worktrees-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  fs.mkdirSync(path.join(root, '.ecc'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.ecc', 'config.json'),
    JSON.stringify({ deliveryWorkflow: 'required', deliveryWorktree: 'required', deliveryBaseBranch: 'main' })
  );
  fs.writeFileSync(path.join(root, '.gitignore'), '.claude/worktrees/\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'fixture');
  const worktreeA = path.join(root, '.claude', 'worktrees', 'other-delivery');
  const worktreeB = path.join(root, '.claude', 'worktrees', 'issue-67-owner');
  fs.mkdirSync(path.dirname(worktreeA), { recursive: true });
  git(root, 'worktree', 'add', '-b', 'codex/issue-1-other', worktreeA, 'HEAD');
  const issueBranch = 'codex/issue-67-owner';
  git(root, 'worktree', 'add', '-b', issueBranch, worktreeB, 'HEAD');
  const env = { ...process.env, ECC_KOUTE_STATE_DIR: `${root}-state` };
  const input = { session_id: 'two-worktrees', cwd: worktreeA };
  writeState(input, {
    delivery: {
      status: 'awaiting-worktree',
      request_hash: 'fixture',
      title: 'branch所有者へ移動',
      base_branch: 'main',
      issue_number: 67,
      issue_url: 'https://example.invalid/issues/67',
      branch: issueBranch,
      worktree_name: 'stale-name'
    }
  }, env);
  const waiting = lifecycle.prepareDelivery(input, { cwd: worktreeA, env });
  assert.strictEqual(waiting.status, 'awaiting-worktree');
  assert.strictEqual(waiting.worktree_name, 'issue-67-owner');
  assert.strictEqual(waiting.worktree, path.resolve(worktreeB));
});

test('required mode rejects manually created linked worktrees', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-delivery-manual-worktree-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  fs.mkdirSync(path.join(root, '.ecc'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.ecc', 'config.json'),
    JSON.stringify({ deliveryWorkflow: 'required', deliveryWorktree: 'required', deliveryBaseBranch: 'main' })
  );
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'fixture');
  const manual = `${root}-manual`;
  const branch = 'codex/issue-67-manual';
  git(root, 'worktree', 'add', '-b', branch, manual, 'HEAD');
  const env = { ...process.env, ECC_KOUTE_STATE_DIR: `${root}-state` };
  const input = { session_id: 'manual-worktree', cwd: manual };
  writeState(input, {
    delivery: {
      status: 'awaiting-worktree',
      request_hash: 'fixture',
      title: '手動Worktreeを拒否',
      base_branch: 'main',
      issue_number: 67,
      issue_url: 'https://example.invalid/issues/67',
      branch
    }
  }, env);
  assert.throws(
    () => lifecycle.prepareDelivery(input, { cwd: manual, env }),
    /non-Claude linked worktree/
  );
});

test('a ready Delivery may re-enter only its recorded official worktree', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-delivery-reenter-'));
  fs.mkdirSync(path.join(root, '.ecc'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.ecc', 'config.json'),
    JSON.stringify({ deliveryWorkflow: 'required', deliveryWorktree: 'required' })
  );
  const env = { ...process.env, ECC_KOUTE_STATE_DIR: path.join(root, 'state') };
  const input = { session_id: 'reenter', cwd: root };
  const recordedPath = path.join(root, '.claude', 'worktrees', 'issue-67-delivery');
  writeState(input, {
    delivery: {
      status: 'ready',
      issue_number: 67,
      worktree_name: 'issue-67-delivery',
      worktree: recordedPath
    }
  }, env);
  const allowed = JSON.stringify({
    ...input,
    tool_name: 'EnterWorktree',
    tool_input: { path: recordedPath }
  });
  assert.strictEqual(require('../../scripts/hooks/delivery-lifecycle-gate').run(allowed, { cwd: root, env }), allowed);
  const denied = JSON.stringify({
    ...input,
    tool_name: 'EnterWorktree',
    tool_input: { name: 'wrong-worktree' }
  });
  assert.match(
    JSON.parse(require('../../scripts/hooks/delivery-lifecycle-gate').run(denied, { cwd: root, env }))
      .hookSpecificOutput.permissionDecisionReason,
    /identity could not be verified|recorded for this Delivery/
  );
});

test('the installed lifecycle hook receives EnterWorktree calls', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'hooks', 'hooks.json'), 'utf8'));
  const registrations = hooks.hooks.PreToolUse || [];
  const lifecycleRegistration = registrations.find(entry =>
    Array.isArray(entry.hooks) && entry.hooks.some(hook => String(hook.command || '').includes('delivery-lifecycle-gate.js'))
  );
  assert.ok(lifecycleRegistration);
  assert.match(lifecycleRegistration.matcher, /(?:^|\|)EnterWorktree(?:\||$)/);
  assert.match(lifecycleRegistration.matcher, /(?:^|\|)ExitWorktree(?:\||$)/);
});

test('active required Delivery denies worktree removal and always permits explicit reset', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-delivery-exit-'));
  fs.mkdirSync(path.join(root, '.ecc'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.ecc', 'config.json'),
    JSON.stringify({ deliveryWorkflow: 'required', deliveryWorktree: 'required' })
  );
  const env = { ...process.env, ECC_KOUTE_STATE_DIR: path.join(root, 'state') };
  const input = { session_id: 'exit-worktree', cwd: root };
  writeState(input, {
    delivery: { status: 'ready', issue_number: 67, worktree: '/deleted/worktree', branch: 'codex/issue-67' }
  }, env);
  const removal = JSON.stringify({
    ...input,
    tool_name: 'ExitWorktree',
    tool_input: { action: 'remove' }
  });
  const denied = JSON.parse(require('../../scripts/hooks/delivery-lifecycle-gate').run(removal, { cwd: root, env }));
  assert.strictEqual(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /cannot be removed/);
  const reset = JSON.stringify({
    ...input,
    tool_name: 'Bash',
    tool_input: { command: 'node "/plugin/scripts/codex/reset.js" exit-worktree' }
  });
  assert.strictEqual(require('../../scripts/hooks/delivery-lifecycle-gate').run(reset, { cwd: root, env }), reset);
});

test('the issue branch is released from the main worktree before EnterWorktree', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-delivery-release-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  fs.mkdirSync(path.join(root, '.ecc'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.ecc', 'config.json'),
    JSON.stringify({ deliveryWorkflow: 'required', deliveryWorktree: 'required', deliveryBaseBranch: 'main' })
  );
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'fixture');
  const issueBranch = 'codex/issue-67-delivery';
  git(root, 'switch', '-c', issueBranch);
  const env = { ...process.env, ECC_KOUTE_STATE_DIR: `${root}-state` };
  const input = { session_id: 'release-branch', cwd: root };
  writeState(input, {
    delivery: {
      status: 'awaiting-worktree',
      request_hash: 'fixture',
      title: 'Deliveryを分離',
      base_branch: 'main',
      issue_number: 67,
      issue_url: 'https://example.invalid/issues/67',
      branch: issueBranch,
      worktree_name: 'issue-67-delivery'
    }
  }, env);
  const next = lifecycle.prepareDelivery(input, { cwd: root, env });
  assert.strictEqual(next.status, 'awaiting-branch');
  assert.strictEqual(next.branch, issueBranch);
  assert.strictEqual(next.branch_switch_purpose, 'release-for-worktree');
  assert.strictEqual(next.branch_switch.command, 'git switch main');
});

console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exit(failed ? 1 : 0);
