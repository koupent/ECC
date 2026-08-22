#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MAX_LOG_BYTES = 8 * 1024 * 1024;
const REPOSITORY_IDENTITY_CACHE = new Map();
const LEGACY_IDENTITY_CACHE = new Map();

function hash(value, length = 24) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, length);
}

function stateRoot(env = process.env) {
  return env.ECC_KOUTE_STATE_DIR || path.join(os.homedir(), '.local', 'state', 'ecc-koute');
}

function sanitizeSessionId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const safe = raw.replace(/[^a-zA-Z0-9_-]/g, '_');
  return safe.length <= 80 ? safe : `sid-${hash(raw)}`;
}

function resolveSessionId(input = {}, env = process.env) {
  return sanitizeSessionId(input.session_id || input.sessionId || env.CLAUDE_SESSION_ID || env.ECC_SESSION_ID) || `project-${hash(env.CLAUDE_PROJECT_DIR || process.cwd())}`;
}

function statePath(input = {}, env = process.env) {
  return path.join(stateRoot(env), 'sessions', `${resolveSessionId(input, env)}.json`);
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function readState(input = {}, env = process.env) {
  return readJson(statePath(input, env), {
    schema_version: 1,
    session_id: resolveSessionId(input, env),
    context_status: 'idle',
    codex_calls: 0,
    codex_failures: 0,
    waste_loops: 0,
    delivery: null,
    protected_config_approvals: [],
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
  });
}

function writeState(input, patch, env = process.env) {
  const current = readState(input, env);
  const next = {
    ...current,
    ...patch,
    schema_version: 1,
    session_id: resolveSessionId(input, env),
    updated_at: new Date().toISOString()
  };
  atomicWrite(statePath(input, env), next);
  return next;
}

function resetState(input = {}, env = process.env) {
  const file = statePath(input, env);
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function contextReady(input = {}, env = process.env) {
  const state = readState(input, env);
  return state.context_status === 'ready' && state.context && typeof state.context === 'object';
}

function gitOutput(root, args) {
  let result;
  try {
    result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 5000, windowsHide: true });
  } catch {
    return '';
  }
  if (!result || result.error || result.status !== 0) return '';
  return String(result.stdout || '').trim();
}

// git common-dirは主作業ツリーと全てのlinked worktreeで同一である。これを識別子に
// 使うと、worktreeで記録したDelivery、レビュー証拠、イベントを主作業ツリーからも
// 同じprojectとして参照できる。Git配下でない場所は従来どおり絶対パスで識別する。
function repositoryIdentity(root) {
  const common = gitOutput(root, ['rev-parse', '--git-common-dir']);
  if (!common) return '';
  const absolute = path.resolve(root, common);
  try {
    return fs.realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function projectFingerprint(cwd = process.cwd()) {
  const root = path.resolve(cwd || process.cwd());
  if (!REPOSITORY_IDENTITY_CACHE.has(root)) {
    REPOSITORY_IDENTITY_CACHE.set(root, hash(repositoryIdentity(root) || root));
  }
  return REPOSITORY_IDENTITY_CACHE.get(root);
}

// 以前のprojectは「作業ツリーの絶対pathのhash」だった。読み込み側がcommon-dir由来の
// 新しいIDだけを探すと、旧版で始まったDeliveryはpending検索にも受入監査にも掛からず、
// 再開もresetもできないまま取り残される。同じリポジトリの作業ツリーpathから作られる
// 旧IDを互換識別子として認め、見つけた時点でcanonicalなIDへ書き換える。
function legacyProjectFingerprints(cwd = process.cwd()) {
  const root = path.resolve(cwd || process.cwd());
  if (LEGACY_IDENTITY_CACHE.has(root)) return LEGACY_IDENTITY_CACHE.get(root);
  const paths = new Set([root]);
  // 旧IDは記録した場所のpathで決まる。主作業ツリーでもlinked worktreeでも記録されうる
  // ため、このリポジトリの作業ツリーをすべて候補にする。
  for (const line of gitOutput(root, ['worktree', 'list', '--porcelain']).split(/\r?\n/)) {
    if (!line.startsWith('worktree ')) continue;
    const value = line.slice('worktree '.length).trim();
    if (!value) continue;
    const absolute = path.resolve(value);
    paths.add(absolute);
    try {
      paths.add(fs.realpathSync(absolute));
    } catch {
      // 消えた登録は候補から外れるだけで、判定には影響しない。
    }
  }
  const canonical = projectFingerprint(root);
  const identifiers = [...new Set([...paths].map(value => hash(value)))].filter(value => value !== canonical);
  LEGACY_IDENTITY_CACHE.set(root, identifiers);
  return identifiers;
}

function matchesProject(state, cwd = process.cwd()) {
  const project = state && state.project;
  if (!project) return false;
  return project === projectFingerprint(cwd) || legacyProjectFingerprints(cwd).includes(project);
}

// 旧IDのstateは読み込んだ時点でcanonicalなIDへ書き換える。互換で読み続けるだけでは、
// 同じprojectを二つの識別子で指す期間が終わらない。書き換えは他の更新と同じ
// 原子的な置換で行い、失敗しても呼び出し側は移行後の値で進める。
function canonicalizeProjectState(file, state, cwd = process.cwd()) {
  const canonical = projectFingerprint(cwd);
  if (!state || state.project === canonical) return state;
  const migrated = { ...state, project: canonical, project_migrated_from: state.project };
  try {
    atomicWrite(file, migrated);
  } catch {
    // 書き換えられなくても、この呼び出しの判定はcanonicalな識別子で行う。
  }
  return migrated;
}

// このprojectのsession stateを列挙する。旧IDで記録されたstateも同じprojectとして返し、
// 返す前にcanonicalなIDへ移行する。
function listProjectSessions(cwd = process.cwd(), env = process.env) {
  const sessionsDir = path.join(stateRoot(env), 'sessions');
  let files = [];
  try {
    files = fs.readdirSync(sessionsDir).filter(file => file.endsWith('.json'));
  } catch {
    return [];
  }
  const entries = [];
  for (const name of files) {
    const file = path.join(sessionsDir, name);
    const state = readJson(file);
    if (!matchesProject(state, cwd)) continue;
    entries.push({ file, state: canonicalizeProjectState(file, state, cwd) });
  }
  return entries;
}

// 進行中のDeliveryが払い出されたworktreeを持つ場合、branch・HEAD・作業ツリーの
// 検証はそのworktreeで行う。記録済みのworktreeが消えている、あるいは別リポジトリを
// 指しているときはnullを返してfail-closeさせる。ここで共有ツリーへ戻すと、隔離したはずの
// Deliveryを共有ツリーのbranchとHEADで判定し、Issueが指摘した衝突を再現してしまう。
//
// worktreeを一度も記録していないDeliveryは、worktree払い出し以前に始まった作業である。
// これは共有ツリーが作業場所のまま従来どおり扱う。ここでfail-closeさせると、進行中の
// 作業が記録済みのIssueとbranchごと止まり、resetで捨てる以外の道がなくなるためである。
// 隔離へ移すときは prepare を再実行する（delivery-lifecycle.js の isPreparableDelivery）。
// 新しく払い出されるDeliveryは必ずworktreeを記録するので、この経路は移行中だけ通る。
function deliveryWorkspace(state, cwd = process.cwd()) {
  const fallback = path.resolve(cwd || process.cwd());
  const recorded = state && state.delivery && state.delivery.worktree_path;
  if (!recorded) return fallback;
  const target = path.resolve(recorded);
  if (target === fallback) return fallback;
  try {
    if (!fs.statSync(target).isDirectory()) return null;
  } catch {
    return null;
  }
  return projectFingerprint(target) === projectFingerprint(fallback) ? target : null;
}

function redactText(value) {
  return String(value || '')
    .replace(/[A-Za-z]:\\[^\s"']+/g, '<path>')
    .replace(/\/(?:home|Users|workspaces)\/[^\s"']+/g, '<path>')
    .replace(/(token|secret|password|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=<redacted>')
    .slice(0, 2000);
}

function logPath(env = process.env) {
  return path.join(stateRoot(env), 'events.jsonl');
}

function appendEvent(event, env = process.env) {
  const file = logPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_LOG_BYTES) {
      fs.renameSync(file, `${file}.1`);
    }
  } catch {
    // Rotation is best effort; event persistence remains append-only.
  }
  const safe = {
    schema_version: 1,
    at: new Date().toISOString(),
    ...event,
    message: event.message ? redactText(event.message) : undefined
  };
  fs.appendFileSync(file, `${JSON.stringify(safe)}\n`, 'utf8');
  return safe;
}

function readEvents(env = process.env, limit = 500) {
  try {
    return fs
      .readFileSync(logPath(env), 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

function incidentFingerprint(incident) {
  return hash([incident.type, incident.role, incident.hook_id, redactText(incident.message)].join('|'), 32);
}

function recordIncident(incident, options = {}) {
  const env = options.env || process.env;
  const fingerprint = incident.fingerprint || incidentFingerprint(incident);
  const priorCount = readEvents(env).filter(event => event.kind === 'incident' && event.fingerprint === fingerprint).length;
  const count = priorCount + 1;
  const event = appendEvent(
    {
      kind: 'incident',
      fingerprint,
      count,
      severity: incident.severity || 'minor',
      type: incident.type || 'unknown',
      target: incident.target || (incident.metadata && incident.metadata.target),
      role: incident.role,
      hook_id: incident.hook_id,
      project: incident.project || projectFingerprint(options.cwd),
      message: incident.message || '',
      promotable: incident.promotable !== false,
      metadata: incident.metadata || {}
    },
    env
  );
  return event;
}

module.exports = {
  appendEvent,
  atomicWrite,
  canonicalizeProjectState,
  contextReady,
  deliveryWorkspace,
  hash,
  incidentFingerprint,
  legacyProjectFingerprints,
  listProjectSessions,
  logPath,
  matchesProject,
  projectFingerprint,
  readEvents,
  readJson,
  readState,
  recordIncident,
  redactText,
  repositoryIdentity,
  resetState,
  resolveSessionId,
  sanitizeSessionId,
  statePath,
  stateRoot,
  writeState
};
