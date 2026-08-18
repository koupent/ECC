#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadConfig } = require('./config');
const { atomicWrite, hash, readEvents, readJson, recordIncident, redactText, stateRoot } = require('./runtime-state');
const { runRole } = require('./run-role');

const INCIDENT_TARGETS = new Set(['ecc', 'kit', 'product']);
const STATUS_LABELS = new Set(['status:queued', 'status:needs-human', 'status:draft-pr']);
const LOCK_STALE_MS = 35 * 60 * 1000;
const LABELS = {
  'harness-incident': { color: 'B60205', description: 'ECC共通ハーネスが自動報告したインシデント' },
  'severity:critical': { color: 'B60205', description: '初回からフォローアップが必要な重大インシデント' },
  'severity:minor': { color: 'FBCA04', description: '反復後にフォローアップへ昇格した軽微インシデント' },
  'status:queued': { color: '1D76DB', description: 'Claude Code CLIの通常ワークフローで対応待ち' },
  'status:needs-human': { color: 'D93F0B', description: '自動処理に失敗し人の判断が必要' },
  'status:draft-pr': { color: '0E8A16', description: '修正Draft PRが作成済み' },
  'target:ecc': { color: '5319E7', description: 'koupent/ECCでの修正候補' },
  'target:kit': { color: '0052CC', description: 'Engineering Environment Kitでの修正候補' },
  'target:product': { color: 'C5DEF5', description: '発生元の製品リポジトリでの確認候補' }
};

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

function lockPath(env = process.env) {
  return path.join(stateRoot(env), 'incident-worker.lock');
}

function acquireLock(env = process.env, now = Date.now()) {
  const file = lockPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const stat = fs.statSync(file);
    if (now - stat.mtimeMs > LOCK_STALE_MS) fs.rmSync(file, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try {
    fs.mkdirSync(file);
  } catch (error) {
    if (error.code === 'EEXIST') return null;
    throw error;
  }
  fs.writeFileSync(path.join(file, 'owner.json'), `${JSON.stringify({ pid: process.pid, acquired_at: new Date(now).toISOString() })}\n`, 'utf8');
  return () => fs.rmSync(file, { recursive: true, force: true });
}

function eligible(event) {
  return event && event.kind === 'incident' && event.promotable !== false && (event.severity === 'critical' || Number(event.count || 0) >= 2);
}

function nextIncident(env = process.env) {
  const processed = readJson(processedPath(env), { fingerprints: [] });
  const seen = new Set(processed.fingerprints || []);
  return readEvents(env, 2000).find(event => eligible(event) && !seen.has(event.fingerprint)) || null;
}

function markProcessed(event, status, details = {}, env = process.env) {
  const file = processedPath(env);
  const current = readJson(file, { fingerprints: [], outcomes: {} });
  const fingerprints = [...new Set([...(current.fingerprints || []), event.fingerprint])].slice(-2000);
  atomicWrite(file, {
    fingerprints,
    outcomes: {
      ...(current.outcomes || {}),
      [event.fingerprint]: { status, at: new Date().toISOString(), ...details }
    }
  });
}

function classifyTarget(event) {
  const explicit = String(event.target || (event.metadata && event.metadata.target) || '').toLowerCase();
  if (INCIDENT_TARGETS.has(explicit)) return explicit;
  const text = [event.type, event.hook_id, event.role, event.message].filter(Boolean).join(' ').toLowerCase();
  if (/dev.?container|engineering.?kit|installer|bootstrap|voice|bubblewrap|\bbwrap\b|unshare|sandbox|authentication|not logged in|command not found/.test(text)) return 'kit';
  if (/^product[_-]|^project[_-]|ai[_-]qa|e2e|compliance/.test(text)) return 'product';
  return 'ecc';
}

function publicIncident(event) {
  return {
    fingerprint: event.fingerprint,
    type: event.type,
    target: classifyTarget(event),
    severity: event.severity,
    count: event.count,
    message: redactText(event.message || ''),
    reproduction_marker: hash(`${event.type}|${event.hook_id || ''}|${event.role || ''}`, 16)
  };
}

function ensureForkTarget(repo) {
  if (repo !== 'koupent/ECC') throw new Error(`Automatic remediation target must be exactly koupent/ECC, got ${repo}`);
}

function ensureLabels(repo, labels, env) {
  for (const name of labels) {
    const spec = LABELS[name];
    if (!spec) continue;
    assertSuccess(
      exec('gh', ['label', 'create', name, '--repo', repo, '--color', spec.color, '--description', spec.description, '--force'], { env }),
      `label ${name}`
    );
  }
}

function listCentralIssues(fingerprint, config, env) {
  const output = assertSuccess(
    exec('gh', ['issue', 'list', '--repo', config.centralIncidentRepo, '--state', 'all', '--search', fingerprint, '--json', 'number,url,state', '--limit', '20'], { env }),
    'central issue lookup'
  );
  const rows = JSON.parse(output || '[]');
  return rows.sort((left, right) => {
    const stateOrder = Number(left.state !== 'OPEN') - Number(right.state !== 'OPEN');
    return stateOrder || Number(left.number) - Number(right.number);
  });
}

function issueNumber(url) {
  const match = String(url || '').match(/\/issues\/(\d+)(?:$|[/?#])/);
  return match ? Number(match[1]) : null;
}

function reconcileDuplicates(canonical, matches, config, env) {
  for (const duplicate of matches.filter(issue => issue.number !== canonical.number && issue.state === 'OPEN')) {
    assertSuccess(
      exec('gh', ['issue', 'close', String(duplicate.number), '--repo', config.centralIncidentRepo, '--comment', `Duplicate of #${canonical.number}; the incident fingerprint is identical.`], { env }),
      `close duplicate issue #${duplicate.number}`
    );
  }
}

function createCentralIssue(event, config, env) {
  const target = classifyTarget(event);
  const labels = ['harness-incident', `target:${target}`, `severity:${event.severity}`, 'status:queued'];
  ensureLabels(config.centralIncidentRepo, labels, env);
  const existing = listCentralIssues(event.fingerprint, config, env);
  if (existing[0]) {
    reconcileDuplicates(existing[0], existing, config, env);
    return { ...existing[0], target, created: false };
  }

  const title = `[ECC incident][${target}] ${event.type} (${event.fingerprint.slice(0, 10)})`;
  const body = [
    'This incident was promoted automatically from privacy-preserving local telemetry.',
    '',
    `- Fingerprint: \`${event.fingerprint}\``,
    `- Type: \`${event.type}\``,
    `- Target: \`${target}\``,
    `- Severity: \`${event.severity}\``,
    `- Occurrences: ${event.count}`,
    `- Project fingerprint: \`${event.project || 'unknown'}\``,
    '',
    'Sanitized message:',
    '',
    redactText(event.message || ''),
    '',
    'Follow-up must use the normal Claude Code CLI workflow. Background remediation never merges changes.',
    'No source prompt, secret, absolute path, or product repository name is included.'
  ].join('\n');
  const args = ['issue', 'create', '--repo', config.centralIncidentRepo, '--title', title, '--body', body];
  for (const label of labels) args.push('--label', label);
  const url = assertSuccess(exec('gh', args, { env }), 'central issue creation');
  const created = { number: issueNumber(url), url, state: 'OPEN' };
  const matches = listCentralIssues(event.fingerprint, config, env);
  const canonical = matches[0] || created;
  reconcileDuplicates(canonical, matches, config, env);
  return { ...canonical, target, created: canonical.number === created.number };
}

function updateIssueStatus(issue, status, message, config, env) {
  ensureLabels(config.centralIncidentRepo, [status], env);
  const view = assertSuccess(
    exec('gh', ['issue', 'view', String(issue.number), '--repo', config.centralIncidentRepo, '--json', 'labels'], { env }),
    `view issue #${issue.number}`
  );
  const current = new Set((JSON.parse(view || '{}').labels || []).map(label => label.name));
  const args = ['issue', 'edit', String(issue.number), '--repo', config.centralIncidentRepo, '--add-label', status];
  for (const label of current) {
    if (STATUS_LABELS.has(label) && label !== status) args.push('--remove-label', label);
  }
  assertSuccess(exec('gh', args, { env }), `update issue #${issue.number}`);
  if (message) {
    assertSuccess(
      exec('gh', ['issue', 'comment', String(issue.number), '--repo', config.centralIncidentRepo, '--body', redactText(message)], { env }),
      `comment issue #${issue.number}`
    );
  }
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
  const release = options.skipLock ? () => {} : acquireLock(env);
  if (!release) return { status: 'locked' };
  try {
    const config = loadConfig(options.cwd || process.cwd(), env);
    const event = nextIncident(env);
    if (!event) return { status: 'idle' };

    let issue;
    try {
      issue = createCentralIssue(event, config, env);
    } catch (error) {
      recordIncident(
        {
          type: 'incident_reporting_failure',
          severity: 'minor',
          promotable: false,
          message: error.message || String(error),
          metadata: { source_fingerprint: event.fingerprint }
        },
        { env }
      );
      return { status: 'retry', error: error.message || String(error) };
    }

    if (!config.autoRemediation || issue.target !== 'ecc') {
      markProcessed(event, 'reported', { issue_url: issue.url, target: issue.target }, env);
      return { status: 'reported', issueUrl: issue.url, target: issue.target };
    }

    try {
      const prUrl = remediate(event, config, env);
      updateIssueStatus(issue, 'status:draft-pr', `Automatic draft remediation created: ${prUrl}`, config, env);
      markProcessed(event, 'draft-pr', { issue_url: issue.url, pr_url: prUrl, target: issue.target }, env);
      return { status: 'draft-pr', issueUrl: issue.url, prUrl };
    } catch (error) {
      recordIncident(
        {
          type: 'incident_remediation_failure',
          severity: 'minor',
          promotable: false,
          message: error.message || String(error),
          metadata: { source_fingerprint: event.fingerprint, issue_url: issue.url }
        },
        { env }
      );
      updateIssueStatus(
        issue,
        'status:needs-human',
        `Background remediation failed. Continue with the normal Claude Code CLI workflow.\n\n${error.message || String(error)}`,
        config,
        env
      );
      markProcessed(event, 'needs-human', { issue_url: issue.url, target: issue.target }, env);
      return { status: 'needs-human', issueUrl: issue.url, error: error.message || String(error) };
    }
  } finally {
    release();
  }
}

if (require.main === module) {
  const output = runOnce();
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  process.exitCode = output.status === 'retry' ? 2 : 0;
}

module.exports = {
  acquireLock,
  classifyTarget,
  createCentralIssue,
  eligible,
  ensureForkTarget,
  markProcessed,
  nextIncident,
  publicIncident,
  runOnce
};
