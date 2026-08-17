#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const { loadConfig } = require('../codex/config');
const { readState, recordIncident, writeState } = require('../codex/runtime-state');

function command(binary, args, cwd, env) {
  const result = spawnSync(binary, args, { cwd, env, encoding: 'utf8', timeout: 10000, windowsHide: true });
  return {
    ok: !result.error && result.status === 0,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim()
  };
}

function block(reason) {
  return JSON.stringify({ decision: 'block', reason: `[ECC Delivery Completion Gate] ${reason}` });
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
  if (delivery.status === 'pending') {
    return block('The required delivery has not been prepared. Run `/ecc:delivery-prepare` so Issue deduplication and the issue-linked branch are recorded before continuing.');
  }
  if (delivery.status !== 'ready') return rawInput;

  const execute = options.command || command;

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
    state.review_worktree_clean !== true ||
    state.review_head !== head.stdout
  ) {
    return block('A fresh independent Codex review is not bound to the current clean commit. Commit the validated implementation, run `/ecc:code-review` on that commit, address release-blocking findings, and then continue.');
  }

  const prs = execute('gh', ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'url,isDraft,number,body'], cwd, env);
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
  const draft = entries.find(pr => pr.isDraft === true);
  if (!draft) {
    return block(`No open Draft PR exists for ${branch}. Push the branch and create one with \`gh pr create --draft\`, linking Issue #${delivery.issue_number}. Do not Ready or merge it.`);
  }
  const issueLink = new RegExp(`(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${delivery.issue_number}\\b`, 'i');
  if (!issueLink.test(String(draft.body || ''))) {
    return block(`Draft PR #${draft.number} is not linked to Issue #${delivery.issue_number}. Add \`Closes #${delivery.issue_number}\` to the PR body.`);
  }

  writeState(input, { delivery: { ...delivery, status: 'draft-pr', draft_pr_url: draft.url, completed_at: new Date().toISOString() } }, env);
  return rawInput;
}

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { raw += chunk; });
  process.stdin.on('end', () => process.stdout.write(run(raw)));
}

module.exports = { block, command, run };
