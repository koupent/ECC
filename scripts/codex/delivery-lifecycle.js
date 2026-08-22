#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const { loadConfig } = require('./config');
const fs = require('fs');
const path = require('path');
const {
  hash,
  projectFingerprint,
  projectFingerprintCandidates,
  projectStateMatches,
  readJson,
  readState,
  recordIncident,
  resolveSessionId,
  stateRoot,
  writeState
} = require('./runtime-state');

const DELIVERY_REQUEST = /(?:\b(?:implement|fix|change|add|remove|refactor|build|create|update)\b|実装|修正|変更|追加|削除|作成|更新|直して)/i;
const DELIVERY_COMPLETION_REQUEST = /(?:\b(?:complete|finish|finalize|deliver)\b|\bmerge\s+(?:it|the\s+pr|pr\s*#?\d+)\b|完遂|完了まで|仕上げて|マージまで)/i;
const NEGATED_DELIVERY_REQUEST = /(?:\b(?:do\s+not|don't|without)\s+(?:implement(?:ing)?|fix(?:ing)?|chang(?:e|ing)|add(?:ing)?|remov(?:e|ing)|refactor(?:ing)?|build(?:ing)?|creat(?:e|ing)|updat(?:e|ing))\b|(?:実装|修正|変更|追加|削除|作成|更新)(?:は)?(?:しないで|しない|しなくてよい|せず|不要)|直さない)/gi;
const DIAGNOSTIC_REQUEST = /(?:\b(?:investigate|review|analy[sz]e|diagnose|inspect|check)\b|調査|確認|レビュー|分析|診断|調べて|教えて)/i;
const EXPLICIT_MUTATION_REQUEST = /(?:\b(?:implement|fix|add|remove|refactor|build|create|update)\b|(?:実装|修正|変更|追加|削除|作成|更新|直)(?:を)?(?:して|する|してください|してほしい|したい|せよ))/i;
const ACTIVE_DELIVERY_CONTINUATION = /(?:\b(?:continue|resume)\b|(?:続けて|継続|再開)(?:ください|して)?)/i;
const ACTIVE_DELIVERY_REFERENCE = /(?:\b(?:continue|resume)\b|\b(?:this|the|current|same)\s+(?:pr|pull\s+request|issue|delivery)\b|\b(?:review|codex)\s+(?:finding|feedback|comment)s?\b|この(?:PR|プルリクエスト|Issue|イシュー|Delivery)|同じ(?:PR|プルリクエスト|Issue|イシュー|Delivery)|(?:続けて|継続|再開)(?:ください|して)?|(?:レビュー|Codex)の?指摘(?:を)?修正)/i;
const ACTIVE_DELIVERY_STATUSES = new Set(['deferred', 'pending', 'awaiting-branch', 'awaiting-worktree', 'ready', 'draft-pr']);
const PREPARABLE_DELIVERY_STATUSES = new Set(['deferred', 'pending', 'awaiting-branch', 'awaiting-worktree']);
// Gitは `;` `&` `$()` を含むrefを有効と認めるが、そのrefを手渡しの切替コマンドへ
// 埋めると複数のshell commandとして解釈されうる。この文字集合はshellのmetacharacterを
// 一切含まないので、通過したrefは追加の引用なしでコマンド文字列へ入れて安全である。
const SAFE_GIT_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

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

function worktreeIdentity(cwd, env = process.env, execute = runCommand) {
  const root = execute('git', ['rev-parse', '--show-toplevel'], { cwd, env });
  const resolveGitDir = flag => {
    try {
      return path.resolve(execute('git', ['rev-parse', '--path-format=absolute', flag], { cwd, env }));
    } catch {
      // --path-format はGit 2.31以降。既存のadvisory環境まで止めないため、
      // 古いGitではrepo root基準で従来出力を絶対化する。
      const legacy = execute('git', ['rev-parse', flag], { cwd, env });
      return path.resolve(cwd, legacy);
    }
  };
  const gitDir = resolveGitDir('--git-dir');
  const commonDir = resolveGitDir('--git-common-dir');
  return {
    root: path.resolve(root),
    git_dir: gitDir,
    common_dir: commonDir,
    isolated: gitDir !== commonDir
  };
}

function explicitIssueNumber(request) {
  const match = String(request || '').match(/\bissue\s*#?\s*(\d+)\b/i);
  return match ? Number(match[1]) : null;
}

function explicitPrNumber(request) {
  const value = String(request || '');
  const match = value.match(/\b(?:pr|pull\s+request)\s*#?\s*(\d+)\b/i) ||
    value.match(/\/pull\/(\d+)(?:\D|$)/i);
  return match ? Number(match[1]) : null;
}

function referencesActiveDelivery(delivery, request) {
  if (!delivery || delivery.status !== 'draft-pr') return false;
  const requestedIssue = explicitIssueNumber(request);
  const requestedPr = explicitPrNumber(request);
  const recordedPrMatch = String(delivery.draft_pr_url || '').match(/\/pull\/(\d+)(?:\D|$)/);
  const activePr = Number(
    delivery.pr_number || recordedPrMatch && recordedPrMatch[1] || delivery.requested_pr_number || 0
  ) || null;
  const value = String(request || '');
  if (requestedIssue || requestedPr) {
    const identityMatches =
      (!requestedIssue || requestedIssue === Number(delivery.issue_number)) &&
      (!requestedPr || requestedPr === activePr);
    return Boolean(identityMatches && (ACTIVE_DELIVERY_CONTINUATION.test(value) || isDeliveryRequest(value)));
  }
  if (ACTIVE_DELIVERY_CONTINUATION.test(value)) return true;
  if (!isDeliveryRequest(value)) return false;
  return Boolean(
    (requestedIssue && requestedIssue === Number(delivery.issue_number)) ||
    (requestedPr && requestedPr === activePr) ||
    (!requestedIssue && !requestedPr && ACTIVE_DELIVERY_REFERENCE.test(value))
  );
}

function worktreeForBranch(branch, cwd, env = process.env, execute = runCommand) {
  if (!branch) return null;
  let raw;
  let nulDelimited = true;
  try {
    raw = execute('git', ['worktree', 'list', '--porcelain', '-z'], { cwd, env });
  } catch {
    nulDelimited = false;
    raw = execute('git', ['-c', 'core.quotePath=false', 'worktree', 'list', '--porcelain'], { cwd, env });
  }
  const records = nulDelimited
    ? String(raw || '').split('\0\0').map(block => block.split('\0'))
    : String(raw || '').split(/\r?\n\r?\n/).map(block => block.split(/\r?\n/));
  const entries = records.map(lines => {
    const worktree = lines.find(line => line.startsWith('worktree '));
    const branchLine = lines.find(line => line.startsWith('branch '));
    return {
      worktree: worktree ? worktree.slice('worktree '.length) : '',
      branch: branchLine ? branchLine.slice('branch refs/heads/'.length) : ''
    };
  });
  return entries.find(entry => entry.worktree && entry.branch === branch) || null;
}

function claudeWorktreeName(worktreePath) {
  const parts = path.resolve(worktreePath).split(path.sep);
  for (let index = parts.length - 3; index >= 0; index -= 1) {
    if (parts[index] === '.claude' && parts[index + 1] === 'worktrees' && parts[index + 2]) {
      return parts[index + 2];
    }
  }
  return '';
}

function normalizeIssueTitle(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000()[\]{}「」『』【】]/g, '');
}

function isSafeGitRef(value) {
  const ref = String(value || '');
  // 先頭ハイフンはgit自身へのoption injectionになるため、SAFE_GIT_REFの先頭文字で弾く。
  return SAFE_GIT_REF.test(ref) && !ref.includes('..') && !ref.endsWith('.lock');
}

function assertSafeGitRef(value, label) {
  const ref = String(value || '');
  if (!isSafeGitRef(ref)) {
    throw new Error(
      `${label} "${ref}" is not shell-safe; Git accepts characters such as ; & | $() that would turn the handed-off switch command into several commands. ` +
        "Use only letters, digits, '.', '_', '/' and '-' (no leading '-' and no '..'), then run this command again."
    );
  }
  return ref;
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
  if (config.projectConfigStatus === 'invalid' && isDeliveryRequest(request)) {
    const delivery = {
      status: 'config-error',
      workflow_mode: 'required',
      request_hash: hash(request, 32),
      revision: 1,
      title: titleFromRequest(request, hash(request, 32)),
      completion_method: null,
      config_path: config.projectConfigPath
    };
    recordIncident({
      type: 'delivery_project_config_invalid',
      severity: 'critical',
      hook_id: 'delivery-lifecycle',
      message: 'The ECC project configuration could not be read or parsed; Delivery initialization failed closed.'
    }, { cwd, env });
    writeState(input, { delivery, project: projectFingerprint(cwd) }, env);
    return delivery;
  }
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
  const explicitContinuation = ACTIVE_DELIVERY_CONTINUATION.test(String(request || '')) &&
    Boolean(explicitIssueNumber(request) || explicitPrNumber(request));
  if (
    !isDeliveryRequest(request) &&
    !referencesActiveDelivery(current.delivery, request) &&
    !explicitContinuation
  ) return null;
  if (
    current.delivery &&
    current.delivery.status !== 'draft-pr' &&
    current.delivery.request_hash === requestHash
  ) return current.delivery;
  // Claude Code の継続turnでは、ユーザーの追記文面が変わっても同じDeliveryである。
  // 進行中Deliveryを本文ハッシュだけで上書きすると、Context Builder、Issue、branchが
  // 二重に作られるため、完了または明示的な新規Sessionまでは既存Deliveryを維持する。
  if (isActiveDelivery(current.delivery)) {
    const positivelyReferencesActive = referencesActiveDelivery(current.delivery, request);
    if (
      current.delivery.status === 'draft-pr' &&
      positivelyReferencesActive
    ) {
      const resumed = {
        ...current.delivery,
        // 現在位置が記録済みbranch/worktreeと異なる場合に復旧コマンドを許可できるよう、
        // prepare可能な状態へ戻す。prepareが同一性を確認してからreadyへ進める。
        status: options.deferred ? 'deferred' : 'awaiting-branch',
        branch_switch: null,
        revision: Number(current.delivery.revision || 1) + 1,
        review_cycle: null,
        completed_at: null,
        committed_head: null,
        committed_at: null,
        completion_stage: null,
        resumed_at: new Date().toISOString()
      };
      writeState(input, {
        delivery: resumed,
        review_role: null,
        review_status: null,
        review_complete: null,
        review_head: null,
        review_worktree_clean: false,
        review_blocking_findings: null,
        review_round: 0,
        review_limit_reached: false,
        review_followups: [],
        review_followup_issue_url: null
      }, env);
      return resumed;
    }
    if (current.delivery.status !== 'draft-pr') return current.delivery;
  }

  const delivery = {
    // Plan modeではIssueやbranchをまだ変更しない一方、承認後の同じturnで
    // 実装へ移っても必須Deliveryを迂回できないよう意図だけを先に記録する。
    status: options.deferred ? 'deferred' : 'pending',
    workflow_mode: 'required',
    delivery_worktree: config.deliveryWorktree,
    request_hash: requestHash,
    revision: 1,
    title: titleFromRequest(request, requestHash),
    requested_issue_number: explicitIssueNumber(request),
    requested_pr_number: explicitPrNumber(request),
    base_branch: config.deliveryBaseBranch,
    issue_number: null,
    issue_url: null,
    branch: null,
    draft_pr_url: null,
    completion_method: config.deliveryCompletion
  };
  // レビュー結果はDelivery単位の証拠である。前のDeliveryの改善候補や
  // 収束上限を次の要求へ持ち越すと、無関係なIssue作成や誤停止になる。
  writeState(input, {
    delivery,
    project: projectFingerprint(cwd),
    task_status: 'active',
    task_delivery_count: 1,
    review_round: 0,
    review_limit_reached: false,
    review_followups: [],
    review_followup_issue_url: null
  }, env);
  return delivery;
}

function pendingSessionForProject(cwd, env = process.env) {
  const sessionsDir = path.join(stateRoot(env), 'sessions');
  const projectCandidates = projectFingerprintCandidates(cwd);
  let candidates = [];
  try {
    candidates = fs.readdirSync(sessionsDir)
      .filter(file => file.endsWith('.json'))
      .map(file => readJson(path.join(sessionsDir, file)))
      .filter(state => state && projectStateMatches(state, cwd, projectCandidates) && state.delivery &&
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
  // 検証はgitへ渡す前に行う。危険なrefは案内コマンドに現れないうえ、Gateも同じ判定で
  // 拒否するため、実行できない切替を指示してawaiting-branchのまま詰むことがない。
  const target = assertSafeGitRef(branch, 'Delivery branch');
  const exists = Boolean(execute('git', ['branch', '--list', target], options));
  // 作成が必要なbranchは、要求を出す前にbaseの存在まで確かめる。切替をエージェントへ
  // 委ねても、解決できないbaseを指したまま手詰まりにならないようにする。
  const base = exists ? null : assertSafeGitRef(delivery.base_branch, 'Delivery base branch');
  if (!exists) execute('git', ['rev-parse', '--verify', base], options);
  return {
    required: true,
    from: currentBranch || '<detached>',
    to: target,
    create: !exists,
    base_branch: base,
    command: exists ? `git switch ${target}` : `git switch -c ${target} ${base}`
  };
}

function prepareDelivery(input = {}, options = {}) {
  const env = options.env || process.env;
  const cwd = options.cwd || input.cwd || process.cwd();
  const config = loadConfig(cwd, env);
  const state = readState(input, env);
  const delivery = state.delivery;
  if (!delivery || !PREPARABLE_DELIVERY_STATUSES.has(delivery.status)) {
    throw new Error('No pending required delivery task. Submit the implementation request first.');
  }
  const worktreeMode = delivery.delivery_worktree || config.deliveryWorktree;

  try {
    const dirty = runCommand('git', ['status', '--porcelain'], { cwd, env });
    if (dirty) throw new Error('Delivery preparation requires a clean working tree; preserve or commit existing changes first.');

    const currentBranch = runCommand('git', ['branch', '--show-current'], { cwd, env });
    // 手動切替を待っているDeliveryはIssueとbranchを確定済みである。再実行のたびに
    // GitHubへ問い合わせ直すと、切替待ちの間だけ重複探索とIssue作成の副作用が増える。
    const resumed = ['deferred', 'awaiting-branch', 'awaiting-worktree'].includes(delivery.status) &&
      Boolean(delivery.issue_number && delivery.branch);
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

    const identity = worktreeIdentity(cwd, env);
    const currentWorktreeName = identity.isolated ? claudeWorktreeName(identity.root) : '';
    if (worktreeMode === 'required' && identity.isolated && !currentWorktreeName) {
      throw new Error(
        `Required Delivery is running in a non-Claude linked worktree (${identity.root}); ` +
        'use EnterWorktree or Claude Code --worktree before continuing.'
      );
    }
    const occupied = worktreeForBranch(branch, cwd, env);
    const occupiedElsewhere = occupied && path.resolve(occupied.worktree) !== path.resolve(identity.root);
    const occupiedName = occupiedElsewhere ? claudeWorktreeName(occupied.worktree) : '';
    if (occupiedElsewhere && !occupiedName) {
      throw new Error(
        `Delivery branch ${branch} is checked out in a non-Claude worktree (${occupied.worktree}); ` +
        'remove that worktree or return the branch to the primary checkout before continuing.'
      );
    }
    const worktreeName = occupiedName || currentWorktreeName || delivery.worktree_name ||
      `issue-${Number(issue.number)}-${slug(issue.title || delivery.title)}`;
    if (worktreeMode === 'required' && occupiedElsewhere) {
      const waiting = {
        ...delivery,
        status: 'awaiting-worktree',
        issue_number: Number(issue.number),
        issue_url: issue.url,
        worktree_name: worktreeName,
        worktree: path.resolve(occupied.worktree),
        branch,
        draft_pr_url: draftPrUrl,
        prepared_at: new Date().toISOString()
      };
      writeState(input, { delivery: waiting }, env);
      return waiting;
    }
    if (worktreeMode === 'required' && !identity.isolated) {
      // 選択済みIssue branchを現在のmain worktreeが保持したままEnterWorktreeすると、
      // 新worktree側で同じbranchへ切り替えられない。まずbaseへ戻してbranchを解放し、
      // 次のprepareでawaiting-worktreeへ進める。
      if (currentBranch === branch && currentBranch !== delivery.base_branch) {
        const releasing = {
          ...delivery,
          status: 'awaiting-branch',
          issue_number: Number(issue.number),
          issue_url: issue.url,
          worktree_name: worktreeName,
          branch,
          draft_pr_url: draftPrUrl,
          branch_switch: branchSwitchPlan(delivery, delivery.base_branch, currentBranch, { cwd, env }),
          branch_switch_purpose: 'release-for-worktree',
          prepared_at: new Date().toISOString()
        };
        writeState(input, { delivery: releasing }, env);
        return releasing;
      }
      const waiting = {
        ...delivery,
        status: 'awaiting-worktree',
        issue_number: Number(issue.number),
        issue_url: issue.url,
        worktree_name: worktreeName,
        worktree: occupiedName ? path.resolve(occupied.worktree) : null,
        // EnterWorktree は独自branchを作るため、選択済みIssue branchを失わずに保持する。
        // Worktreeへ入った後、通常のbranch switch gateでこのbranchへ揃える。
        branch,
        draft_pr_url: draftPrUrl,
        prepared_at: new Date().toISOString()
      };
      writeState(input, { delivery: waiting }, env);
      return waiting;
    }

    if (worktreeMode === 'required') {
      if (!currentBranch) throw new Error('Delivery worktree must have a branch; detached HEAD is not allowed.');
    }

    const prepared = {
      ...delivery,
      issue_number: Number(issue.number),
      issue_url: issue.url,
      branch,
      draft_pr_url: draftPrUrl,
      worktree_name: worktreeName,
      worktree: identity.root,
      git_common_dir: identity.common_dir,
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
  claudeWorktreeName,
  explicitIssueNumber,
  explicitPrNumber,
  deliveryBranch,
  findDuplicateIssue,
  findExistingDeliveryPr,
  initializeDelivery,
  isActiveDelivery,
  isDeliveryRequest,
  isSafeGitRef,
  normalizeIssueTitle,
  parseIssueNumber,
  pendingSessionForProject,
  prepareDelivery,
  referencesActiveDelivery,
  runCommand,
  selectDeliveryBranch,
  slug,
  titleFromRequest,
  worktreeForBranch,
  worktreeIdentity
};
