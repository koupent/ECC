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
// `awaiting-branch` はworktree払い出し以前のstateにしか現れないが、そのSessionを
// 再度prepareできるよう受理し続ける。
const ACTIVE_DELIVERY_STATUSES = new Set(['deferred', 'pending', 'awaiting-branch', 'ready']);
const PREPARABLE_DELIVERY_STATUSES = new Set(['deferred', 'pending', 'awaiting-branch']);
// Gitは `;` `&` `$()` を含むrefを有効と認めるが、そのrefを指示コマンドや
// worktreeのdirectory名へ埋めると複数のshell commandとして解釈されうる。この文字集合は
// shellのmetacharacterを一切含まないので、通過したrefは追加の引用なしで安全に扱える。
const SAFE_GIT_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const WORKTREE_ADD_TIMEOUT_MS = 120000;

function isActiveDelivery(delivery) {
  return Boolean(delivery && ACTIVE_DELIVERY_STATUSES.has(delivery.status));
}

// worktree払い出し以前に `ready` となったDeliveryは、共有作業ツリーの上で進んでいる。
// そのDeliveryは二度とprepareできないと、隔離へ移す手段がresetしか残らず、記録済みの
// IssueとbranchごとDeliveryを捨てることになる。worktreeを記録していないreadyだけを
// 再度preparableにして、同じIssueとbranchのまま専用worktreeへ移せるようにする。
function isPreparableDelivery(delivery) {
  if (!delivery) return false;
  if (PREPARABLE_DELIVERY_STATUSES.has(delivery.status)) return true;
  return delivery.status === 'ready' && !delivery.worktree_path;
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
      .filter(state => state && state.project === project && isPreparableDelivery(state.delivery))
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

function listWorktrees(options = {}) {
  const execute = options.runCommand || runCommand;
  const raw = execute('git', ['worktree', 'list', '--porcelain'], options);
  const entries = [];
  for (const line of String(raw || '').split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      entries.push({ path: line.slice('worktree '.length).trim(), branch: '', detached: false });
      continue;
    }
    const current = entries[entries.length - 1];
    if (!current) continue;
    if (line.startsWith('branch ')) current.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    else if (line === 'detached') current.detached = true;
  }
  return entries;
}

function isInsideWorkingTree(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

// 設定値をそのまま信じると、リポジトリの中を指す払い出し先を受け入れてしまう。境界は
// ここで拒否し、既定値へ黙って戻さない。実体pathでも判定するのは、リポジトリの外に
// 見えるsymlinkが中を指している場合に字面だけでは通ってしまうためである。
function assertWorktreeOutsideSharedTree(main, target, configured) {
  const roots = new Set([main]);
  try {
    roots.add(fs.realpathSync(main));
  } catch {
    // 主作業ツリーを解決できない環境では字面の判定だけを行う。
  }
  for (const root of roots) {
    if (!isInsideWorkingTree(root, target)) continue;
    throw new Error(
      `Delivery worktree ${target} would be created inside the shared working tree ${root}. ` +
        'A worktree inside the repository dirties the shared `git status` and breaks the clean-HEAD checks this workflow depends on. ' +
        (configured
          ? `Point deliveryWorktreeRoot (or ECC_DELIVERY_WORKTREE_ROOT) at a path outside that tree; a relative value such as "${configured}" is resolved against the shared working tree. `
          : 'Point deliveryWorktreeRoot (or ECC_DELIVERY_WORKTREE_ROOT) at a path outside that tree. ') +
        'Then run this command again.'
    );
  }
}

function deliveryWorktreePath(mainWorktree, branch, options = {}) {
  const configured = (options.config && options.config.deliveryWorktreeRoot) || '';
  const main = path.resolve(mainWorktree);
  // 既定の払い出し先はリポジトリの外側に置く。worktreeを作業ツリーの中へ作ると、
  // 共有ツリーの `git status` が汚れ、cleanなHEADを要求する検証を自分で壊す。
  // 設定値の相対pathは共有ツリーの根から解決する。process.cwdから解決すると、同じ設定でも
  // 起動場所ごとに別の場所へ払い出してしまう。
  const root = configured
    ? path.resolve(main, configured)
    : path.join(path.dirname(main), `${path.basename(main)}-worktrees`);
  const target = path.join(root, assertSafeGitRef(branch, 'Delivery branch').replace(/\//g, '-'));
  assertWorktreeOutsideSharedTree(main, target, configured);
  return target;
}

function ensureDeliveryWorktree(delivery, branch, options = {}) {
  const execute = options.runCommand || runCommand;
  const target = assertSafeGitRef(branch, 'Delivery branch');
  const worktrees = listWorktrees(options);
  const main = worktrees[0] ? path.resolve(worktrees[0].path) : path.resolve(options.cwd || process.cwd());
  const existing = worktrees.find(entry => entry.branch === target);
  if (existing) {
    const existingPath = path.resolve(existing.path);
    // 主作業ツリーがそのbranchをcheckoutしていても、そこをDeliveryの作業場所にはしない。
    // 受け入れると隔離が消え、Issueが報告した「全ての作業が単一ツリーに集中する」状態に
    // 戻る。branchは同時に一つのツリーへしかcheckoutできないので、専用worktreeを作る前に
    // 共有ツリー側でbranchを手放してもらう。
    if (existingPath === main) {
      throw new Error(
        `Branch ${target} is checked out in the shared working tree ${existingPath}. ` +
          'Delivery work always runs in a worktree of its own, and preparation never adopts the shared working tree. ' +
          `Commit or stash the work that belongs to ${target} first: the new worktree checks out the same branch, so committed work follows it while uncommitted changes stay in the shared tree. ` +
          `Then switch ${existingPath} to another branch yourself and run this command again.`
      );
    }
    // 既存のlinked worktreeは削除も上書きもせず、そのまま再利用する。
    if (!fs.existsSync(existingPath)) {
      throw new Error(
        `Branch ${target} is registered to worktree ${existingPath}, but that directory is missing. ` +
          'Restore it or run `git worktree prune` yourself, then run this command again.'
      );
    }
    return { path: existingPath, branch: target, created: false, base_branch: null };
  }

  const worktreePath = deliveryWorktreePath(main, target, options);
  if (fs.existsSync(worktreePath)) {
    throw new Error(
      `Delivery worktree path ${worktreePath} already exists but is not registered for branch ${target}. ` +
        'Inspect it and move or remove it yourself; preparation never deletes an unverified directory.'
    );
  }
  const branchExists = Boolean(execute('git', ['branch', '--list', target], options));
  // 作成が必要なbranchは、worktreeを作る前にbaseの解決まで確かめる。解決できない
  // baseで `git worktree add` を走らせ、中途半端な登録を残さない。
  const base = branchExists ? null : assertSafeGitRef(delivery.base_branch, 'Delivery base branch');
  if (base) execute('git', ['rev-parse', '--verify', base], options);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  execute(
    'git',
    branchExists
      ? ['worktree', 'add', worktreePath, target]
      : ['worktree', 'add', '-b', target, worktreePath, base],
    { ...options, timeout: WORKTREE_ADD_TIMEOUT_MS }
  );
  return { path: worktreePath, branch: target, created: true, base_branch: base };
}

function prepareDelivery(input = {}, options = {}) {
  const env = options.env || process.env;
  const cwd = options.cwd || input.cwd || process.cwd();
  const state = readState(input, env);
  const delivery = state.delivery;
  if (!isPreparableDelivery(delivery)) {
    throw new Error(
      delivery && delivery.status === 'ready'
        ? `Issue #${delivery.issue_number} is already prepared in the delivery worktree ${delivery.worktree_path}. ` +
            'Continue there; preparation never re-issues a worktree that is already recorded.'
        : 'No pending required delivery task. Submit the implementation request first.'
    );
  }

  try {
    const config = loadConfig(cwd, env);
    // 共有ツリーのcleanさは要求しない。未コミットの作業と衝突しないことこそがIssueごとの
    // worktreeを払い出す目的であり、ここでcleanを求めると隔離が必要な状況ほど止まる。
    const currentBranch = runCommand('git', ['branch', '--show-current'], { cwd, env });
    // Issueとbranchを記録済みのDeliveryは確定している。再実行のたびにGitHubへ問い合わせ
    // 直すと、worktree払い出しをやり直す間だけ重複探索とIssue作成の副作用が増える。
    const resumed = Boolean(delivery.issue_number) && Boolean(delivery.branch);
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
    // worktreeを払い出す前にIssueとbranchを記録する。払い出しが失敗しても、再実行が
    // GitHubを引き直して重複Issueを作ることはない。
    writeState(input, { delivery: prepared }, env);

    // prepareは共有ツリーのbranchを切り替えず、Issueごとのworktreeを払い出す。以降の
    // 編集、コミット、レビュー、完了判定はこのpathで行われ、共有ツリーで走っている
    // 別の作業と衝突しない。
    const worktree = ensureDeliveryWorktree(prepared, branch, { cwd, env, config });
    const next = {
      ...prepared,
      status: 'ready',
      worktree_path: worktree.path,
      worktree_created: worktree.created,
      branch_switch: null
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
  // 払い出しは常に共有ツリーとは別のworktreeで終わる。stdoutのJSONは機械可読の契約なので、
  // 作業場所の受け渡しという人間向けの指示はstderrへ出す。
  process.stderr.write(
    `[ECC Delivery] Issue #${delivery.issue_number} is checked out at ${delivery.worktree_path} ` +
      `(${delivery.worktree_created ? 'created' : 'reused'} worktree on ${delivery.branch}). ` +
      'The shared working tree keeps its own branch and uncommitted changes. ' +
      'Run every edit, test, commit, review, and push for this delivery inside that path ' +
      `(for example \`cd "${delivery.worktree_path}"\` or \`git -C "${delivery.worktree_path}" ...\`).\n`
  );
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
  deliveryWorktreePath,
  ensureDeliveryWorktree,
  explicitIssueNumber,
  explicitPrNumber,
  deliveryBranch,
  findDuplicateIssue,
  findExistingDeliveryPr,
  initializeDelivery,
  isActiveDelivery,
  isDeliveryRequest,
  isPreparableDelivery,
  isSafeGitRef,
  listWorktrees,
  normalizeIssueTitle,
  parseIssueNumber,
  pendingSessionForProject,
  prepareDelivery,
  runCommand,
  selectDeliveryBranch,
  slug,
  titleFromRequest
};
