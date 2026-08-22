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

// Issue / PR の指定は `Issue #300` のような短い表記だけでなく、GitHubのcanonical URL
// （`https://<host>/<owner>/<repo>/issues|pull/<n>`）や `Pull Request #300` でも届く。
// どれか一つでも取りこぼすと、別Deliveryへの要求を進行中Deliveryの続きとして扱ってしまう。
// URL表記ではhost・owner・repoも保持する。番号だけを見ると、別リポジトリの同番号URL
// （`other/project/pull/274`）を進行中DeliveryのPR #274と同一視し、このcloneの
// 無関係なIssueやbranchへ配送してしまう。
// URLは境界付きで丸ごと切り出し、authorityとpathをURLパーサーで解釈する。scheme無しの
// 部分文字列を拾うと、`https://evil.example/github.com/koupent/ECC/pull/300` の途中にある
// `github.com/koupent/ECC/pull/300` をこのcloneのPRと誤認する。左境界では、別URLのpath・
// query（`/`、`=`、`?`、`&`、`#`）に埋め込まれた表記を除外する。
const DELIVERY_URL = /(?<![\w./@%=?&#-])(?:https?:\/\/)?(?:[\w-]+\.)+[a-z]{2,}(?::\d+)?\/[A-Za-z0-9._~:/?#@!$&'*+,;=%-]*/gi;
// owner / repo はissues|pullの直前の2 segmentから採り、hostはURLのauthorityだけを見る。
// `https://evil.example/github.com/koupent/ECC/pull/300` はowner/repoが一致していても
// 別hostのURLであり、このcloneのPRとしては解決させない（foreignとしてfail-closeする）。
const DELIVERY_URL_PATH = /(?:^|\/)([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)(?:\/|$)/i;
const SHORT_REFERENCES = {
  issue: /\bissue\s*#?\s*(\d+)\b/gi,
  pr: /\b(?:pull[\s-]*request|pr)\s*#?\s*(\d+)\b/gi
};
// GitHubのhost・owner・repoは大文字小文字を区別せず、remote URLは `.git` 付きでも届く。
const REMOTE_URL = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/\s]*@)?([^/:\s]+?)(?::\d+)?[/:]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i;

function normalizeRepositoryPart(value) {
  return String(value || '').replace(/\.git$/i, '').toLowerCase();
}

function parseRepositoryUrl(value) {
  const match = String(value || '').trim().match(REMOTE_URL);
  if (!match) return null;
  return {
    host: normalizeRepositoryPart(match[1]),
    owner: normalizeRepositoryPart(match[2]),
    repo: normalizeRepositoryPart(match[3])
  };
}

function parseDeliveryUrl(candidate) {
  // 文末の句読点や閉じ括弧はURLの一部ではない。
  const trimmed = String(candidate || '').replace(/[.,;:!?)\]}'"]+$/, '');
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  const match = url.pathname.match(DELIVERY_URL_PATH);
  if (!match) return null;
  return {
    kind: match[3].toLowerCase() === 'issues' ? 'issue' : 'pr',
    host: normalizeRepositoryPart(url.hostname),
    owner: normalizeRepositoryPart(match[1]),
    repo: normalizeRepositoryPart(match[2]),
    number: Number(match[4])
  };
}

function collectDeliveryReferences(request) {
  const value = String(request || '');
  const collected = { issue: [], pr: [] };
  for (const candidate of value.match(DELIVERY_URL) || []) {
    const reference = parseDeliveryUrl(candidate);
    if (reference) collected[reference.kind].push(reference);
  }
  for (const [kind, pattern] of Object.entries(SHORT_REFERENCES)) {
    for (const match of value.matchAll(pattern)) {
      collected[kind].push({ kind, host: null, owner: null, repo: null, number: Number(match[1]) });
    }
  }
  return collected;
}

function referenceKey(reference) {
  return `${reference.kind}:${reference.host || ''}/${reference.owner || ''}/${reference.repo || ''}#${reference.number}`;
}

function dedupeReferences(references) {
  const unique = new Map();
  for (const reference of references) {
    if (!unique.has(referenceKey(reference))) unique.set(referenceKey(reference), reference);
  }
  return [...unique.values()];
}

// 同じ種類の参照が複数あるとき、先頭一致で対象を決めてはいけない。
// 「Issue #271 ではなく Issue #300 を修正してください」を#271と解釈すると、名指しされて
// いないIssueのDraft PRを再開し、別branchへ変更を配送する。番号やrepositoryが割れる要求は
// 対象を推測せずfail-closeする。
function selectReference(references) {
  if (!references.length) return { reference: null, ambiguous: [] };
  const numbers = new Set(references.map(reference => reference.number));
  const scopes = new Set(references.filter(reference => reference.host).map(describeRepository));
  if (numbers.size > 1 || scopes.size > 1) return { reference: null, ambiguous: references };
  // 同じ対象を短い表記とURLの両方で書いた要求では、host・owner・repoまで揃うURLを採る。
  return { reference: references.find(reference => reference.host) || references[0], ambiguous: [] };
}

function parseDeliveryReferences(request) {
  const collected = collectDeliveryReferences(request);
  const parsed = { issue: null, pr: null, ambiguous: [] };
  for (const kind of ['issue', 'pr']) {
    const { reference, ambiguous } = selectReference(dedupeReferences(collected[kind]));
    parsed[kind] = reference;
    parsed.ambiguous.push(...ambiguous);
  }
  return parsed;
}

function explicitIssueNumber(request) {
  const reference = parseDeliveryReferences(request).issue;
  return reference ? reference.number : null;
}

function explicitPrNumber(request) {
  const reference = parseDeliveryReferences(request).pr;
  return reference ? reference.number : null;
}

// このcloneが実際に配送できるGitHub repositoryはremoteだけが決める。
function currentRepository(options = {}) {
  const execute = options.runCommand || runCommand;
  try {
    return parseRepositoryUrl(execute('git', ['remote', 'get-url', 'origin'], { cwd: options.cwd, env: options.env, timeout: 5000 }));
  } catch {
    return null;
  }
}

function describeRepository(repository) {
  return repository ? `${repository.host}/${repository.owner}/${repository.repo}` : 'an unresolved GitHub repository';
}

function describeReference(reference) {
  const scope = reference.host ? describeRepository(reference) : 'this repository';
  return `${scope} ${reference.kind === 'pr' ? 'PR' : 'Issue'} #${reference.number}`;
}

// 短い表記（`Issue #300`）は現在のrepositoryの指定として扱う。host・owner・repoまで
// 書かれたURLだけは、remoteと完全一致したときにだけ現在のrepositoryの指定とみなす。
// 別リポジトリ・不明なhost・remoteを解決できないcloneはfail-closeさせるため、
// requested_issue_number / requested_pr_number には採用しない。
function referenceMatchesRepository(reference, repository) {
  if (!reference || !reference.host) return true;
  if (!repository) return false;
  return reference.host === repository.host &&
    reference.owner === repository.owner &&
    reference.repo === repository.repo;
}

function resolveDeliveryReferences(request, options = {}) {
  const parsed = parseDeliveryReferences(request);
  const needsRepository = ['issue', 'pr'].some(kind => parsed[kind] && parsed[kind].host);
  const repository = options.repository !== undefined
    ? options.repository
    : needsRepository ? currentRepository(options) : null;
  const resolved = { issue: null, pr: null, repository, foreign: [], ambiguous: parsed.ambiguous };
  for (const kind of ['issue', 'pr']) {
    const reference = parsed[kind];
    if (!reference) continue;
    if (referenceMatchesRepository(reference, repository)) resolved[kind] = reference;
    else resolved.foreign.push(reference);
  }
  return resolved;
}

function describeAmbiguousReferences(references) {
  return dedupeReferences(references).map(describeReference).join(' / ');
}

function deliveryPrNumber(delivery) {
  const match = String(delivery && delivery.draft_pr_url || '').match(/\/pull\/(\d+)(?:\D|$)/);
  return match ? Number(match[1]) : (delivery && delivery.requested_pr_number) || null;
}

function referencesOtherDelivery(delivery, request, options = {}) {
  const references = options.references || resolveDeliveryReferences(request, options);
  // どのIssue / PRを指すのか確定できない要求は、進行中Deliveryの続きとみなさない。
  if (references.ambiguous.length) return true;
  // 別リポジトリを名指しした要求は、番号が一致していてもこのDeliveryの続きではない。
  if (references.foreign.length) return true;
  if (references.issue && delivery.issue_number && references.issue.number !== Number(delivery.issue_number)) return true;
  const recordedPr = deliveryPrNumber(delivery);
  return Boolean(references.pr && recordedPr && references.pr.number !== recordedPr);
}

function resumeDeliveryAfterDraftPr(input, delivery, env) {
  const resumed = {
    ...delivery,
    status: 'ready',
    completed_at: null,
    draft_pr_head: null,
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
  const references = resolveDeliveryReferences(request, { cwd, env, runCommand: options.runCommand });
  const active = isActiveDelivery(current.delivery) ? current.delivery : null;
  let superseded = null;
  if (active && active.status === 'draft-pr') {
    // Plan mode中はIssue・branch・状態遷移を起こさない。承認後の編集もDelivery Gateが
    // draft-prのままfail-closeするため、ここを素通りさせても迂回にはならない。
    if (options.deferred) return active;
    // Draft PR到達後の追加要求は、同じIssue/PRを指す限り同じDeliveryの続きである。
    // 参照を保ったままreadyへ戻し、branch一致、clean commit、fresh review、
    // Completion Gateを再適用する。draft-prのまま継続すると全Gateが素通りになる。
    if (!referencesOtherDelivery(active, request, { references })) return resumeDeliveryAfterDraftPr(input, active, env);
    // 別のIssue/PR、または別リポジトリを名指しする要求だけは新しいDeliveryを開始する。
    // 旧DeliveryのIssue・branch・Draft PR参照はstateに退避し、記録から消さない。
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
    requested_issue_number: references.issue ? references.issue.number : null,
    requested_pr_number: references.pr ? references.pr.number : null,
    // 別リポジトリを指すURLは、このcloneのIssue・branchへ配送してはいけない。番号を
    // 採用せずに記録だけ残し、prepareでfail-closeする。
    foreign_reference: references.foreign.length ? describeReference(references.foreign[0]) : null,
    // 同じ種類のIssue / PRを複数名指しした要求も、対象を推測せずprepareで止める。
    ambiguous_reference: references.ambiguous.length ? describeAmbiguousReferences(references.ambiguous) : null,
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

// PRを名指しした要求は、Issue検索やbranch作成より先にそのPRを解決してDeliveryを拘束する。
// 解決しないままprepareへ進むと、指定PRのheadを一度も見ないまま別Issueと別branchを作り、
// 指定PRと無関係なDeliveryが動き出す。
const PR_ISSUE_LINK = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/i;

function resolveRequestedPr(delivery, options = {}) {
  const requested = delivery && delivery.requested_pr_number;
  if (!requested) return null;
  const execute = options.runCommand || runCommand;
  const raw = execute(
    'gh',
    ['pr', 'view', String(requested), '--json', 'number,url,state,headRefName,baseRefName,body,isCrossRepository'],
    options
  );
  const pr = JSON.parse(raw || '{}');
  if (Number(pr.number) !== Number(requested)) {
    throw new Error(`gh pr view ${requested} did not return PR #${requested}; refusing to start a delivery on an unresolved PR.`);
  }
  if (String(pr.state || '').toUpperCase() !== 'OPEN') {
    throw new Error(`Referenced PR #${requested} is ${String(pr.state || 'unknown').toUpperCase()}; reopen it or name the Issue explicitly instead of creating a new one.`);
  }
  if (pr.isCrossRepository) {
    throw new Error(`Referenced PR #${requested} comes from a fork; its head branch cannot be delivered from this clone.`);
  }
  if (!pr.headRefName) {
    throw new Error(`Referenced PR #${requested} has no head branch; resolve the PR before continuing.`);
  }
  const linked = String(pr.body || '').match(PR_ISSUE_LINK);
  const issueNumber = linked ? Number(linked[1]) : Number(delivery.requested_issue_number) || null;
  if (!issueNumber) {
    throw new Error(`Referenced PR #${requested} does not link an Issue (Closes #<number>); name the Issue explicitly instead of creating a new one.`);
  }
  if (delivery.requested_issue_number && issueNumber !== Number(delivery.requested_issue_number)) {
    throw new Error(`Referenced PR #${requested} links Issue #${issueNumber}, but the request named Issue #${delivery.requested_issue_number}; resolve the conflict before continuing.`);
  }
  return {
    number: Number(pr.number),
    url: pr.url,
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName || null,
    issueNumber
  };
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

  const execute = options.runCommand || runCommand;
  const commandOptions = { cwd, env, runCommand: execute };

  try {
    // 同じ種類のIssue / PRが複数名指しされた要求は、どれが対象か確定していない。推測して
    // 進めると名指しされていないIssueのbranchへ変更を配送するため、ここで止める。
    if (delivery.ambiguous_reference) {
      throw new Error(
        `The request names more than one target (${delivery.ambiguous_reference}); ` +
          'name exactly one Issue or PR of this repository before preparing the delivery.'
      );
    }
    // 別リポジトリのIssue/PRは、このcloneのgh・branchでは解決できない。番号だけが一致する
    // 無関係なIssueへ配送しないよう、Issue検索もbranch作成も行わずここで止める。
    if (delivery.foreign_reference) {
      throw new Error(
        `The request names ${delivery.foreign_reference}, but this clone is ${describeRepository(currentRepository(commandOptions))}; ` +
          'run the delivery in that repository\'s clone, or name the Issue or PR of this repository.'
      );
    }
    const dirty = execute('git', ['status', '--porcelain'], commandOptions);
    if (dirty) throw new Error('Delivery preparation requires a clean working tree; preserve or commit existing changes first.');

    const currentBranch = execute('git', ['branch', '--show-current'], commandOptions);
    // 指定PRの解決に失敗したときは、Issueもbranchも作らずここでfail-closeする。
    const requestedPr = resolveRequestedPr(delivery, commandOptions);
    const existingPr = requestedPr || findExistingDeliveryPr(delivery, currentBranch, commandOptions);
    let issue = findDuplicateIssue(
      requestedPr ? { ...delivery, requested_issue_number: requestedPr.issueNumber } : delivery,
      { ...commandOptions, allowClosedReferencedIssue: Boolean(existingPr) }
    );
    if (!issue) {
      const body = [
        'ECC deterministic delivery workflow がユーザー要求から自動作成しました。',
        '',
        `Request fingerprint: \`${delivery.request_hash}\``,
        '',
        'このIssueに紐づくDraft PRが作成されるまで自動クローズしません。'
      ].join('\n');
      const url = execute('gh', ['issue', 'create', '--title', delivery.title, '--body', body], commandOptions);
      issue = { number: parseIssueNumber(url), title: delivery.title, url };
    }

    const existingIssueBranches = execute(
      'git',
      ['branch', '--list', `codex/issue-${issue.number}-*`, '--format=%(refname:short)'],
      commandOptions
    ).split(/\r?\n/).filter(Boolean);
    // 再開時にタイトルやslugが変わっても、同じIssueの現在branchを優先する。
    // これにより同一Issueへ複数branchを作ることを防ぐ。
    // 指定PRがあるときは、そのhead branchだけがDeliveryの対象になる。
    const branch = requestedPr
      ? requestedPr.headRefName
      : existingPr
        ? currentBranch
        : selectDeliveryBranch(issue.number, delivery.title, currentBranch, existingIssueBranches);
    if (currentBranch !== branch) {
      const existing = execute('git', ['branch', '--list', branch], commandOptions);
      if (existing) {
        execute('git', ['switch', branch], commandOptions);
      } else if (requestedPr) {
        // 指定PRのhead branchはPR側の実体である。baseから作り直すと別の変更になるため、
        // 手元に無ければ取得を促してfail-closeする。
        const tracked = execute(
          'git',
          ['branch', '--list', '--remotes', `*/${branch}`, '--format=%(refname:short)'],
          commandOptions
        ).split(/\r?\n/).filter(Boolean);
        if (tracked.length !== 1) {
          throw new Error(`PR #${requestedPr.number} head branch ${branch} is not available in this clone; fetch it before continuing.`);
        }
        execute('git', ['switch', '--track', tracked[0]], commandOptions);
      } else {
        execute('git', ['rev-parse', '--verify', delivery.base_branch], commandOptions);
        execute('git', ['switch', '-c', branch, delivery.base_branch], commandOptions);
      }
    }

    const next = {
      ...delivery,
      status: 'ready',
      requested_issue_number: requestedPr ? requestedPr.issueNumber : delivery.requested_issue_number,
      issue_number: Number(issue.number),
      issue_url: issue.url,
      branch,
      base_branch: requestedPr && requestedPr.baseRefName ? requestedPr.baseRefName : delivery.base_branch,
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
  currentRepository,
  describeAmbiguousReferences,
  describeReference,
  describeRepository,
  parseDeliveryUrl,
  explicitIssueNumber,
  explicitPrNumber,
  deliveryBranch,
  deliveryPrNumber,
  parseRepositoryUrl,
  referenceMatchesRepository,
  referencesOtherDelivery,
  resolveDeliveryReferences,
  resumeDeliveryAfterDraftPr,
  findDuplicateIssue,
  findExistingDeliveryPr,
  initializeDelivery,
  isActiveDelivery,
  isDeliveryRequest,
  normalizeIssueTitle,
  parseDeliveryReferences,
  parseIssueNumber,
  pendingSessionForProject,
  prepareDelivery,
  resolveRequestedPr,
  runCommand,
  selectDeliveryBranch,
  slug,
  titleFromRequest
};
