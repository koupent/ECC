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
const { isTestPath, normalizeReviewResult, requireUsableResult, reviewSnapshot, roleInstructions, runRole, validateResult, workingTreeSignature } = require('../../scripts/codex/run-role');
const {
  acquireLock,
  centralIssuePayload,
  classifyTarget,
  eligible,
  publicIncident
} = require('../../scripts/codex/incident-worker');
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
  branchSwitchPlan,
  explicitIssueNumber,
  explicitPrNumber,
  deliveryBranch,
  findDuplicateIssue,
  findExistingDeliveryPr,
  initializeDelivery,
  isDeliveryRequest,
  isSafeGitRef,
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
      "if (mode === 'read-only-drift') {",
      "  fs.appendFileSync(path.join(process.cwd(), 'src', 'product.ts'), '// external drift\\n');",
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

test('incident handling remains report-only even when external config requests remediation', () => {
  const configFile = path.join(temp, 'operator-config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    version: 1,
    profile: 'standard',
    rulePacks: ['common'],
    incidentHandling: {
      mode: 'unsupported-write-mode',
      repository: 'koupent/engineering-environment-kit'
    },
    codex: { enabled: true }
  }), 'utf8');
  const config = loadConfig(repo, { ...env, ECC_PROJECT_CONFIG: configFile });
  assert.strictEqual(config.projectConfigPath, configFile);
  assert.strictEqual(config.projectRoot, repo);
  assert.strictEqual(config.incidentHandling.mode, 'report-only');
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

test('a new delivery clears review convergence and follow-up state from the prior delivery', () => {
  const fixture = createGitFixture('delivery-review-reset-repo');
  fs.writeFileSync(
    path.join(fixture, '.ecc', 'config.json'),
    JSON.stringify({ profile: 'standard', deliveryWorkflow: 'required', codex: { enabled: true } }),
    'utf8'
  );
  const fixtureEnv = { ...env, ECC_KOUTE_STATE_DIR: path.join(temp, 'delivery-review-reset-state') };
  const input = { session_id: 'delivery-review-reset', cwd: fixture };
  writeState(input, {
    delivery: { status: 'merged', request_hash: 'prior' },
    review_round: 3,
    review_limit_reached: true,
    review_followups: [{ fingerprint: 'prior', title: '前回の改善候補' }],
    review_followup_issue_url: 'https://example.invalid/issues/1'
  }, fixtureEnv);

  const delivery = initializeDelivery(input, '新しい不具合を修正してください', { cwd: fixture, env: fixtureEnv });
  const state = readState(input, fixtureEnv);
  assert.strictEqual(delivery.status, 'pending');
  assert.strictEqual(state.review_round, 0);
  assert.strictEqual(state.review_limit_reached, false);
  assert.deepStrictEqual(state.review_followups, []);
  assert.strictEqual(state.review_followup_issue_url, null);
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
  // pending時の案内も「prepareがbranchを切り替える」と読めてはいけない。切替は
  // 実行中の検証を畳んだエージェントが行う契約である。
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /records that branch without switching to it/);
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
  writeState(input, { delivery: { ...delivery, status: 'ready', issue_number: 42, branch } }, fixtureEnv);
  assert.strictEqual(deliveryGate.run(raw, { cwd: fixture, env: fixtureEnv }), raw);
  writeState(input, { delivery: { ...delivery, status: 'draft-pr', issue_number: 42, branch } }, fixtureEnv);
  assert.strictEqual(deliveryGate.run(bash, { cwd: fixture, env: fixtureEnv }), bash);
  assert.strictEqual(deliveryGate.run(raw, { cwd: fixture, env: fixtureEnv }), raw);
});

test('preparation hands the branch switch to the agent instead of moving a running verification', () => {
  const fixture = createGitFixture('delivery-branch-handoff-repo');
  fs.writeFileSync(
    path.join(fixture, '.ecc', 'config.json'),
    JSON.stringify({ profile: 'standard', deliveryWorkflow: 'required', codex: { enabled: true } }),
    'utf8'
  );
  assert.strictEqual(spawnSync('git', ['add', '.ecc/config.json'], { cwd: fixture }).status, 0);
  assert.strictEqual(spawnSync('git', ['commit', '--quiet', '-m', 'require delivery workflow'], { cwd: fixture }).status, 0);
  const baseBranch = spawnSync('git', ['branch', '--show-current'], { cwd: fixture, encoding: 'utf8' }).stdout.trim();
  const fixtureEnv = { ...env, ECC_KOUTE_STATE_DIR: path.join(temp, 'delivery-branch-handoff-state') };
  const input = { session_id: 'delivery-branch-handoff', cwd: fixture };
  const branch = 'codex/issue-68-branch-handoff';
  writeState(input, {
    delivery: {
      status: 'awaiting-branch',
      request_hash: 'handoff-fixture',
      title: 'preparation must not switch branches',
      base_branch: baseBranch,
      issue_number: 68,
      issue_url: 'https://example.invalid/issues/68',
      branch,
      draft_pr_url: null
    }
  }, fixtureEnv);

  const handoff = prepareDelivery(input, { cwd: fixture, env: fixtureEnv });
  assert.strictEqual(handoff.status, 'awaiting-branch');
  assert.strictEqual(handoff.branch_switch.create, true);
  assert.strictEqual(handoff.branch_switch.command, `git switch -c ${branch} ${baseBranch}`);
  assert.strictEqual(spawnSync('git', ['branch', '--show-current'], { cwd: fixture, encoding: 'utf8' }).stdout.trim(), baseBranch);
  assert.strictEqual(spawnSync('git', ['branch', '--list', branch], { cwd: fixture, encoding: 'utf8' }).stdout.trim(), '');

  const recorded = readState(input, fixtureEnv);
  assert.strictEqual(deliveryGate.isExactBranchSwitchCommand(`git switch -c ${branch} ${baseBranch}`, recorded.delivery), true);
  assert.strictEqual(deliveryGate.isExactBranchSwitchCommand(`git switch -c ${branch} ${baseBranch} && npm run build`, recorded.delivery), false);
  assert.strictEqual(deliveryGate.isExactBranchSwitchCommand(`git switch ${branch}`, recorded.delivery), false);

  const switchCommand = JSON.stringify({ ...input, tool_name: 'Bash', tool_input: { command: `git switch -c ${branch} ${baseBranch}` } });
  assert.strictEqual(deliveryGate.run(switchCommand, { cwd: fixture, env: fixtureEnv }), switchCommand);
  const otherBash = JSON.stringify({ ...input, tool_name: 'Bash', tool_input: { command: 'npm test' } });
  assert.strictEqual(
    JSON.parse(deliveryGate.run(otherBash, { cwd: fixture, env: fixtureEnv })).hookSpecificOutput.permissionDecision,
    'deny'
  );
  const edit = JSON.stringify({ ...input, tool_name: 'Edit', tool_input: { file_path: path.join(fixture, 'src', 'product.ts') } });
  const denied = JSON.parse(deliveryGate.run(edit, { cwd: fixture, env: fixtureEnv }));
  assert.strictEqual(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /no longer switches branches/);

  const stop = JSON.parse(deliveryCompletion.run(JSON.stringify(input), { cwd: fixture, env: fixtureEnv }));
  assert.strictEqual(stop.decision, 'block');
  assert.match(stop.reason, /waiting for the branch switch/);

  assert.strictEqual(spawnSync('git', ['switch', '--quiet', '-c', branch, baseBranch], { cwd: fixture }).status, 0);
  const ready = prepareDelivery(input, { cwd: fixture, env: fixtureEnv });
  assert.strictEqual(ready.status, 'ready');
  assert.strictEqual(ready.branch, branch);
  assert.strictEqual(ready.issue_number, 68);
  assert.strictEqual(ready.branch_switch, null);
  assert.strictEqual(deliveryGate.run(edit, { cwd: fixture, env: fixtureEnv }), edit);
});

test('branch switch handoff reports an existing branch without creating or switching one', () => {
  const executed = [];
  const plan = branchSwitchPlan({ base_branch: 'main' }, 'codex/issue-68-existing', 'codex/issue-271-task', {
    runCommand(binary, args) {
      executed.push([binary, ...args].join(' '));
      return args[0] === 'branch' ? '  codex/issue-68-existing' : '';
    }
  });
  assert.deepStrictEqual(plan, {
    required: true,
    from: 'codex/issue-271-task',
    to: 'codex/issue-68-existing',
    create: false,
    base_branch: null,
    command: 'git switch codex/issue-68-existing'
  });
  assert.ok(executed.every(command => !command.includes('switch')));
});

test('branch switch handoff refuses Git refs that a shell would read as several commands', () => {
  const executed = [];
  const runCommand = (binary, args) => {
    executed.push([binary, ...args].join(' '));
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
      () => branchSwitchPlan({ base_branch: 'main' }, ref, 'main', { runCommand }),
      /not shell-safe/,
      ref
    );
    assert.strictEqual(isSafeGitRef(ref), false, ref);
  }
  assert.throws(
    () => branchSwitchPlan({ base_branch: 'main;make' }, 'codex/issue-68-safe-ref', 'main', { runCommand }),
    /Delivery base branch .* not shell-safe/
  );
  // 危険なrefはgitへも渡らない。先頭ハイフンのrefで `git branch --list` がoptionとして
  // 解釈されることも、切替が実行されることもない。
  assert.ok(executed.every(command => !command.includes('switch') && !command.includes('-codex/issue-68')));

  const plan = branchSwitchPlan({ base_branch: 'main' }, 'codex/issue-68-safe-ref', 'main', { runCommand });
  assert.strictEqual(plan.command, 'git switch -c codex/issue-68-safe-ref main');

  // stateへ危険なrefが残っていても、Gateは記録済みhandoffとして実行を許可しない。
  const tampered = {
    branch: 'codex/issue-68;make',
    branch_switch: {
      required: true,
      from: 'main',
      to: 'codex/issue-68;make',
      create: false,
      base_branch: null,
      command: 'git switch codex/issue-68;make'
    }
  };
  assert.strictEqual(deliveryGate.isExactBranchSwitchCommand(tampered.branch_switch.command, tampered), false);
  assert.strictEqual(deliveryGate.isExactBranchSwitchCommand("git switch 'codex/issue-68;make'", tampered), false);
  assert.strictEqual(deliveryGate.isExactBranchSwitchCommand('git switch codex/issue-68-safe-ref', {
    branch_switch: { required: true, to: 'codex/issue-68-safe-ref', create: false, base_branch: null }
  }), true);
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
    review_complete: true,
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
  assert.strictEqual(spawnSync('git', ['switch', '-c', branch], { cwd: fixture }).status, 0);
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: fixture, encoding: 'utf8' }).stdout.trim();
  const fixtureEnv = { ...env, ECC_KOUTE_STATE_DIR: path.join(temp, 'delivery-squash-state') };
  const input = { session_id: 'delivery-squash', cwd: fixture };
  writeState(input, {
    delivery: { status: 'ready', issue_number: 73, branch, base_branch: 'main' },
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

  writeState(input, { delivery: { status: 'ready', issue_number: 73, branch, base_branch: 'main' } }, fixtureEnv);
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

test('a clean commit is recorded and further edits wait for an independent review', () => {
  const fixture = createGitFixture('delivery-progress-repo');
  fs.writeFileSync(
    path.join(fixture, '.ecc', 'config.json'),
    JSON.stringify({ profile: 'standard', deliveryWorkflow: 'required', codex: { enabled: true } }),
    'utf8'
  );
  assert.strictEqual(spawnSync('git', ['add', '.ecc/config.json'], { cwd: fixture }).status, 0);
  assert.strictEqual(spawnSync('git', ['commit', '--quiet', '-m', 'require delivery'], { cwd: fixture }).status, 0);
  const branch = 'codex/issue-31-progress';
  assert.strictEqual(spawnSync('git', ['switch', '-c', branch], { cwd: fixture }).status, 0);
  fs.writeFileSync(path.join(fixture, 'src', 'product.ts'), 'export const product = false;\n', 'utf8');
  assert.strictEqual(spawnSync('git', ['add', 'src/product.ts'], { cwd: fixture }).status, 0);
  assert.strictEqual(spawnSync('git', ['commit', '--quiet', '-m', 'fix product'], { cwd: fixture }).status, 0);

  const fixtureEnv = { ...env, ECC_KOUTE_STATE_DIR: path.join(temp, 'delivery-progress-state') };
  const input = { session_id: 'delivery-progress', cwd: fixture };
  writeState(input, { delivery: { status: 'ready', issue_number: 31, branch, base_branch: 'main' } }, fixtureEnv);
  const progress = deliveryProgress.run(JSON.stringify({
    ...input,
    tool_name: 'Bash',
    tool_input: { command: 'git commit -m "fix product"' },
    tool_response: { exit_code: 0 }
  }), { cwd: fixture, env: fixtureEnv });
  assert.match(progress.additionalContext, /独立したCodexレビュー/);
  const recorded = readState(input, fixtureEnv);
  assert.strictEqual(recorded.delivery.committed_head, spawnSync('git', ['rev-parse', 'HEAD'], { cwd: fixture, encoding: 'utf8' }).stdout.trim());

  const edit = JSON.stringify({ ...input, tool_name: 'Edit', tool_input: { file_path: path.join(fixture, 'src', 'product.ts') } });
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
  const fixtureEnv = { ...env, ECC_KOUTE_STATE_DIR: path.join(temp, 'delivery-incident-dedup-state') };
  const input = { session_id: 'delivery-incident-dedup', cwd: fixture };
  writeState(input, { delivery: { status: 'ready', issue_number: 32, branch: 'codex/issue-32-dedup' } }, fixtureEnv);

  const failedCommit = JSON.stringify({
    ...input,
    tool_name: 'Bash',
    tool_input: { command: 'git commit -m failed' },
    tool_response: { exit_code: 1, stderr: 'nothing to commit' }
  });
  assert.strictEqual(deliveryProgress.run(failedCommit, { cwd: fixture, env: fixtureEnv }), failedCommit);
  assert.strictEqual(readState(input, fixtureEnv).delivery.committed_head, undefined);

  const edit = JSON.stringify({ ...input, tool_name: 'Edit', tool_input: { file_path: path.join(fixture, 'src', 'product.ts') } });
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
    project: hash(path.resolve(fixture)),
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

test('read-only workspace drift is audited without falsely reporting a Codex role failure', () => {
  const fixture = createGitFixture('read-only-workspace-drift-repo');
  const fixtureEnv = {
    ...env,
    ECC_KOUTE_STATE_DIR: path.join(temp, 'read-only-workspace-drift-state'),
    ECC_CODEX_BINARY: createCodexShim('read-only-drift', fixture)
  };
  const input = { session_id: 'read-only-workspace-drift' };
  const result = runRole({
    role: 'review',
    request: 'review while an external process changes the worktree',
    cwd: fixture,
    sessionId: input.session_id,
    env: fixtureEnv
  });
  const state = readState(input, fixtureEnv);
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.strictEqual(state.codex_failures || 0, 0);
  assert.strictEqual(state.role_workspace_changed, true);
  assert.strictEqual(state.review_worktree_clean, false);
  assert.ok(readEvents(fixtureEnv, 20).some(event => event.kind === 'read_only_workspace_drift'));
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
  assert.doesNotThrow(
    () => validateResult({
      status: 'ok',
      review_complete: true,
      summary: 'high follow-up',
      findings: [{ severity: 'high', disposition: 'follow-up' }],
      followups: ['fix later']
    }, 'assessment-result.schema.json')
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
  assert.match(instructions, /HIGH finding may be follow-up/);
  assert.match(instructions, /Write the summary.*in Japanese/i);
  assert.match(instructions, /Do not run build, test, package, formatter, or generator commands/i);

  const focused = roleInstructions('review', 'review blocker fix', {
    focused: true,
    round: 2,
    maxRounds: 3,
    blockers: [{ fingerprint: 'known-blocker', title: '既知のblocker' }]
  });
  assert.match(focused, /focused re-review round 2 of 3/i);
  assert.match(focused, /Do not restart the full delivery review/i);
  assert.match(focused, /known-blocker/);

  const contextInstructions = roleInstructions('context-builder', 'inspect this delivery');
  assert.match(contextInstructions, /Do not run build, test, package, formatter, or generator commands/i);
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

test('focused review rounds preserve follow-up findings from earlier rounds', () => {
  const fixture = createGitFixture('review-followup-accumulation-repo');
  const fixtureEnv = {
    ...env,
    ECC_KOUTE_STATE_DIR: path.join(temp, 'review-followup-accumulation-state'),
    ECC_CODEX_BINARY: createCodexShim('review-cache', fixture)
  };
  const input = { session_id: 'review-followup-accumulation' };
  writeState(input, {
    review_followups: [{ fingerprint: 'earlier', severity: 'medium', title: '先の改善候補' }]
  }, fixtureEnv);

  const result = runRole({
    role: 'review',
    request: 'review follow-up accumulation',
    cwd: fixture,
    sessionId: input.session_id,
    env: fixtureEnv
  });
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.deepStrictEqual(
    readState(input, fixtureEnv).review_followups.map(item => item.fingerprint),
    ['earlier']
  );
});

test('review cycle reuses the same snapshot, focuses blocker fixes, and stops after three rounds', () => {
  const fixture = createGitFixture('review-convergence-cap-repo');
  const fixtureEnv = {
    ...env,
    ECC_KOUTE_STATE_DIR: path.join(temp, 'review-convergence-cap-state'),
    ECC_CODEX_BINARY: createCodexShim('contradictory-blocker', fixture)
  };
  const sessionId = 'review-convergence-cap';
  const input = { session_id: sessionId };
  writeState(input, {
    delivery: {
      status: 'ready',
      issue_number: 88,
      branch: spawnSync('git', ['branch', '--show-current'], { cwd: fixture, encoding: 'utf8' }).stdout.trim(),
      base_branch: 'main'
    }
  }, fixtureEnv);

  const first = runRole({ role: 'review', request: 'review convergence', cwd: fixture, sessionId, env: fixtureEnv });
  assert.strictEqual(first.ok, true, JSON.stringify(first));
  assert.strictEqual(readState(input, fixtureEnv).delivery.review_cycle.round, 1);

  const cached = runRole({ role: 'review', request: 'review convergence', cwd: fixture, sessionId, env: fixtureEnv });
  assert.strictEqual(cached.cached, true, JSON.stringify(cached));
  assert.strictEqual(readState(input, fixtureEnv).delivery.review_cycle.round, 1);

  for (let round = 2; round <= 3; round += 1) {
    fs.appendFileSync(path.join(fixture, 'src', 'product.ts'), `// blocker fix ${round}\n`, 'utf8');
    assert.strictEqual(spawnSync('git', ['add', 'src/product.ts'], { cwd: fixture }).status, 0);
    assert.strictEqual(spawnSync('git', ['commit', '--quiet', '-m', `blocker fix ${round}`], { cwd: fixture }).status, 0);
    const rerun = runRole({ role: 'review', request: 'review convergence', cwd: fixture, sessionId, env: fixtureEnv });
    assert.strictEqual(rerun.ok, true, JSON.stringify(rerun));
    assert.strictEqual(readState(input, fixtureEnv).delivery.review_cycle.round, round);
    assert.strictEqual(readState(input, fixtureEnv).delivery.review_cycle.mode, 'focused');
  }

  fs.appendFileSync(path.join(fixture, 'src', 'product.ts'), '// fourth attempt\n', 'utf8');
  assert.strictEqual(spawnSync('git', ['add', 'src/product.ts'], { cwd: fixture }).status, 0);
  assert.strictEqual(spawnSync('git', ['commit', '--quiet', '-m', 'fourth attempt'], { cwd: fixture }).status, 0);
  const stopped = runRole({ role: 'review', request: 'review convergence', cwd: fixture, sessionId, env: fixtureEnv });
  assert.strictEqual(stopped.ok, false);
  assert.strictEqual(stopped.needsHuman, true);
  assert.strictEqual(readState(input, fixtureEnv).codex_calls, 3);
  assert.strictEqual(readState(input, fixtureEnv).review_limit_reached, true);
});

test('non-blocking review findings are grouped into one Japanese follow-up Issue', () => {
  const fixture = createGitFixture('review-followup-issue-repo');
  const fixtureEnv = { ...env, ECC_KOUTE_STATE_DIR: path.join(temp, 'review-followup-issue-state') };
  const input = { session_id: 'review-followup-issue' };
  const state = {
    review_followups: [
      { fingerprint: 'docs', severity: 'medium', title: '運用文書を補足する', path: 'docs/runbook.md', recommendation: '例を追加する' },
      { fingerprint: 'docs', severity: 'medium', title: '重複', recommendation: '重複' }
    ]
  };
  const calls = [];
  const result = deliveryCompletion.ensureReviewFollowupIssue(
    (binary, args) => {
      calls.push([binary, ...args]);
      if (args[0] === 'issue' && args[1] === 'list') return { ok: true, stdout: '[]', stderr: '' };
      if (args[0] === 'issue' && args[1] === 'create') return { ok: true, stdout: 'https://example.invalid/issues/90', stderr: '' };
      throw new Error(`unexpected command: ${binary} ${args.join(' ')}`);
    },
    state,
    input,
    { issue_number: 89 },
    { url: 'https://example.invalid/pulls/12' },
    fixture,
    fixtureEnv
  );
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.url, 'https://example.invalid/issues/90');
  const create = calls.find(call => call[1] === 'issue' && call[2] === 'create');
  assert.ok(create);
  assert.match(create.join('\n'), /Issue #89 のレビュー改善候補/);
  assert.match(create.join('\n'), /運用文書を補足する/);
  assert.doesNotMatch(create.join('\n'), /重複/);
  assert.strictEqual(readState(input, fixtureEnv).review_followup_issue_url, result.url);
});

const repoRoot = path.join(__dirname, '..', '..');
const readRepoFile = (...segments) => fs.readFileSync(path.join(repoRoot, ...segments), 'utf8');

test('standard delivery keeps one implementation owner and one independent release review', () => {
  const workflow = readRepoFile('rules', 'common', 'development-workflow.md');
  const testing = readRepoFile('rules', 'common', 'testing.md');
  const reviewRule = readRepoFile('rules', 'common', 'code-review.md');
  const reviewCommand = readRepoFile('commands', 'code-review.md');
  const rootAgents = readRepoFile('AGENTS.md');

  assert.match(workflow, /same implementation owner carries the task/i);
  assert.match(workflow, /One independent release review/i);
  assert.match(workflow, /initial review plus two focused re-reviews/i);
  assert.doesNotMatch(workflow, /mandatory before any new implementation/i);
  assert.doesNotMatch(testing, /Minimum Test Coverage:\s*80%/i);
  assert.doesNotMatch(testing, /MANDATORY workflow/i);
  assert.match(reviewRule, /Fix only release blockers/i);
  assert.match(reviewCommand, /must not read the complete diff again/i);
  assert.match(reviewCommand, /Do not run Codex and a\s+full native review for the same snapshot/i);
  assert.doesNotMatch(rootAgents, /80%\+ coverage required/i);
});

test('distributed agent rules defer to runtime capabilities and do not claim automatic spawning', () => {
  const agentsRule = readRepoFile('rules', 'common', 'agents.md');
  const rootAgents = readRepoFile('AGENTS.md');
  assert.doesNotMatch(agentsRule, /No user prompt needed/);
  assert.doesNotMatch(agentsRule, /ALWAYS use parallel Task execution/);
  assert.match(agentsRule, /higher-priority/);
  assert.match(agentsRule, /does not automatically spawn/i);
  assert.doesNotMatch(rootAgents, /Use agents proactively without user prompt/);
  assert.match(rootAgents, /higher-priority/);
  assert.match(rootAgents, /does not automatically spawn/i);
});

test('the canonical delegation policy carries the project owner standing authorization', () => {
  // 中央Issue #184: 「ユーザーが要求した場合だけ委任可」というruntime条件に対して、
  // ECC導入自体が所有者の継続的な委任要求であることを明示し、毎セッションの再許可を不要にする。
  const agentsRule = readRepoFile('rules', 'common', 'agents.md');
  assert.match(agentsRule, /canonical delegation policy/);
  assert.match(agentsRule, /governs every "use the X agent" step/);
  assert.match(agentsRule, /standing\s+request/i);
  assert.match(agentsRule, /satisfies.*requires a user request/is);
  assert.doesNotMatch(agentsRule, /follow the harness.*parent context/is);

  for (const [file, restatement] of [
    [readRepoFile('CLAUDE.md'), /canonical delegation policy/],
    [readRepoFile('AGENTS.md'), /canonical delegation policy/],
    [readRepoFile('.cursor', 'rules', 'common-agents.md'), /canonical delegation policy/],
    [readRepoFile('.opencode', 'instructions', 'INSTRUCTIONS.md'), /canonical delegation policy/],
    [readRepoFile('.kiro', 'steering', 'agents.md'), /canonical delegation policy/]
  ]) {
    assert.match(file, /rules\/common\/agents\.md/);
    assert.match(file, restatement);
    assert.match(file, /governs\s+\n?every "use the X agent" step/);
    assert.match(file, /standing\s+request/i);
  }

  const rulesReadme = readRepoFile('rules', 'README.md');
  assert.match(rulesReadme, /Rule Priority/);
  assert.match(rulesReadme, /standing\s+request/);
});

test('Claude sub-agents and Codex have one non-overlapping review contract', () => {
  // 中央Issue #141: Claude reviewerを必須Codex reviewの代替・重複として扱わない。
  for (const file of [
    ['rules', 'common', 'agents.md'],
    ['AGENTS.md'],
    ['.cursor', 'rules', 'common-agents.md'],
    ['.opencode', 'instructions', 'INSTRUCTIONS.md'],
    ['.kiro', 'steering', 'agents.md']
  ]) {
    const source = readRepoFile(...file);
    const label = file.join('/');
    assert.match(source, /Codex owns the initial Context Builder packet/i, label);
    assert.match(source, /reviewer-named Claude agents are advisory/i, label);
    assert.match(source, /(?:not|to) replace or\s+duplicate the (?:mandatory )?Codex review/i, label);
  }

  for (const file of [
    ['rules', 'common', 'development-workflow.md'],
    ['rules', 'common', 'security.md'],
    ['.cursor', 'rules', 'common-development-workflow.md'],
    ['.cursor', 'rules', 'common-security.md'],
    ['.kiro', 'steering', 'development-workflow.md'],
    ['.kiro', 'steering', 'security.md']
  ]) {
    const source = readRepoFile(...file);
    const label = file.join('/');
    assert.match(source, /independent Codex/i, label);
    assert.match(source, /does not replace|do not\s+duplicate/i, label);
  }
});

test('rules that name an agent stay conditional on the canonical delegation policy', () => {
  for (const file of [
    ['rules', 'common', 'security.md'],
    ['rules', 'common', 'performance.md'],
    ['rules', 'common', 'testing.md'],
    ['rules', 'common', 'development-workflow.md'],
    ['rules', 'common', 'code-review.md'],
    ['.cursor', 'rules', 'common-security.md'],
    ['.cursor', 'rules', 'common-performance.md'],
    ['.cursor', 'rules', 'common-testing.md'],
    ['.cursor', 'rules', 'common-development-workflow.md']
  ]) {
    const source = readRepoFile(...file);
    const label = file.join('/');
    assert.match(source, /permits? delegation|agent orchestration rule|agents\.md/, label);
    assert.doesNotMatch(source, /Use PROACTIVELY/, label);
  }

  const reactNativeTesting = readRepoFile('rules', 'react-native', 'testing.md');
  assert.doesNotMatch(reactNativeTesting, /agent proactively/);
  assert.match(reactNativeTesting, /permits delegation/);

  for (const rules of [readRepoFile('RULES.md'), readRepoFile('docs', 'ja-JP', 'RULES.md')]) {
    assert.match(rules, /rules\/common\/agents\.md/);
  }
});

test('the Kiro steering surface ships the delegation policy and keeps its agent steps conditional', () => {
  // 中央Issue #58: Kiroのsteeringは自動読込されるため、委任ポリシーが無いと同じ衝突が残る。
  const policy = readRepoFile('.kiro', 'steering', 'agents.md');
  assert.match(policy, /^---\n[\s\S]*inclusion: auto[\s\S]*?\n---/, '.kiro/steering/agents.md');
  assert.match(policy, /does not automatically spawn/i);
  assert.match(policy, /standing\s+request/i);

  for (const file of [
    ['.kiro', 'steering', 'testing.md'],
    ['.kiro', 'steering', 'development-workflow.md'],
    ['.kiro', 'steering', 'security.md'],
    ['.kiro', 'steering', 'performance.md']
  ]) {
    const source = readRepoFile(...file);
    const label = file.join('/');
    assert.match(source, /permits? delegation|agent orchestration steering file/, label);
    assert.doesNotMatch(source, /Use PROACTIVELY/, label);
  }

  // 配布と自動読込の経路が壊れていないこと。
  assert.match(readRepoFile('.kiro', 'install.sh'), /SOURCE_KIRO\/steering"\/\*\.md/);
  assert.match(readRepoFile('.kiro', 'README.md'), /`agents\.md` \| auto \|/);
});

test('every translated delegation policy carries the same mechanism and precedence', () => {
  const translations = [
    ['docs', 'es', 'rules', 'common', 'agents.md'],
    ['docs', 'ja-JP', 'rules', 'common', 'agents.md'],
    ['docs', 'ko-KR', 'rules', 'agents.md'],
    ['docs', 'pt-BR', 'rules', 'agents.md'],
    ['docs', 'tr', 'rules', 'common', 'agents.md'],
    ['docs', 'zh-CN', 'rules', 'common', 'agents.md'],
    ['docs', 'zh-TW', 'rules', 'agents.md'],
    ['docs', 'es', 'AGENTS.md'],
    ['docs', 'ja-JP', 'AGENTS.md'],
    ['docs', 'tr', 'AGENTS.md'],
    ['docs', 'zh-CN', 'AGENTS.md']
  ];
  for (const file of translations) {
    const source = readRepoFile(...file);
    const label = file.join('/');
    assert.match(source, /rules\/common\/agents\.md/, label);
    assert.doesNotMatch(source, /No user prompt needed/, label);
    assert.doesNotMatch(source, /Immediate Agent Usage/, label);
    // 「ハーネス」に相当する語で優先順位が説明されていること。
    assert.match(source, /harness|하네스|ハーネス/i, label);
  }
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

test('central incident Issues use the Japanese report-only template without workflow status labels', () => {
  const payload = centralIssuePayload({
    fingerprint: '48be3a24636cd77006fdb4def3bfce03',
    type: 'codex_role_failure',
    severity: 'minor',
    count: 2,
    project: 'project-fingerprint',
    message: 'read-only Codex role changed the working tree'
  });
  assert.strictEqual(payload.title, '[ECCインシデント][ECC] Codex役割の実行に失敗 (48be3a2463)');
  assert.deepStrictEqual(payload.labels, ['harness-incident', 'target:ecc', 'severity:minor']);
  assert.match(payload.body, /^## 概要/m);
  assert.match(payload.body, /^## 分類/m);
  assert.match(payload.body, /^## 匿名化済みメッセージ/m);
  assert.match(payload.body, /^## 対応方針/m);
  assert.match(payload.body, /製品セッションは報告だけ/);
  assert.doesNotMatch(payload.body, /Background remediation|Follow-up must use/);
  assert.ok(!payload.labels.some(label => label.startsWith('status:') || label.startsWith('automation:')));
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

test('incident ownership Hook rejects product-side remediation without a background bypass', () => {
  const raw = JSON.stringify({
    tool_name: 'Bash',
    cwd: repo,
    tool_input: { command: 'engineering-kit-incident-operator run-once' }
  });
  const denied = JSON.parse(incidentOwnershipGate.run(raw, { cwd: repo, env }));
  assert.strictEqual(denied.hookSpecificOutput.permissionDecision, 'deny');

  const productClone = JSON.stringify({
    tool_name: 'Bash',
    cwd: repo,
    tool_input: { command: 'gh repo clone koupent/ECC /tmp/ecc-repair' }
  });
  const cloneDenied = JSON.parse(incidentOwnershipGate.run(productClone, { cwd: repo, env }));
  assert.strictEqual(cloneDenied.hookSpecificOutput.permissionDecision, 'deny');
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
