#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MAX_LOG_BYTES = 8 * 1024 * 1024;
const REPOSITORY_IDENTITY_CACHE = new Map();

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

// git common-dirは主作業ツリーと全てのlinked worktreeで同一である。これを識別子に
// 使うと、worktreeで記録したDelivery、レビュー証拠、イベントを主作業ツリーからも
// 同じprojectとして参照できる。Git配下でない場所は従来どおり絶対パスで識別する。
function repositoryIdentity(root) {
  let result;
  try {
    result = spawnSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true
    });
  } catch {
    return '';
  }
  if (!result || result.error || result.status !== 0) return '';
  const common = String(result.stdout || '').trim();
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

// 進行中のDeliveryが払い出されたworktreeを持つ場合、branch・HEAD・作業ツリーの
// 検証はそのworktreeで行う。記録が消えている、あるいは別リポジトリを指している
// stateでは共有ツリーへ戻し、無関係なツリーを操作対象にしない。
function deliveryWorkspace(state, cwd = process.cwd()) {
  const fallback = path.resolve(cwd || process.cwd());
  const recorded = state && state.delivery && state.delivery.worktree_path;
  if (!recorded) return fallback;
  const target = path.resolve(recorded);
  if (target === fallback) return fallback;
  try {
    if (!fs.statSync(target).isDirectory()) return fallback;
  } catch {
    return fallback;
  }
  return projectFingerprint(target) === projectFingerprint(fallback) ? target : fallback;
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
  contextReady,
  deliveryWorkspace,
  hash,
  incidentFingerprint,
  logPath,
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
