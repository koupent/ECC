#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadConfig } = require('./config');
const { projectFingerprintCandidates, projectStateMatches, readJson, stateRoot } = require('./runtime-state');

function command(binary, args, cwd, env) {
  const result = spawnSync(binary, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true
  });
  return {
    ok: !result.error && result.status === 0,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || result.error && result.error.message || '').trim()
  };
}

function latestState(cwd, issueNumber, env) {
  const sessionsDir = path.join(stateRoot(env), 'sessions');
  const projectCandidates = projectFingerprintCandidates(cwd);
  let entries = [];
  try {
    entries = fs.readdirSync(sessionsDir)
      .filter(file => file.endsWith('.json'))
      .map(file => ({ file: path.join(sessionsDir, file), state: readJson(path.join(sessionsDir, file)) }))
      .filter(entry => entry.state && projectStateMatches(entry.state, cwd, projectCandidates) && entry.state.delivery)
      .filter(entry => !issueNumber ||
        entry.state.delivery.requested_issue_number === issueNumber ||
        entry.state.delivery.issue_number === issueNumber)
      .sort((left, right) => String(right.state.updated_at || '').localeCompare(String(left.state.updated_at || '')));
  } catch {
    return null;
  }
  return entries[0] || null;
}

function check(id, pass, expected, actual, detail) {
  return { id, pass: Boolean(pass), expected, actual, detail: detail || undefined };
}

function audit(options = {}, dependencies = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const env = options.env || process.env;
  const issueNumber = Number(options.issueNumber || 0) || null;
  const execute = dependencies.command || command;
  const entry = dependencies.entry || latestState(cwd, issueNumber, env);
  if (!entry) {
    return {
      status: 'FAIL',
      issue_number: issueNumber,
      checks: [check('external-state', false, 'matching ECC session state', null)]
    };
  }

  const state = entry.state;
  const delivery = state.delivery || {};
  const projectConfig = loadConfig(cwd, env);
  const completionMethod = delivery.completion_method || projectConfig.deliveryCompletion;
  const squashExpected = completionMethod === 'squash-merge';
  const squashMerged = delivery.status === 'merged';
  const gitStatus = execute('git', ['status', '--porcelain'], cwd, env);
  const branch = execute('git', ['branch', '--show-current'], cwd, env);
  const head = execute('git', ['rev-parse', 'HEAD'], cwd, env);
  const issue = delivery.issue_number
    ? execute('gh', ['issue', 'view', String(delivery.issue_number), '--json', 'number,state,url'], cwd, env)
    : { ok: false, stdout: '', stderr: 'delivery issue is missing' };
  const prs = delivery.branch
    ? execute('gh', ['pr', 'list', '--head', delivery.branch, '--state', squashMerged ? 'all' : 'open', '--json', 'url,isDraft,number,body,baseRefName,state,headRefOid'], cwd, env)
    : { ok: false, stdout: '', stderr: 'delivery branch is missing' };

  let issueData = null;
  let prData = [];
  try { issueData = issue.ok ? JSON.parse(issue.stdout) : null; } catch { issueData = null; }
  try { prData = prs.ok ? JSON.parse(prs.stdout || '[]') : []; } catch { prData = []; }
  const draft = prData.find(pr => pr.isDraft === true && pr.url === delivery.draft_pr_url);
  const merged = prData.find(pr => pr.state === 'MERGED' && pr.url === delivery.merged_pr_url);
  const issueLink = delivery.issue_number
    ? new RegExp(`(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${delivery.issue_number}\\b`, 'i')
    : null;

  const checks = [
    check('context-builder', state.context_status === 'ready', 'ready', state.context_status),
    check('explicit-issue-reused', !issueNumber ||
      (delivery.requested_issue_number === issueNumber && delivery.issue_number === issueNumber),
      issueNumber ? `requested=${issueNumber}, selected=${issueNumber}` : 'selected issue',
      `requested=${delivery.requested_issue_number}, selected=${delivery.issue_number}`),
    check('delivery-stop-gate', (squashExpected ? delivery.status === 'merged' : ['draft-pr', 'merged'].includes(delivery.status)) && Boolean(delivery.completed_at),
      squashExpected ? 'merged with completed_at' : 'draft-pr or merged with completed_at', delivery.status),
    check('delivery-completion-contract', Boolean(delivery.completion_method) || projectConfig.projectConfigStatus === 'ok',
      'recorded completion method or readable project config',
      delivery.completion_method || projectConfig.projectConfigStatus),
    check('delivery-pr-url', squashMerged ? Boolean(delivery.merged_pr_url) : Boolean(delivery.draft_pr_url),
      squashMerged ? 'non-empty merged PR URL' : 'non-empty Draft PR URL',
      squashMerged ? delivery.merged_pr_url : delivery.draft_pr_url),
    check('worktree-clean', gitStatus.ok && !gitStatus.stdout, 'clean', gitStatus.ok ? gitStatus.stdout || 'clean' : gitStatus.stderr),
    check('issue-branch', branch.ok && branch.stdout === delivery.branch, delivery.branch, branch.ok ? branch.stdout : branch.stderr),
    check('commit-bound-review', head.ok && state.review_status === 'ok' &&
      ['review', 'security-review'].includes(state.review_role) &&
      state.review_complete === true &&
      Number.isInteger(state.review_blocking_findings) && state.review_blocking_findings === 0 &&
      state.review_worktree_clean === true && state.review_head === head.stdout,
      'fresh independent review with zero release blockers bound to clean HEAD',
      `role=${state.review_role}, status=${state.review_status}, complete=${state.review_complete}, blockers=${state.review_blocking_findings}, clean=${state.review_worktree_clean}, head=${state.review_head}`),
    check('codex-delegation', Number(state.codex_calls || 0) >= 2 && Number(state.codex_failures || 0) === 0,
      'at least 2 successful calls and 0 failures',
      `calls=${state.codex_calls || 0}, failures=${state.codex_failures || 0}`),
    check('waste-loops', Number(state.waste_loops || 0) === 0, '0', state.waste_loops || 0),
    check('github-issue', issue.ok && issueData && issueData.number === delivery.issue_number &&
      (squashMerged ? issueData.state === 'CLOSED' : issueData.state === 'OPEN'),
      `${squashMerged ? 'closed' : 'open'} Issue #${delivery.issue_number}`, issue.ok ? JSON.stringify(issueData) : issue.stderr),
    check('github-delivery-pr', squashMerged
      ? Boolean(merged) && merged.baseRefName === delivery.base_branch && merged.headRefOid === delivery.merged_head && issueLink.test(String(merged.body || ''))
      : Boolean(draft) && draft.baseRefName === delivery.base_branch &&
        draft.headRefOid === head.stdout && issueLink.test(String(draft.body || '')),
      squashMerged
        ? `Merged PR targeting ${delivery.base_branch} with Closes #${delivery.issue_number}`
        : `Draft PR targeting ${delivery.base_branch} with Closes #${delivery.issue_number}`,
      squashMerged
        ? merged ? `PR #${merged.number}, base=${merged.baseRefName}` : prs.stderr || 'matching merged PR not found'
        : draft ? `PR #${draft.number}, base=${draft.baseRefName}` : prs.stderr || 'matching Draft PR not found')
  ];

  return {
    status: checks.every(item => item.pass) ? 'PASS' : 'FAIL',
    issue_number: delivery.issue_number,
    session_id: state.session_id,
    state_file: entry.file,
    branch: delivery.branch,
    head: head.ok ? head.stdout : null,
    draft_pr_url: delivery.draft_pr_url,
    metrics: {
      codex_calls: state.codex_calls || 0,
      codex_failures: state.codex_failures || 0,
      waste_loops: state.waste_loops || 0
    },
    checks
  };
}

function parseArgs(argv) {
  const issueIndex = argv.indexOf('--issue');
  return { issueNumber: issueIndex >= 0 ? Number(argv[issueIndex + 1]) : null };
}

if (require.main === module) {
  const report = audit(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.status === 'PASS' ? 0 : 1;
}

module.exports = { audit, command, latestState, parseArgs };
