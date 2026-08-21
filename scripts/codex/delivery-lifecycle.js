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
// Gitは `;` `&` `$()` を含むrefを有効と認めるが、そのrefを手渡しの切替コマンドへ
// 埋めると複数のshell commandとして解釈されうる。この文字集合はshellのmetacharacterを
// 一切含まないので、通過したrefは追加の引用なしでコマンド文字列へ入れて安全である。
const SAFE_GIT_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
// 既定の接頭辞。既存プロジェクトと記録済みstateのbranch名を変えないため変更しない。
const DEFAULT_BRANCH_PREFIX = 'codex';
// `--title` はGitHub Issueのタイトルになる。1行に収まる長さへ制限し、改行や制御文字を弾く。
const DELIVERY_TITLE_LIMIT = 120;
const PREPARE_OPTIONS = new Map([
  ['--session', 'session'],
  ['--title', 'title'],
  ['--branch-suffix', 'branchSuffix']
]);
const PREPARE_USAGE = 'usage: delivery-lifecycle.js prepare [--session <id>] [--title "<issue title>"] [--branch-suffix <ascii-slug>]';

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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeBranchPrefix(value) {
  // 末尾の `/` は書き方の揺れなので受け入れる。区切りはこのモジュールが必ず付ける。
  const prefix = String(value === undefined || value === null ? '' : value).trim().replace(/\/+$/, '');
  if (!prefix) return DEFAULT_BRANCH_PREFIX;
  return assertSafeGitRef(prefix, 'Delivery branch prefix');
}

function issueBranchPrefixes(prefix) {
  const configured = normalizeBranchPrefix(prefix);
  // 接頭辞を変えた後も、変更前に作られた `codex/issue-N-*` を同じIssueのbranchとして拾う。
  // 拾わないと、記録済みの作業branchがあるIssueへ2本目のbranchを作ってしまう。
  return configured.toLowerCase() === DEFAULT_BRANCH_PREFIX ? [configured] : [configured, DEFAULT_BRANCH_PREFIX];
}

function issueBranchPattern(issueNumber, prefix) {
  // 設定値は正規表現へ直接は入れない。shell-safeな検証を通した文字だけを、さらにエスケープする。
  const prefixes = issueBranchPrefixes(prefix).map(escapeRegExp).join('|');
  return new RegExp(`^(?:${prefixes})/issue-${Number(issueNumber)}(?:-|$)`, 'i');
}

function issueBranchPatterns(issueNumber, prefix) {
  return issueBranchPrefixes(prefix).map(value => `${value}/issue-${Number(issueNumber)}-*`);
}

function deliveryBranch(issueNumber, title, currentBranch = '', prefix = DEFAULT_BRANCH_PREFIX) {
  return issueBranchPattern(issueNumber, prefix).test(String(currentBranch || ''))
    ? currentBranch
    : `${normalizeBranchPrefix(prefix)}/issue-${Number(issueNumber)}-${slug(title)}`;
}

function selectDeliveryBranch(issueNumber, title, currentBranch = '', existingBranches = [], prefix = DEFAULT_BRANCH_PREFIX) {
  const issueBranch = issueBranchPattern(issueNumber, prefix);
  if (issueBranch.test(String(currentBranch || ''))) return currentBranch;
  const candidates = [...new Set(existingBranches.filter(branch => issueBranch.test(String(branch || ''))))];
  if (candidates.length > 1) {
    throw new Error(`Issue #${Number(issueNumber)} has multiple local branches (${candidates.join(', ')}); consolidate them before continuing.`);
  }
  return candidates[0] || deliveryBranch(issueNumber, title, currentBranch, prefix);
}

function hasControlCharacter(value) {
  return Array.from(String(value)).some(character => {
    const code = character.codePointAt(0);
    return code < 32 || code === 127;
  });
}

function assertDeliveryTitle(value) {
  const title = String(value === undefined || value === null ? '' : value).trim();
  // 改行や制御文字はIssueのタイトルにもGateの案内文にも載せられない。先頭ハイフンは
  // `gh issue create` のoptionと見分けの付かない名前になるので同じく受け付けない。
  if (!title || title.length > DELIVERY_TITLE_LIMIT || hasControlCharacter(title) || title.startsWith('-')) {
    throw new Error(
      `Delivery title "${title}" is not usable as a GitHub Issue title. ` +
        `Give one line of 1-${DELIVERY_TITLE_LIMIT} characters that does not start with "-".`
    );
  }
  return title;
}

function assertBranchSuffix(value) {
  const suffix = String(value === undefined || value === null ? '' : value).trim();
  // slugはASCII以外を落とすので、日本語だけのsuffixは黙って `task` になる。意味を持たない
  // branch名を作る代わりに、branchへ載せるASCIIを明示してもらう。
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(suffix)) {
    throw new Error(
      `Delivery branch suffix "${suffix}" is not usable. Use ASCII letters and digits (spaces, '.', '_' and '-' are allowed inside), ` +
        'because the branch slug keeps ASCII only. A non-ASCII title can still be given with --title.'
    );
  }
  return suffix;
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

  // 入力の検証はincidentを記録するtryの外で行う。CLIの打ち間違いはDeliveryの障害ではない。
  const requestedTitle = options.title === undefined ? '' : assertDeliveryTitle(options.title);
  const requestedSuffix = options.branchSuffix === undefined ? '' : assertBranchSuffix(options.branchSuffix);
  // 名前はIssueとbranchを記録する前にしか決められない。記録後の改名はGateが突き合わせる
  // branchを壊すので、ここで拒否して「名前を決めてからprepareする」経路だけを残す。
  if ((requestedTitle || requestedSuffix) && (delivery.issue_number || delivery.branch)) {
    throw new Error(
      `Issue #${delivery.issue_number || '?'} and branch ${delivery.branch || '<none>'} are already recorded for this delivery, so its name is fixed. ` +
        'Run this command again without --title/--branch-suffix, or reset the delivery and name it before preparation.'
    );
  }
  const named = requestedTitle ? { ...delivery, title: requestedTitle } : delivery;

  try {
    const branchPrefix = normalizeBranchPrefix(config.deliveryBranchPrefix);
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
      const existingPr = findExistingDeliveryPr(named, currentBranch, { cwd, env });
      issue = findDuplicateIssue(named, {
        cwd,
        env,
        allowClosedReferencedIssue: Boolean(existingPr)
      });
      if (!issue) {
        const body = [
          'ECC deterministic delivery workflow がユーザー要求から自動作成しました。',
          '',
          `Request fingerprint: \`${named.request_hash}\``,
          '',
          'このIssueに紐づくDraft PRが作成されるまで自動クローズしません。'
        ].join('\n');
        const url = runCommand('gh', ['issue', 'create', '--title', named.title, '--body', body], { cwd, env });
        issue = { number: parseIssueNumber(url), title: named.title, url };
      }

      const existingIssueBranches = runCommand(
        'git',
        ['branch', '--list', ...issueBranchPatterns(issue.number, branchPrefix), '--format=%(refname:short)'],
        { cwd, env }
      ).split(/\r?\n/).filter(Boolean);
      // 再開時にタイトルやslugが変わっても、同じIssueの現在branchを優先する。
      // これにより同一Issueへ複数branchを作ることを防ぐ。
      branch = existingPr
        ? currentBranch
        : selectDeliveryBranch(issue.number, requestedSuffix || named.title, currentBranch, existingIssueBranches, branchPrefix);
      draftPrUrl = existingPr ? existingPr.url : delivery.draft_pr_url;
    }

    const prepared = {
      ...named,
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
          branch_switch: branchSwitchPlan(named, branch, currentBranch, { cwd, env })
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

function parsePrepareOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const key = PREPARE_OPTIONS.get(flag);
    const value = argv[index + 1];
    // Gateは厳密なコマンド一致でしかprepareを通さない。ここで曖昧な入力を受けると、
    // Gateが許した文字列とこのCLIが読む意味がずれる。
    if (!key) throw new Error(`Unknown option ${flag}; ${PREPARE_USAGE}`);
    if (options[key] !== undefined) throw new Error(`${flag} was given more than once; ${PREPARE_USAGE}`);
    if (value === undefined || PREPARE_OPTIONS.has(value)) throw new Error(`${flag} requires a value; ${PREPARE_USAGE}`);
    options[key] = value;
    index += 1;
  }
  return options;
}

function main() {
  const command = process.argv[2];
  if (command !== 'prepare') throw new Error(PREPARE_USAGE);
  const options = parsePrepareOptions(process.argv.slice(3));
  const explicitSession = options.session || process.env.CLAUDE_SESSION_ID;
  const sessionId = explicitSession || pendingSessionForProject(process.cwd(), process.env);
  if (!sessionId) throw new Error('No unique pending delivery session for this project; retry the exact session-bound command from the Delivery Gate.');
  const delivery = prepareDelivery(
    { session_id: sessionId, cwd: process.cwd() },
    { title: options.title, branchSuffix: options.branchSuffix }
  );
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
  assertBranchSuffix,
  assertDeliveryTitle,
  branchSwitchPlan,
  explicitIssueNumber,
  explicitPrNumber,
  deliveryBranch,
  findDuplicateIssue,
  findExistingDeliveryPr,
  initializeDelivery,
  isActiveDelivery,
  isDeliveryRequest,
  isSafeGitRef,
  issueBranchPatterns,
  normalizeBranchPrefix,
  normalizeIssueTitle,
  parseIssueNumber,
  parsePrepareOptions,
  pendingSessionForProject,
  prepareDelivery,
  runCommand,
  selectDeliveryBranch,
  slug,
  titleFromRequest
};
