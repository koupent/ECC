#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const { loadConfig } = require('../codex/config');
const { readState, recordIncident, resolveSessionId, writeState } = require('../codex/runtime-state');

function isTransientGitHubFailure(message) {
  return /(?:HTTP 5\d\d|timed?\s*out|timeout|ECONNRESET|ENOTFOUND|temporar(?:y|ily)|server is currently unavailable)/i.test(String(message || ''));
}

function command(binary, args, cwd, env) {
  const attempts = binary === 'gh' ? 3 : 1;
  let response = { ok: false, stdout: '', stderr: '' };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = spawnSync(binary, args, { cwd, env, encoding: 'utf8', timeout: 10000, windowsHide: true });
    response = {
      ok: !result.error && result.status === 0,
      stdout: String(result.stdout || '').trim(),
      stderr: String(result.stderr || result.error && result.error.message || '').trim()
    };
    if (response.ok || !isTransientGitHubFailure(response.stderr) || attempt === attempts) return response;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 500);
  }
  return response;
}

function block(reason) {
  return JSON.stringify({ decision: 'block', reason: `[ECC Delivery Completion Gate] ${reason}` });
}

function parseJson(response, description) {
  try {
    return JSON.parse(response.stdout || 'null');
  } catch (error) {
    throw new Error(`${description} returned invalid JSON: ${error.message}`);
  }
}

function verifyCommitStatus(execute, config, head, cwd, env) {
  const repository = execute('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], cwd, env);
  if (!repository.ok || !repository.stdout) {
    return { ok: false, reason: `GitHub repository could not be resolved: ${repository.stderr || 'empty repository'}` };
  }
  const response = execute('gh', ['api', `repos/${repository.stdout}/commits/${head}/status`], cwd, env);
  if (!response.ok) {
    return { ok: false, reason: `commit status could not be read: ${response.stderr || 'gh api failed'}` };
  }
  let payload;
  try {
    payload = parseJson(response, 'commit status');
  } catch (error) {
    return { ok: false, reason: error.message };
  }
  if (payload.sha !== head) {
    return { ok: false, reason: `Local Merge Gate status is not bound to current HEAD ${head}.` };
  }
  const status = Array.isArray(payload.statuses)
    ? payload.statuses.find(entry => entry && entry.context === config.mergeGate.statusContext)
    : null;
  if (!status || status.state !== 'success') {
    return {
      ok: false,
      reason: `${config.mergeGate.statusContext} is ${status && status.state || 'missing'} for current HEAD ${head}. Run ${config.mergeGate.command} and retry.`
    };
  }
  return { ok: true, status };
}

// Draft PR到達後のDeliveryは、Delivery Gateが変更を止めている限り worktree も HEAD も動かない。
// それでも動いていれば、記録の外で差分が積み上がったということなので fail-close する。
function draftPrDrift(execute, delivery, cwd, env) {
  const status = execute('git', ['status', '--porcelain'], cwd, env);
  if (!status.ok) return `The worktree could not be inspected: ${status.stderr || 'git status failed'}.`;
  if (status.stdout) return 'The worktree has uncommitted changes made after the Draft PR.';
  const recorded = delivery.draft_pr_head || delivery.committed_head || '';
  if (!recorded) return '';
  const head = execute('git', ['rev-parse', 'HEAD'], cwd, env);
  if (!head.ok) return `The current commit could not be inspected: ${head.stderr || 'git rev-parse failed'}.`;
  if (head.stdout !== recorded) return `HEAD moved from the reviewed Draft PR commit ${recorded} to ${head.stdout || '<unknown>'}.`;
  return '';
}

function completeBySquashMerge(execute, config, delivery, pr, head, cwd, env) {
  if (config.mergeGate.provider !== 'commit-status' || config.mergeGate.strategy !== 'squash') {
    return { ok: false, reason: 'squash-merge completion requires mergeGate provider=commit-status and strategy=squash.' };
  }
  if (pr.headRefOid !== head) {
    return { ok: false, reason: `PR #${pr.number} is not bound to current HEAD ${head}. Push the current commit before merging.` };
  }
  const gate = verifyCommitStatus(execute, config, head, cwd, env);
  if (!gate.ok) return gate;

  if (pr.state === 'MERGED') return { ok: true, pr, status: gate.status };

  if (pr.isDraft) {
    const ready = execute('gh', ['pr', 'ready', String(pr.number)], cwd, env);
    if (!ready.ok) return { ok: false, reason: `PR #${pr.number} could not be marked ready: ${ready.stderr || 'gh pr ready failed'}` };
  }
  const merge = execute('gh', ['pr', 'merge', String(pr.number), '--squash'], cwd, env);
  if (!merge.ok) return { ok: false, reason: `PR #${pr.number} could not be squash merged: ${merge.stderr || 'gh pr merge failed'}` };

  const view = execute('gh', ['pr', 'view', String(pr.number), '--json', 'state,isDraft,headRefOid,url'], cwd, env);
  if (!view.ok) return { ok: false, reason: `Merged PR could not be confirmed: ${view.stderr || 'gh pr view failed'}` };
  let merged;
  try {
    merged = parseJson(view, 'merged PR');
  } catch (error) {
    return { ok: false, reason: error.message };
  }
  if (merged.state !== 'MERGED' || merged.headRefOid !== head) {
    return { ok: false, reason: `GitHub did not confirm PR #${pr.number} as merged for current HEAD ${head}.` };
  }
  return { ok: true, pr: merged, status: gate.status };
}

function run(rawInput, options = {}) {
  let input;
  try {
    input = typeof rawInput === 'string' ? JSON.parse(rawInput) : rawInput;
  } catch {
    return rawInput;
  }
  const env = options.env || process.env;
  const cwd = options.cwd || input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const config = loadConfig(cwd, env);
  if (config.deliveryWorkflow !== 'required') return rawInput;

  const state = readState(input, env);
  const delivery = state.delivery;
  if (!delivery) return rawInput;
  if (delivery.status === 'deferred') {
    const permissionMode = String(input.permission_mode || input.permissionMode || '').toLowerCase();
    if (permissionMode === 'plan') return rawInput;
    return block('The approved plan has not entered the required delivery workflow. Run `/ecc:delivery-prepare` before implementation so Issue deduplication and the issue-linked branch are recorded.');
  }
  if (delivery.status === 'pending') {
    return block('The required delivery has not been prepared. Run `/ecc:delivery-prepare` so Issue deduplication and the issue-linked branch are recorded before continuing.');
  }
  const execute = options.command || command;

  if (delivery.status === 'draft-pr') {
    const drift = draftPrDrift(execute, delivery, cwd, env);
    if (!drift) return rawInput;
    return block(
      `${drift} The delivery for Issue #${delivery.issue_number || '<unknown>'} is recorded as finished at its Draft PR ` +
        `(${delivery.draft_pr_url || 'recorded in ECC state'}), so this change has no commit record and no fresh review. ` +
        `Ask for the follow-up change explicitly so the delivery resumes on ${delivery.branch || 'the recorded branch'} and every gate applies again, ` +
        `or reset it with node "${path.resolve(__dirname, '../codex/reset.js')}" "${resolveSessionId(input, env)}".`
    );
  }
  if (delivery.status !== 'ready') return rawInput;

  const status = execute('git', ['status', '--porcelain'], cwd, env);
  if (!status.ok) return block(`Could not inspect the worktree: ${status.stderr || 'git status failed'}`);
  if (status.stdout) {
    return block('The worktree still has uncommitted changes. Complete the ECC checks, commit the reviewed implementation on the issue-linked branch, push it, and create a Draft PR linked to the recorded Issue.');
  }

  const branch = execute('git', ['branch', '--show-current'], cwd, env).stdout;
  if (branch !== delivery.branch) {
    return block(`Current branch ${branch || '<none>'} does not match recorded branch ${delivery.branch}.`);
  }

  const head = execute('git', ['rev-parse', 'HEAD'], cwd, env);
  if (!head.ok) return block(`Could not inspect the current commit: ${head.stderr || 'git rev-parse failed'}`);
  if (
    !['review', 'security-review'].includes(state.review_role) ||
    state.review_status !== 'ok' ||
    state.review_complete !== true ||
    !Number.isInteger(state.review_blocking_findings) ||
    state.review_blocking_findings !== 0 ||
    state.review_worktree_clean !== true ||
    state.review_head !== head.stdout
  ) {
    return block('A fresh independent Codex review is not bound to the current clean commit. Commit the validated implementation, run `/ecc:code-review` on that commit, address release-blocking findings, and then continue.');
  }

  const prs = execute('gh', [
    'pr', 'list', '--head', branch,
    '--state', config.deliveryCompletion === 'squash-merge' ? 'all' : 'open',
    '--json', 'url,isDraft,number,body,baseRefName,headRefOid,state'
  ], cwd, env);
  if (!prs.ok) {
    recordIncident({ type: 'delivery_pr_lookup_failure', severity: 'minor', message: prs.stderr || 'gh pr list failed' }, { cwd, env });
    return block('Draft PR status could not be verified. Confirm GitHub authentication, push the branch, and create a Draft PR; do not bypass this gate.');
  }
  let entries;
  try {
    entries = JSON.parse(prs.stdout || '[]');
  } catch (error) {
    recordIncident({ type: 'delivery_pr_schema_failure', severity: 'minor', message: error.message }, { cwd, env });
    return block('Draft PR status returned invalid data. Keep the gate enabled, repair GitHub CLI connectivity, and retry.');
  }
  const matchingHead = entries.filter(pr =>
    pr.headRefOid === head.stdout &&
    (config.deliveryCompletion !== 'squash-merge' || ['OPEN', 'MERGED'].includes(pr.state || 'OPEN'))
  );
  const candidate = config.deliveryCompletion === 'squash-merge'
    ? matchingHead.length === 1 && matchingHead[0]
    : matchingHead.find(pr => pr.isDraft === true);
  if (!candidate) {
    const detail = config.deliveryCompletion === 'squash-merge' && matchingHead.length > 1
      ? `Multiple open PRs exist for ${branch}; keep exactly one.`
      : `No open Draft PR exists for ${branch}. Push the branch and create one with \`gh pr create --draft --base ${delivery.base_branch}\`, linking Issue #${delivery.issue_number}.`;
    return block(detail);
  }
  if (candidate.baseRefName !== delivery.base_branch) {
    return block(`Draft PR #${candidate.number} targets ${candidate.baseRefName || '<unknown>'}, but this delivery is based on ${delivery.base_branch}. Recreate or retarget the Draft PR without bypassing the gate.`);
  }
  const issueLink = new RegExp(`(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${delivery.issue_number}\\b`, 'i');
  if (!issueLink.test(String(candidate.body || ''))) {
    return block(`Draft PR #${candidate.number} is not linked to Issue #${delivery.issue_number}. Add \`Closes #${delivery.issue_number}\` to the PR body.`);
  }

  if (config.deliveryCompletion === 'squash-merge') {
    const completion = completeBySquashMerge(execute, config, delivery, candidate, head.stdout, cwd, env);
    if (!completion.ok) {
      recordIncident(
        { type: 'delivery_squash_merge_blocked', severity: 'minor', message: completion.reason, hook_id: 'delivery-completion' },
        { cwd, env }
      );
      return block(completion.reason);
    }
    writeState(input, {
      delivery: {
        ...delivery,
        status: 'merged',
        draft_pr_url: candidate.url,
        merged_pr_url: completion.pr.url || candidate.url,
        merged_head: head.stdout,
        completed_at: new Date().toISOString()
      }
    }, env);
    return rawInput;
  }

  writeState(input, {
    delivery: {
      ...delivery,
      status: 'draft-pr',
      draft_pr_url: candidate.url,
      // 以後のStop Gateは、このcommitからHEADが動いていないことを確認する。
      draft_pr_head: head.stdout,
      completed_at: new Date().toISOString()
    }
  }, env);
  return rawInput;
}

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { raw += chunk; });
  process.stdin.on('end', () => process.stdout.write(run(raw)));
}

module.exports = { block, command, completeBySquashMerge, draftPrDrift, isTransientGitHubFailure, parseJson, run, verifyCommitStatus };
