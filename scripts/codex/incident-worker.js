#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadConfig } = require('./config');
const { atomicWrite, hash, readEvents, readJson, recordIncident, redactText, stateRoot } = require('./runtime-state');
const { runRole } = require('./run-role');

function exec(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: 'utf8',
    timeout: options.timeout || 120000,
    maxBuffer: 32 * 1024 * 1024
  });
}

function assertSuccess(result, label) {
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed (${result.status}): ${String(result.stderr || result.stdout || '').slice(-1500)}`);
  return String(result.stdout || '').trim();
}

function processedPath(env = process.env) {
  return path.join(stateRoot(env), 'incident-worker.json');
}

function eligible(event) {
  return event && event.kind === 'incident' && event.promotable !== false && (event.severity === 'critical' || Number(event.count || 0) >= 2);
}

function nextIncident(env = process.env) {
  const processed = readJson(processedPath(env), { fingerprints: [] });
  const seen = new Set(processed.fingerprints || []);
  return readEvents(env, 2000).find(event => eligible(event) && !seen.has(event.fingerprint)) || null;
}

function markProcessed(event, status, env = process.env) {
  const file = processedPath(env);
  const current = readJson(file, { fingerprints: [], outcomes: {} });
  const fingerprints = [...new Set([...(current.fingerprints || []), event.fingerprint])].slice(-2000);
  atomicWrite(file, {
    fingerprints,
    outcomes: { ...(current.outcomes || {}), [event.fingerprint]: { status, at: new Date().toISOString() } }
  });
}

function publicIncident(event) {
  return {
    fingerprint: event.fingerprint,
    type: event.type,
    severity: event.severity,
    count: event.count,
    message: redactText(event.message || ''),
    reproduction_marker: hash(`${event.type}|${event.hook_id || ''}|${event.role || ''}`, 16)
  };
}

function ensureForkTarget(repo) {
  if (repo !== 'koupent/ECC') throw new Error(`Automatic remediation target must be exactly koupent/ECC, got ${repo}`);
}

function createCentralIssue(event, config, env) {
  const title = `[ECC incident] ${event.type} (${event.fingerprint.slice(0, 10)})`;
  const body = [
    'This incident was promoted automatically from privacy-preserving local telemetry.',
    '',
    `- Fingerprint: \`${event.fingerprint}\``,
    `- Type: \`${event.type}\``,
    `- Severity: \`${event.severity}\``,
    `- Occurrences: ${event.count}`,
    `- Project fingerprint: \`${event.project || 'unknown'}\``,
    '',
    'Sanitized message:',
    '',
    redactText(event.message || ''),
    '',
    'No source prompt, secret, absolute path, or product repository name is included.'
  ].join('\n');
  const existing = exec('gh', ['issue', 'list', '--repo', config.centralIncidentRepo, '--state', 'all', '--search', event.fingerprint, '--json', 'number,url', '--limit', '1'], { env });
  if (existing.status === 0) {
    try {
      const rows = JSON.parse(existing.stdout || '[]');
      if (rows[0]) return rows[0].url;
    } catch {
      // Continue and create a new issue when the response cannot be parsed.
    }
  }
  return assertSuccess(exec('gh', ['issue', 'create', '--repo', config.centralIncidentRepo, '--title', title, '--body', body], { env }), 'central issue creation');
}

function remediate(event, config, env) {
  ensureForkTarget(config.forkRepo);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-remediation-'));
  const checkout = path.join(temp, 'ECC');
  const branch = `codex/incident-${event.fingerprint.slice(0, 12)}`;
  try {
    assertSuccess(exec('gh', ['repo', 'clone', config.forkRepo, checkout], { env, timeout: 180000 }), 'fork clone');
    assertSuccess(exec('git', ['switch', '-c', branch], { cwd: checkout, env }), 'branch creation');
    const request = [
      'Fix this sanitized ECC harness incident without changing ECC standard workflow semantics.',
      JSON.stringify(publicIncident(event)),
      'A regression test must fail before the fix and pass afterward. Keep the change generic and public-safe.'
    ].join('\n');
    const role = runRole({ role: 'harness-remediation', request, cwd: checkout, env, force: true });
    if (!role.ok) throw new Error(`Codex remediation failed: ${role.error}`);
    const changed = String(assertSuccess(exec('git', ['status', '--porcelain'], { cwd: checkout, env }), 'status'));
    if (!changed.trim()) throw new Error('Codex remediation produced no changes');
    assertSuccess(exec('npm', ['test'], { cwd: checkout, env, timeout: 20 * 60 * 1000 }), 'ECC test suite');
    assertSuccess(exec('git', ['add', '--all'], { cwd: checkout, env }), 'staging');
    assertSuccess(
      exec('git', ['-c', 'user.name=Koupent ECC Worker', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com', 'commit', '-m', `fix: インシデント ${event.fingerprint.slice(0, 10)} を修正`], {
        cwd: checkout,
        env
      }),
      'commit'
    );
    assertSuccess(exec('git', ['push', '--set-upstream', 'origin', branch], { cwd: checkout, env, timeout: 180000 }), 'push');
    const prBody = [
      '## 変更内容',
      '',
      `匿名化された共通ハーネスインシデント \`${event.fingerprint}\` の回帰テストと修正です。`,
      '',
      '## 検証',
      '',
      '- `npm test`',
      '',
      'このPRは自動マージされません。本家ECCへのPRも自動作成されません。'
    ].join('\n');
    return assertSuccess(
      exec('gh', ['pr', 'create', '--repo', config.forkRepo, '--base', 'main', '--head', branch, '--draft', '--title', `fix: 共通ハーネスインシデント ${event.fingerprint.slice(0, 10)}`, '--body', prBody], {
        cwd: checkout,
        env
      }),
      'draft PR creation'
    );
  } finally {
    try {
      fs.rmSync(temp, { recursive: true, force: true });
    } catch {
      // The worker's private temp directory is best-effort cleanup.
    }
  }
}

function runOnce(options = {}) {
  const env = options.env || process.env;
  const config = loadConfig(options.cwd || process.cwd(), env);
  const event = nextIncident(env);
  if (!event) return { status: 'idle' };
  let issueUrl = '';
  try {
    issueUrl = createCentralIssue(event, config, env);
    if (!config.autoRemediation) {
      markProcessed(event, 'issue-only', env);
      return { status: 'issue-only', issueUrl };
    }
    const prUrl = remediate(event, config, env);
    markProcessed(event, 'draft-pr', env);
    return { status: 'draft-pr', issueUrl, prUrl };
  } catch (error) {
    recordIncident(
      {
        type: 'incident_remediation_failure',
        severity: 'minor',
        promotable: false,
        message: error.message || String(error),
        metadata: { source_fingerprint: event.fingerprint, issue_url: issueUrl }
      },
      { env }
    );
    markProcessed(event, 'needs-human', env);
    return { status: 'needs-human', issueUrl, error: error.message || String(error) };
  }
}

if (require.main === module) {
  const output = runOnce();
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  process.exitCode = output.status === 'needs-human' ? 2 : 0;
}

module.exports = { eligible, ensureForkTarget, markProcessed, nextIncident, publicIncident, runOnce };
