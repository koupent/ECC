#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadConfig } = require('../../scripts/codex/config');
const {
  atomicWrite,
  deliveryWorkspace,
  hash,
  projectFingerprint,
  readJson,
  readState,
  readEvents,
  recordIncident,
  redactText,
  resetState,
  statePath,
  writeState
} = require('../../scripts/codex/runtime-state');
const { latestState } = require('../../scripts/codex/acceptance-audit');
const { isTestPath, normalizeReviewResult, requireUsableResult, reviewSnapshot, roleInstructions, runRole, validateResult, workingTreeSignature } = require('../../scripts/codex/run-role');
const {
  acquireLock,
  classifyTarget,
  eligible,
  publicIncident
} = require('../../scripts/codex/incident-worker');
const {
  assertCentralRemediationAllowed,
  readOperatorAttestation
} = require('../../scripts/codex/incident-ownership');
const { record } = require('../../scripts/codex/record-event');
const contextGate = require('../../scripts/hooks/codex-context-gate');
const contextBuilder = require('../../scripts/hooks/codex-context-builder');
const deliveryGate = require('../../scripts/hooks/delivery-lifecycle-gate');
const deliveryCompletion = require('../../scripts/hooks/delivery-completion-gate');
const localMergePolicy = require('../../scripts/hooks/local-merge-policy-gate');
const incidentOwnershipGate = require('../../scripts/hooks/incident-ownership-gate');
const { PRE_BASH_HOOKS } = require('../../scripts/hooks/bash-hook-dispatcher');
const deliveryProgress = require('../../scripts/hooks/delivery-progress');
const deliveryFinalizer = require('../../scripts/hooks/delivery-session-finalizer');
const configProtection = require('../../scripts/hooks/config-protection');
const {
  deliveryWorktreePath,
  ensureDeliveryWorktree,
  explicitIssueNumber,
  explicitPrNumber,
  deliveryBranch,
  findDuplicateIssue,
  findExistingDeliveryPr,
  initializeDelivery,
  isDeliveryRequest,
  isSafeGitRef,
  listWorktrees,
  normalizeIssueTitle,
  parseIssueNumber,
  pendingSessionForProject,
  prepareDelivery,
  selectDeliveryBranch,
  slug,
  titleFromRequest
} = require('../../scripts/codex/delivery-lifecycle');

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
// Delivery Gateは、ECC自身のcommandをplugin本体のscriptの実体pathで見分ける。
const pluginRoot = path.resolve(__dirname, '..', '..');
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
      "if (mode === 'assert-workspace-args') {",
      "  if (!args.includes('--approve-for-me') || args.includes('--sandbox')) process.exit(23);",
      "  fs.mkdirSync(path.join(process.cwd(), 'tests'), { recursive: true });",
      "  fs.writeFileSync(path.join(process.cwd(), 'tests', 'contract.test.ts'), 'test placeholder\\n');",
      "}",
      "const context = {status:'ok',summary:'fixture context',files:['src/product.ts'],constraints:[],risks:[],verification:[]};",
      "const ownerActionFinding = {severity:'high',disposition:'owner-action',title:'owner step',path:'docs/runbook.md',line:1,evidence:'external host setup is required',recommendation:'complete the host setup',fingerprint:'owner-step'};",
      "const blockerFinding = {severity:'high',disposition:'release-blocker',title:'unsafe change',path:'src/product.ts',line:1,evidence:'the implementation is unsafe',recommendation:'fix the implementation',fingerprint:'release-blocker'};",
      "const assessment = mode === 'owner-action' ? {status:'blocked',review_complete:true,summary:'owner action remains',findings:[ownerActionFinding],followups:['Track the external host setup']} : mode === 'contradictory-blocker' ? {status:'ok',review_complete:true,summary:'incorrect model status',findings:[blockerFinding],followups:[]} : {status:'ok',review_complete:true,summary:'fixture assessment',findings:[],followups:[]};",
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
  assert.strictEqual(config.deliveryCompletion, 'draft-pr');
  assert.strictEqual(config.mergeGate.statusContext, 'Local Merge Gate');
  assert.deepStrictEqual(config.incidentHandling, {
    mode: 'report-only',
    repository: 'koupent/engineering-environment-kit'
  });
});

test('operator may load an external central-remediate config without modifying the target clone', () => {
  const configFile = path.join(temp, 'operator-config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    version: 1,
    profile: 'standard',
    rulePacks: ['common'],
    incidentHandling: {
      mode: 'central-remediate',
      repository: 'koupent/engineering-environment-kit'
    },
    codex: { enabled: true }
  }), 'utf8');
  const config = loadConfig(repo, { ...env, ECC_PROJECT_CONFIG: configFile });
  assert.strictEqual(config.projectConfigPath, configFile);
  assert.strictEqual(config.projectRoot, repo);
  assert.strictEqual(config.incidentHandling.mode, 'central-remediate');
});

test('project config opts into commit-status backed squash merge completion', () => {
  const fixture = createGitFixture('squash-config-repo');
  fs.writeFileSync(
    path.join(fixture, '.ecc', 'config.json'),
    JSON.stringify({
      profile: 'standard',
      deliveryWorkflow: 'required',
      deliveryCompletion: 'squash-merge',
      mergeGate: {
        provider: 'commit-status',
        command: 'engineering-kit-merge-gate',
        adapter: 'scripts/ci/project-verify.sh',
        statusContext: 'Local Merge Gate',
        strategy: 'squash'
      },
      codex: { enabled: true }
    }),
    'utf8'
  );
  const config = loadConfig(fixture, env);
  assert.strictEqual(config.deliveryCompletion, 'squash-merge');
  assert.strictEqual(config.mergeGate.provider, 'commit-status');
  assert.strictEqual(config.mergeGate.adapter, 'scripts/ci/project-verify.sh');
  assert.strictEqual(config.mergeGate.strategy, 'squash');
});

test('delivery request classifier ignores chat and recognizes implementation work', () => {
  assert.strictEqual(isDeliveryRequest('この不具合を修正してください'), true);
  assert.strictEqual(isDeliveryRequest('製品コードやGit管理ファイルは変更せず、受入コマンドを実行してください'), false);
  assert.strictEqual(isDeliveryRequest('設定は変更せず、この不具合を修正してください'), true);
  assert.strictEqual(isDeliveryRequest('Do not change product files; run the acceptance command once.'), false);
  assert.strictEqual(isDeliveryRequest('Do not change config; fix the parser bug.'), true);
  assert.strictEqual(isDeliveryRequest('設定変更の影響を調査してください'), false);
  assert.strictEqual(isDeliveryRequest('設定変更の影響を調査し、必要なら設定を修正してください'), true);
  assert.strictEqual(isDeliveryRequest('設計について相談したいです'), false);
  assert.strictEqual(isDeliveryRequest('Issue #251とPR #257を完遂してください'), true);
  assert.strictEqual(isDeliveryRequest('Finish PR #257 and merge it after the required gate.'), true);
  assert.strictEqual(isDeliveryRequest('Issue #251とPR #257を完遂し、GitHub MERGED確認まで進めてください'), true);
  assert.strictEqual(isDeliveryRequest('Review PR #257 merge status and report it.'), false);
  assert.match(titleFromRequest('秘密を含むかもしれない音声入力です'), /^ECC delivery [0-9a-f]{10}$/);
  assert.doesNotMatch(titleFromRequest('秘密を含むかもしれない音声入力です'), /秘密|音声/);
  assert.strictEqual(parseIssueNumber('https://github.com/acme/repo/issues/42'), 42);
  assert.strictEqual(slug('Fix generated worktrees'), 'fix-generated-worktrees');
});

test('delivery preparation prioritizes an explicit open Issue reference and normalizes Unicode titles', () => {
  assert.strictEqual(explicitIssueNumber('GitHub Issue #9「proxyへ移行」'), 9);
  assert.strictEqual(explicitIssueNumber('issue 42 を修正してください'), 42);
  assert.strictEqual(explicitIssueNumber('Issue番号を調査してください'), null);
  assert.strictEqual(explicitPrNumber('Issue #9 と PR #57 を完遂してください'), 57);
  assert.strictEqual(explicitPrNumber('PR番号を確認してください'), null);
  assert.strictEqual(normalizeIssueTitle('Proxy（移行）'), normalizeIssueTitle('proxy ( 移行 )'));

  const delivery = {
    request_hash: 'request-hash',
    title: 'GitHub Issue #9「Next.js middleware（proxyへの移行）」',
    requested_issue_number: 9
  };
  const issue = findDuplicateIssue(delivery, {
    runCommand(binary, args) {
      assert.strictEqual(binary, 'gh');
      assert.deepStrictEqual(args.slice(0, 3), ['issue', 'view', '9']);
      return JSON.stringify({ number: 9, title: 'Next.js middleware (proxyへの移行)', url: 'https://example.invalid/issues/9', state: 'OPEN' });
    }
  });
  assert.strictEqual(issue.number, 9);
  assert.throws(
    () => findDuplicateIssue(delivery, {
      runCommand() {
        return JSON.stringify({ number: 9, title: 'closed', url: 'https://example.invalid/issues/9', state: 'CLOSED' });
      }
    }),
    /not open/
  );
  assert.strictEqual(
    findDuplicateIssue(delivery, {
      allowClosedReferencedIssue: true,
      runCommand() {
        return JSON.stringify({ number: 9, title: 'closed', url: 'https://example.invalid/issues/9', state: 'CLOSED' });
      }
    }).state,
    'CLOSED'
  );
  const existingPr = findExistingDeliveryPr(
    { requested_issue_number: 9, requested_pr_number: 57 },
    'legacy-issue-9',
    {
      runCommand(binary, args) {
        assert.strictEqual(binary, 'gh');
        assert.deepStrictEqual(args.slice(0, 5), ['pr', 'list', '--head', 'legacy-issue-9', '--state']);
        return JSON.stringify([
          { number: 56, url: 'https://example.invalid/pull/56', headRefName: 'legacy-issue-9', body: 'Closes #9' },
          { number: 57, url: 'https://example.invalid/pull/57', headRefName: 'legacy-issue-9', body: 'Closes #9' }
        ]);
      }
    }
  );
  assert.strictEqual(existingPr.number, 57);
  assert.strictEqual(
    deliveryBranch(9, 'changed title', 'codex/issue-9-original-title'),
    'codex/issue-9-original-title'
  );
  assert.strictEqual(deliveryBranch(10, 'Changed title', 'main'), 'codex/issue-10-changed-title');
  assert.strictEqual(
    selectDeliveryBranch(9, 'changed title', 'main', ['codex/issue-9-original-title']),
    'codex/issue-9-original-title'
  );
  assert.throws(
    () => selectDeliveryBranch(9, 'changed title', 'main', ['codex/issue-9-a', 'codex/issue-9-b']),
    /multiple local branches/
  );
});

test('follow-up prompts preserve the active delivery and reuse its Context Builder packet', () => {
  const fixture = createGitFixture('delivery-follow-up-repo');
  fs.writeFileSync(
    path.join(fixture, '.ecc', 'config.json'),
    JSON.stringify({ profile: 'standard', deliveryWorkflow: 'required', codex: { enabled: true } }),
    'utf8'
  );
  const fixtureEnv = { ...env, ECC_KOUTE_STATE_DIR: path.join(temp, 'delivery-follow-up-state') };
  const input = { session_id: 'delivery-follow-up', cwd: fixture };
  const original = 'Issue #12 の診断表示を修正してください';
  const first = initializeDelivery(input, original, { cwd: fixture, env: fixtureEnv });
  writeState(input, {
    delivery: { ...first, status: 'ready', issue_number: 12, branch: 'codex/issue-12-diagnostics' },
    context_status: 'ready',
    context_request_hash: first.request_hash,
    context: { status: 'ok', summary: 'cached packet', files: [], constraints: [], risks: [], verification: [] }
  }, fixtureEnv);

  const followUp = 'そのまま修正を続けて、完了まで進めてください';
  const preserved = initializeDelivery(input, followUp, { cwd: fixture, env: fixtureEnv });
  assert.strictEqual(preserved.request_hash, first.request_hash);
  let reran = false;
  const output = JSON.parse(contextBuilder.run(JSON.stringify({ ...input, prompt: followUp }), {
    cwd: fixture,
    env: fixtureEnv,
    runRole() {
      reran = true;
      throw new Error('Context Builder must not rerun for a follow-up prompt');
    }
  }));
  assert.strictEqual(reran, false);
  assert.match(output.hookSpecificOutput.additionalContext, /cached packet/);
  assert.match(output.hookSpecificOutput.additionalContext, /active Delivery/);
});

test('Context Builder distinguishes unavailable evidence from verified absence and avoids delivery diagnostics', () => {
  const instructions = roleInstructions('context-builder', 'Issue #9を修正してください');
  assert.match(instructions, /unverified/i);
  assert.match(instructions, /Do not diagnose.*authentication/i);
  assert.match(instructions, /Do not claim.*missing/i);
  assert.match(instructions, /Do not execute the requested implementation, acceptance, migration, or state-changing command/i);
  assert.match(instructions, /only an explicit operational or acceptance command.*status=ok.*empty files array/i);
  assert.match(instructions, /Do not call GitHub write operations/i);
});

test('Context Builder injects an explicit Issue snapshot before entering the Codex sandbox', () => {
  const prompt = 'Issue #17 を実装してください';
  let roleOptions;
  const output = JSON.parse(
    contextBuilder.run(
      JSON.stringify({ session_id: 'issue-snapshot', cwd: repo, prompt }),
      {
        cwd: repo,
        env,
        runCommand(binary, args) {
          assert.strictEqual(binary, 'gh');
          assert.deepStrictEqual(args, [
            'issue',
            'view',
            '17',
            '--json',
            'number,title,url,state,body'
          ]);
          return JSON.stringify({
            number: 17,
            title: 'Synthetic acceptance task',
            url: 'https://example.invalid/issues/17',
            state: 'OPEN',
            body: 'requestedAt: 2026-08-18T08:00:00Z'
          });
        },
        runRole(options) {
          roleOptions = options;
          return {
            ok: true,
            result: { status: 'ok', summary: 'issue context ready', files: [], constraints: [], risks: [], verification: [] }
          };
        }
      }
    )
  );
  assert.match(roleOptions.request, /authoritative referenced Issue snapshot/);
  assert.match(roleOptions.request, /2026-08-18T08:00:00Z/);
  assert.strictEqual(roleOptions.requestHash, hash(prompt, 32));
  assert.match(output.hookSpecificOutput.additionalContext, /issue context ready/);
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
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /--session "delivery-gate"/);
  assert.doesNotMatch(denied.hookSpecificOutput.permissionDecisionReason, /CLAUDE_PLUGIN_ROOT/);
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /delivery-lifecycle\.js/);
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /reset\.js/);
  // pending時の案内も「prepareが共有ツリーのbranchを切り替える」と読めてはいけない。
  // 実装はIssueごとのworktreeで行う契約である。
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /never switches the shared working tree/);
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /separate worktree/);
  assert.doesNotMatch(
    fs.readFileSync(path.join(__dirname, '..', '..', 'commands', 'codex-task-reset.md'), 'utf8'),
    /\$CLAUDE_PLUGIN_ROOT/
  );
  assert.strictEqual(deliveryGate.isExactLifecycleCommand(
    'node "/plugin/scripts/codex/delivery-lifecycle.js" prepare --session "delivery-gate"',
    'prepare'
  ), true);
  assert.strictEqual(deliveryGate.isExactLifecycleCommand(
    '"C:\\Program Files\\Node (x86)\\node.exe" "C:\\A&B\\scripts\\codex\\delivery-lifecycle.js" prepare --session "delivery-gate"',
    'prepare'
  ), true);
  assert.strictEqual(deliveryGate.isExactLifecycleCommand(
    'node "/opt/A&B/ECC/scripts/codex/reset.js" "delivery-gate"',
    'reset'
  ), true);
  for (const bypass of [
    'echo node /plugin/scripts/codex/delivery-lifecycle.js prepare',
    'node /plugin/scripts/codex/delivery-lifecycle.js prepare && git add .',
    'node /plugin/scripts/codex/delivery-lifecycle.js prepare; git add .',
    'node /plugin/scripts/codex/delivery-lifecycle.js prepare --session x&make',
    'node /plugin/scripts/codex/reset.js x&make',
    'node "/plugin/$(make)/scripts/codex/reset.js" x',
    'node "${NODE_BINARY@P}" "/plugin/scripts/codex/delivery-lifecycle.js" prepare',
    'node "${CLAUDE_PLUGIN_ROOT@P}/scripts/codex/reset.js" x',
    'node /plugin/scripts/codex/delivery-lifecycle.js prepare $(git add .)'
  ]) {
    assert.strictEqual(deliveryGate.isExactLifecycleCommand(bypass, 'prepare'), false, bypass);
  }

  const bash = JSON.stringify({ ...input, tool_name: 'Bash', tool_input: { command: 'npm test' } });
  assert.strictEqual(JSON.parse(deliveryGate.run(bash, { cwd: fixture, env: fixtureEnv })).hookSpecificOutput.permissionDecision, 'deny');
  const prepare = JSON.stringify({ ...input, tool_name: 'Bash', tool_input: { command: 'node "$CLAUDE_PLUGIN_ROOT/scripts/codex/delivery-lifecycle.js" prepare --session test' } });
  assert.strictEqual(deliveryGate.run(prepare, { cwd: fixture, env: fixtureEnv }), prepare);
  const reset = JSON.stringify({ ...input, tool_name: 'Bash', tool_input: { command: 'node "/plugin/scripts/codex/reset.js" delivery-gate' } });
  assert.strictEqual(deliveryGate.run(reset, { cwd: fixture, env: fixtureEnv }), reset);

  const branch = 'codex/issue-42-worktree-lint';
  assert.strictEqual(spawnSync('git', ['switch', '-c', branch], { cwd: fixture }).status, 0);
  // worktreeを記録していない `ready` は、払い出し以前に共有作業ツリーで始まったDeliveryで
  // ある。そのまま編集を通すと、Issueが報告した「全ての作業が単一ツリーに集中する」経路が
  // 移行期のDeliveryにだけ残る。移行が済むまでprepareとreset以外を止める。
  writeState(input, { delivery: { ...delivery, status: 'ready', issue_number: 42, branch } }, fixtureEnv);
  const migrationPending = JSON.parse(deliveryGate.run(raw, { cwd: fixture, env: fixtureEnv }));
  assert.strictEqual(migrationPending.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(migrationPending.hookSpecificOutput.permissionDecisionReason, /prepared before deliveries were isolated/);
  assert.match(migrationPending.hookSpecificOutput.permissionDecisionReason, new RegExp(branch));
  assert.strictEqual(
    JSON.parse(deliveryGate.run(bash, { cwd: fixture, env: fixtureEnv })).hookSpecificOutput.permissionDecision,
    'deny'
  );
  // 拒否理由が案内するECC自身のcommandだけは、移行の間も実行できる。
  for (const command of [
    `node "${path.join(pluginRoot, 'scripts', 'codex', 'delivery-lifecycle.js')}" prepare --session delivery-gate`,
    `node "${path.join(pluginRoot, 'scripts', 'codex', 'reset.js')}" delivery-gate`
  ]) {
    const recovery = JSON.stringify({ ...input, tool_name: 'Bash', tool_input: { command } });
    assert.strictEqual(deliveryGate.run(recovery, { cwd: fixture, env: fixtureEnv }), recovery, command);
  }
  writeState(input, { delivery: { ...delivery, status: 'draft-pr', issue_number: 42, branch } }, fixtureEnv);
  assert.strictEqual(deliveryGate.run(bash, { cwd: fixture, env: fixtureEnv }), bash);
  assert.strictEqual(deliveryGate.run(raw, { cwd: fixture, env: fixtureEnv }), raw);
});

test('preparation issues an Issue worktree instead of switching the shared working tree', () => {
  const fixture = createGitFixture('delivery-worktree-repo');
  fs.writeFileSync(
    path.join(fixture, '.ecc', 'config.json'),
    JSON.stringify({ profile: 'standard', deliveryWorkflow: 'required', codex: { enabled: true } }),
    'utf8'
  );
  assert.strictEqual(spawnSync('git', ['add', '.ecc/config.json'], { cwd: fixture }).status, 0);
  assert.strictEqual(spawnSync('git', ['commit', '--quiet', '-m', 'require delivery workflow'], { cwd: fixture }).status, 0);
  const baseBranch = spawnSync('git', ['branch', '--show-current'], { cwd: fixture, encoding: 'utf8' }).stdout.trim();
  const fixtureEnv = {
    ...env,
    ECC_KOUTE_STATE_DIR: path.join(temp, 'delivery-worktree-state'),
    CLAUDE_PLUGIN_ROOT: pluginRoot
  };
  const input = { session_id: 'delivery-worktree', cwd: fixture };
  const branch = 'codex/issue-79-worktree-isolation';
  writeState(input, {
    delivery: {
      status: 'pending',
      request_hash: 'worktree-fixture',
      title: 'preparation must not touch the shared tree',
      base_branch: baseBranch,
      issue_number: 79,
      issue_url: 'https://example.invalid/issues/79',
      branch,
      draft_pr_url: null
    }
  }, fixtureEnv);

  // 共有ツリーは未コミットの別作業を抱えたままでよい。隔離が必要な状況こそ
  // prepareが通らなければならない。
  fs.writeFileSync(path.join(fixture, 'src', 'other-tool.ts'), 'export const other = true;\n', 'utf8');

  const ready = prepareDelivery(input, { cwd: fixture, env: fixtureEnv });
  assert.strictEqual(ready.status, 'ready');
  assert.strictEqual(ready.branch, branch);
  assert.strictEqual(ready.worktree_created, true);
  assert.strictEqual(ready.branch_switch, null);
  assert.notStrictEqual(fs.realpathSync(ready.worktree_path), fs.realpathSync(fixture));
  assert.strictEqual(ready.worktree_path, deliveryWorktreePath(fs.realpathSync(fixture), branch));
  assert.ok(fs.existsSync(path.join(ready.worktree_path, 'src', 'product.ts')));
  // 共有ツリーのbranchも未コミットの変更もそのまま残る。
  assert.strictEqual(spawnSync('git', ['branch', '--show-current'], { cwd: fixture, encoding: 'utf8' }).stdout.trim(), baseBranch);
  assert.ok(fs.existsSync(path.join(fixture, 'src', 'other-tool.ts')));
  assert.strictEqual(
    spawnSync('git', ['branch', '--show-current'], { cwd: ready.worktree_path, encoding: 'utf8' }).stdout.trim(),
    branch
  );
  // worktreeはリポジトリの外に置かれ、共有ツリーの `git status` を汚さない。
  assert.ok(!path.resolve(ready.worktree_path).startsWith(`${path.resolve(fixture)}${path.sep}`));

  // 中断後の再prepareや同じIssueの再開は、同じworktreeを再利用し、二本目のbranchも
  // directoryも作らない。
  writeState(input, { delivery: { ...ready, status: 'pending' } }, fixtureEnv);
  const reprepared = prepareDelivery(input, { cwd: fixture, env: fixtureEnv });
  assert.strictEqual(reprepared.worktree_path, ready.worktree_path);
  assert.strictEqual(reprepared.worktree_created, false);
  assert.strictEqual(listWorktrees({ cwd: fixture, env: fixtureEnv }).length, 2);

  // Gateはcwdではなく記録済みworktreeのbranchで判定する。
  const worktreeEdit = JSON.stringify({
    ...input,
    tool_name: 'Edit',
    tool_input: { file_path: path.join(ready.worktree_path, 'src', 'product.ts') }
  });
  assert.strictEqual(deliveryGate.run(worktreeEdit, { cwd: fixture, env: fixtureEnv }), worktreeEdit);

  const sharedEdit = JSON.stringify({
    ...input,
    tool_name: 'Edit',
    tool_input: { file_path: path.join(fixture, 'src', 'product.ts') }
  });
  const deniedEdit = JSON.parse(deliveryGate.run(sharedEdit, { cwd: fixture, env: fixtureEnv }));
  assert.strictEqual(deniedEdit.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(
    deniedEdit.hookSpecificOutput.permissionDecisionReason,
    new RegExp(path.join(ready.worktree_path, 'src', 'product.ts').replace(/[\\^$*+?.()|[\]{}]/g, '\\$&'))
  );

  // 編集対象はトップレベルのfile_pathだけではない。MultiEditの編集ごとのpathも
  // NotebookEditのnotebook_pathも共有ツリーを書き換える。
  const worktreeMultiEdit = JSON.stringify({
    ...input,
    tool_name: 'MultiEdit',
    tool_input: {
      file_path: path.join(ready.worktree_path, 'src', 'product.ts'),
      edits: [{ file_path: path.join(ready.worktree_path, 'src', 'product.ts'), old_string: 'a', new_string: 'b' }]
    }
  });
  assert.strictEqual(deliveryGate.run(worktreeMultiEdit, { cwd: fixture, env: fixtureEnv }), worktreeMultiEdit);
  for (const toolInput of [
    {
      file_path: path.join(ready.worktree_path, 'src', 'product.ts'),
      edits: [{ file_path: path.join(fixture, 'src', 'product.ts'), old_string: 'a', new_string: 'b' }]
    },
    { edits: [{ file_path: path.join(fixture, 'src', 'product.ts'), old_string: 'a', new_string: 'b' }] }
  ]) {
    const smuggled = JSON.stringify({ ...input, tool_name: 'MultiEdit', tool_input: toolInput });
    const deniedMultiEdit = JSON.parse(deliveryGate.run(smuggled, { cwd: fixture, env: fixtureEnv }));
    assert.strictEqual(deniedMultiEdit.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(deniedMultiEdit.hookSpecificOutput.permissionDecisionReason, /delivery worktree/);
  }
  const sharedNotebook = JSON.stringify({
    ...input,
    tool_name: 'NotebookEdit',
    tool_input: { notebook_path: path.join(fixture, 'src', 'analysis.ipynb') }
  });
  assert.strictEqual(
    JSON.parse(deliveryGate.run(sharedNotebook, { cwd: fixture, env: fixtureEnv })).hookSpecificOutput.permissionDecision,
    'deny'
  );
  // 書き込み先を読み取れないtool呼び出しは、worktreeの中だと決めつけずに止める。
  const pathlessWrite = JSON.stringify({ ...input, tool_name: 'Write', tool_input: { content: 'x' } });
  const deniedPathless = JSON.parse(deliveryGate.run(pathlessWrite, { cwd: fixture, env: fixtureEnv }));
  assert.strictEqual(deniedPathless.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(deniedPathless.hookSpecificOutput.permissionDecisionReason, /did not name a file to write/);

  const sharedCommit = JSON.stringify({ ...input, tool_name: 'Bash', tool_input: { command: 'git commit -am "fix"' } });
  const deniedCommit = JSON.parse(deliveryGate.run(sharedCommit, { cwd: fixture, env: fixtureEnv }));
  assert.strictEqual(deniedCommit.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(deniedCommit.hookSpecificOutput.permissionDecisionReason, /isolated in the worktree/);
  const worktreeCommit = JSON.stringify({
    ...input,
    tool_name: 'Bash',
    tool_input: { command: `git -C "${ready.worktree_path}" commit -am "fix"` }
  });
  assert.strictEqual(deliveryGate.run(worktreeCommit, { cwd: fixture, env: fixtureEnv }), worktreeCommit);
  const worktreeCd = JSON.stringify({
    ...input,
    tool_name: 'Bash',
    tool_input: { command: `cd "${ready.worktree_path}" && git commit -am "fix"` }
  });
  assert.strictEqual(deliveryGate.run(worktreeCd, { cwd: fixture, env: fixtureEnv }), worktreeCd);
  // pathを引数に書いただけのGit書き込みは、共有ツリーで走るので拒否する。
  const mentionOnly = JSON.stringify({
    ...input,
    tool_name: 'Bash',
    tool_input: { command: `git add "${path.join(ready.worktree_path, 'src', 'product.ts')}"` }
  });
  assert.strictEqual(
    JSON.parse(deliveryGate.run(mentionOnly, { cwd: fixture, env: fixtureEnv })).hookSpecificOutput.permissionDecision,
    'deny'
  );
  // 列挙漏れのsubcommandや、cdの成否に依存する形での共有ツリー書き込みも止める。
  // Git以外のcommand、リダイレクト、任意のcodeを実行する形も同じく共有ツリーを書き換える。
  for (const command of [
    'git mv src/product.ts src/renamed.ts',
    `cd "${ready.worktree_path}/missing" || git reset --hard`,
    'sh -c "git reset --hard"',
    `git --work-tree "${fixture}" checkout -- .`,
    'touch src/product.ts',
    'rm -rf src',
    'npm test',
    'npm run build -- --out src',
    'node -e "require(\'fs\').writeFileSync(\'src/product.ts\', \'\')"',
    'echo bypass > src/product.ts',
    'git status --porcelain > src/status.txt',
    `cd "${ready.worktree_path}" && echo bypass > "${path.join(fixture, 'src', 'product.ts')}"`,
    // 読み取り扱いのcommandでも、引数次第で共有ツリーへ書き、外部programを起動する。
    'sort -o src/product.ts src/product.ts',
    'sort --output=src/product.ts src/product.ts',
    'sort --compress-program=./evil src/product.ts',
    'diff --output=src/product.ts src/product.ts src/product.ts',
    'tree -o src/product.ts',
    'uniq src/product.ts src/product.ts',
    'rg --pre ./evil pattern',
    'rg --pre=./evil pattern',
    // 環境変数の前置きは、commandがどのprogramに解決されるかを差し替える。
    `PATH="${ready.worktree_path}" cat src/product.ts`,
    // pathを付けた実行ファイルは、名前が同じでもPATHのcommandとは限らない。
    `"${path.join(ready.worktree_path, 'sort')}" src/product.ts`,
    './sort src/product.ts',
    `"${path.join(ready.worktree_path, 'git')}" commit -am "fix"`,
    // ECCのcommandは名前ではなくplugin本体のscriptの実体で見分ける。
    'node /tmp/evil/scripts/codex/run-role.js review --session test',
    `node "${path.join(ready.worktree_path, 'scripts', 'codex', 'run-role.js')}" review --session test`,
    'node "$ECC_UNKNOWN_ROOT/scripts/codex/run-role.js" review --session test'
  ]) {
    const bypass = JSON.stringify({ ...input, tool_name: 'Bash', tool_input: { command } });
    const denied = JSON.parse(deliveryGate.run(bypass, { cwd: fixture, env: fixtureEnv }));
    assert.strictEqual(denied.hookSpecificOutput.permissionDecision, 'deny', command);
    assert.match(denied.hookSpecificOutput.permissionDecisionReason, /isolated in the worktree/);
  }
  // 副作用のない読み取り、worktreeの中で走る検証、ECC自身のworktree対応commandは通る。
  for (const command of [
    'git status --porcelain',
    'cat src/product.ts',
    'sort src/product.ts',
    'uniq -c src/product.ts',
    'grep -rn "product" src',
    `cd "${ready.worktree_path}" && npm test`,
    `cd "${ready.worktree_path}" && npm test > report.log`,
    `cd "${ready.worktree_path}" && sort -o sorted.txt src/product.ts`,
    'node "$CLAUDE_PLUGIN_ROOT/scripts/codex/run-role.js" review --request "Review" --session test',
    `node "${path.join(pluginRoot, 'scripts', 'codex', 'acceptance-audit.js')}" --issue 79`
  ]) {
    const allowed = JSON.stringify({ ...input, tool_name: 'Bash', tool_input: { command } });
    assert.strictEqual(deliveryGate.run(allowed, { cwd: fixture, env: fixtureEnv }), allowed, command);
  }
});

test('isolation holds against attached redirections, writing Git arguments, and symlink escapes', () => {
  const fixture = createGitFixture('delivery-escape-repo');
  fs.writeFileSync(
    path.join(fixture, '.ecc', 'config.json'),
    JSON.stringify({ profile: 'standard', deliveryWorkflow: 'required', codex: { enabled: true } }),
    'utf8'
  );
  const baseBranch = spawnSync('git', ['branch', '--show-current'], { cwd: fixture, encoding: 'utf8' }).stdout.trim();
  const branch = 'codex/issue-79-escape-paths';
  const worktreePath = path.join(temp, 'delivery-escape-worktree');
  assert.strictEqual(
    spawnSync('git', ['worktree', 'add', '--quiet', '-b', branch, worktreePath], { cwd: fixture }).status,
    0
  );
  const fixtureEnv = { ...env, ECC_KOUTE_STATE_DIR: path.join(temp, 'delivery-escape-state') };
  const input = { session_id: 'delivery-escape', cwd: fixture };
  writeState(input, {
    delivery: {
      status: 'ready',
      request_hash: 'escape-fixture',
      title: 'the gate must not be talked out of the worktree',
      base_branch: baseBranch,
      issue_number: 79,
      issue_url: 'https://example.invalid/issues/79',
      branch,
      worktree_path: worktreePath,
      draft_pr_url: null
    }
  }, fixtureEnv);

  const denyBash = command => {
    const payload = JSON.stringify({ ...input, tool_name: 'Bash', tool_input: { command } });
    const decision = JSON.parse(deliveryGate.run(payload, { cwd: fixture, env: fixtureEnv }));
    assert.strictEqual(decision.hookSpecificOutput.permissionDecision, 'deny', command);
  };
  const allowBash = command => {
    const payload = JSON.stringify({ ...input, tool_name: 'Bash', tool_input: { command } });
    assert.strictEqual(deliveryGate.run(payload, { cwd: fixture, env: fixtureEnv }), payload, command);
  };

  // リダイレクト演算子はtokenの先頭に限らない。shellは `word>file` も出力先として解釈する。
  for (const command of [
    'echo payload marker>src/product.ts',
    'echo payload marker>>src/product.ts',
    'echo payload 2>src/product.ts',
    'echo payload>"src/product.ts"',
    'git status --porcelain>src/status.txt'
  ]) denyBash(command);

  // 読み取り扱いのsubcommandでも、引数次第でファイルを書き、外部programを起動する。
  for (const command of [
    'git diff --output=src/product.ts',
    'git diff --output src/product.ts',
    'git log --output=src/product.ts',
    'git grep -O./evil pattern',
    'git diff --ext-diff',
    'git -c diff.external=./evil diff'
  ]) denyBash(command);

  // 引用された `>` は引数であり、共有ツリーの読み取りとworktreeの中の書き込みは通り続ける。
  allowBash('git status --porcelain');
  allowBash('git log --oneline -5');
  allowBash('git diff --stat HEAD -- src/product.ts');
  allowBash(`git -C "${worktreePath}" commit -m "note > file"`);
  allowBash(`cd "${worktreePath}" && git diff --output=report.diff`);

  // worktreeの中のsymlinkが共有ツリーを指す場合、字面のpathだけではworktreeの中に見える。
  const linkPath = path.join(worktreePath, 'linked-shared');
  let symlinked = true;
  try {
    fs.symlinkSync(fixture, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    // symlinkを作れない環境ではこの経路自体が存在しない。
    symlinked = false;
  }
  if (symlinked) {
    denyBash(`cd "${worktreePath}" && echo bypass > linked-shared/src/product.ts`);
    denyBash(`cd "${linkPath}" && git commit -am "fix"`);
    const linkedEdit = JSON.stringify({
      ...input,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(linkPath, 'src', 'product.ts') }
    });
    const deniedLink = JSON.parse(deliveryGate.run(linkedEdit, { cwd: fixture, env: fixtureEnv }));
    assert.strictEqual(deniedLink.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(deniedLink.hookSpecificOutput.permissionDecisionReason, /delivery worktree/);
  }
  // worktreeの実体そのものへの編集は通り続ける。
  const worktreeEdit = JSON.stringify({
    ...input,
    tool_name: 'Edit',
    tool_input: { file_path: path.join(worktreePath, 'src', 'product.ts') }
  });
  assert.strictEqual(deliveryGate.run(worktreeEdit, { cwd: fixture, env: fixtureEnv }), worktreeEdit);
});

test('isolation holds when the session runs from a subdirectory of the shared working tree', () => {
  const fixture = createGitFixture('delivery-subdirectory-repo');
  fs.writeFileSync(
    path.join(fixture, '.ecc', 'config.json'),
    JSON.stringify({ profile: 'standard', deliveryWorkflow: 'required', codex: { enabled: true } }),
    'utf8'
  );
  // 単一リポジトリの中にpackageを抱える構成では、cwdがリポジトリの根とは限らない。
  const subdirectory = path.join(fixture, 'packages', 'app');
  fs.mkdirSync(subdirectory, { recursive: true });
  const baseBranch = spawnSync('git', ['branch', '--show-current'], { cwd: fixture, encoding: 'utf8' }).stdout.trim();
  const branch = 'codex/issue-79-subdirectory';
  const worktreePath = path.join(temp, 'delivery-subdirectory-worktree');
  assert.strictEqual(
    spawnSync('git', ['worktree', 'add', '--quiet', '-b', branch, worktreePath], { cwd: fixture }).status,
    0
  );
  const fixtureEnv = { ...env, ECC_KOUTE_STATE_DIR: path.join(temp, 'delivery-subdirectory-state') };
  const input = { session_id: 'delivery-subdirectory', cwd: subdirectory };
  writeState(input, {
    delivery: {
      status: 'ready',
      request_hash: 'subdirectory-fixture',
      title: 'the shared tree boundary is the repository root',
      base_branch: baseBranch,
      issue_number: 79,
      issue_url: 'https://example.invalid/issues/79',
      branch,
      worktree_path: worktreePath,
      draft_pr_url: null
    }
  }, fixtureEnv);

  const decide = payload => JSON.parse(deliveryGate.run(JSON.stringify(payload), { cwd: subdirectory, env: fixtureEnv }));
  // cwdを境界にすると、`../../src/product.ts` は共有ツリーの外に見えてしまう。
  for (const toolCall of [
    { tool_name: 'Edit', tool_input: { file_path: path.join('..', '..', 'src', 'product.ts') } },
    { tool_name: 'Edit', tool_input: { file_path: path.join(fixture, 'src', 'product.ts') } },
    { tool_name: 'Write', tool_input: { file_path: path.join(fixture, 'README.md'), content: 'x' } },
    {
      tool_name: 'MultiEdit',
      tool_input: {
        file_path: path.join(worktreePath, 'src', 'product.ts'),
        edits: [{ file_path: path.join('..', '..', 'src', 'product.ts'), old_string: 'a', new_string: 'b' }]
      }
    },
    { tool_name: 'NotebookEdit', tool_input: { notebook_path: path.join('..', '..', 'src', 'analysis.ipynb') } }
  ]) {
    const denied = decide({ ...input, ...toolCall });
    assert.strictEqual(denied.hookSpecificOutput.permissionDecision, 'deny', JSON.stringify(toolCall.tool_input));
    assert.match(denied.hookSpecificOutput.permissionDecisionReason, /delivery worktree/);
  }
  // 共有ツリーの根を基準に、worktree側の対応pathを案内する。
  assert.match(
    decide({ ...input, tool_name: 'Edit', tool_input: { file_path: path.join('..', '..', 'src', 'product.ts') } })
      .hookSpecificOutput.permissionDecisionReason,
    new RegExp(path.join(worktreePath, 'src', 'product.ts').replace(/[\\^$*+?.()|[\]{}]/g, '\\$&'))
  );

  for (const command of [
    'echo bypass > ../../src/product.ts',
    'cd ../.. && git commit -am "fix"',
    'cd ../.. && touch src/product.ts'
  ]) {
    const denied = decide({ ...input, tool_name: 'Bash', tool_input: { command } });
    assert.strictEqual(denied.hookSpecificOutput.permissionDecision, 'deny', command);
    assert.match(denied.hookSpecificOutput.permissionDecisionReason, /isolated in the worktree/);
  }

  // worktreeの中の作業と、共有ツリーの読み取りは、subdirectoryからでも通り続ける。
  const worktreeEdit = JSON.stringify({
    ...input,
    tool_name: 'Edit',
    tool_input: { file_path: path.join(worktreePath, 'src', 'product.ts') }
  });
  assert.strictEqual(deliveryGate.run(worktreeEdit, { cwd: subdirectory, env: fixtureEnv }), worktreeEdit);
  for (const command of ['git status --porcelain', `cd "${worktreePath}" && npm test`]) {
    const allowed = JSON.stringify({ ...input, tool_name: 'Bash', tool_input: { command } });
    assert.strictEqual(deliveryGate.run(allowed, { cwd: subdirectory, env: fixtureEnv }), allowed, command);
  }
});

test('the boundary holds when the session itself already runs inside the delivery worktree', () => {
  const fixture = createGitFixture('delivery-inside-worktree-repo');
  fs.writeFileSync(
    path.join(fixture, '.ecc', 'config.json'),
    JSON.stringify({ profile: 'standard', deliveryWorkflow: 'required', codex: { enabled: true } }),
    'utf8'
  );
  // worktreeにも同じ設定が渡るよう、payload前にcommitしておく。
  assert.strictEqual(spawnSync('git', ['add', '.ecc/config.json'], { cwd: fixture }).status, 0);
  assert.strictEqual(spawnSync('git', ['commit', '--quiet', '-m', 'require delivery workflow'], { cwd: fixture }).status, 0);
  const baseBranch = spawnSync('git', ['branch', '--show-current'], { cwd: fixture, encoding: 'utf8' }).stdout.trim();
  const branch = 'codex/issue-79-inside-worktree';
  const worktreePath = path.join(temp, 'delivery-inside-worktree-tree');
  const siblingPath = path.join(temp, 'delivery-inside-worktree-sibling');
  assert.strictEqual(
    spawnSync('git', ['worktree', 'add', '--quiet', '-b', branch, worktreePath], { cwd: fixture }).status,
    0
  );
  assert.strictEqual(
    spawnSync('git', ['worktree', 'add', '--quiet', '-b', 'codex/issue-80-sibling', siblingPath], { cwd: fixture }).status,
    0
  );
  const fixtureEnv = { ...env, ECC_KOUTE_STATE_DIR: path.join(temp, 'delivery-inside-worktree-state') };
  // 手順書どおり、以後の作業は払い出されたworktreeの中で進む。cwdはworktreeである。
  const input = { session_id: 'delivery-inside-worktree', cwd: worktreePath };
  writeState(input, {
    // prepareが記録するのと同じ、共有リポジトリのproject識別子。cwdが記録worktreeそのもの
    // であるときに、記録pathの素性を突き合わせる拠り所になる。
    project: projectFingerprint(fixture),
    delivery: {
      status: 'ready',
      request_hash: 'inside-worktree-fixture',
      title: 'the gate must not switch itself off inside the worktree',
      base_branch: baseBranch,
      issue_number: 79,
      issue_url: 'https://example.invalid/issues/79',
      branch,
      worktree_path: worktreePath,
      draft_pr_url: null
    }
  }, fixtureEnv);

  const decide = payload => JSON.parse(deliveryGate.run(JSON.stringify(payload), { cwd: worktreePath, env: fixtureEnv }));
  // cwdとworktreeが一致すると境界検査ごと消える実装では、共有ツリーも兄弟worktreeも
  // 絶対pathでそのまま書き換えられてしまう。
  for (const toolCall of [
    { tool_name: 'Edit', tool_input: { file_path: path.join(fixture, 'src', 'product.ts') } },
    { tool_name: 'Write', tool_input: { file_path: path.join(siblingPath, 'src', 'product.ts'), content: 'x' } },
    {
      tool_name: 'MultiEdit',
      tool_input: {
        file_path: path.join(worktreePath, 'src', 'product.ts'),
        edits: [{ file_path: path.join(fixture, 'src', 'product.ts'), old_string: 'a', new_string: 'b' }]
      }
    },
    { tool_name: 'NotebookEdit', tool_input: { notebook_path: path.join(fixture, 'src', 'analysis.ipynb') } }
  ]) {
    const denied = decide({ ...input, ...toolCall });
    assert.strictEqual(denied.hookSpecificOutput.permissionDecision, 'deny', JSON.stringify(toolCall.tool_input));
    assert.match(denied.hookSpecificOutput.permissionDecisionReason, /delivery worktree/);
  }

  for (const command of [
    `git -C "${fixture}" reset --hard`,
    `git -C "${siblingPath}" commit -am "fix"`,
    `echo bypass > "${path.join(fixture, 'src', 'product.ts')}"`,
    `cd "${fixture}" && touch src/product.ts`,
    `echo "safe\\""; git -C "${fixture}" reset --hard`,
    // worktreeの中で走っていても、引数は共有ツリーや兄弟worktreeを指せる。
    `rm -rf "${path.join(fixture, 'src')}"`,
    `cp src/product.ts "${path.join(siblingPath, 'src', 'product.ts')}"`,
    `ln -s "${fixture}" linked-shared`,
    'rm -rf "$SHARED_TREE"',
    // 引数のcodeをそのまま実行する形は、何をどこへ書くかcommandから追えない。
    `node -e "require('fs').rmSync('${fixture}', { recursive: true })"`,
    'node --eval "process.exit(0)"',
    // gitがworktreeで走っても、出力先の引数は外を指せる。
    `git diff --output="${path.join(fixture, 'leak.diff')}"`
  ]) {
    const denied = decide({ ...input, tool_name: 'Bash', tool_input: { command } });
    assert.strictEqual(denied.hookSpecificOutput.permissionDecision, 'deny', command);
    assert.match(denied.hookSpecificOutput.permissionDecisionReason, /isolated in the worktree/);
  }

  // worktreeの中の作業は、cwdがworktreeでもそのまま通り続ける。
  for (const toolInput of [
    { file_path: path.join(worktreePath, 'src', 'product.ts') },
    { file_path: path.join('src', 'product.ts') }
  ]) {
    const allowed = JSON.stringify({ ...input, tool_name: 'Edit', tool_input: toolInput });
    assert.strictEqual(deliveryGate.run(allowed, { cwd: worktreePath, env: fixtureEnv }), allowed, toolInput.file_path);
  }
  for (const command of [
    'git commit -am "fix"',
    'npm test',
    'git status --porcelain',
    // worktreeの中で完結する作業と、共有ツリーを読むだけのcommandは通り続ける。
    'rm -rf node_modules',
    'node scripts/build.js',
    'git diff --output=review.diff',
    `cat "${path.join(fixture, 'src', 'product.ts')}"`
  ]) {
    const allowed = JSON.stringify({ ...input, tool_name: 'Bash', tool_input: { command } });
    assert.strictEqual(deliveryGate.run(allowed, { cwd: worktreePath, env: fixtureEnv }), allowed, command);
  }
});

test('an existing linked worktree is reused, and the shared working tree is never adopted', () => {
  const executed = [];
  const runCommand = (binary, args) => {
    executed.push([binary, ...args].join(' '));
    if (args[0] === 'worktree' && args[1] === 'list') {
      return [
        `worktree ${path.join(temp, 'reuse-main')}`,
        'branch refs/heads/main',
        '',
        `worktree ${path.join(temp, 'reuse-main-worktrees', 'codex-issue-68-existing')}`,
        'branch refs/heads/codex/issue-68-existing',
        ''
      ].join('\n');
    }
    return '';
  };
  fs.mkdirSync(path.join(temp, 'reuse-main'), { recursive: true });
  fs.mkdirSync(path.join(temp, 'reuse-main-worktrees', 'codex-issue-68-existing'), { recursive: true });

  const worktree = ensureDeliveryWorktree({ base_branch: 'main' }, 'codex/issue-68-existing', {
    cwd: path.join(temp, 'reuse-main'),
    runCommand
  });
  assert.strictEqual(worktree.created, false);
  assert.strictEqual(worktree.path, path.join(temp, 'reuse-main-worktrees', 'codex-issue-68-existing'));
  assert.ok(executed.every(command => !/worktree (add|remove|prune)/.test(command)));

  // 共有ツリーが対象branchをcheckoutしている場合は、そのツリーを作業場所として
  // 受け入れない。branchを手放してもらうまでfail-closeする。
  assert.throws(
    () => ensureDeliveryWorktree({ base_branch: 'main' }, 'main', {
      cwd: path.join(temp, 'reuse-main'),
      runCommand
    }),
    /checked out in the shared working tree/
  );
  assert.ok(executed.every(command => !/worktree (add|remove|prune)/.test(command)));
});

test('preparation fails closed while the shared working tree holds the delivery branch', () => {
  const fixture = createGitFixture('delivery-shared-branch-repo');
  fs.writeFileSync(
    path.join(fixture, '.ecc', 'config.json'),
    JSON.stringify({ profile: 'standard', deliveryWorkflow: 'required', codex: { enabled: true } }),
    'utf8'
  );
  assert.strictEqual(spawnSync('git', ['add', '.ecc/config.json'], { cwd: fixture }).status, 0);
  assert.strictEqual(spawnSync('git', ['commit', '--quiet', '-m', 'require delivery workflow'], { cwd: fixture }).status, 0);
  const baseBranch = spawnSync('git', ['branch', '--show-current'], { cwd: fixture, encoding: 'utf8' }).stdout.trim();
  const branch = 'codex/issue-79-shared-checkout';
  // 共有ツリーが対象branchをcheckoutしている状態。ここを作業場所にすると隔離が消える。
  assert.strictEqual(spawnSync('git', ['switch', '--quiet', '-c', branch], { cwd: fixture }).status, 0);
  const fixtureEnv = { ...env, ECC_KOUTE_STATE_DIR: path.join(temp, 'delivery-shared-branch-state') };
  const input = { session_id: 'delivery-shared-branch', cwd: fixture };
  writeState(input, {
    delivery: {
      status: 'pending',
      request_hash: 'shared-branch-fixture',
      title: 'the shared tree must release the branch',
      base_branch: baseBranch,
      issue_number: 79,
      issue_url: 'https://example.invalid/issues/79',
      branch,
      draft_pr_url: null
    }
  }, fixtureEnv);

  assert.throws(
    () => prepareDelivery(input, { cwd: fixture, env: fixtureEnv }),
    /checked out in the shared working tree/
  );
  // 共有ツリーのbranchは動かさず、Deliveryもreadyにしない。
  assert.strictEqual(spawnSync('git', ['branch', '--show-current'], { cwd: fixture, encoding: 'utf8' }).stdout.trim(), branch);
  const blocked = readState(input, fixtureEnv).delivery;
  assert.notStrictEqual(blocked.status, 'ready');
  assert.strictEqual(blocked.worktree_path, undefined);
  assert.ok(readEvents(fixtureEnv).some(event => event.type === 'delivery_prepare_failure'));

  // 共有ツリーがbranchを手放せば、同じ再実行が専用worktreeを払い出す。
  assert.strictEqual(spawnSync('git', ['switch', '--quiet', baseBranch], { cwd: fixture }).status, 0);
  const ready = prepareDelivery(input, { cwd: fixture, env: fixtureEnv });
  assert.strictEqual(ready.status, 'ready');
  assert.strictEqual(ready.branch, branch);
  assert.strictEqual(ready.worktree_created, true);
  assert.notStrictEqual(fs.realpathSync(ready.worktree_path), fs.realpathSync(fixture));
  assert.strictEqual(
    spawnSync('git', ['branch', '--show-current'], { cwd: ready.worktree_path, encoding: 'utf8' }).stdout.trim(),
    branch
  );
  assert.strictEqual(spawnSync('git', ['branch', '--show-current'], { cwd: fixture, encoding: 'utf8' }).stdout.trim(), baseBranch);
});

test('a delivery still bound to the shared working tree is migrated into a worktree by preparing again', () => {
  const fixture = createGitFixture('delivery-migration-repo');
  fs.writeFileSync(
    path.join(fixture, '.ecc', 'config.json'),
    JSON.stringify({ profile: 'standard', deliveryWorkflow: 'required', codex: { enabled: true } }),
    'utf8'
  );
  const baseBranch = spawnSync('git', ['branch', '--show-current'], { cwd: fixture, encoding: 'utf8' }).stdout.trim();
  const branch = 'codex/issue-79-migration';
  const fixtureEnv = { ...env, ECC_KOUTE_STATE_DIR: path.join(temp, 'delivery-migration-state') };
  const input = { session_id: 'delivery-migration', cwd: fixture };
  // worktree払い出し以前のstate。Issueとbranchは記録済みだが worktree_path を持たない。
  writeState(input, {
    project: projectFingerprint(fixture),
    delivery: {
      status: 'ready',
      request_hash: 'migration-fixture',
      title: 'a delivery that started on the shared working tree',
      base_branch: baseBranch,
      issue_number: 79,
      issue_url: 'https://example.invalid/issues/79',
      branch,
      draft_pr_url: null
    }
  }, fixtureEnv);
  // 共有ツリーが対象branchをcheckoutしたまま進んでいる状態。
  assert.strictEqual(spawnSync('git', ['switch', '--quiet', '-c', branch], { cwd: fixture }).status, 0);

  // 移行が済むまで、Gateも進捗記録も完了GateもCodexレビューも、共有ツリーを作業場所として
  // 扱わない。ここで共有ツリーへ落とすと、隔離は新しいDeliveryだけの話になる。
  assert.strictEqual(deliveryWorkspace(readState(input, fixtureEnv), fixture), null);
  const sharedEdit = JSON.stringify({
    ...input,
    tool_name: 'Edit',
    tool_input: { file_path: path.join(fixture, 'src', 'product.ts') }
  });
  const deniedEdit = JSON.parse(deliveryGate.run(sharedEdit, { cwd: fixture, env: fixtureEnv }));
  assert.strictEqual(deniedEdit.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(deniedEdit.hookSpecificOutput.permissionDecisionReason, /prepared before deliveries were isolated/);
  const sharedCommit = JSON.stringify({
    ...input,
    tool_name: 'Bash',
    tool_input: { command: 'git commit -m "shared tree work"' },
    tool_response: { exit_code: 0 }
  });
  assert.match(
    deliveryProgress.run(sharedCommit, { cwd: fixture, env: fixtureEnv }).additionalContext,
    /no delivery worktree bound to it yet/
  );
  const blockedCompletion = JSON.parse(deliveryCompletion.run(JSON.stringify(input), {
    cwd: fixture,
    env: fixtureEnv,
    command: () => { throw new Error('completion must not inspect any working tree'); }
  }));
  assert.strictEqual(blockedCompletion.decision, 'block');
  assert.match(blockedCompletion.reason, /prepared before deliveries were isolated/);
  assert.throws(
    () => runRole({ role: 'review', request: 'review the delivery', cwd: fixture, sessionId: input.session_id, env: fixtureEnv }),
    /no worktree is bound to it/
  );

  // このstateは再度prepareできる。共有ツリーがbranchを握っている間はfail-closeする。
  assert.strictEqual(pendingSessionForProject(fixture, fixtureEnv), 'delivery-migration');
  assert.throws(
    () => prepareDelivery(input, { cwd: fixture, env: fixtureEnv }),
    /checked out in the shared working tree/
  );

  assert.strictEqual(spawnSync('git', ['switch', '--quiet', baseBranch], { cwd: fixture }).status, 0);
  // GitHubは引き直さない。記録済みのIssueとbranchのまま専用worktreeへ移す。
  const migrated = prepareDelivery(input, { cwd: fixture, env: fixtureEnv });
  assert.strictEqual(migrated.status, 'ready');
  assert.strictEqual(migrated.issue_number, 79);
  assert.strictEqual(migrated.branch, branch);
  assert.strictEqual(migrated.worktree_created, true);
  assert.strictEqual(deliveryWorkspace(readState(input, fixtureEnv), fixture), migrated.worktree_path);
  assert.strictEqual(spawnSync('git', ['branch', '--show-current'], { cwd: fixture, encoding: 'utf8' }).stdout.trim(), baseBranch);

  // 移行後は、払い出されたworktreeの中でだけ作業できる。
  const migratedEdit = JSON.stringify({
    ...input,
    tool_name: 'Edit',
    tool_input: { file_path: path.join(migrated.worktree_path, 'src', 'product.ts') }
  });
  assert.strictEqual(deliveryGate.run(migratedEdit, { cwd: fixture, env: fixtureEnv }), migratedEdit);
  assert.match(
    JSON.parse(deliveryGate.run(sharedEdit, { cwd: fixture, env: fixtureEnv })).hookSpecificOutput.permissionDecisionReason,
    /delivery worktree/
  );

  // 隔離済みになったDeliveryは、もうworktreeを作り直さない。
  assert.throws(() => prepareDelivery(input, { cwd: fixture, env: fixtureEnv }), /already prepared/);
  assert.strictEqual(pendingSessionForProject(fixture, fixtureEnv), '');
});

test('a worktree on the wrong branch can be restored inside that worktree', () => {
  const fixture = createGitFixture('delivery-branch-restore-repo');
  fs.writeFileSync(
    path.join(fixture, '.ecc', 'config.json'),
    JSON.stringify({ profile: 'standard', deliveryWorkflow: 'required', codex: { enabled: true } }),
    'utf8'
  );
  const baseBranch = spawnSync('git', ['branch', '--show-current'], { cwd: fixture, encoding: 'utf8' }).stdout.trim();
  const branch = 'codex/issue-79-branch-restore';
  const worktreePath = path.join(temp, 'delivery-branch-restore-worktree');
  assert.strictEqual(
    spawnSync('git', ['worktree', 'add', '--quiet', '-b', branch, worktreePath], { cwd: fixture }).status,
    0
  );
  // 払い出したworktreeが別branchへ移ってしまった状態。
  assert.strictEqual(
    spawnSync('git', ['switch', '--quiet', '-c', 'codex/issue-79-other'], { cwd: worktreePath }).status,
    0
  );
  const fixtureEnv = { ...env, ECC_KOUTE_STATE_DIR: path.join(temp, 'delivery-branch-restore-state') };
  const input = { session_id: 'delivery-branch-restore', cwd: fixture };
  writeState(input, {
    delivery: {
      status: 'ready',
      request_hash: 'branch-restore-fixture',
      title: 'the recorded branch must come back in the worktree',
      base_branch: baseBranch,
      issue_number: 79,
      issue_url: 'https://example.invalid/issues/79',
      branch,
      worktree_path: worktreePath,
      draft_pr_url: null
    }
  }, fixtureEnv);

  const edit = JSON.stringify({
    ...input,
    tool_name: 'Edit',
    tool_input: { file_path: path.join(worktreePath, 'src', 'product.ts') }
  });
  const denied = JSON.parse(deliveryGate.run(edit, { cwd: fixture, env: fixtureEnv }));
  assert.strictEqual(denied.hookSpecificOutput.permissionDecision, 'deny');
  // 案内するcommandは、このGateが実際に通す形でなければ復旧できない。
  assert.match(
    denied.hookSpecificOutput.permissionDecisionReason,
    new RegExp(`git -C "${worktreePath}" switch ${branch}`.replace(/[\\^$*+?.()|[\]{}]/g, '\\$&'))
  );

  const bash = command => JSON.stringify({ ...input, tool_name: 'Bash', tool_input: { command } });
  for (const command of [
    `git -C "${worktreePath}" switch ${branch}`,
    `cd "${worktreePath}" && git switch ${branch}`,
    `node "${path.join(pluginRoot, 'scripts', 'codex', 'reset.js')}" delivery-branch-restore`
  ]) {
    assert.strictEqual(deliveryGate.run(bash(command), { cwd: fixture, env: fixtureEnv }), bash(command), command);
  }
  // worktreeの中で走ることだけを条件にすると、誤ったbranchのまま編集も削除もコミットも
  // 通ってしまう。通すのは期待branchへ戻す操作と、状況を確かめる読み取りだけである。
  for (const command of [
    `cd "${worktreePath}" && rm -rf src`,
    `cd "${worktreePath}" && git commit -am "work on the wrong branch"`,
    `git -C "${worktreePath}" switch codex/issue-79-other`,
    `git -C "${worktreePath}" switch -c ${branch}-again`,
    `git -C "${worktreePath}" checkout -- src/product.ts`,
    `cd "${worktreePath}" && npm test`,
    `cd "${worktreePath}" && git switch ${branch} && rm -rf src`,
    `cd "${worktreePath}" && git status --porcelain > status.txt`
  ]) {
    const decision = JSON.parse(deliveryGate.run(bash(command), { cwd: fixture, env: fixtureEnv }));
    assert.strictEqual(decision.hookSpecificOutput.permissionDecision, 'deny', command);
    assert.match(decision.hookSpecificOutput.permissionDecisionReason, /Expected issue-linked branch/);
  }
  // 状況を確かめる読み取りは、復旧の判断材料として通し続ける。
  for (const command of [
    `git -C "${worktreePath}" status --porcelain`,
    `cd "${worktreePath}" && git branch --show-current`
  ]) {
    assert.strictEqual(deliveryGate.run(bash(command), { cwd: fixture, env: fixtureEnv }), bash(command), command);
  }
  // 共有ツリーへ届くcommandは、branchが合っていない間も拒否し続ける。
  for (const command of ['git reset --hard', 'touch src/product.ts', `git --work-tree "${fixture}" checkout -- .`]) {
    assert.strictEqual(
      JSON.parse(deliveryGate.run(bash(command), { cwd: fixture, env: fixtureEnv })).hookSpecificOutput.permissionDecision,
      'deny',
      command
    );
  }
  const sharedEdit = JSON.stringify({
    ...input,
    tool_name: 'Edit',
    tool_input: { file_path: path.join(fixture, 'src', 'product.ts') }
  });
  assert.strictEqual(
    JSON.parse(deliveryGate.run(sharedEdit, { cwd: fixture, env: fixtureEnv })).hookSpecificOutput.permissionDecision,
    'deny'
  );

  // branchを戻せば、Gateは通常の判定に戻る。
  assert.strictEqual(spawnSync('git', ['switch', '--quiet', branch], { cwd: worktreePath }).status, 0);
  assert.strictEqual(deliveryGate.run(edit, { cwd: fixture, env: fixtureEnv }), edit);
});

test('worktree issuance fails closed on unverified paths and shell-unsafe refs', () => {
  const executed = [];
  const runCommand = (binary, args) => {
    executed.push([binary, ...args].join(' '));
    if (args[0] === 'worktree' && args[1] === 'list') {
      return `worktree ${path.join(temp, 'failclose-main')}\nbranch refs/heads/main\n`;
    }
    return '';
  };

  for (const ref of [
    'codex/issue-68;git push --force',
    'codex/issue-68&make',
    'codex/issue-68$(make)',
    'codex/issue-68|tee x',
    'codex/issue 68',
    '-codex/issue-68',
    'codex/issue-68/../main'
  ]) {
    assert.throws(
      () => ensureDeliveryWorktree({ base_branch: 'main' }, ref, { cwd: path.join(temp, 'failclose-main'), runCommand }),
      /not shell-safe/,
      ref
    );
    assert.strictEqual(isSafeGitRef(ref), false, ref);
  }
  assert.throws(
    () => ensureDeliveryWorktree({ base_branch: 'main;make' }, 'codex/issue-68-safe-ref', {
      cwd: path.join(temp, 'failclose-main'),
      runCommand
    }),
    /Delivery base branch .* not shell-safe/
  );
  // 危険なrefはgitへも渡らず、worktreeも作られない。
  assert.ok(executed.every(command => !command.includes('worktree add') && !command.includes('-codex/issue-68')));

  // 素性の分からない既存directoryは上書きも削除もせず、そこで停止する。
  const occupied = deliveryWorktreePath(path.join(temp, 'failclose-main'), 'codex/issue-68-occupied');
  fs.mkdirSync(occupied, { recursive: true });
  fs.writeFileSync(path.join(occupied, 'unrelated.txt'), 'keep me\n', 'utf8');
  assert.throws(
    () => ensureDeliveryWorktree({ base_branch: 'main' }, 'codex/issue-68-occupied', {
      cwd: path.join(temp, 'failclose-main'),
      runCommand
    }),
    /already exists but is not registered/
  );
  assert.strictEqual(fs.readFileSync(path.join(occupied, 'unrelated.txt'), 'utf8'), 'keep me\n');

  // 払い出し先の設定は境界まで検証する。リポジトリの中を指す値を受け入れると、隔離した
  // はずのworktreeが共有ツリーの `git status` に現れ、cleanなHEADを要求する検証を壊す。
  const main = path.join(temp, 'failclose-main');
  const insideRepo = { deliveryWorktreeRoot: path.join(main, '.worktrees') };
  for (const config of [insideRepo, { deliveryWorktreeRoot: 'delivery-worktrees' }, { deliveryWorktreeRoot: '.' }]) {
    assert.throws(
      () => deliveryWorktreePath(main, 'codex/issue-68-inside', { config }),
      /inside the shared working tree/,
      config.deliveryWorktreeRoot
    );
  }
  // 相対値は共有ツリーの根から解決する。process.cwd から解決すると、同じ設定でも起動
  // 場所ごとに別の場所へ払い出してしまう。
  assert.strictEqual(
    deliveryWorktreePath(main, 'codex/issue-68-outside', {
      config: { deliveryWorktreeRoot: path.join('..', 'ecc-delivery-worktrees') }
    }),
    path.join(temp, 'ecc-delivery-worktrees', 'codex-issue-68-outside')
  );
  assert.throws(
    () => ensureDeliveryWorktree({ base_branch: 'main' }, 'codex/issue-68-inside', {
      cwd: main,
      config: insideRepo,
      runCommand
    }),
    /inside the shared working tree/
  );
  // 境界違反はgitへ渡る前に止まる。中途半端に登録されたworktreeを残さない。
  assert.ok(executed.every(command => !command.includes('worktree add')));

  // 実体を解決しない検査は、リポジトリの外に見えるsymlinkが中を指す払い出し先を通す。
  const nestedRoot = path.join(main, 'nested-root');
  fs.mkdirSync(nestedRoot, { recursive: true });
  const linkedRoot = path.join(temp, 'failclose-linked-root');
  let linked = true;
  try {
    fs.symlinkSync(nestedRoot, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    // symlinkを作れない環境ではこの経路自体が存在しない。
    linked = false;
  }
  if (linked) {
    assert.throws(
      () => deliveryWorktreePath(main, 'codex/issue-68-linked', { config: { deliveryWorktreeRoot: linkedRoot } }),
      /inside the shared working tree/
    );
    assert.throws(
      () => ensureDeliveryWorktree({ base_branch: 'main' }, 'codex/issue-68-linked', {
        cwd: main,
        config: { deliveryWorktreeRoot: linkedRoot },
        runCommand
      }),
      /inside the shared working tree/
    );
  }

  // 登録済みのworktreeも同じ境界で検証する。共有ツリーの配下にあるworktreeを再利用すると、
  // 隔離したはずの作業が共有ツリーの `git status` に現れる。
  const nestedWorktree = path.join(main, 'nested-worktree');
  fs.mkdirSync(nestedWorktree, { recursive: true });
  const nestedRunCommand = (binary, args) => {
    executed.push([binary, ...args].join(' '));
    if (args[0] === 'worktree' && args[1] === 'list') {
      return [
        `worktree ${main}`,
        'branch refs/heads/main',
        '',
        `worktree ${nestedWorktree}`,
        'branch refs/heads/codex/issue-68-nested',
        ''
      ].join('\n');
    }
    return '';
  };
  assert.throws(
    () => ensureDeliveryWorktree({ base_branch: 'main' }, 'codex/issue-68-nested', {
      cwd: main,
      runCommand: nestedRunCommand
    }),
    /resolves inside the shared working tree/
  );
  assert.ok(executed.every(command => !command.includes('worktree add')));
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

test('a linked worktree shares the project identity of its main working tree', () => {
  const fixture = createGitFixture('project-identity-repo');
  fs.writeFileSync(
    path.join(fixture, '.ecc', 'config.json'),
    JSON.stringify({ profile: 'standard', deliveryWorkflow: 'required', codex: { enabled: true } }),
    'utf8'
  );
  const worktreePath = path.join(temp, 'project-identity-worktree');
  assert.strictEqual(
    spawnSync('git', ['worktree', 'add', '--quiet', '-b', 'codex/issue-79-identity', worktreePath], { cwd: fixture }).status,
    0
  );
  // 同じリポジトリなら、共有ツリーでもworktreeでも同じprojectとして証拠を突き合わせられる。
  assert.strictEqual(projectFingerprint(worktreePath), projectFingerprint(fixture));
  assert.notStrictEqual(projectFingerprint(worktreePath), hash(path.resolve(worktreePath)));
  // Git配下でない場所は従来どおり絶対パスで識別する。
  const nonGit = path.join(temp, 'project-identity-non-git');
  fs.mkdirSync(nonGit, { recursive: true });
  assert.strictEqual(projectFingerprint(nonGit), hash(path.resolve(nonGit)));

  const fixtureEnv = { ...env, ECC_KOUTE_STATE_DIR: path.join(temp, 'project-identity-state') };
  initializeDelivery(
    { session_id: 'identity-session', cwd: fixture },
    'worktree隔離を修正してください',
    { cwd: fixture, env: fixtureEnv }
  );
  // 共有ツリーで記録した pending Delivery は worktree からも同じSessionとして見つかる。
  assert.strictEqual(pendingSessionForProject(worktreePath, fixtureEnv), 'identity-session');
});

test('a delivery recorded with the legacy working-tree project identifier is still found and migrated', () => {
  const fixture = createGitFixture('legacy-project-id-repo');
  fs.writeFileSync(
    path.join(fixture, '.ecc', 'config.json'),
    JSON.stringify({ profile: 'standard', deliveryWorkflow: 'required', codex: { enabled: true } }),
    'utf8'
  );
  const worktreePath = path.join(temp, 'legacy-project-id-worktree');
  assert.strictEqual(
    spawnSync('git', ['worktree', 'add', '--quiet', '-b', 'codex/issue-79-legacy', worktreePath], { cwd: fixture }).status,
    0
  );
  const fixtureEnv = { ...env, ECC_KOUTE_STATE_DIR: path.join(temp, 'legacy-project-id-state') };
  const input = { session_id: 'legacy-project-id', cwd: fixture };
  writeState(input, {
    delivery: {
      status: 'ready',
      request_hash: 'legacy-project-fixture',
      title: 'a delivery serialized before the common project identifier',
      base_branch: 'main',
      issue_number: 79,
      issue_url: 'https://example.invalid/issues/79',
      branch: 'codex/issue-79-legacy',
      draft_pr_url: null
    }
  }, fixtureEnv);

  // 旧版が直列化したstate。projectは共通のリポジトリ識別子ではなく作業ツリー絶対pathの
  // hashで、更新時刻はstale監査の対象になるほど古い。
  const file = statePath(input, fixtureEnv);
  const legacyProject = hash(path.resolve(fixture));
  const restoreLegacyState = () => atomicWrite(file, {
    ...readJson(file),
    project: legacyProject,
    updated_at: '2026-01-01T00:00:00.000Z'
  });
  assert.notStrictEqual(legacyProject, projectFingerprint(fixture));

  // prepare待ちのSession検索は旧IDでも見つけ、読み込んだ時点でcanonicalなIDへ移行する。
  restoreLegacyState();
  assert.strictEqual(pendingSessionForProject(fixture, fixtureEnv), 'legacy-project-id');
  assert.strictEqual(readJson(file).project, projectFingerprint(fixture));

  // 主作業ツリーのpathで記録された旧IDは、worktreeから探しても同じprojectである。
  restoreLegacyState();
  assert.strictEqual(pendingSessionForProject(worktreePath, fixtureEnv), 'legacy-project-id');
  assert.strictEqual(readJson(file).project, projectFingerprint(worktreePath));

  // 受入監査も旧IDのDeliveryを見失わない。
  restoreLegacyState();
  const entry = latestState(fixture, 79, fixtureEnv);
  assert.ok(entry, 'the acceptance audit must find the legacy state');
  assert.strictEqual(entry.state.session_id, 'legacy-project-id');
  assert.strictEqual(readJson(file).project, projectFingerprint(fixture));

  // 取り残されたDeliveryのstale監査も同じく旧IDを拾う。
  restoreLegacyState();
  assert.strictEqual(
    deliveryFinalizer.auditStale({ session_id: 'another-session', cwd: fixture }, { cwd: fixture, env: fixtureEnv }),
    1
  );
  assert.ok(readEvents(fixtureEnv).some(event => event.type === 'delivery_session_incomplete'));
});

test('completion accepts review evidence bound to the delivery worktree, not the shared tree', () => {
  const fixture = createGitFixture('delivery-worktree-completion-repo');
  fs.writeFileSync(
    path.join(fixture, '.ecc', 'config.json'),
    JSON.stringify({ profile: 'standard', deliveryWorkflow: 'required', codex: { enabled: true } }),
    'utf8'
  );
  assert.strictEqual(spawnSync('git', ['add', '.ecc/config.json'], { cwd: fixture }).status, 0);
  assert.strictEqual(spawnSync('git', ['commit', '--quiet', '-m', 'require delivery workflow'], { cwd: fixture }).status, 0);
  const baseBranch = spawnSync('git', ['branch', '--show-current'], { cwd: fixture, encoding: 'utf8' }).stdout.trim();
  const branch = 'codex/issue-79-worktree-completion';
  const worktreePath = path.join(temp, 'delivery-worktree-completion-tree');
  assert.strictEqual(
    spawnSync('git', ['worktree', 'add', '--quiet', '-b', branch, worktreePath], { cwd: fixture }).status,
    0
  );
  fs.writeFileSync(path.join(worktreePath, 'src', 'product.ts'), 'export const product = false;\n', 'utf8');
  assert.strictEqual(spawnSync('git', ['add', 'src/product.ts'], { cwd: worktreePath }).status, 0);
  assert.strictEqual(spawnSync('git', ['commit', '--quiet', '-m', 'implement in worktree'], { cwd: worktreePath }).status, 0);
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf8' }).stdout.trim();
  // 共有ツリーは別branchのまま、未コミットの変更を抱えていてよい。
  fs.writeFileSync(path.join(fixture, 'src', 'other-tool.ts'), 'export const other = true;\n', 'utf8');

  const fixtureEnv = { ...env, ECC_KOUTE_STATE_DIR: path.join(temp, 'delivery-worktree-completion-state') };
  const input = { session_id: 'delivery-worktree-completion', cwd: fixture };
  writeState(input, {
    delivery: { status: 'ready', issue_number: 79, branch, base_branch: baseBranch, worktree_path: worktreePath },
    review_role: 'review',
    review_status: 'ok',
    review_complete: true,
    review_head: head,
    review_worktree_clean: true,
    review_blocking_findings: 0
  }, fixtureEnv);
  assert.strictEqual(deliveryWorkspace(readState(input, fixtureEnv), fixture), worktreePath);

  const inspected = [];
  const raw = JSON.stringify(input);
  assert.strictEqual(deliveryCompletion.run(raw, {
    cwd: fixture,
    env: fixtureEnv,
    command(binary, args, commandCwd, commandEnv) {
      inspected.push([binary, args[0], commandCwd]);
      if (binary === 'gh') {
        return {
          ok: true,
          stdout: JSON.stringify([{ url: 'https://example.invalid/pr/9', isDraft: true, number: 9, body: 'Closes #79', baseRefName: baseBranch, headRefOid: head }]),
          stderr: ''
        };
      }
      return deliveryCompletion.command(binary, args, commandCwd, commandEnv);
    }
  }), raw);
  assert.ok(inspected.every(([binary, , commandCwd]) => binary !== 'git' || commandCwd === worktreePath));
  assert.strictEqual(readState(input, fixtureEnv).delivery.status, 'draft-pr');
});

test('an isolated delivery only allows commands that provably act inside the worktree', () => {
  const shared = path.join(temp, 'targets-shared');
  const workspace = path.join(temp, 'targets-shared-worktrees', 'codex-issue-79');
  const gateEnv = { CLAUDE_PLUGIN_ROOT: pluginRoot };
  for (const command of [
    `cd "${workspace}" && git commit -am "fix"`,
    `cd "${workspace}" && cd src && git add .`,
    `git -C "${workspace}" push origin HEAD`,
    `git -C"${workspace}" restore src/product.ts`,
    'git -C ../targets-shared-worktrees/codex-issue-79 commit -m "fix"',
    'git status --porcelain',
    'git log --oneline -5',
    // 一覧表示しかしない形は共有ツリーでも読み取りとして通す。
    'git branch --show-current',
    'git worktree list',
    'git stash list',
    // 設定は読み取る形だけ残す。
    'git config --list',
    // 書き込みでも、そのworktreeの作業ツリー・index・現在のbranchに収まる形は通る。
    `git -C "${workspace}" mv src/product.ts src/renamed.ts`,
    `cd "${workspace}" && git stash`,
    `cd "${workspace}" && git switch -c codex/issue-79-follow-up`,
    // worktreeの中で走るcommandは、gitでなくてもファイルを作ってよい。
    `cd "${workspace}" && npm test`,
    `cd "${workspace}" && npm test > report.log`,
    `cd "${workspace}" && node scripts/build.js`,
    // 共有ツリーでも、ファイルを作らない読み取りcommandは通す。
    'grep -r "git" docs',
    'cat src/product.ts',
    'ls -la src',
    `git diff > "${path.join(workspace, 'delivery.diff')}"`,
    'git log --oneline -5 | head -3',
    // 読み取りcommandは、引数まで見て副作用がないと言える形なら通り続ける。
    'sort src/product.ts',
    'uniq -c src/product.ts',
    'diff -u src/product.ts src/renamed.ts',
    'rg --line-number --hidden pattern src',
    'wc -l src/product.ts',
    // バックスラッシュで意味を消した文字は語の一部であって、演算子ではない。
    `git -C "${workspace}" commit -m "note \\" quote"`,
    'grep -rn pattern\\;name src',
    // ECC自身のcommandは記録済みDeliveryのworktreeを解決して動く。
    'node "$CLAUDE_PLUGIN_ROOT/scripts/codex/run-role.js" review --session delivery',
    `node "${path.join(pluginRoot, 'scripts', 'codex', 'acceptance-audit.js')}" --issue 79`,
    // 明示cwdが記録済みworktreeを指すなら、ECCのcommandはそのまま通る。
    `node "$CLAUDE_PLUGIN_ROOT/scripts/codex/run-role.js" review --cwd "${workspace}"`,
    `cd "${workspace}" && node "$CLAUDE_PLUGIN_ROOT/scripts/codex/run-role.js" review --session delivery`,
    // worktreeの中で完結する作業は、gitでなくても通り続ける。
    `cd "${workspace}" && rm -rf node_modules`,
    `cd "${workspace}" && cp src/product.ts src/product.ts.bak`,
    `cd "${workspace}" && node tests/run-all.js`,
    `cd "${workspace}" && git diff --output=review.diff`,
    // 共有ツリーを読むだけのcommandは、worktreeの中からでも通す。
    `cd "${workspace}" && cat "${shared}/src/product.ts"`,
    // globが広がる範囲がworktreeの中に収まる形は通り続ける。
    `cd "${workspace}" && rm -rf node_modules/*`,
    `cd "${workspace}" && rm -rf *.log`,
    `cd "${workspace}" && git add src/*.ts`,
    `git -C "${workspace}" add "${workspace}"/src/*.ts`,
    // 引用された `*` や `?` は展開されない。ただの語として通す。
    `git -C "${workspace}" commit -m "why? handle a*b"`
  ]) {
    assert.strictEqual(deliveryGate.targetsWorkspace(command, workspace, shared, { env: gateEnv }), true, command);
  }
  for (const command of [
    'git commit -am "fix"',
    // pathを名指ししても、gitは共有ツリーで走る。
    `git add "${workspace}/src/product.ts"`,
    `echo "${workspace}" && git commit -am "fix"`,
    `cd "${workspace}" && cd .. && git reset --hard`,
    // 展開が必要なcd先は追跡できないので、worktreeの中だと決めつけない。
    'cd "$DELIVERY_WORKTREE" && git commit -m "fix"',
    `cd "${workspace}" && git -C "${shared}" reset --hard`,
    `git -C "${workspace}" commit -m "fix"; git reset --hard`,
    // 列挙していないsubcommandは読み取りだと決めつけず、書き込みとして扱う。
    'git mv src/product.ts src/renamed.ts',
    'git branch -D main',
    'git tag v1.0.0',
    'git update-ref refs/heads/main HEAD',
    'git config user.email attacker@example.invalid',
    'git submodule update --init',
    'git notes add -m "note"',
    'git worktree remove ../other',
    // refと設定はgit common-dirにあり、worktreeごとに分かれていない。worktreeの中で
    // 走らせても共有ツリーが今いるbranchを動かせるため、実行位置では正当化できない。
    `git -C "${workspace}" update-ref refs/heads/main HEAD`,
    `cd "${workspace}" && git update-ref refs/heads/main HEAD`,
    `git -C "${workspace}" branch -f main HEAD`,
    `git -C "${workspace}" branch -D codex/old`,
    `cd "${workspace}" && git branch -M main`,
    `git -C "${workspace}" tag -f v1.0.0 HEAD`,
    `cd "${workspace}" && git symbolic-ref HEAD refs/heads/main`,
    `git -C "${workspace}" remote add origin https://example.invalid/repo.git`,
    `git -C "${workspace}" notes add -m "note"`,
    `cd "${workspace}" && git worktree remove "${shared}"`,
    `cd "${workspace}" && git gc --prune=now`,
    // 許可したsubcommandでも、既にあるbranchを付け替える形と、書き込み先のrefを名指しする
    // refspecは共有refへ届く。
    `git -C "${workspace}" checkout -B main`,
    `cd "${workspace}" && git switch -C main`,
    `git -C "${workspace}" push . HEAD:refs/heads/main`,
    `cd "${workspace}" && git push . HEAD:main`,
    `git -C "${workspace}" fetch . main:main`,
    `cd "${workspace}" && git pull . main:main`,
    // aliasで別名を付けた操作も、Gateからは何をするか読めない。
    `git -C "${workspace}" sync`,
    // cdの効果が次のcommandに届くのは `&&` のときだけ。cdが失敗しても、あるいは
    // 成否に関わらず先へ進む形は、共有ツリーで走りうる。
    `cd "${workspace}/missing" || git reset --hard`,
    `cd "${workspace}"; git reset --hard`,
    `cd "${workspace}" & git reset --hard`,
    `cd "${workspace}" | git reset --hard`,
    // subshellのcdは呼び出し元のdirectoryを動かさない。
    `(cd "${workspace}") && git reset --hard`,
    // gitを間接的に起動する形は、実際の実行directoryを追跡できない。
    `sh -c "cd ${workspace} && git reset --hard"`,
    'eval "git reset --hard"',
    `env GIT_WORK_TREE="${shared}" git reset --hard`,
    'echo src/product.ts | xargs git checkout --',
    `cd "${workspace}" && $(echo git) reset --hard`,
    'cd "${DELIVERY}" && git reset --hard',
    '`git reset --hard`',
    `cd "${workspace}" && git commit -m "$(git -C ${shared} reset --hard)"`,
    // 作業ツリーやgit dirの差し替えは、cdやpathからは追えない。
    `GIT_WORK_TREE="${shared}" GIT_DIR="${shared}/.git" git reset --hard`,
    `cd "${workspace}" && git --git-dir="${shared}/.git" --work-tree="${shared}" reset --hard`,
    `cd "${workspace}" && git --work-tree "${shared}" checkout -- .`,
    `cd "${workspace}" && git -c core.worktree="${shared}" reset --hard`,
    // 設定の上書きは、実行directoryがworktreeのままでも共有ツリーへ届くcommandを
    // gitに起動させる。鍵の名前では安全だと言えない。
    `git -C "${workspace}" -c alias.destroy="!rm -rf ${shared}/src" destroy`,
    `git -C "${workspace}" -c alias.destroy="!rm -rf ${shared}/src" status`,
    `cd "${workspace}" && git -c include.path="${shared}/.git/evil-config" status`,
    `git -C "${workspace}" -c diff.external=./evil diff`,
    `git -C "${workspace}" -c core.pager=./evil log --oneline -5`,
    `git -C "${workspace}" -calias.destroy="!rm -rf ${shared}/src" destroy`,
    `git -C "${workspace}" --config-env alias.destroy=EVIL destroy`,
    `git -C "${workspace}" --config-env=alias.destroy=EVIL status`,
    `git -C "${workspace}" -c user.name=ECC commit -m "fix"`,
    // gitが起動するprogramの置き場所を差し替える形も、読み取りsubcommandを名乗れる。
    `git -C "${workspace}" --exec-path=./evil status`,
    // 設定への書き込みはリポジトリ共通の設定に残り、後のgitを共有ツリーへ向ける。
    `git -C "${workspace}" config alias.destroy "!rm -rf ${shared}/src"`,
    `cd "${workspace}" && git config include.path ../evil-config`,
    `cd "${workspace}" && git config --worktree core.worktree "${shared}"`,
    // 絶対pathでgitを呼んでも同じgitである。
    '/usr/bin/git reset --hard',
    // Gitを使わなくても共有ツリーは書き換えられる。worktreeの中で走ると読み取れない
    // 限り、ファイルを作りうるcommandは通さない。
    'npm test',
    'npm run build',
    'touch src/product.ts',
    'rm -rf src',
    'mv src/product.ts src/renamed.ts',
    'sed -i "s/a/b/" src/product.ts',
    'python -c "open(\'src/product.ts\', \'w\')"',
    'node -e "require(\'fs\').writeFileSync(\'src/product.ts\', \'\')"',
    'node scripts/build.js',
    // リダイレクトはcommandの種類に関わらず共有ツリーへ書き込む。
    'echo bypass > src/product.ts',
    'echo bypass >src/product.ts',
    'echo bypass >> src/product.ts',
    'git status --porcelain > src/status.txt',
    'git diff 2> src/error.log',
    `cd "${workspace}" && cat report.log > "${shared}/report.log"`,
    'cat src/product.ts > $LOG',
    // worktreeの中に見えても、cdが効いていなければ共有ツリーで走る。
    `cd "${workspace}"; npm test`,
    // ECCのcommandに見せかけた任意のcode実行は通さない。
    'node --require /plugin/scripts/codex/run-role.js -e "process.exit(0)"',
    // 名前がECCのscriptと同じでも、plugin本体のscriptでなければECCのcommandではない。
    'node /plugin/scripts/codex/run-role.js review --session delivery',
    `node "${path.join(workspace, 'scripts', 'codex', 'run-role.js')}" review --session delivery`,
    `node "${path.join(pluginRoot, 'scripts', 'codex', 'run-role.js')}.bak" review`,
    'node "$ECC_UNKNOWN_ROOT/scripts/codex/run-role.js" review',
    // 読み取り扱いのcommandでも、出力先を指すoptionはファイルを作る。
    'sort -o src/product.ts src/product.ts',
    'sort --output=src/product.ts src/product.ts',
    'sort -osrc/product.ts src/product.ts',
    'diff --output=src/product.ts src/a src/b',
    'tree -o src/product.ts',
    // 二つ目のoperandが出力先になる形も同じ。
    'uniq src/product.ts src/product.ts',
    // 外部programを起動するoptionは、読み取りcommandでも任意のcodeを走らせる。
    'rg --pre ./evil pattern',
    'rg --pre=./evil pattern',
    'sort --compress-program=./evil src/product.ts',
    'file -C -m src/magic',
    // 環境変数の前置きは、commandがどのprogramに解決されるかを差し替える。
    `PATH="${workspace}" cat src/product.ts`,
    'LD_PRELOAD=./evil.so grep pattern src',
    // pathを付けた実行ファイルは、名前が同じでもPATHのcommandとは限らない。
    `"${path.join(workspace, 'sort')}" src/product.ts`,
    './grep pattern src',
    `"${path.join(workspace, 'git')}" commit -am "fix"`,
    // バックスラッシュは二重引用符の中でも `"` の意味を消す。引用の開閉だけを追うと、
    // 引用の外にある `;` を引用の中と読み違え、共有ツリーで走るcommandを見落とす。
    'echo "safe\\""; git reset --hard; echo "x"',
    'echo "safe\\"" && rm -rf src',
    "echo 'literal\\' ; git reset --hard",
    // 読み切れない引用は、どこからが次のcommandなのかを決められない。
    'git status --porcelain "',
    "git status --porcelain 'unclosed",
    'git status --porcelain \\',
    // 実行位置がworktreeの中でも、引数は共有ツリーや兄弟worktreeを指せる。実行位置だけで
    // 任意のcommandを通すと、隔離はcdを一つ書くだけで無効になる。
    `cd "${workspace}" && rm -rf "${shared}/src"`,
    `cd "${workspace}" && cp src/product.ts "${shared}/src/product.ts"`,
    `cd "${workspace}" && mv src/product.ts "${shared}/src/product.ts"`,
    `cd "${workspace}" && rm -rf ../../targets-shared/src`,
    // 共有ツリーへのsymlinkを作れば、以降の書き込みはworktreeの中に見える。
    `cd "${workspace}" && ln -s "${shared}" linked-shared`,
    `cd "${workspace}" && ln -s ../../targets-shared linked-shared`,
    // 展開してからでないと、引数が何を指すか決まらない。
    `cd "${workspace}" && rm -rf "$SHARED_TREE"`,
    `cd "${workspace}" && rm -rf ~/repo/src`,
    // globとbrace展開は、字面ではworktreeの外を指していなくても共有ツリーへ広がる。
    `cd "${workspace}" && rm -rf ../../*/src`,
    `cd "${workspace}" && rm -rf ../*/src`,
    `cd "${workspace}" && rm -rf ../../targets-share?/src`,
    `cd "${workspace}" && rm -rf ../../targets-shared/[s]rc`,
    `cd "${workspace}" && rm -rf ../../{targets-shared,other}/src`,
    `cd "${workspace}" && git checkout -- ../../*/src`,
    `git -C "${workspace}" add ../../*/src`,
    // shell変数の書き換えは、以後のcommand名がどの実行ファイルに解決されるかを変える。
    `printf -v PATH "${workspace}"`,
    `printf -v PATH "${workspace}"; git status --porcelain`,
    `printf -vPATH "${workspace}"; cat src/product.ts`,
    `PATH="${workspace}"; git status --porcelain`,
    `cd "${workspace}" && printf -v PATH .; cd "${shared}" && git status --porcelain`,
    `cd "${workspace}" && export PATH="${workspace}"; cd "${shared}" && cat src/product.ts`,
    `cd "${workspace}" && PATH="${shared}/bin" npm test`,
    // 引数のcodeをそのまま実行する形は、worktreeの中で走っていても対象を追えない。
    `cd "${workspace}" && node -e "require('fs').writeFileSync('x', '')"`,
    `cd "${workspace}" && node --eval "process.exit(0)"`,
    `cd "${workspace}" && node -pe "1"`,
    `cd "${workspace}" && python3 -c "open('x', 'w')"`,
    `cd "${workspace}" && perl -e "1"`,
    // gitがworktreeで走っても、引数の出力先は外を指せる。
    `cd "${workspace}" && git diff --output="${shared}/leak.diff"`,
    `git -C "${workspace}" diff --output="${shared}/leak.diff"`,
    // ECC自身のcommandでも、明示cwdが外を指せば隔離した先では走らない。
    `node "$CLAUDE_PLUGIN_ROOT/scripts/codex/run-role.js" review --cwd "${shared}"`,
    `node "$CLAUDE_PLUGIN_ROOT/scripts/codex/run-role.js" review --cwd="${shared}"`,
    `cd "${workspace}" && node "$CLAUDE_PLUGIN_ROOT/scripts/codex/run-role.js" review --cwd ..`,
    `node "${path.join(pluginRoot, 'scripts', 'codex', 'run-role.js')}" review --cwd`
  ]) {
    assert.strictEqual(deliveryGate.targetsWorkspace(command, workspace, shared, { env: gateEnv }), false, command);
  }
});

test('an isolated delivery cannot move the branch the shared working tree has checked out', () => {
  const fixture = createGitFixture('delivery-shared-ref-repo');
  fs.writeFileSync(
    path.join(fixture, '.ecc', 'config.json'),
    JSON.stringify({ profile: 'standard', deliveryWorkflow: 'required', codex: { enabled: true } }),
    'utf8'
  );
  assert.strictEqual(spawnSync('git', ['add', '.ecc/config.json'], { cwd: fixture }).status, 0);
  assert.strictEqual(spawnSync('git', ['commit', '--quiet', '-m', 'require delivery workflow'], { cwd: fixture }).status, 0);
  const baseBranch = spawnSync('git', ['branch', '--show-current'], { cwd: fixture, encoding: 'utf8' }).stdout.trim();
  const branch = 'codex/issue-79-shared-ref';
  const worktreePath = path.join(temp, 'delivery-shared-ref-worktree');
  assert.strictEqual(
    spawnSync('git', ['worktree', 'add', '--quiet', '-b', branch, worktreePath], { cwd: fixture }).status,
    0
  );
  const fixtureEnv = { ...env, ECC_KOUTE_STATE_DIR: path.join(temp, 'delivery-shared-ref-state') };
  const input = { session_id: 'delivery-shared-ref', cwd: fixture };
  writeState(input, {
    project: projectFingerprint(fixture),
    delivery: { status: 'ready', issue_number: 79, branch, base_branch: baseBranch, worktree_path: worktreePath }
  }, fixtureEnv);

  const bash = command => JSON.stringify({ ...input, tool_name: 'Bash', tool_input: { command } });
  const sharedHead = spawnSync('git', ['rev-parse', baseBranch], { cwd: fixture, encoding: 'utf8' }).stdout.trim();
  // refはgit common-dirにあり、worktreeごとに分かれていない。worktreeの中で走る形でも、
  // 共有ツリーがcheckoutしているbranchを動かすcommandは通さない。
  for (const command of [
    `git -C "${worktreePath}" update-ref refs/heads/${baseBranch} ${branch}`,
    `cd "${worktreePath}" && git branch -f ${baseBranch} ${branch}`,
    `git -C "${worktreePath}" checkout -B ${baseBranch}`,
    `cd "${worktreePath}" && git push . HEAD:refs/heads/${baseBranch}`,
    `git -C "${worktreePath}" tag -f release ${branch}`,
    `git -C "${worktreePath}" symbolic-ref HEAD refs/heads/${baseBranch}`
  ]) {
    const denied = JSON.parse(deliveryGate.run(bash(command), { cwd: fixture, env: fixtureEnv }));
    assert.strictEqual(denied.hookSpecificOutput.permissionDecision, 'deny', command);
  }
  // worktreeの中で完結する書き込みは、これまでどおり通る。
  const allowed = bash(`git -C "${worktreePath}" commit -am "fix in the worktree"`);
  assert.strictEqual(deliveryGate.run(allowed, { cwd: fixture, env: fixtureEnv }), allowed);
  // 拒否している間、共有ツリーのbranchは一度も動いていない。
  assert.strictEqual(
    spawnSync('git', ['rev-parse', baseBranch], { cwd: fixture, encoding: 'utf8' }).stdout.trim(),
    sharedHead
  );
});

test('a delivery whose worktree is gone fails closed instead of falling back to the shared tree', () => {
  const fixture = createGitFixture('delivery-worktree-lost-repo');
  fs.writeFileSync(
    path.join(fixture, '.ecc', 'config.json'),
    JSON.stringify({ profile: 'standard', deliveryWorkflow: 'required', codex: { enabled: true } }),
    'utf8'
  );
  assert.strictEqual(spawnSync('git', ['add', '.ecc/config.json'], { cwd: fixture }).status, 0);
  assert.strictEqual(spawnSync('git', ['commit', '--quiet', '-m', 'require delivery workflow'], { cwd: fixture }).status, 0);
  const baseBranch = spawnSync('git', ['branch', '--show-current'], { cwd: fixture, encoding: 'utf8' }).stdout.trim();
  const branch = 'codex/issue-79-worktree-lost';
  const worktreePath = path.join(temp, 'delivery-worktree-lost-tree');
  assert.strictEqual(
    spawnSync('git', ['worktree', 'add', '--quiet', '-b', branch, worktreePath], { cwd: fixture }).status,
    0
  );
  fs.writeFileSync(path.join(worktreePath, 'src', 'product.ts'), 'export const product = false;\n', 'utf8');
  assert.strictEqual(spawnSync('git', ['add', 'src/product.ts'], { cwd: worktreePath }).status, 0);
  assert.strictEqual(spawnSync('git', ['commit', '--quiet', '-m', 'implement in worktree'], { cwd: worktreePath }).status, 0);
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf8' }).stdout.trim();

  const fixtureEnv = { ...env, ECC_KOUTE_STATE_DIR: path.join(temp, 'delivery-worktree-lost-state') };
  const input = { session_id: 'delivery-worktree-lost', cwd: fixture };
  writeState(input, {
    delivery: {
      status: 'ready',
      issue_number: 79,
      branch,
      base_branch: baseBranch,
      worktree_path: worktreePath,
      committed_head: head
    },
    review_role: 'review',
    review_status: 'ok',
    review_complete: true,
    review_head: head,
    review_worktree_clean: true,
    review_blocking_findings: 0
  }, fixtureEnv);

  // 払い出したworktreeが外部の操作で消えた状態。共有ツリーはcleanなbase branchのまま。
  fs.rmSync(worktreePath, { recursive: true, force: true });
  assert.strictEqual(deliveryWorkspace(readState(input, fixtureEnv), fixture), null);

  const sharedEdit = JSON.stringify({
    ...input,
    tool_name: 'Edit',
    tool_input: { file_path: path.join(fixture, 'src', 'product.ts') }
  });
  const denied = JSON.parse(deliveryGate.run(sharedEdit, { cwd: fixture, env: fixtureEnv }));
  assert.strictEqual(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /no longer a working tree of this repository/);
  assert.ok(readEvents(fixtureEnv).some(event => event.type === 'delivery_worktree_missing'));

  // fail-closeしている間も、拒否理由が案内するECC自身のcommandだけは実行できる。
  // ここを塞ぐと、案内しているresetそのものを走らせられず復旧できない。
  for (const command of [
    `node "${path.join(pluginRoot, 'scripts', 'codex', 'reset.js')}" delivery-worktree-lost`,
    `node "${path.join(pluginRoot, 'scripts', 'codex', 'delivery-lifecycle.js')}" prepare --session delivery-worktree-lost`
  ]) {
    const recovery = JSON.stringify({ ...input, tool_name: 'Bash', tool_input: { command } });
    assert.strictEqual(deliveryGate.run(recovery, { cwd: fixture, env: fixtureEnv }), recovery, command);
  }
  // 共有ツリーで走るcommandは、案内に見えても通らない。
  const restoreElsewhere = JSON.stringify({
    ...input,
    tool_name: 'Bash',
    tool_input: { command: `git worktree add "${worktreePath}" ${branch}` }
  });
  assert.strictEqual(
    JSON.parse(deliveryGate.run(restoreElsewhere, { cwd: fixture, env: fixtureEnv })).hookSpecificOutput.permissionDecision,
    'deny'
  );

  const raw = JSON.stringify(input);
  const blocked = JSON.parse(deliveryCompletion.run(raw, {
    cwd: fixture,
    env: fixtureEnv,
    command: () => { throw new Error('completion must not inspect any working tree'); }
  }));
  assert.strictEqual(blocked.decision, 'block');
  assert.match(blocked.reason, /no longer a working tree of this repository/);

  // 共有ツリーのコミットをDeliveryの成果として拾わない。
  const committed = JSON.stringify({
    ...input,
    tool_name: 'Bash',
    tool_input: { command: 'git commit -m "unrelated"' },
    tool_response: { exit_code: 0 }
  });
  assert.match(
    deliveryProgress.run(committed, { cwd: fixture, env: fixtureEnv }).additionalContext,
    /missing or belongs to another repository/
  );
  assert.strictEqual(readState(input, fixtureEnv).delivery.committed_head, head);

  // 別リポジトリを指す記録も同じくfail-closeする。
  const foreign = createGitFixture('delivery-worktree-foreign-repo');
  writeState(input, {
    delivery: { ...readState(input, fixtureEnv).delivery, worktree_path: foreign }
  }, fixtureEnv);
  assert.strictEqual(deliveryWorkspace(readState(input, fixtureEnv), fixture), null);
});

test('a recorded worktree swapped for another repository fails closed, even from inside that path', () => {
  const fixture = createGitFixture('delivery-worktree-swap-repo');
  const deliveryConfig = JSON.stringify({ profile: 'standard', deliveryWorkflow: 'required', codex: { enabled: true } });
  fs.writeFileSync(path.join(fixture, '.ecc', 'config.json'), deliveryConfig, 'utf8');
  // 払い出したworktreeにも同じ設定が渡るよう、先にcommitしておく。
  assert.strictEqual(spawnSync('git', ['add', '.ecc/config.json'], { cwd: fixture }).status, 0);
  assert.strictEqual(spawnSync('git', ['commit', '--quiet', '-m', 'require delivery workflow'], { cwd: fixture }).status, 0);
  const baseBranch = spawnSync('git', ['branch', '--show-current'], { cwd: fixture, encoding: 'utf8' }).stdout.trim();
  const branch = 'codex/issue-79-worktree-swap';
  const worktreePath = path.join(temp, 'delivery-worktree-swap-tree');
  assert.strictEqual(
    spawnSync('git', ['worktree', 'add', '--quiet', '-b', branch, worktreePath], { cwd: fixture }).status,
    0
  );
  const fixtureEnv = { ...env, ECC_KOUTE_STATE_DIR: path.join(temp, 'delivery-worktree-swap-state') };
  // 手順書どおり、以後の作業は払い出されたworktreeの中で進む。cwdは記録pathそのものである。
  const input = { session_id: 'delivery-worktree-swap', cwd: worktreePath };
  writeState(input, {
    project: projectFingerprint(fixture),
    delivery: {
      status: 'ready',
      request_hash: 'worktree-swap-fixture',
      title: 'the recorded worktree must stay this repository',
      base_branch: baseBranch,
      issue_number: 79,
      issue_url: 'https://example.invalid/issues/79',
      branch,
      worktree_path: worktreePath,
      draft_pr_url: null
    }
  }, fixtureEnv);

  const edit = JSON.stringify({
    ...input,
    tool_name: 'Edit',
    tool_input: { file_path: path.join(worktreePath, 'src', 'product.ts') }
  });
  const ready = readState(input, fixtureEnv);
  assert.strictEqual(deliveryWorkspace(ready, worktreePath), worktreePath);
  assert.strictEqual(deliveryWorkspace(ready, fixture), worktreePath);
  assert.strictEqual(deliveryGate.run(edit, { cwd: worktreePath, env: fixtureEnv }), edit);

  // 記録pathを、同じ設定と同じbranch名を持つ別リポジトリの作業ツリーへ差し替える。
  // pathも設定も見た目は変わらないので、リポジトリの素性を測り直さない限り区別できない。
  fs.rmSync(worktreePath, { recursive: true, force: true });
  fs.mkdirSync(path.join(worktreePath, '.ecc'), { recursive: true });
  fs.mkdirSync(path.join(worktreePath, 'src'), { recursive: true });
  fs.writeFileSync(path.join(worktreePath, '.ecc', 'config.json'), deliveryConfig, 'utf8');
  fs.writeFileSync(path.join(worktreePath, 'src', 'product.ts'), 'export const product = true;\n', 'utf8');
  assert.strictEqual(spawnSync('git', ['init', '--quiet'], { cwd: worktreePath }).status, 0);
  assert.strictEqual(spawnSync('git', ['config', 'user.email', 'ecc-test@example.invalid'], { cwd: worktreePath }).status, 0);
  assert.strictEqual(spawnSync('git', ['config', 'user.name', 'ECC Test'], { cwd: worktreePath }).status, 0);
  assert.strictEqual(spawnSync('git', ['add', '.'], { cwd: worktreePath }).status, 0);
  assert.strictEqual(spawnSync('git', ['commit', '--quiet', '-m', 'foreign repository'], { cwd: worktreePath }).status, 0);
  assert.strictEqual(spawnSync('git', ['switch', '--quiet', '-c', branch], { cwd: worktreePath }).status, 0);

  // 一度通ったpathでも、判定のたびに現在のリポジトリを測り直す。cwdが記録path自身でも、
  // 突き合わせる相手はDeliveryが記録したproject識別子であって、cwd自身ではない。
  const swapped = readState(input, fixtureEnv);
  assert.strictEqual(deliveryWorkspace(swapped, worktreePath), null);
  assert.strictEqual(deliveryWorkspace(swapped, fixture), null);

  const denied = JSON.parse(deliveryGate.run(edit, { cwd: worktreePath, env: fixtureEnv }));
  assert.strictEqual(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /no longer a working tree of this repository/);

  // Codexレビューも完了Gateも、差し替えられたツリーを証拠として読まない。
  assert.throws(
    () => runRole({ role: 'review', request: 'review the delivery', cwd: worktreePath, sessionId: input.session_id, env: fixtureEnv }),
    /missing or belongs to another repository/
  );
  const blocked = JSON.parse(deliveryCompletion.run(JSON.stringify(input), {
    cwd: worktreePath,
    env: fixtureEnv,
    command: () => { throw new Error('completion must not inspect any working tree'); }
  }));
  assert.strictEqual(blocked.decision, 'block');
  assert.match(blocked.reason, /no longer a working tree of this repository/);
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
  // 完了判定は払い出したworktreeで行う。共有ツリーはDeliveryのbranchを握らない。
  const worktreePath = path.join(temp, 'delivery-completion-worktree');
  assert.strictEqual(
    spawnSync('git', ['worktree', 'add', '--quiet', '-b', branch, worktreePath], { cwd: fixture }).status,
    0
  );
  writeState(input, {
    delivery: { status: 'ready', issue_number: 7, branch, base_branch: 'main', worktree_path: worktreePath },
    last_role: 'review',
    review_role: 'review',
    review_status: 'ok',
    review_complete: true,
    review_head: 'stale-commit',
    review_worktree_clean: true
  }, fixtureEnv);
  const output = JSON.parse(deliveryCompletion.run(JSON.stringify(input), { cwd: fixture, env: fixtureEnv }));
  assert.strictEqual(output.decision, 'block');
  assert.match(output.reason, /current clean commit/);

  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf8' }).stdout.trim();
  writeState(input, {
    review_role: 'review',
    review_status: 'ok',
    review_complete: true,
    review_head: head,
    review_worktree_clean: true,
    review_blocking_findings: 1
  }, fixtureEnv);
  const blockingReview = JSON.parse(deliveryCompletion.run(JSON.stringify(input), { cwd: fixture, env: fixtureEnv }));
  assert.strictEqual(blockingReview.decision, 'block');
  assert.match(blockingReview.reason, /release-blocking findings/);
  writeState(input, { review_blocking_findings: 0 }, fixtureEnv);
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
          stdout: JSON.stringify([{ url: 'https://example.invalid/pr/1', isDraft: true, number: 1, body: 'Closes #7', baseRefName: 'develop', headRefOid: head }]),
          stderr: ''
        };
      }
      return deliveryCompletion.command(binary, args, commandCwd, commandEnv);
    }
  }));
  assert.strictEqual(wrongBase.decision, 'block');
  assert.match(wrongBase.reason, /based on main/);

  const rawInput = JSON.stringify(input);
  assert.strictEqual(deliveryCompletion.run(rawInput, {
    cwd: fixture,
    env: fixtureEnv,
    command(binary, args, commandCwd, commandEnv) {
      if (binary === 'gh') {
        return {
          ok: true,
          stdout: JSON.stringify([{ url: 'https://example.invalid/pr/2', isDraft: true, number: 2, body: 'Closes #7', baseRefName: 'main', headRefOid: head }]),
          stderr: ''
        };
      }
      return deliveryCompletion.command(binary, args, commandCwd, commandEnv);
    }
  }), rawInput);
  const completed = readState(input, fixtureEnv);
  assert.strictEqual(completed.delivery.status, 'draft-pr');
  assert.strictEqual(completed.delivery.draft_pr_url, 'https://example.invalid/pr/2');
});

test('squash completion requires a current Local Merge Gate status and confirms the merged PR', () => {
  const fixture = createGitFixture('delivery-squash-completion-repo');
  fs.writeFileSync(
    path.join(fixture, '.ecc', 'config.json'),
    JSON.stringify({
      profile: 'standard',
      deliveryWorkflow: 'required',
      deliveryCompletion: 'squash-merge',
      mergeGate: {
        provider: 'commit-status',
        command: 'engineering-kit-merge-gate',
        adapter: 'scripts/ci/project-verify.sh',
        statusContext: 'Local Merge Gate',
        strategy: 'squash'
      },
      codex: { enabled: true }
    }),
    'utf8'
  );
  assert.strictEqual(spawnSync('git', ['add', '.ecc/config.json'], { cwd: fixture }).status, 0);
  assert.strictEqual(spawnSync('git', ['commit', '--quiet', '-m', 'enable squash completion'], { cwd: fixture }).status, 0);
  const branch = 'codex/issue-73-local-gate';
  const worktreePath = path.join(temp, 'delivery-squash-worktree');
  assert.strictEqual(
    spawnSync('git', ['worktree', 'add', '--quiet', '-b', branch, worktreePath], { cwd: fixture }).status,
    0
  );
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf8' }).stdout.trim();
  const fixtureEnv = { ...env, ECC_KOUTE_STATE_DIR: path.join(temp, 'delivery-squash-state') };
  const input = { session_id: 'delivery-squash', cwd: fixture };
  writeState(input, {
    delivery: { status: 'ready', issue_number: 73, branch, base_branch: 'main', worktree_path: worktreePath },
    review_role: 'review',
    review_status: 'ok',
    review_complete: true,
    review_head: head,
    review_worktree_clean: true,
    review_blocking_findings: 0
  }, fixtureEnv);

  const calls = [];
  const execute = (binary, args, commandCwd, commandEnv) => {
    calls.push([binary, ...args]);
    if (binary !== 'gh') return deliveryCompletion.command(binary, args, commandCwd, commandEnv);
    if (args[0] === 'pr' && args[1] === 'list') {
      return { ok: true, stdout: JSON.stringify([{ url: 'https://example.invalid/pr/8', isDraft: true, number: 8, body: 'Closes #73', baseRefName: 'main', headRefOid: head }]), stderr: '' };
    }
    if (args[0] === 'repo') return { ok: true, stdout: 'acme/example', stderr: '' };
    if (args[0] === 'api') {
      return { ok: true, stdout: JSON.stringify({ sha: head, statuses: [{ context: 'Local Merge Gate', state: 'success', target_url: 'https://example.invalid/evidence' }] }), stderr: '' };
    }
    if (args[0] === 'pr' && args[1] === 'ready') return { ok: true, stdout: '', stderr: '' };
    if (args[0] === 'pr' && args[1] === 'merge') return { ok: true, stdout: '', stderr: '' };
    if (args[0] === 'pr' && args[1] === 'view') {
      return { ok: true, stdout: JSON.stringify({ state: 'MERGED', isDraft: false, headRefOid: head, url: 'https://example.invalid/pr/8' }), stderr: '' };
    }
    throw new Error(`unexpected gh command: ${args.join(' ')}`);
  };

  const raw = JSON.stringify(input);
  assert.strictEqual(deliveryCompletion.run(raw, { cwd: fixture, env: fixtureEnv, command: execute }), raw);
  const completed = readState(input, fixtureEnv);
  assert.strictEqual(completed.delivery.status, 'merged');
  assert.strictEqual(completed.delivery.merged_pr_url, 'https://example.invalid/pr/8');
  assert.ok(calls.some(call => call.join(' ') === 'gh pr ready 8'));
  assert.ok(calls.some(call => call.join(' ') === 'gh pr merge 8 --squash'));

  writeState(input, {
    delivery: { status: 'ready', issue_number: 73, branch, base_branch: 'main', worktree_path: worktreePath }
  }, fixtureEnv);
  const stale = JSON.parse(deliveryCompletion.run(raw, {
    cwd: fixture,
    env: fixtureEnv,
    command(binary, args, commandCwd, commandEnv) {
      if (binary !== 'gh') return deliveryCompletion.command(binary, args, commandCwd, commandEnv);
      if (args[0] === 'pr' && args[1] === 'list') return execute(binary, args, commandCwd, commandEnv);
      if (args[0] === 'repo') return { ok: true, stdout: 'acme/example', stderr: '' };
      if (args[0] === 'api') return { ok: true, stdout: JSON.stringify({ sha: 'stale', statuses: [{ context: 'Local Merge Gate', state: 'success' }] }), stderr: '' };
      throw new Error(`unexpected gh command: ${args.join(' ')}`);
    }
  }));
  assert.strictEqual(stale.decision, 'block');
  assert.match(stale.reason, /current HEAD/);
});

test('local merge policy blocks merge bypasses and direct success status publication', () => {
  assert.ok(PRE_BASH_HOOKS.some(hook => hook.id === 'pre:bash:local-merge-policy'));
  const fixture = createGitFixture('local-merge-policy-repo');
  fs.writeFileSync(
    path.join(fixture, '.ecc', 'config.json'),
    JSON.stringify({
      profile: 'standard',
      deliveryWorkflow: 'required',
      deliveryCompletion: 'squash-merge',
      mergeGate: { provider: 'commit-status', statusContext: 'Local Merge Gate', strategy: 'squash' },
      codex: { enabled: true }
    }),
    'utf8'
  );
  const bash = command => JSON.stringify({ cwd: fixture, tool_name: 'Bash', tool_input: { command } });
  for (const command of [
    'gh pr merge 12 --squash',
    'gh pr merge 12 --admin --squash',
    'gh api repos/acme/example/statuses/abc -f state=success -f context="Local Merge Gate"'
  ]) {
    const denied = JSON.parse(localMergePolicy.run(bash(command), { cwd: fixture, env }));
    assert.strictEqual(denied.hookSpecificOutput.permissionDecision, 'deny', command);
  }
  const ordinary = bash('gh pr view 12 --json state');
  assert.strictEqual(localMergePolicy.run(ordinary, { cwd: fixture, env }), ordinary);

  const backgroundReview = JSON.stringify({
    cwd: fixture,
    tool_name: 'Bash',
    tool_input: {
      command: 'node "$CLAUDE_PLUGIN_ROOT/scripts/codex/run-role.js" review --request test',
      run_in_background: true
    }
  });
  const backgroundDenied = JSON.parse(localMergePolicy.run(backgroundReview, { cwd: fixture, env }));
  assert.strictEqual(backgroundDenied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(backgroundDenied.hookSpecificOutput.permissionDecisionReason, /foreground/);

  const foregroundReview = JSON.stringify({
    cwd: fixture,
    tool_name: 'Bash',
    tool_input: {
      command: 'node "$CLAUDE_PLUGIN_ROOT/scripts/codex/run-role.js" review --request test',
      run_in_background: false
    }
  });
  assert.strictEqual(localMergePolicy.run(foregroundReview, { cwd: fixture, env }), foregroundReview);
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

test('a clean commit in the delivery worktree is recorded and further edits wait for an independent review', () => {
  const fixture = createGitFixture('delivery-progress-repo');
  fs.writeFileSync(
    path.join(fixture, '.ecc', 'config.json'),
    JSON.stringify({ profile: 'standard', deliveryWorkflow: 'required', codex: { enabled: true } }),
    'utf8'
  );
  assert.strictEqual(spawnSync('git', ['add', '.ecc/config.json'], { cwd: fixture }).status, 0);
  assert.strictEqual(spawnSync('git', ['commit', '--quiet', '-m', 'require delivery'], { cwd: fixture }).status, 0);
  const branch = 'codex/issue-31-progress';
  // 実装は共有ツリーではなく払い出したworktreeで進む。共有ツリーは自分のbranchのままである。
  const worktreePath = path.join(temp, 'delivery-progress-worktree');
  assert.strictEqual(
    spawnSync('git', ['worktree', 'add', '--quiet', '-b', branch, worktreePath], { cwd: fixture }).status,
    0
  );
  fs.writeFileSync(path.join(worktreePath, 'src', 'product.ts'), 'export const product = false;\n', 'utf8');
  assert.strictEqual(spawnSync('git', ['add', 'src/product.ts'], { cwd: worktreePath }).status, 0);
  assert.strictEqual(spawnSync('git', ['commit', '--quiet', '-m', 'fix product'], { cwd: worktreePath }).status, 0);

  const fixtureEnv = { ...env, ECC_KOUTE_STATE_DIR: path.join(temp, 'delivery-progress-state') };
  const input = { session_id: 'delivery-progress', cwd: fixture };
  writeState(input, {
    project: projectFingerprint(fixture),
    delivery: { status: 'ready', issue_number: 31, branch, base_branch: 'main', worktree_path: worktreePath }
  }, fixtureEnv);
  // 手順書が案内するコミットの形は `git -C "<worktree>" commit …` である。共有ツリーで走る
  // 形しか読めない観測では、隔離後のDeliveryのコミットを一つも記録できない。
  assert.strictEqual(deliveryProgress.runsGitCommit(`git -C "${worktreePath}" commit -m "fix product"`), true);
  assert.strictEqual(deliveryProgress.runsGitCommit(`cd "${worktreePath}" && git commit -m "fix product"`), true);
  assert.strictEqual(deliveryProgress.runsGitCommit('git log --oneline -5'), false);
  const progress = deliveryProgress.run(JSON.stringify({
    ...input,
    tool_name: 'Bash',
    tool_input: { command: `git -C "${worktreePath}" commit -m "fix product"` },
    tool_response: { exit_code: 0 }
  }), { cwd: fixture, env: fixtureEnv });
  assert.match(progress.additionalContext, /independent Codex review/);
  const recorded = readState(input, fixtureEnv);
  assert.strictEqual(recorded.delivery.committed_head, spawnSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf8' }).stdout.trim());

  const edit = JSON.stringify({ ...input, tool_name: 'Edit', tool_input: { file_path: path.join(worktreePath, 'src', 'product.ts') } });
  const denied = JSON.parse(deliveryGate.run(edit, { cwd: fixture, env: fixtureEnv }));
  assert.strictEqual(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /waiting for an independent Codex review/);

  writeState(input, {
    review_role: 'review',
    review_status: 'blocked',
    review_complete: true,
    review_head: recorded.delivery.committed_head,
    review_worktree_clean: true,
    review_blocking_findings: 1
  }, fixtureEnv);
  assert.strictEqual(deliveryGate.run(edit, { cwd: fixture, env: fixtureEnv }), edit);
});

test('failed commits do not advance Delivery and branch mismatch incidents are deduplicated', () => {
  const fixture = createGitFixture('delivery-incident-dedup-repo');
  fs.writeFileSync(
    path.join(fixture, '.ecc', 'config.json'),
    JSON.stringify({ profile: 'standard', deliveryWorkflow: 'required', codex: { enabled: true } }),
    'utf8'
  );
  const branch = 'codex/issue-32-dedup';
  // 記録済みbranchとは別のbranchのまま残っているworktree。不一致はここで観測される。
  const worktreePath = path.join(temp, 'delivery-incident-dedup-worktree');
  assert.strictEqual(
    spawnSync('git', ['worktree', 'add', '--quiet', '-b', 'codex/issue-32-other', worktreePath], { cwd: fixture }).status,
    0
  );
  const fixtureEnv = { ...env, ECC_KOUTE_STATE_DIR: path.join(temp, 'delivery-incident-dedup-state') };
  const input = { session_id: 'delivery-incident-dedup', cwd: fixture };
  writeState(input, {
    project: projectFingerprint(fixture),
    delivery: { status: 'ready', issue_number: 32, branch, worktree_path: worktreePath }
  }, fixtureEnv);

  const failedCommit = JSON.stringify({
    ...input,
    tool_name: 'Bash',
    tool_input: { command: `git -C "${worktreePath}" commit -m failed` },
    tool_response: { exit_code: 1, stderr: 'nothing to commit' }
  });
  assert.strictEqual(deliveryProgress.run(failedCommit, { cwd: fixture, env: fixtureEnv }), failedCommit);
  assert.strictEqual(readState(input, fixtureEnv).delivery.committed_head, undefined);

  const edit = JSON.stringify({ ...input, tool_name: 'Edit', tool_input: { file_path: path.join(worktreePath, 'src', 'product.ts') } });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const denied = JSON.parse(deliveryGate.run(edit, { cwd: fixture, env: fixtureEnv }));
    assert.strictEqual(denied.hookSpecificOutput.permissionDecision, 'deny');
  }
  const incidents = readEvents(fixtureEnv).filter(event => event.type === 'delivery_branch_mismatch');
  assert.strictEqual(incidents.length, 1);
  assert.strictEqual(incidents[0].severity, 'minor');
});

test('an incomplete delivery session records exactly one promotable incident', () => {
  const fixture = createGitFixture('delivery-finalizer-repo');
  const fixtureEnv = { ...env, ECC_KOUTE_STATE_DIR: path.join(temp, 'delivery-finalizer-state') };
  const input = { session_id: 'delivery-finalizer', cwd: fixture };
  writeState(input, {
    project: projectFingerprint(fixture),
    delivery: {
      status: 'ready',
      issue_number: 44,
      branch: 'codex/issue-44-finalizer',
      committed_head: 'deadbeef',
      completion_stage: 'review-required'
    }
  }, fixtureEnv);
  const state = readState(input, fixtureEnv);
  assert.strictEqual(deliveryFinalizer.reportIncomplete(input, state, { cwd: fixture, env: fixtureEnv }), true);
  assert.strictEqual(deliveryFinalizer.reportIncomplete(input, readState(input, fixtureEnv), { cwd: fixture, env: fixtureEnv }), false);
  const incidents = readEvents(fixtureEnv).filter(event => event.type === 'delivery_stranded_after_commit');
  assert.strictEqual(incidents.length, 1);
  assert.strictEqual(incidents[0].severity, 'critical');
  assert.strictEqual(incidents[0].target, 'ecc');
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

test('plan mode records deferred delivery intent and blocks the first approved edit until prepare', () => {
  const fixture = createGitFixture('plan-mode-context-repo');
  fs.writeFileSync(
    path.join(fixture, '.ecc', 'config.json'),
    JSON.stringify({ profile: 'standard', deliveryWorkflow: 'required', codex: { enabled: true } }),
    'utf8'
  );
  const fixtureEnv = { ...env, ECC_KOUTE_STATE_DIR: path.join(temp, 'plan-mode-context-state') };
  const output = JSON.parse(contextBuilder.run(JSON.stringify({
    session_id: 'plan-mode-context',
    cwd: fixture,
    permission_mode: 'plan',
    prompt: '認証処理を修正してください'
  }), {
    cwd: fixture,
    env: fixtureEnv,
    runRole() {
      return {
        ok: true,
        result: { status: 'ok', summary: 'planning context', files: [], constraints: [], risks: [], verification: [] }
      };
    }
  }));
  const state = readState({ session_id: 'plan-mode-context' }, fixtureEnv);
  assert.strictEqual(state.delivery.status, 'deferred');
  assert.match(output.hookSpecificOutput.additionalContext, /delivery-lifecycle\.js/);
  assert.match(output.hookSpecificOutput.additionalContext, /planning context/);

  const planBash = JSON.stringify({
    session_id: 'plan-mode-context',
    cwd: fixture,
    permission_mode: 'plan',
    tool_name: 'Bash',
    tool_input: { command: 'git status --short' }
  });
  assert.strictEqual(deliveryGate.run(planBash, { cwd: fixture, env: fixtureEnv }), planBash);

  const approvedEdit = JSON.stringify({
    session_id: 'plan-mode-context',
    cwd: fixture,
    permission_mode: 'default',
    tool_name: 'Edit',
    tool_input: { file_path: path.join(fixture, 'src', 'product.ts') }
  });
  const denied = JSON.parse(deliveryGate.run(approvedEdit, { cwd: fixture, env: fixtureEnv }));
  assert.strictEqual(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /delivery-lifecycle\.js/);

  const planStop = JSON.stringify({ session_id: 'plan-mode-context', cwd: fixture, permission_mode: 'plan' });
  assert.strictEqual(deliveryCompletion.run(planStop, { cwd: fixture, env: fixtureEnv }), planStop);
  const approvedStop = JSON.parse(deliveryCompletion.run(JSON.stringify({
    session_id: 'plan-mode-context', cwd: fixture, permission_mode: 'default'
  }), { cwd: fixture, env: fixtureEnv }));
  assert.strictEqual(approvedStop.decision, 'block');
  assert.match(approvedStop.reason, /delivery-prepare/);
});

test('switching an existing pending delivery into plan mode defers it without repository side effects', () => {
  const fixture = createGitFixture('pending-to-plan-context-repo');
  fs.writeFileSync(
    path.join(fixture, '.ecc', 'config.json'),
    JSON.stringify({ profile: 'standard', deliveryWorkflow: 'required', codex: { enabled: true } }),
    'utf8'
  );
  const fixtureEnv = { ...env, ECC_KOUTE_STATE_DIR: path.join(temp, 'pending-to-plan-context-state') };
  const input = { session_id: 'pending-to-plan-context', cwd: fixture };
  const request = '認証処理を修正してください';
  assert.strictEqual(initializeDelivery(input, request, { cwd: fixture, env: fixtureEnv }).status, 'pending');
  assert.strictEqual(initializeDelivery(input, 'まず設計だけ確認したいです', {
    cwd: fixture,
    env: fixtureEnv,
    deferred: true
  }).status, 'deferred');
  assert.strictEqual(readState(input, fixtureEnv).delivery.status, 'deferred');
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
  assert.throws(
    () => validateResult({
      status: 'blocked',
      review_complete: true,
      summary: 'owner action',
      findings: [{ severity: 'critical', disposition: 'owner-action' }],
      followups: ['perform the action']
    }, 'assessment-result.schema.json'),
    /Critical findings must be classified as release-blocker/
  );
  assert.throws(
    () => validateResult({
      status: 'ok',
      review_complete: true,
      summary: 'high follow-up',
      findings: [{ severity: 'high', disposition: 'follow-up' }],
      followups: ['fix later']
    }, 'assessment-result.schema.json'),
    /High findings cannot be classified as follow-up/
  );
  assert.throws(
    () => validateResult({
      status: 'blocked',
      review_complete: true,
      summary: 'owner action',
      findings: [{ severity: 'high', disposition: 'owner-action' }],
      followups: []
    }, 'assessment-result.schema.json'),
    /require at least one explicit follow-up/
  );
});

test('review normalization makes release blockers authoritative over model status', () => {
  const blocker = {
    severity: 'high',
    disposition: 'release-blocker',
    fingerprint: 'authoritative-blocker'
  };
  const normalized = normalizeReviewResult({
    status: 'ok',
    review_complete: true,
    summary: 'contradictory result',
    findings: [blocker],
    followups: []
  });
  assert.strictEqual(normalized.result.status, 'blocked');
  assert.strictEqual(normalized.releaseBlockers.length, 1);
  const medium = normalizeReviewResult({
    status: 'ok',
    review_complete: true,
    summary: 'lower severity blocker',
    findings: [{ ...blocker, severity: 'medium' }],
    followups: []
  });
  assert.strictEqual(medium.result.status, 'blocked');
  assert.strictEqual(medium.releaseBlockers.length, 1);

  const ownerOnly = normalizeReviewResult({
    status: 'blocked',
    review_complete: true,
    summary: 'owner action remains',
    findings: [{ severity: 'high', disposition: 'owner-action', fingerprint: 'owner-step' }],
    followups: ['complete the owner action']
  });
  assert.strictEqual(ownerOnly.result.status, 'ok');

  const incomplete = normalizeReviewResult({
    status: 'ok',
    review_complete: false,
    summary: 'inspection stopped early',
    findings: [],
    followups: []
  });
  assert.strictEqual(incomplete.result.status, 'blocked');
});

test('review instructions require full-file and workflow-structure inspection', () => {
  const instructions = roleInstructions('review', 'review this delivery');
  assert.match(instructions, /Read every changed file in full/);
  assert.match(instructions, /ordered procedure/);
  assert.match(instructions, /owner-action/);
});

test('clean review snapshots are reused instead of rerunning Codex', () => {
  const fixture = createGitFixture('review-cache-repo');
  const fixtureEnv = {
    ...env,
    ECC_KOUTE_STATE_DIR: path.join(temp, 'review-cache-state'),
    ECC_CODEX_BINARY: createCodexShim('review-cache', fixture)
  };
  const first = runRole({ role: 'review', request: 'review fixture', cwd: fixture, sessionId: 'review-cache', env: fixtureEnv });
  const second = runRole({ role: 'review', request: 'review fixture', cwd: fixture, sessionId: 'review-cache', env: fixtureEnv });
  assert.strictEqual(first.ok, true, JSON.stringify(first));
  assert.strictEqual(second.ok, true, JSON.stringify(second));
  assert.strictEqual(second.cached, true);
  assert.strictEqual(readState({ session_id: 'review-cache' }, fixtureEnv).codex_calls, 1);
});

test('a materially different review request does not reuse a prior review snapshot', () => {
  const fixture = createGitFixture('review-request-cache-repo');
  const fixtureEnv = {
    ...env,
    ECC_KOUTE_STATE_DIR: path.join(temp, 'review-request-cache-state'),
    ECC_CODEX_BINARY: createCodexShim('review-request-cache', fixture)
  };
  const first = runRole({ role: 'review', request: 'review correctness', cwd: fixture, sessionId: 'review-request-cache', env: fixtureEnv });
  const second = runRole({ role: 'review', request: 'review security boundaries', cwd: fixture, sessionId: 'review-request-cache', env: fixtureEnv });
  assert.strictEqual(first.ok, true, JSON.stringify(first));
  assert.strictEqual(second.ok, true, JSON.stringify(second));
  assert.notStrictEqual(second.cached, true);
  assert.strictEqual(readState({ session_id: 'review-request-cache' }, fixtureEnv).codex_calls, 2);
});

test('an incomplete blocked review is not cached and can be retried with the same request', () => {
  const fixture = createGitFixture('review-incomplete-cache-repo');
  const fixtureEnv = {
    ...env,
    ECC_KOUTE_STATE_DIR: path.join(temp, 'review-incomplete-cache-state'),
    ECC_CODEX_BINARY: createCodexShim('review-cache', fixture)
  };
  const session = { session_id: 'review-incomplete-cache' };
  const request = 'review incomplete fixture';
  writeState(session, {
    review_role: 'review',
    review_status: 'blocked',
    review_complete: false,
    review_worktree_clean: true,
    review_blocking_findings: 0,
    review_snapshot: reviewSnapshot(fixture, {}),
    review_request_hash: hash(request, 32),
    review_result: { status: 'blocked', review_complete: false, summary: 'review incomplete', findings: [], followups: [] }
  }, fixtureEnv);
  const result = runRole({ role: 'review', request, cwd: fixture, sessionId: session.session_id, env: fixtureEnv });
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.notStrictEqual(result.cached, true);
  assert.strictEqual(result.result.status, 'ok');
});

test('owner-only external actions do not create an unclosable review blocker', () => {
  const fixture = createGitFixture('review-owner-action-repo');
  const fixtureEnv = {
    ...env,
    ECC_KOUTE_STATE_DIR: path.join(temp, 'review-owner-action-state'),
    ECC_CODEX_BINARY: createCodexShim('owner-action', fixture)
  };
  const output = runRole({ role: 'review', request: 'review owner action', cwd: fixture, sessionId: 'review-owner-action', env: fixtureEnv });
  const state = readState({ session_id: 'review-owner-action' }, fixtureEnv);
  assert.strictEqual(output.ok, true, JSON.stringify(output));
  assert.strictEqual(output.result.status, 'ok');
  assert.strictEqual(state.review_status, 'ok');
  assert.strictEqual(state.review_blocking_findings, 0);
  assert.deepStrictEqual(state.review_owner_actions.map(item => item.fingerprint), ['owner-step']);
});

test('run-role persists a contradictory release blocker as blocked', () => {
  const fixture = createGitFixture('review-release-blocker-repo');
  const fixtureEnv = {
    ...env,
    ECC_KOUTE_STATE_DIR: path.join(temp, 'review-release-blocker-state'),
    ECC_CODEX_BINARY: createCodexShim('contradictory-blocker', fixture)
  };
  const output = runRole({ role: 'review', request: 'review blocker', cwd: fixture, sessionId: 'review-release-blocker', env: fixtureEnv });
  const state = readState({ session_id: 'review-release-blocker' }, fixtureEnv);
  assert.strictEqual(output.ok, true, JSON.stringify(output));
  assert.strictEqual(output.result.status, 'blocked');
  assert.strictEqual(state.review_status, 'blocked');
  assert.strictEqual(state.review_blocking_findings, 1);
});

test('Codex roles refuse an explicit cwd that is not the recorded delivery worktree', () => {
  const fixture = createGitFixture('run-role-cwd-repo');
  const fixtureEnv = {
    ...env,
    ECC_KOUTE_STATE_DIR: path.join(temp, 'run-role-cwd-state'),
    // shimはworktreeにも渡る必要があるため、払い出しの前にcommitしておく。
    ECC_CODEX_BINARY: createCodexShim('run-role-cwd', fixture)
  };
  const branch = 'codex/issue-79-run-role-cwd';
  const worktreePath = path.join(temp, 'run-role-cwd-worktree');
  assert.strictEqual(
    spawnSync('git', ['worktree', 'add', '--quiet', '-b', branch, worktreePath], { cwd: fixture }).status,
    0
  );
  const session = { session_id: 'run-role-cwd' };
  writeState(session, {
    project: projectFingerprint(fixture),
    delivery: { status: 'ready', issue_number: 79, branch, base_branch: 'main', worktree_path: worktreePath }
  }, fixtureEnv);

  // 共有ツリーを --cwd で渡しても、隔離済みDeliveryのroleはそこでは走らない。
  // workspace-write roleならそのまま共有ツリーを書き換えてしまう。
  for (const cwd of [fixture, path.join(worktreePath, 'src')]) {
    assert.throws(
      () => runRole({ role: 'contract-test', request: 'write a contract test', cwd, sessionId: session.session_id, env: fixtureEnv }),
      /--cwd points at/,
      cwd
    );
  }

  // 記録済みworktreeそのものを指す --cwd は従来どおり通り、証拠もそのHEADに結び付く。
  const output = runRole({ role: 'review', request: 'review the delivery', cwd: worktreePath, sessionId: session.session_id, env: fixtureEnv });
  assert.strictEqual(output.ok, true, JSON.stringify(output));
  assert.strictEqual(
    readState(session, fixtureEnv).review_head,
    spawnSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf8' }).stdout.trim()
  );

  // worktreeが失われた後も、--cwdで共有ツリーへ戻ることはできない。
  fs.rmSync(worktreePath, { recursive: true, force: true });
  assert.throws(
    () => runRole({ role: 'review', request: 'review the delivery', cwd: fixture, sessionId: session.session_id, env: fixtureEnv }),
    /missing or belongs to another repository/
  );
});

test('the Context Builder runs in the delivery worktree instead of failing on the session project directory', () => {
  const fixture = createGitFixture('context-builder-worktree-repo');
  const fixtureEnv = {
    ...env,
    ECC_KOUTE_STATE_DIR: path.join(temp, 'context-builder-worktree-state'),
    // shimはworktreeにも渡る必要があるため、払い出しの前にcommitしておく。
    ECC_CODEX_BINARY: createCodexShim('context', fixture)
  };
  const branch = 'codex/issue-79-context-builder';
  const worktreePath = path.join(temp, 'context-builder-worktree');
  assert.strictEqual(
    spawnSync('git', ['worktree', 'add', '--quiet', '-b', branch, worktreePath], { cwd: fixture }).status,
    0
  );
  // 共有ツリーとHEADを分け、どちらで走ったかを記録された証拠から見分けられるようにする。
  fs.writeFileSync(path.join(worktreePath, 'src', 'product.ts'), 'export const product = false;\n', 'utf8');
  assert.strictEqual(spawnSync('git', ['add', 'src/product.ts'], { cwd: worktreePath }).status, 0);
  assert.strictEqual(spawnSync('git', ['commit', '--quiet', '-m', 'implement in worktree'], { cwd: worktreePath }).status, 0);
  const worktreeHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf8' }).stdout.trim();
  const sharedHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: fixture, encoding: 'utf8' }).stdout.trim();
  assert.notStrictEqual(worktreeHead, sharedHead);

  const session = { session_id: 'context-builder-worktree', cwd: fixture };
  writeState(session, {
    delivery: { status: 'ready', issue_number: 79, branch, base_branch: 'main', worktree_path: worktreePath }
  }, fixtureEnv);

  // HookがrunRoleへ渡すのはSessionのproject directoryであって、作業場所の指定ではない。
  // 明示的な --cwd と同じに扱うと、隔離済みDeliveryではUserPromptSubmitが例外で落ちる。
  const output = JSON.parse(contextBuilder.run(
    JSON.stringify({ ...session, prompt: 'worktree隔離の続きを修正してください' }),
    { cwd: fixture, env: fixtureEnv }
  ));
  assert.match(output.hookSpecificOutput.additionalContext, /fixture context/);
  const state = readState(session, fixtureEnv);
  assert.strictEqual(state.context_status, 'ready');
  assert.strictEqual(state.context_head, worktreeHead);
});

test('distributed agent rules defer to runtime capabilities and do not claim automatic spawning', () => {
  const agentsRule = fs.readFileSync(path.join(__dirname, '..', '..', 'rules', 'common', 'agents.md'), 'utf8');
  const rootAgents = fs.readFileSync(path.join(__dirname, '..', '..', 'AGENTS.md'), 'utf8');
  assert.doesNotMatch(agentsRule, /No user prompt needed/);
  assert.doesNotMatch(agentsRule, /ALWAYS use parallel Task execution/);
  assert.match(agentsRule, /higher-priority/);
  assert.match(agentsRule, /does not automatically spawn/i);
  assert.doesNotMatch(rootAgents, /Use agents proactively without user prompt/);
  assert.match(rootAgents, /higher-priority/);
  assert.match(rootAgents, /does not automatically spawn/i);
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

test('workspace-write Codex roles use approve-for-me without conflicting sandbox flags', () => {
  const fixture = createGitFixture('workspace-args-shim-repo');
  const fixtureEnv = {
    ...env,
    ECC_KOUTE_STATE_DIR: path.join(temp, 'workspace-args-shim-state'),
    ECC_CODEX_BINARY: createCodexShim('assert-workspace-args', fixture)
  };
  const output = runRole({
    role: 'contract-test',
    request: 'write an independent public contract test',
    cwd: fixture,
    sessionId: 'workspace-args-shim',
    env: fixtureEnv
  });
  assert.strictEqual(output.ok, true, JSON.stringify(output));
  assert.deepStrictEqual(output.changedPaths, ['tests/contract.test.ts']);
});

test('incident threshold promotes critical once and minor twice', () => {
  assert.ok(eligible({ kind: 'incident', severity: 'critical', count: 1 }));
  assert.ok(eligible({ kind: 'incident', severity: 'minor', count: 2 }));
  assert.ok(!eligible({ kind: 'incident', severity: 'minor', count: 1 }));
});

test('incident target classification routes Kit, ECC, product, and explicit targets deterministically', () => {
  assert.strictEqual(classifyTarget({ type: 'devcontainer_voice_failure' }), 'kit');
  assert.strictEqual(classifyTarget({ type: 'codex_role_failure', message: 'Codex is not logged in' }), 'kit');
  assert.strictEqual(classifyTarget({ type: 'duplicate_finding', role: 'review' }), 'ecc');
  assert.strictEqual(classifyTarget({ type: 'product_e2e_failure' }), 'product');
  assert.strictEqual(classifyTarget({ type: 'unknown', metadata: { target: 'kit' } }), 'kit');
});

test('incident worker lock prevents concurrent reporting and releases cleanly', () => {
  const lockEnv = { ...env, ECC_KOUTE_STATE_DIR: path.join(temp, 'incident-lock-state') };
  const release = acquireLock(lockEnv);
  assert.strictEqual(typeof release, 'function');
  assert.strictEqual(acquireLock(lockEnv), null);
  release();
  const reacquired = acquireLock(lockEnv);
  assert.strictEqual(typeof reacquired, 'function');
  reacquired();
});

test('product incident handling is report-only and has no background remediation switch', () => {
  const config = loadConfig(repo, { ...env, ECC_INCIDENT_AUTO_REMEDIATE: '1' });
  assert.strictEqual(config.incidentHandling.mode, 'report-only');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(config, 'autoRemediation'), false);
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

test('central remediation requires a private operator attestation and a permitted target', () => {
  const operatorState = path.join(temp, 'operator-state');
  fs.mkdirSync(operatorState, { recursive: true });
  const attestation = path.join(operatorState, 'attestation.json');
  fs.writeFileSync(attestation, JSON.stringify({
    schemaVersion: 1,
    owner: 'engineering-environment-kit-operator',
    repositories: ['koupent/engineering-environment-kit', 'koupent/ECC']
  }), { mode: 0o600 });
  const operatorEnv = {
    ...env,
    ECC_OPERATOR_STATE_ROOT: operatorState,
    ECC_OPERATOR_ATTESTATION: attestation
  };

  assert.strictEqual(readOperatorAttestation(operatorEnv).owner, 'engineering-environment-kit-operator');
  assert.doesNotThrow(() => assertCentralRemediationAllowed({
    mode: 'central-remediate',
    targetRepository: 'koupent/ECC',
    env: operatorEnv
  }));
  assert.throws(() => assertCentralRemediationAllowed({
    mode: 'central-remediate',
    targetRepository: 'koupent/av-cast-link',
    env: operatorEnv
  }), /許可されていません/);
  assert.throws(() => assertCentralRemediationAllowed({
    mode: 'central-remediate',
    targetRepository: 'koupent/ECC',
    env
  }), /state root|attestation/);
  assert.throws(() => assertCentralRemediationAllowed({
    mode: 'report-only',
    targetRepository: 'koupent/ECC',
    env: operatorEnv
  }), /report-only/);
});

test('incident ownership Hook rejects product-side remediation and accepts an attested operator', () => {
  const raw = JSON.stringify({
    tool_name: 'Bash',
    cwd: repo,
    tool_input: { command: 'engineering-kit-incident-operator run-once' }
  });
  const denied = JSON.parse(incidentOwnershipGate.run(raw, { cwd: repo, env }));
  assert.strictEqual(denied.hookSpecificOutput.permissionDecision, 'deny');

  const operatorState = path.join(temp, 'operator-hook-state');
  fs.mkdirSync(operatorState, { recursive: true });
  const attestation = path.join(operatorState, 'attestation.json');
  const configFile = path.join(operatorState, 'config.json');
  fs.writeFileSync(attestation, JSON.stringify({
    schemaVersion: 1,
    owner: 'engineering-environment-kit-operator',
    repositories: ['koupent/engineering-environment-kit', 'koupent/ECC']
  }), { mode: 0o600 });
  fs.writeFileSync(configFile, JSON.stringify({
    version: 1,
    profile: 'standard',
    rulePacks: ['common'],
    incidentHandling: { mode: 'central-remediate', repository: 'koupent/engineering-environment-kit' }
  }));
  const operatorEnv = {
    ...env,
    ECC_OPERATOR_STATE_ROOT: operatorState,
    ECC_PROJECT_CONFIG: configFile,
    ECC_OPERATOR_ATTESTATION: attestation,
    ECC_OPERATOR_TARGET_REPOSITORY: 'koupent/ECC'
  };
  assert.strictEqual(incidentOwnershipGate.run(raw, { cwd: repo, env: operatorEnv }), raw);
  const productClone = JSON.stringify({
    tool_name: 'Bash',
    cwd: repo,
    tool_input: { command: 'gh repo clone koupent/ECC /tmp/ecc-repair' }
  });
  const cloneDenied = JSON.parse(incidentOwnershipGate.run(productClone, { cwd: repo, env }));
  assert.strictEqual(cloneDenied.hookSpecificOutput.permissionDecision, 'deny');
  assert.strictEqual(incidentOwnershipGate.run(productClone, { cwd: repo, env: operatorEnv }), productClone);
  assert.ok(PRE_BASH_HOOKS.some(hook => hook.id === 'pre:bash:incident-ownership'));
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
  for (const event of ['UserPromptSubmit', 'Stop']) {
    assert.ok(hooks[event].every(group => !Object.prototype.hasOwnProperty.call(group, 'matcher')), `${event} does not support matchers`);
  }
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
