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
const ACTIVE_DELIVERY_STATUSES = new Set(['deferred', 'pending', 'awaiting-branch', 'ready']);
const PREPARABLE_DELIVERY_STATUSES = new Set(['deferred', 'pending', 'awaiting-branch']);

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
  if (current.delivery && current.delivery.request_hash === requestHash) return current.delivery;
  // Claude Code の継続turnでは、ユーザーの追記文面が変わっても同じDeliveryである。
  // 進行中Deliveryを本文ハッシュだけで上書きすると、Context Builder、Issue、branchが
  // 二重に作られるため、完了または明示的な新規Sessionまでは既存Deliveryを維持する。
  if (isActiveDelivery(current.delivery)) return current.delivery;

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
  writeState(input, { delivery, project: projectFingerprint(cwd) }, env);
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
        PREPARABLE_DELIVERY_STATUSES.has(state.delivery.status))
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

function branchSwitchPlan(delivery, branch, currentBranch, options = {}) {
  const execute = options.runCommand || runCommand;
  const exists = Boolean(execute('git', ['branch', '--list', branch], options));
  // 作成が必要なbranchは、要求を出す前にbaseの存在まで確かめる。切替をエージェントへ
  // 委ねても、解決できないbaseを指したまま手詰まりにならないようにする。
  if (!exists) execute('git', ['rev-parse', '--verify', delivery.base_branch], options);
  return {
    required: true,
    from: currentBranch || '<detached>',
    to: branch,
    create: !exists,
    base_branch: exists ? null : delivery.base_branch,
    command: exists ? `git switch ${branch}` : `git switch -c ${branch} ${delivery.base_branch}`
  };
}

function prepareDelivery(input = {}, options = {}) {
  const env = options.env || process.env;
  const cwd = options.cwd || input.cwd || process.cwd();
  const state = readState(input, env);
  const delivery = state.delivery;
  if (!delivery || !PREPARABLE_DELIVERY_STATUSES.has(delivery.status)) {
    throw new Error('No pending required delivery task. Submit the implementation request first.');
  }

  try {
    const dirty = runCommand('git', ['status', '--porcelain'], { cwd, env });
    if (dirty) throw new Error('Delivery preparation requires a clean working tree; preserve or commit existing changes first.');

    const currentBranch = runCommand('git', ['branch', '--show-current'], { cwd, env });
    // 手動切替を待っているDeliveryはIssueとbranchを確定済みである。再実行のたびに
    // GitHubへ問い合わせ直すと、切替待ちの間だけ重複探索とIssue作成の副作用が増える。
    const resumed = delivery.status === 'awaiting-branch' && Boolean(delivery.issue_number) && Boolean(delivery.branch);
    let issue = { number: delivery.issue_number, url: delivery.issue_url };
    let branch = delivery.branch;
    let draftPrUrl = delivery.draft_pr_url;

    if (!resumed) {
      const existingPr = findExistingDeliveryPr(delivery, currentBranch, { cwd, env });
      issue = findDuplicateIssue(delivery, {
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
      branch = existingPr
        ? currentBranch
        : selectDeliveryBranch(issue.number, delivery.title, currentBranch, existingIssueBranches);
      draftPrUrl = existingPr ? existingPr.url : delivery.draft_pr_url;
    }

    const prepared = {
      ...delivery,
      issue_number: Number(issue.number),
      issue_url: issue.url,
      branch,
      draft_pr_url: draftPrUrl,
      prepared_at: new Date().toISOString()
    };
    // prepareはbranchを切り替えない。生成物が無視される限り `git status --porcelain` は
    // 実行中のビルドやテストを検出できず、ここで切り替えるとその検証だけが別コミットの
    // 作業ツリーを読み続ける。切替はエージェントが走っている作業を畳んでから実行し、
    // このコマンドの再実行でreadyへ進む。
    const next = currentBranch === branch
      ? { ...prepared, status: 'ready', branch_switch: null }
      : {
          ...prepared,
          status: 'awaiting-branch',
          branch_switch: branchSwitchPlan(delivery, branch, currentBranch, { cwd, env })
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
  const delivery = prepareDelivery({ session_id: sessionId, cwd: process.cwd() });
  // stdoutのJSONは機械可読の契約なので、切替要求という人間向けの指示はstderrへ出す。
  if (delivery.status === 'awaiting-branch' && delivery.branch_switch) {
    process.stderr.write(
      `[ECC Delivery] Branch switch required: ${delivery.branch_switch.from} -> ${delivery.branch_switch.to}. ` +
        'This command no longer switches branches, so a build or test that is still running is never moved onto another commit. ' +
        `Finish or stop that work, run \`${delivery.branch_switch.command}\` yourself, then run this command again to record the Delivery as ready.\n`
    );
  }
  process.stdout.write(`${JSON.stringify(delivery, null, 2)}\n`);
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
  branchSwitchPlan,
  explicitIssueNumber,
  explicitPrNumber,
  deliveryBranch,
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
