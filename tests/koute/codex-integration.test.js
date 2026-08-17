#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadConfig } = require('../../scripts/codex/config');
const {
  readState,
  recordIncident,
  redactText,
  resetState,
  writeState
} = require('../../scripts/codex/runtime-state');
const { isTestPath, requireUsableResult, validateResult, workingTreeSignature } = require('../../scripts/codex/run-role');
const { eligible, ensureForkTarget, publicIncident } = require('../../scripts/codex/incident-worker');
const { record } = require('../../scripts/codex/record-event');
const contextGate = require('../../scripts/hooks/codex-context-gate');
const contextBuilder = require('../../scripts/hooks/codex-context-builder');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${name}: ${error.stack || error.message}`);
  }
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-koute-test-'));
const repo = path.join(temp, 'repo');
const stateDir = path.join(temp, 'state');
fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
fs.mkdirSync(path.join(repo, '.ecc'), { recursive: true });
fs.writeFileSync(
  path.join(repo, '.ecc', 'config.json'),
  JSON.stringify({ version: 1, profile: 'standard', rulePacks: ['common'], codex: { enabled: true } }),
  'utf8'
);
const env = { ...process.env, ECC_KOUTE_STATE_DIR: stateDir, CLAUDE_SESSION_ID: 'test-session' };

console.log('\n=== Koupent ECC Codex integration ===\n');

test('project config opts into standard Codex integration', () => {
  const config = loadConfig(repo, env);
  assert.strictEqual(config.enabled, true);
  assert.strictEqual(config.hookProfile, 'standard');
  assert.strictEqual(config.contextModel, 'gpt-5.6-terra');
  assert.strictEqual(config.reviewModel, 'gpt-5.6-sol');
  assert.strictEqual(config.timeoutSeconds, 1800);
});

test('project without .ecc config remains opt-out', () => {
  const other = path.join(temp, 'other');
  fs.mkdirSync(other, { recursive: true });
  assert.strictEqual(loadConfig(other, env).enabled, false);
});

test('runtime state is persistent and resettable outside the repository', () => {
  writeState({ session_id: 'abc' }, { context_status: 'ready', codex_calls: 2 }, env);
  assert.strictEqual(readState({ session_id: 'abc' }, env).codex_calls, 2);
  assert.ok(!path.resolve(stateDir).startsWith(path.resolve(repo)));
  resetState({ session_id: 'abc' }, env);
  assert.strictEqual(readState({ session_id: 'abc' }, env).context_status, 'idle');
});

test('context gate blocks broad search while pending', () => {
  writeState({ session_id: 'gate' }, { context_status: 'pending' }, env);
  const raw = JSON.stringify({ session_id: 'gate', tool_name: 'Grep', tool_input: { pattern: 'TODO' } });
  const output = JSON.parse(contextGate.run(raw, { cwd: repo, env }));
  assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
});

test('context gate allows bootstrap instructions while pending', () => {
  writeState({ session_id: 'bootstrap' }, { context_status: 'pending' }, env);
  const raw = JSON.stringify({ session_id: 'bootstrap', tool_name: 'Read', tool_input: { file_path: path.join(repo, 'AGENTS.md') } });
  assert.strictEqual(contextGate.run(raw, { cwd: repo, env }), raw);
});

test('context gate opens for ready and recorded fallback states', () => {
  for (const status of ['ready', 'fallback']) {
    writeState({ session_id: status }, { context_status: status }, env);
    const raw = JSON.stringify({ session_id: status, tool_name: 'Glob', tool_input: { pattern: '**/*' } });
    assert.strictEqual(contextGate.run(raw, { cwd: repo, env }), raw);
  }
});

test('context builder reuses the task packet instead of starting a duplicate Codex run', () => {
  writeState(
    { session_id: 'cached-context' },
    { context_status: 'ready', context: { status: 'ok', summary: 'cached', files: [] } },
    env
  );
  const output = JSON.parse(
    contextBuilder.run(
      JSON.stringify({ session_id: 'cached-context', cwd: repo, prompt: 'follow-up detail' }),
      { cwd: repo, env }
    )
  );
  assert.match(output.hookSpecificOutput.additionalContext, /cached packet/);
  assert.match(output.hookSpecificOutput.additionalContext, /"summary":"cached"/);
});

test('test write allowlist accepts contracts and rejects product source', () => {
  assert.ok(isTestPath('tests/api/contract.test.ts'));
  assert.ok(isTestPath('lib/foo.spec.dart'));
  assert.ok(isTestPath('integration_test/login_test.dart'));
  assert.ok(!isTestPath('src/api.ts'));
  assert.ok(!isTestPath('package.json'));
});

test('read-only role signature detects changes inside an already-dirty path', () => {
  const signatureRepo = path.join(temp, 'signature-repo');
  fs.mkdirSync(signatureRepo, { recursive: true });
  assert.strictEqual(spawnSync('git', ['init', '--quiet'], { cwd: signatureRepo }).status, 0);
  const file = path.join(signatureRepo, 'dirty.txt');
  fs.writeFileSync(file, 'before', 'utf8');
  const before = workingTreeSignature(signatureRepo);
  fs.writeFileSync(file, 'after', 'utf8');
  assert.notStrictEqual(workingTreeSignature(signatureRepo), before);
});

test('role result validator rejects malformed output', () => {
  assert.throws(() => validateResult({ status: 'ok', summary: 'x' }, 'context-result.schema.json'), /files/);
  assert.doesNotThrow(() =>
    validateResult({ status: 'ok', summary: 'x', files: [], constraints: [], risks: [], verification: [] }, 'context-result.schema.json')
  );
});

test('insufficient Context Builder output triggers Claude fallback', () => {
  assert.throws(
    () => requireUsableResult('context-builder', { status: 'insufficient', summary: 'sandbox unavailable' }),
    /context is insufficient/
  );
  assert.doesNotThrow(() => requireUsableResult('context-builder', { status: 'ok', summary: 'ready' }));
  assert.doesNotThrow(() => requireUsableResult('review', { status: 'blocked', summary: 'release blocker' }));
});

test('incident threshold promotes critical once and minor twice', () => {
  assert.ok(eligible({ kind: 'incident', severity: 'critical', count: 1 }));
  assert.ok(eligible({ kind: 'incident', severity: 'minor', count: 2 }));
  assert.ok(!eligible({ kind: 'incident', severity: 'minor', count: 1 }));
});

test('incident recorder increments identical fingerprints', () => {
  const first = recordIncident({ type: 'x', severity: 'minor', message: 'same' }, { cwd: repo, env });
  const second = recordIncident({ type: 'x', severity: 'minor', message: 'same' }, { cwd: repo, env });
  assert.strictEqual(first.count, 1);
  assert.strictEqual(second.count, 2);
});

test('project quality runners record evidence and incidents in external state', () => {
  const evidence = record(['evidence', 'deterministic_e2e', 'PASS', 'artifact verified'], { cwd: repo, env });
  assert.strictEqual(evidence.kind, 'evidence');
  assert.strictEqual(evidence.status, 'PASS');
  const incident = record(['incident', 'ai_qa_abort', 'minor', 'browser unavailable'], { cwd: repo, env });
  assert.strictEqual(incident.kind, 'incident');
  assert.strictEqual(incident.severity, 'minor');
  assert.throws(() => record(['evidence', 'bad type', 'PASS', 'x'], { cwd: repo, env }), /usage/);
  assert.throws(() => record(['incident', 'ai_qa_abort', 'unsafe', 'x'], { cwd: repo, env }), /usage/);
});

test('public remediation is hard-locked to koupent/ECC', () => {
  assert.doesNotThrow(() => ensureForkTarget('koupent/ECC'));
  assert.throws(() => ensureForkTarget('affaan-m/ECC'), /exactly koupent\/ECC/);
});

test('public incident payload redacts absolute paths and secrets', () => {
  const event = {
    fingerprint: 'abc',
    type: 'loop',
    severity: 'minor',
    count: 2,
    message: 'C:\\Users\\private\\repo token=supersecret'
  };
  const payload = publicIncident(event);
  assert.ok(!payload.message.includes('private'));
  assert.ok(!payload.message.includes('supersecret'));
  assert.ok(payload.message.includes('<redacted>'));
});

test('plugin manifest does not explicitly register hooks twice', () => {
  const plugin = require('../../.claude-plugin/plugin.json');
  const hooks = require('../../hooks/hooks.json').hooks;
  assert.ok(!Object.prototype.hasOwnProperty.call(plugin, 'hooks'));
  assert.ok(hooks.UserPromptSubmit.some(group => group.id === 'user:prompt:codex-context-builder'));
  assert.ok(hooks.PreToolUse.some(group => group.id === 'pre:read-search:codex-context-gate'));
  assert.ok(hooks.SessionEnd.some(group => group.id === 'session:end:codex-incident-worker'));
});

test('GateGuard standard implementation is not bypassed by Codex state', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'hooks', 'gateguard-fact-force.js'), 'utf8');
  assert.ok(!source.includes('contextReady'));
  assert.ok(!source.includes('contextCoversFile'));
  assert.ok(source.includes('isDestructiveBash'));
});

test('migrated statusline keeps dynamic windows and fork-local cache', () => {
  const statusline = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'statusline', 'statusline.sh'), 'utf8');
  const helper = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'statusline', 'bin', 'statusline-codex.sh'), 'utf8');
  assert.ok(statusline.includes('winlabel'));
  assert.ok(statusline.includes('codex_blocks'));
  assert.ok(helper.includes('ecc-koute/statusline-codex.cache'));
  assert.ok(helper.includes('account/rateLimits/read'));
});

test('upstream stable sync remains a manual fork-only draft PR', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'sync-upstream-stable.yml'), 'utf8');
  const runner = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'ci', 'sync-upstream-stable.sh'), 'utf8');
  const tracking = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'upstream-stable.json'), 'utf8'));

  assert.strictEqual(tracking.repository, 'affaan-m/ECC');
  assert.strictEqual(tracking.tag, 'v2.1.0');
  assert.match(workflow, /github\.repository == 'koupent\/ECC'/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(runner, /FORK_REPOSITORY:-.*koupent\/ECC/);
  assert.match(runner, /gh pr create[\s\S]*--draft/);
  assert.match(runner, /npm ci --ignore-scripts/);
  assert.doesNotMatch(runner, /gh pr merge|--auto|enable-auto-merge/);
  assert.doesNotMatch(runner, /--repo\s+["']?affaan-m\/ECC/);
});

test('redaction is bounded and privacy preserving', () => {
  const output = redactText(`password=hunter2 ${'x'.repeat(3000)}`);
  assert.ok(!output.includes('hunter2'));
  assert.ok(output.length <= 2000);
});

try {
  fs.rmSync(temp, { recursive: true, force: true });
} catch {
  // Best-effort cleanup of this test's own temp directory.
}

console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
