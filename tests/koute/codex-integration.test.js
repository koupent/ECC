#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadConfig } = require('../../scripts/codex/config');
const {
  hash,
  readState,
  readEvents,
  recordIncident,
  redactText,
  resetState,
  writeState
} = require('../../scripts/codex/runtime-state');
const { isTestPath, requireUsableResult, runRole, validateResult, workingTreeSignature } = require('../../scripts/codex/run-role');
const { eligible, ensureForkTarget, publicIncident } = require('../../scripts/codex/incident-worker');
const { record } = require('../../scripts/codex/record-event');
const contextGate = require('../../scripts/hooks/codex-context-gate');
const contextBuilder = require('../../scripts/hooks/codex-context-builder');
const deliveryGate = require('../../scripts/hooks/delivery-lifecycle-gate');
const deliveryCompletion = require('../../scripts/hooks/delivery-completion-gate');
const configProtection = require('../../scripts/hooks/config-protection');
const { initializeDelivery, isDeliveryRequest, parseIssueNumber, pendingSessionForProject, slug } = require('../../scripts/codex/delivery-lifecycle');

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

function createGitFixture(name) {
  const fixture = path.join(temp, name);
  fs.mkdirSync(path.join(fixture, '.ecc'), { recursive: true });
  fs.mkdirSync(path.join(fixture, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(fixture, '.ecc', 'config.json'),
    JSON.stringify({ profile: 'standard', codex: { enabled: true, timeoutSeconds: 1 } }),
    'utf8'
  );
  fs.writeFileSync(path.join(fixture, 'src', 'product.ts'), 'export const product = true;\n', 'utf8');
  assert.strictEqual(spawnSync('git', ['init', '--quiet'], { cwd: fixture }).status, 0);
  assert.strictEqual(spawnSync('git', ['config', 'user.email', 'ecc-test@example.invalid'], { cwd: fixture }).status, 0);
  assert.strictEqual(spawnSync('git', ['config', 'user.name', 'ECC Test'], { cwd: fixture }).status, 0);
  assert.strictEqual(spawnSync('git', ['add', '.'], { cwd: fixture }).status, 0);
  assert.strictEqual(spawnSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: fixture }).status, 0);
  return fixture;
}

function createCodexShim(mode, fixture) {
  // run-role invokes `codex exec ...`. Pointing the binary at Node makes `exec`
  // a portable script name on both Windows and Unix without enabling a shell.
  const script = path.join(fixture, 'exec');
  fs.writeFileSync(
    script,
    [
      "'use strict';",
      "const fs = require('fs');",
      "const path = require('path');",
      "const args = process.argv.slice(2);",
      "const output = args[args.indexOf('--output-last-message') + 1];",
      `const mode = ${JSON.stringify(mode)};`,
      "if (mode === 'timeout') { setTimeout(() => {}, 5000); return; }",
      "if (mode === 'schema') { fs.writeFileSync(output, '{}'); return; }",
      "if (mode === 'write-violation') {",
      "  fs.mkdirSync(path.join(process.cwd(), 'tests'), { recursive: true });",
      "  fs.writeFileSync(path.join(process.cwd(), 'tests', 'contract.test.ts'), 'test placeholder\\n');",
      "  fs.writeFileSync(path.join(process.cwd(), 'src', 'forbidden.ts'), 'forbidden\\n');",
      "}",
      "const context = {status:'ok',summary:'fixture context',files:['src/product.ts'],constraints:[],risks:[],verification:[]};",
      "const assessment = {status:'ok',summary:'fixture assessment',findings:[]};",
      "fs.writeFileSync(output, JSON.stringify(mode === 'context' ? context : assessment));"
    ].join('\n'),
    'utf8'
  );
  assert.strictEqual(spawnSync('git', ['add', 'exec'], { cwd: fixture }).status, 0);
  assert.strictEqual(spawnSync('git', ['commit', '--quiet', '-m', `add ${mode} shim`], { cwd: fixture }).status, 0);
  return process.execPath;
}

console.log('\n=== Koupent ECC Codex integration ===\n');

test('Codex output schemas satisfy strict Structured Outputs object requirements', () => {
  for (const schemaName of ['context-result.schema.json', 'assessment-result.schema.json']) {
    const schema = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '..', 'schemas', 'codex', schemaName), 'utf8')
    );
    const visit = (node, location = '$') => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'object') {
        assert.strictEqual(node.additionalProperties, false, `${schemaName} ${location} must reject extra properties`);
        const properties = Object.keys(node.properties || {}).sort();
        const required = [...(node.required || [])].sort();
        assert.deepStrictEqual(required, properties, `${schemaName} ${location} must require every declared property`);
      }
      for (const [key, value] of Object.entries(node)) {
        if (key === 'properties') {
          for (const [property, propertySchema] of Object.entries(value || {})) {
            visit(propertySchema, `${location}.properties.${property}`);
          }
        } else if (key === 'items') {
          visit(value, `${location}.items`);
        } else if (key === 'anyOf') {
          for (const [index, variant] of (value || []).entries()) visit(variant, `${location}.anyOf[${index}]`);
        }
      }
    };
    visit(schema);
  }
});

test('delivery GitHub retry classifier is limited to transient transport and server failures', () => {
  assert.strictEqual(deliveryCompletion.isTransientGitHubFailure('HTTP 503: server unavailable'), true);
  assert.strictEqual(deliveryCompletion.isTransientGitHubFailure('ECONNRESET'), true);
  assert.strictEqual(deliveryCompletion.isTransientGitHubFailure('HTTP 401: Bad credentials'), false);
  assert.strictEqual(deliveryCompletion.isTransientGitHubFailure('validation failed'), false);
});

test('project config opts into standard Codex integration', () => {
  const config = loadConfig(repo, env);
  assert.strictEqual(config.enabled, true);
  assert.strictEqual(config.hookProfile, 'standard');
  assert.strictEqual(config.contextModel, 'gpt-5.6-terra');
  assert.strictEqual(config.reviewModel, 'gpt-5.6-sol');
  assert.strictEqual(config.timeoutSeconds, 1800);
  assert.strictEqual(config.deliveryWorkflow, 'advisory');
});

test('delivery request classifier ignores chat and recognizes implementation work', () => {
  assert.strictEqual(isDeliveryRequest('この不具合を修正してください'), true);
  assert.strictEqual(isDeliveryRequest('設計について相談したいです'), false);
  assert.strictEqual(parseIssueNumber('https://github.com/acme/repo/issues/42'), 42);
  assert.strictEqual(slug('Fix generated worktrees'), 'fix-generated-worktrees');
});

test('required delivery gate blocks edits until issue and branch evidence are ready', () => {
  const fixture = createGitFixture('delivery-gate-repo');
  fs.writeFileSync(
    path.join(fixture, '.ecc', 'config.json'),
    JSON.stringify({ profile: 'standard', deliveryWorkflow: 'required', codex: { enabled: true } }),
    'utf8'
  );
  const fixtureEnv = { ...env, ECC_KOUTE_STATE_DIR: path.join(temp, 'delivery-gate-state') };
  const input = { session_id: 'delivery-gate', cwd: fixture };
  const delivery = initializeDelivery(input, 'worktree lintの誤検出を修正してください', { cwd: fixture, env: fixtureEnv });
  assert.strictEqual(delivery.status, 'pending');
  const raw = JSON.stringify({ ...input, tool_name: 'Edit', tool_input: { file_path: path.join(fixture, 'src', 'product.ts') } });
  const denied = JSON.parse(deliveryGate.run(raw, { cwd: fixture, env: fixtureEnv }));
  assert.strictEqual(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /--session \"delivery-gate\"/);

  const bash = JSON.stringify({ ...input, tool_name: 'Bash', tool_input: { command: 'npm test' } });
  assert.strictEqual(JSON.parse(deliveryGate.run(bash, { cwd: fixture, env: fixtureEnv })).hookSpecificOutput.permissionDecision, 'deny');
  const prepare = JSON.stringify({ ...input, tool_name: 'Bash', tool_input: { command: 'node "$CLAUDE_PLUGIN_ROOT/scripts/codex/delivery-lifecycle.js" prepare --session test' } });
  assert.strictEqual(deliveryGate.run(prepare, { cwd: fixture, env: fixtureEnv }), prepare);

  const branch = 'codex/issue-42-worktree-lint';
  assert.strictEqual(spawnSync('git', ['switch', '-c', branch], { cwd: fixture }).status, 0);
  writeState(input, { delivery: { ...delivery, status: 'ready', issue_number: 42, branch } }, fixtureEnv);
  assert.strictEqual(deliveryGate.run(raw, { cwd: fixture, env: fixtureEnv }), raw);
});

test('delivery preparation resolves the unique pending project session without relying on Bash environment propagation', () => {
  const fixture = createGitFixture('delivery-project-session-repo');
  fs.writeFileSync(
    path.join(fixture, '.ecc', 'config.json'),
    JSON.stringify({ profile: 'standard', deliveryWorkflow: 'required', codex: { enabled: true } }),
    'utf8'
  );
  const fixtureEnv = { ...env, ECC_KOUTE_STATE_DIR: path.join(temp, 'delivery-project-session-state') };
  initializeDelivery(
    { session_id: 'session-from-hook', cwd: fixture },
    '生成ディレクトリ除外を修正してください',
    { cwd: fixture, env: fixtureEnv }
  );
  assert.strictEqual(pendingSessionForProject(fixture, fixtureEnv), 'session-from-hook');
});

test('delivery completion gate rejects a review that is not bound to the current clean commit', () => {
  const fixture = createGitFixture('delivery-completion-repo');
  fs.writeFileSync(
    path.join(fixture, '.ecc', 'config.json'),
    JSON.stringify({ profile: 'standard', deliveryWorkflow: 'required', codex: { enabled: true } }),
    'utf8'
  );
  assert.strictEqual(spawnSync('git', ['add', '.ecc/config.json'], { cwd: fixture }).status, 0);
  assert.strictEqual(spawnSync('git', ['commit', '--quiet', '-m', 'require delivery workflow'], { cwd: fixture }).status, 0);
  const fixtureEnv = { ...env, ECC_KOUTE_STATE_DIR: path.join(temp, 'delivery-completion-state') };
  const input = { session_id: 'delivery-completion', cwd: fixture };
  const branch = 'codex/issue-7-task';
  assert.strictEqual(spawnSync('git', ['switch', '-c', branch], { cwd: fixture }).status, 0);
  writeState(input, {
    delivery: { status: 'ready', issue_number: 7, branch, base_branch: 'main' },
    last_role: 'review',
    review_role: 'review',
    review_status: 'ok',
    review_head: 'stale-commit',
    review_worktree_clean: true
  }, fixtureEnv);
  const output = JSON.parse(deliveryCompletion.run(JSON.stringify(input), { cwd: fixture, env: fixtureEnv }));
  assert.strictEqual(output.decision, 'block');
  assert.match(output.reason, /current clean commit/);

  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: fixture, encoding: 'utf8' }).stdout.trim();
  writeState(input, {
    review_role: 'review',
    review_status: 'ok',
    review_head: head,
    review_worktree_clean: true
  }, fixtureEnv);
  const invalidPrData = JSON.parse(deliveryCompletion.run(JSON.stringify(input), {
    cwd: fixture,
    env: fixtureEnv,
    command(binary, args, commandCwd, commandEnv) {
      if (binary === 'gh') return { ok: true, stdout: '{invalid', stderr: '' };
      return deliveryCompletion.command(binary, args, commandCwd, commandEnv);
    }
  }));
  assert.strictEqual(invalidPrData.decision, 'block');
  assert.match(invalidPrData.reason, /invalid data/);

  const wrongBase = JSON.parse(deliveryCompletion.run(JSON.stringify(input), {
    cwd: fixture,
    env: fixtureEnv,
    command(binary, args, commandCwd, commandEnv) {
      if (binary === 'gh') {
        return {
          ok: true,
          stdout: JSON.stringify([{ url: 'https://example.invalid/pr/1', isDraft: true, number: 1, body: 'Closes #7', baseRefName: 'develop' }]),
          stderr: ''
        };
      }
      return deliveryCompletion.command(binary, args, commandCwd, commandEnv);
    }
  }));
  assert.strictEqual(wrongBase.decision, 'block');
  assert.match(wrongBase.reason, /based on main/);
});

test('delivery completion gate does not allow a required pending delivery to stop silently', () => {
  const fixture = createGitFixture('delivery-pending-stop-repo');
  fs.writeFileSync(
    path.join(fixture, '.ecc', 'config.json'),
    JSON.stringify({ profile: 'standard', deliveryWorkflow: 'required', codex: { enabled: true } }),
    'utf8'
  );
  const fixtureEnv = { ...env, ECC_KOUTE_STATE_DIR: path.join(temp, 'delivery-pending-stop-state') };
  const input = { session_id: 'delivery-pending-stop', cwd: fixture };
  writeState(input, { delivery: { status: 'pending', request_hash: 'fixture' } }, fixtureEnv);
  const output = JSON.parse(deliveryCompletion.run(JSON.stringify(input), { cwd: fixture, env: fixtureEnv }));
  assert.strictEqual(output.decision, 'block');
  assert.match(output.reason, /delivery-prepare/);
});

test('config protection allows only additive generated-path exclusion with independent context and delivery evidence', () => {
  const fixture = createGitFixture('protected-config-repo');
  const configFile = path.join(fixture, 'eslint.config.mjs');
  fs.writeFileSync(configFile, "export default [{ ignores: ['.next/**'] }];\n", 'utf8');
  const fixtureEnv = { ...env, ECC_KOUTE_STATE_DIR: path.join(temp, 'protected-config-state') };
  const input = { session_id: 'protected-config', cwd: fixture };
  writeState(input, {
    context_status: 'ready',
    context: { files: ['eslint.config.mjs'] },
    delivery: { status: 'ready', issue_number: 9, branch: 'codex/issue-9-task' }
  }, fixtureEnv);
  const result = configProtection.run({
    ...input,
    tool_input: {
      file_path: configFile,
      old_string: "export default [{ ignores: ['.next/**'] }];",
      new_string: "export default [{ ignores: ['.next/**'] }];\n// Exclude generated worktrees\nexport const generatedIgnores = ['.worktrees/**'];"
    }
  }, { env: fixtureEnv });
  assert.strictEqual(result.exitCode, 0);

  const weakening = configProtection.run({
    ...input,
    tool_input: { file_path: configFile, old_string: "rules: { strict: 'error' }", new_string: "rules: { strict: 'off' }" }
  }, { env: fixtureEnv });
  assert.strictEqual(weakening.exitCode, 2);
});

test('config protection accepts structured Context Builder file evidence', () => {
  const fixture = createGitFixture('protected-config-structured-context-repo');
  const configFile = path.join(fixture, 'eslint.config.mjs');
  fs.writeFileSync(configFile, "export default [{ ignores: ['.next/**'] }];\n", 'utf8');
  const fixtureEnv = { ...env, ECC_KOUTE_STATE_DIR: path.join(temp, 'protected-config-structured-state') };
  const input = { session_id: 'protected-config-structured', cwd: fixture };
  writeState(input, {
    context_status: 'ready',
    context: { files: [{ path: 'eslint.config.mjs', reason: 'generated worktree lint scope' }] },
    delivery: { status: 'ready', issue_number: 10, branch: 'codex/issue-10-task' }
  }, fixtureEnv);
  const result = configProtection.run({
    ...input,
    tool_input: {
      file_path: configFile,
      old_string: "export default [{ ignores: ['.next/**'] }];",
      new_string: "export default [{ ignores: ['.next/**', '.worktrees/**'] }];"
    }
  }, { env: fixtureEnv });
  assert.strictEqual(result.exitCode, 0);
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
  const request = 'follow-up detail';
  writeState(
    { session_id: 'cached-context' },
    {
      context_status: 'ready',
      context_request_hash: hash(request, 32),
      context: { status: 'ok', summary: 'cached', files: [] }
    },
    env
  );
  const output = JSON.parse(
    contextBuilder.run(
      JSON.stringify({ session_id: 'cached-context', cwd: repo, prompt: request }),
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

test('dangerous Codex sandbox bypass is rejected instead of being executed', () => {
  const fixture = createGitFixture('sandbox-bypass-rejected');
  const fixtureEnv = {
    ...env,
    ECC_KOUTE_STATE_DIR: path.join(temp, 'sandbox-bypass-state'),
    ECC_CODEX_EXTERNAL_SANDBOX: '1',
    ECC_CODEX_BINARY: path.join(temp, 'must-not-run', 'codex')
  };
  const output = runRole({
    role: 'context-builder',
    request: 'inspect fixture',
    cwd: fixture,
    sessionId: 'sandbox-bypass',
    env: fixtureEnv
  });
  assert.strictEqual(output.ok, false);
  assert.match(output.error, /sandbox bypass is unsupported/);
  assert.strictEqual(readState({ session_id: 'sandbox-bypass' }, fixtureEnv).context_status, 'fallback');
});

test('Context Builder shim opens the gate without external Codex access', () => {
  const fixture = createGitFixture('context-shim-repo');
  const fixtureEnv = {
    ...env,
    ECC_KOUTE_STATE_DIR: path.join(temp, 'context-shim-state'),
    ECC_CODEX_BINARY: createCodexShim('context', fixture)
  };
  const output = runRole({
    role: 'context-builder',
    request: 'find household rename surfaces',
    cwd: fixture,
    sessionId: 'context-shim',
    env: fixtureEnv
  });
  assert.strictEqual(output.ok, true, JSON.stringify(output));
  assert.strictEqual(readState({ session_id: 'context-shim' }, fixtureEnv).context_status, 'ready');
  const raw = JSON.stringify({ session_id: 'context-shim', tool_name: 'Grep', tool_input: { pattern: 'household' } });
  assert.strictEqual(contextGate.run(raw, { cwd: fixture, env: fixtureEnv }), raw);
});

for (const failure of ['missing-binary', 'timeout', 'schema']) {
  test(`Context Builder records fallback for ${failure}`, () => {
    const fixture = createGitFixture(`failure-${failure}`);
    const fixtureEnv = {
      ...env,
      ECC_KOUTE_STATE_DIR: path.join(temp, `failure-state-${failure}`),
      ECC_CODEX_BINARY:
        failure === 'missing-binary'
          ? path.join(temp, 'does-not-exist', 'codex')
          : createCodexShim(failure, fixture),
      ECC_CODEX_TIMEOUT_SECONDS: failure === 'timeout' ? '1' : '30'
    };
    const output = runRole({
      role: 'context-builder',
      request: 'bounded fixture investigation',
      cwd: fixture,
      sessionId: `failure-${failure}`,
      env: fixtureEnv
    });
    assert.strictEqual(output.ok, false);
    assert.strictEqual(output.fallback, true);
    assert.strictEqual(readState({ session_id: `failure-${failure}` }, fixtureEnv).context_status, 'fallback');
  });
}

test('tests-only shim removes product changes and records a critical violation', () => {
  const fixture = createGitFixture('tests-only-shim-repo');
  const fixtureEnv = {
    ...env,
    ECC_KOUTE_STATE_DIR: path.join(temp, 'tests-only-shim-state'),
    ECC_CODEX_BINARY: createCodexShim('write-violation', fixture)
  };
  const output = runRole({
    role: 'contract-test',
    request: 'write an independent public contract test',
    cwd: fixture,
    sessionId: 'tests-only-shim',
    env: fixtureEnv
  });
  assert.strictEqual(output.ok, false, JSON.stringify(output));
  assert.ok(fs.existsSync(path.join(fixture, 'tests', 'contract.test.ts')));
  assert.ok(!fs.existsSync(path.join(fixture, 'src', 'forbidden.ts')));
  const incidents = readEvents(fixtureEnv, 100).filter(event => event.kind === 'incident');
  assert.ok(incidents.some(event => event.type === 'codex_write_scope_violation' && event.severity === 'critical'));
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
  assert.ok(hooks.PreToolUse.some(group => group.id === 'pre:edit-write:delivery-lifecycle'));
  assert.ok(hooks.Stop.some(group => group.id === 'stop:delivery-completion'));
  assert.ok(hooks.SessionEnd.some(group => group.id === 'session:end:codex-incident-worker'));
});

test('GateGuard reuses scoped Context Builder evidence without disabling destructive Bash checks', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'hooks', 'gateguard-fact-force.js'), 'utf8');
  assert.ok(source.includes('gateguard_context_reuse'));
  assert.ok(source.includes("codexState.context_status === 'ready'"));
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
