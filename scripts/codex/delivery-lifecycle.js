#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const { loadConfig } = require('./config');
const fs = require('fs');
const path = require('path');
const { hash, projectFingerprint, readJson, readState, recordIncident, resolveSessionId, stateRoot, writeState } = require('./runtime-state');

const DELIVERY_REQUEST = /(?:\b(?:implement|fix|change|add|remove|refactor|build|create|update)\b|実装|修正|変更|追加|削除|作成|更新|直して)/i;
const DELIVERY_COMPLETION_REQUEST = /(?:\b(?:complete|finish|finalize|deliver)\b|\bmerge\s+(?:it|the\s+pr|pr\s*#?\d+)\b|完遂|完了まで|仕上げて|マージまで)/i;
const NEGATED_DELIVERY_REQUEST = /(?:\b(?:do\s+not|don't|without)\s+(?:implement(?:ing)?|fix(?:ing)?|chang(?:e|ing)|add(?:ing)?|remov(?:e|ing)|refactor(?:ing)?|build(?:ing)?|creat(?:e|ing)|updat(?:e|ing))\b|(?:実装|修正|変更|追加|削除|作成|更新)(?:は)?(?:しないで|しない|しなくてよい|せず|不要)|直さない)/gi;
const DIAGNOSTIC_REQUEST = /(?:\b(?:investigate|review|analy[sz]e|diagnose|inspect|check)\b|調査|確認|レビュー|分析|診断|調べて|教えて)/i;
const EXPLICIT_MUTATION_REQUEST = /(?:\b(?:implement|fix|add|remove|refactor|build|create|update)\b|(?:実装|修正|変更|追加|削除|作成|更新|直)(?:を)?(?:して|する|してください|してほしい|したい|せよ))/i;
// draft-pr はreadyより先へ進んだ進行中Deliveryであり、Draft PR・Issue・branchの参照を
// 保持し続ける必要がある。ただし保持だけでは全Gateが素通りになるため、次の変更要求では
// resumeDeliveryAfterDraftPr()でreadyへ戻す。mergedだけは完了済みとして新規Deliveryを許す。
const ACTIVE_DELIVERY_STATUSES = new Set(['deferred', 'pending', 'ready', 'draft-pr']);
// 再開時に破棄する証拠。Issue・branch・PR参照だけを引き継ぎ、commit記録とreview証拠は
// 捨てて、branch一致・clean commit・fresh review・Completion Gateを最初から適用し直す。
const CLEARED_REVIEW_EVIDENCE = {
  review_role: null,
  review_status: null,
  review_complete: null,
  review_head: null,
  review_worktree_clean: false,
  review_blocking_findings: null,
  review_owner_actions: [],
  review_result: null,
  review_snapshot: null,
  review_request_hash: null
};

function isActiveDelivery(delivery) {
  return Boolean(delivery && ACTIVE_DELIVERY_STATUSES.has(delivery.status));
}

function isDeliveryRequest(prompt) {
  const value = String(prompt || '').trim();
  const actionable = value.replace(NEGATED_DELIVERY_REQUEST, '');
  if (value.length < 8 || /^\s*\/(?:help|clear|compact|status)\b/i.test(value)) return false;
  const completion = DELIVERY_COMPLETION_REQUEST.test(actionable);
  if (completion && (explicitIssueNumber(value) || explicitPrNumber(value) || !DIAGNOSTIC_REQUEST.test(actionable))) return true;
  if (DIAGNOSTIC_REQUEST.test(actionable) && !EXPLICIT_MUTATION_REQUEST.test(actionable)) return false;
  return DELIVERY_REQUEST.test(actionable) || completion;
}

function titleFromRequest(request, requestHash = '') {
  const fingerprint = requestHash || hash(String(request || ''), 32);
  return `ECC delivery ${fingerprint.slice(0, 10)}`;
}

function slug(value) {
  const ascii = String(value || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36);
  return ascii || 'task';
}

function explicitIssueNumber(request) {
  const match = String(request || '').match(/\bissue\s*#?\s*(\d+)\b/i);
  return match ? Number(match[1]) : null;
}

function explicitPrNumber(request) {
  const match = String(request || '').match(/\bpr\s*#?\s*(\d+)\b/i);
  return match ? Number(match[1]) : null;
}

function deliveryPrNumber(delivery) {
  const match = String(delivery && delivery.draft_pr_url || '').match(/\/pull\/(\d+)(?:\D|$)/);
  return match ? Number(match[1]) : (delivery && delivery.requested_pr_number) || null;
}

function referencesOtherDelivery(delivery, request) {
  const issueNumber = explicitIssueNumber(request);
  if (issueNumber && delivery.issue_number && issueNumber !== Number(delivery.issue_number)) return true;
  const prNumber = explicitPrNumber(request);
  const recordedPr = deliveryPrNumber(delivery);
  return Boolean(prNumber && recordedPr && prNumber !== recordedPr);
}

function resumeDeliveryAfterDraftPr(input, delivery, env) {
  const resumed = {
    ...delivery,
    status: 'ready',
    completed_at: null,
    committed_head: null,
    committed_at: null,
    completion_stage: null,
    incomplete_reported_at: null,
    resumed_at: new Date().toISOString()
  };
  writeState(input, { delivery: resumed, ...CLEARED_REVIEW_EVIDENCE }, env);
  return resumed;
}

function normalizeIssueTitle(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000()[\]{}「」『』【】]/g, '');
}

function deliveryBranch(issueNumber, title, currentBranch = '') {
  const issueBranch = new RegExp(`^codex/issue-${Number(issueNumber)}(?:-|$)`, 'i');
  return issueBranch.test(String(currentBranch || ''))
    ? currentBranch
    : `codex/issue-${Number(issueNumber)}-${slug(title)}`;
}

function selectDeliveryBranch(issueNumber, title, currentBranch = '', existingBranches = []) {
  const issueBranch = new RegExp(`^codex/issue-${Number(issueNumber)}(?:-|$)`, 'i');
  if (issueBranch.test(String(currentBranch || ''))) return currentBranch;
  const candidates = [...new Set(existingBranches.filter(branch => issueBranch.test(String(branch || ''))))];
  if (candidates.length > 1) {
    throw new Error(`Issue #${Number(issueNumber)} has multiple local branches (${candidates.join(', ')}); consolidate them before continuing.`);
  }
  return candidates[0] || deliveryBranch(issueNumber, title, currentBranch);
}

function initializeDelivery(input, request, options = {}) {
  const env = options.env || process.env;
  const cwd = options.cwd || input.cwd || process.cwd();
  const config = loadConfig(cwd, env);
  if (config.deliveryWorkflow !== 'required') return null;

  const current = readState(input, env);
  const requestHash = hash(request, 32);
  if (
    options.deferred &&
    current.delivery &&
    current.delivery.status === 'pending'
  ) {
    const deferred = { ...current.delivery, status: 'deferred' };
    writeState(input, { delivery: deferred, project: projectFingerprint(cwd) }, env);
    return deferred;
  }
  if (!isDeliveryRequest(request)) return null;
  const active = isActiveDelivery(current.delivery) ? current.delivery : null;
  let superseded = null;
  if (active && active.status === 'draft-pr') {
    // Plan mode中はIssue・branch・状態遷移を起こさない。承認後の編集もDelivery Gateが
    // draft-prのままfail-closeするため、ここを素通りさせても迂回にはならない。
    if (options.deferred) return active;
    // Draft PR到達後の追加要求は、同じIssue/PRを指す限り同じDeliveryの続きである。
    // 参照を保ったままreadyへ戻し、branch一致、clean commit、fresh review、
    // Completion Gateを再適用する。draft-prのまま継続すると全Gateが素通りになる。
    if (!referencesOtherDelivery(active, request)) return resumeDeliveryAfterDraftPr(input, active, env);
    // 別のIssue/PRを名指しする要求だけは新しいDeliveryを開始する。旧Deliveryの
    // Issue・branch・Draft PR参照はstateに退避し、記録から消さない。
    superseded = active;
  } else {
    // Claude Code の継続turnでは、ユーザーの追記文面が変わっても同じDeliveryである。
    // 進行中Deliveryを本文ハッシュだけで上書きすると、Context Builder、Issue、branchが
    // 二重に作られるため、マージ完了または明示的な新規Session/resetまでは既存Deliveryを維持する。
    // 逆に完了済み(merged)のDeliveryは、同じ文面を再送されても再利用しない。再利用すると
    // 全Gateがmerged扱いのまま素通りし、Issueもbranchも無い状態で次の変更が進んでしまう。
    if (active) return active;
  }

  const delivery = {
    // Plan modeではIssueやbranchをまだ変更しない一方、承認後の同じturnで
    // 実装へ移っても必須Deliveryを迂回できないよう意図だけを先に記録する。
    status: options.deferred ? 'deferred' : 'pending',
    request_hash: requestHash,
    title: titleFromRequest(request, requestHash),
    requested_issue_number: explicitIssueNumber(request),
    requested_pr_number: explicitPrNumber(request),
    base_branch: config.deliveryBaseBranch,
    issue_number: null,
    issue_url: null,
    branch: null,
    draft_pr_url: null
  };
  // 新しいDeliveryが前のDeliveryのreview証拠を引き継ぐと、1度もcommitしていない状態で
  // Completion Gateを満たし得るため、置き換え時は常に証拠を初期化する。
  const patch = { delivery, project: projectFingerprint(cwd), ...CLEARED_REVIEW_EVIDENCE };
  // 別のIssue/PRのために脇へ退けた進行中Deliveryだけは、参照を消さずstateへ残す。
  if (superseded) patch.previous_delivery = superseded;
  writeState(input, patch, env);
  return delivery;
}

function pendingSessionForProject(cwd, env = process.env) {
  const sessionsDir = path.join(stateRoot(env), 'sessions');
  const project = projectFingerprint(cwd);
  let candidates = [];
  try {
    candidates = fs.readdirSync(sessionsDir)
      .filter(file => file.endsWith('.json'))
      .map(file => readJson(path.join(sessionsDir, file)))
      .filter(state => state && state.project === project && state.delivery &&
        ['deferred', 'pending'].includes(state.delivery.status))
      .sort((left, right) => String(right.updated_at || '').localeCompare(String(left.updated_at || '')));
  } catch {
    return '';
  }
  return candidates.length === 1 ? resolveSessionId(candidates[0], env) : '';
}

function runCommand(binary, args, options = {}) {
  const attempts = binary === 'gh' ? 3 : 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = spawnSync(binary, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      encoding: 'utf8',
      timeout: options.timeout || 30000,
      windowsHide: true
    });
    if (!result.error && result.status === 0) return String(result.stdout || '').trim();
    const detail = result.error ? result.error.message : String(result.stderr || result.stdout || '').trim();
    const transient = /(?:HTTP 5\d\d|timed?\s*out|timeout|ECONNRESET|ENOTFOUND|temporar(?:y|ily)|server is currently unavailable)/i.test(detail);
    if (binary !== 'gh' || !transient || attempt === attempts) {
      throw new Error(`${binary} ${args[0] || ''} failed: ${detail || `exit ${result.status}`}`);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 500);
  }
  throw new Error(`${binary} ${args[0] || ''} failed after bounded retries`);
}

function parseIssueNumber(url) {
  const match = String(url || '').match(/\/issues\/(\d+)(?:\D|$)/);
  if (!match) throw new Error('GitHub did not return an issue URL');
  return Number(match[1]);
}

function findDuplicateIssue(delivery, options = {}) {
  const execute = options.runCommand || runCommand;
  if (delivery.requested_issue_number) {
    const raw = execute(
      'gh',
      ['issue', 'view', String(delivery.requested_issue_number), '--json', 'number,title,url,state'],
      options
    );
    const referenced = JSON.parse(raw || '{}');
    if (String(referenced.state || '').toUpperCase() !== 'OPEN' && !options.allowClosedReferencedIssue) {
      throw new Error(`Explicitly referenced Issue #${delivery.requested_issue_number} is not open; refusing to create a duplicate.`);
    }
    return referenced;
  }

  const raw = execute('gh', ['issue', 'list', '--state', 'open', '--limit', '100', '--json', 'number,title,url,body'], options);
  const issues = JSON.parse(raw || '[]');
  const needle = normalizeIssueTitle(delivery.title);
  return issues.find(issue => {
    const title = normalizeIssueTitle(issue.title);
    const body = String(issue.body || '');
    const sameFingerprint = body.includes(`Request fingerprint: \`${delivery.request_hash}\``);
    const strongTitleOverlap = title.length >= 24 && needle.length >= 24 && (title.includes(needle) || needle.includes(title));
    return sameFingerprint || title === needle || strongTitleOverlap;
  }) || null;
}

function findExistingDeliveryPr(delivery, currentBranch, options = {}) {
  if (!currentBranch || !delivery.requested_issue_number) return null;
  const execute = options.runCommand || runCommand;
  const raw = execute(
    'gh',
    ['pr', 'list', '--head', currentBranch, '--state', 'open', '--json', 'number,url,headRefName,baseRefName,body'],
    options
  );
  const issueLink = new RegExp(`(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${delivery.requested_issue_number}\\b`, 'i');
  const candidates = JSON.parse(raw || '[]').filter(pr =>
    pr.headRefName === currentBranch &&
    issueLink.test(String(pr.body || '')) &&
    (!delivery.requested_pr_number || Number(pr.number) === delivery.requested_pr_number)
  );
  if (candidates.length > 1) {
    throw new Error(`Issue #${delivery.requested_issue_number} has multiple open PRs on ${currentBranch}; keep exactly one before continuing.`);
  }
  return candidates[0] || null;
}

function prepareDelivery(input = {}, options = {}) {
  const env = options.env || process.env;
  const cwd = options.cwd || input.cwd || process.cwd();
  const state = readState(input, env);
  const delivery = state.delivery;
  if (!delivery || !['deferred', 'pending'].includes(delivery.status)) {
    throw new Error('No pending required delivery task. Submit the implementation request first.');
  }

  try {
    const dirty = runCommand('git', ['status', '--porcelain'], { cwd, env });
    if (dirty) throw new Error('Delivery preparation requires a clean working tree; preserve or commit existing changes first.');

    const currentBranch = runCommand('git', ['branch', '--show-current'], { cwd, env });
    const existingPr = findExistingDeliveryPr(delivery, currentBranch, { cwd, env });
    let issue = findDuplicateIssue(delivery, {
      cwd,
      env,
      allowClosedReferencedIssue: Boolean(existingPr)
    });
    if (!issue) {
      const body = [
        'ECC deterministic delivery workflow がユーザー要求から自動作成しました。',
        '',
        `Request fingerprint: \`${delivery.request_hash}\``,
        '',
        'このIssueに紐づくDraft PRが作成されるまで自動クローズしません。'
      ].join('\n');
      const url = runCommand('gh', ['issue', 'create', '--title', delivery.title, '--body', body], { cwd, env });
      issue = { number: parseIssueNumber(url), title: delivery.title, url };
    }

    const existingIssueBranches = runCommand(
      'git',
      ['branch', '--list', `codex/issue-${issue.number}-*`, '--format=%(refname:short)'],
      { cwd, env }
    ).split(/\r?\n/).filter(Boolean);
    // 再開時にタイトルやslugが変わっても、同じIssueの現在branchを優先する。
    // これにより同一Issueへ複数branchを作ることを防ぐ。
    const branch = existingPr
      ? currentBranch
      : selectDeliveryBranch(issue.number, delivery.title, currentBranch, existingIssueBranches);
    if (currentBranch !== branch) {
      const existing = runCommand('git', ['branch', '--list', branch], { cwd, env });
      if (existing) {
        runCommand('git', ['switch', branch], { cwd, env });
      } else {
        runCommand('git', ['rev-parse', '--verify', delivery.base_branch], { cwd, env });
        runCommand('git', ['switch', '-c', branch, delivery.base_branch], { cwd, env });
      }
    }

    const next = {
      ...delivery,
      status: 'ready',
      issue_number: Number(issue.number),
      issue_url: issue.url,
      branch,
      draft_pr_url: existingPr ? existingPr.url : delivery.draft_pr_url,
      prepared_at: new Date().toISOString()
    };
    writeState(input, { delivery: next }, env);
    return next;
  } catch (error) {
    recordIncident(
      { type: 'delivery_prepare_failure', severity: 'critical', message: error.message, hook_id: 'delivery-lifecycle' },
      { cwd, env }
    );
    throw error;
  }
}

function main() {
  const command = process.argv[2];
  const sessionIndex = process.argv.indexOf('--session');
  const explicitSession = sessionIndex >= 0 ? process.argv[sessionIndex + 1] : process.env.CLAUDE_SESSION_ID;
  const sessionId = explicitSession || pendingSessionForProject(process.cwd(), process.env);
  if (command !== 'prepare') throw new Error('usage: delivery-lifecycle.js prepare --session <id>');
  if (!sessionId) throw new Error('No unique pending delivery session for this project; retry the exact session-bound command from the Delivery Gate.');
  process.stdout.write(`${JSON.stringify(prepareDelivery({ session_id: sessionId, cwd: process.cwd() }), null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[ECC Delivery] ${error.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  explicitIssueNumber,
  explicitPrNumber,
  deliveryBranch,
  deliveryPrNumber,
  referencesOtherDelivery,
  resumeDeliveryAfterDraftPr,
  findDuplicateIssue,
  findExistingDeliveryPr,
  initializeDelivery,
  isActiveDelivery,
  isDeliveryRequest,
  normalizeIssueTitle,
  parseIssueNumber,
  pendingSessionForProject,
  prepareDelivery,
  runCommand,
  selectDeliveryBranch,
  slug,
  titleFromRequest
};
