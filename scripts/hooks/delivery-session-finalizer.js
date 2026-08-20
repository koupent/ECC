#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  projectFingerprint,
  readJson,
  readState,
  recordIncident,
  resolveSessionId,
  stateRoot,
  writeState
} = require('../codex/runtime-state');

const ACTIVE = new Set(['pending', 'ready']);

function reportIncomplete(input, state, options = {}) {
  const env = options.env || process.env;
  const cwd = options.cwd || input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const delivery = state && state.delivery;
  if (!delivery || !ACTIVE.has(delivery.status) || delivery.incomplete_reported_at) return false;

  const hasCommit = Boolean(delivery.committed_head);
  recordIncident({
    type: hasCommit ? 'delivery_stranded_after_commit' : 'delivery_session_incomplete',
    severity: hasCommit ? 'critical' : 'minor',
    target: 'ecc',
    hook_id: 'delivery-session-finalizer',
    message: `Required delivery ended before configured completion (status=${delivery.status}, stage=${delivery.completion_stage || 'not-recorded'}).`,
    metadata: {
      issue_number: delivery.issue_number || delivery.requested_issue_number || null,
      stage: delivery.completion_stage || null,
      committed: hasCommit
    }
  }, { cwd, env });
  writeState(input, {
    delivery: { ...delivery, incomplete_reported_at: new Date().toISOString() }
  }, env);
  return true;
}

function auditStale(input, options = {}) {
  const env = options.env || process.env;
  const cwd = options.cwd || input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const currentSession = resolveSessionId(input, env);
  const project = projectFingerprint(cwd);
  const maxAgeSeconds = Math.max(0, Number(env.ECC_STALE_DELIVERY_SECONDS || 1800));
  const cutoff = Date.now() - maxAgeSeconds * 1000;
  const sessionsDir = path.join(stateRoot(env), 'sessions');
  let reported = 0;
  let files = [];
  try {
    files = fs.readdirSync(sessionsDir).filter(file => file.endsWith('.json'));
  } catch {
    return 0;
  }
  for (const file of files) {
    const state = readJson(path.join(sessionsDir, file));
    if (!state || state.session_id === currentSession || state.project !== project) continue;
    const updated = Date.parse(state.updated_at || '');
    if (!Number.isFinite(updated) || updated > cutoff) continue;
    if (reportIncomplete({ session_id: state.session_id, cwd }, state, { cwd, env })) reported += 1;
  }
  return reported;
}

function run(rawInput, options = {}) {
  let input;
  try {
    input = typeof rawInput === 'string' ? JSON.parse(rawInput) : rawInput;
  } catch {
    return rawInput;
  }
  const env = options.env || process.env;
  const mode = options.mode || process.argv[2] || 'end';
  if (mode === 'start') auditStale(input, { ...options, env });
  else reportIncomplete(input, readState(input, env), { ...options, env });
  return rawInput;
}

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { raw += chunk; });
  process.stdin.on('end', () => process.stdout.write(run(raw)));
}

module.exports = { auditStale, reportIncomplete, run };
