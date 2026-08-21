#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadConfig } = require('./config');
const {
  appendEvent,
  deliveryWorkspace,
  hash,
  projectFingerprint,
  readEvents,
  readState,
  recordIncident,
  resolveSessionId,
  stateRoot,
  writeState
} = require('./runtime-state');

const ROLE_DEFS = {
  'context-builder': { model: 'context', schema: 'context-result.schema.json', sandbox: 'read-only' },
  'failure-diagnosis': { model: 'context', schema: 'assessment-result.schema.json', sandbox: 'read-only' },
  'plan-critique': { model: 'review', schema: 'assessment-result.schema.json', sandbox: 'read-only' },
  review: { model: 'review', schema: 'assessment-result.schema.json', sandbox: 'read-only' },
  'security-review': { model: 'review', schema: 'assessment-result.schema.json', sandbox: 'read-only' },
  'bug-reproduction-test': { model: 'review', schema: 'assessment-result.schema.json', sandbox: 'workspace-write', writePolicy: 'tests-only' },
  'contract-test': { model: 'review', schema: 'assessment-result.schema.json', sandbox: 'workspace-write', writePolicy: 'tests-only' },
  'harness-remediation': { model: 'review', schema: 'assessment-result.schema.json', sandbox: 'workspace-write', writePolicy: 'fork-only' }
};

function git(cwd, args, options = {}) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: options.timeout || 30000,
    maxBuffer: 16 * 1024 * 1024
  });
}

function gitOutput(cwd, args) {
  const result = git(cwd, args);
  return result.status === 0 ? String(result.stdout || '').trim() : '';
}

function workingTreePaths(cwd) {
  const output = gitOutput(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (!output) return [];
  const entries = output.split('\0').filter(Boolean);
  const paths = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const status = entry.slice(0, 2);
    let file = entry.slice(3);
    if ((status.startsWith('R') || status.startsWith('C')) && entries[i + 1]) {
      file = entries[i + 1];
      i += 1;
    }
    if (file) paths.push(file.replace(/\\/g, '/'));
  }
  return [...new Set(paths)];
}

function workingTreeSignature(cwd) {
  const status = gitOutput(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const diff = gitOutput(cwd, ['diff', '--binary', 'HEAD']);
  const contentHashes = workingTreePaths(cwd).map(relative => {
    const result = git(cwd, ['hash-object', '--', relative]);
    return `${relative}\0${result.status === 0 ? String(result.stdout || '').trim() : '<missing>'}`;
  });
  return hash(`${status}\n${diff}\n${contentHashes.join('\n')}`, 64);
}

function isTestPath(file) {
  const normalized = String(file || '').replace(/\\/g, '/');
  return /(^|\/)(test|tests|__tests__|e2e|integration_test)(\/|$)/i.test(normalized) || /\.(test|spec)\.[^/]+$/i.test(normalized);
}

function removeUnauthorizedChanges(cwd, paths) {
  for (const relative of paths) {
    const absolute = path.resolve(cwd, relative);
    const root = `${path.resolve(cwd)}${path.sep}`;
    if (!absolute.startsWith(root)) continue;
    const tracked = git(cwd, ['ls-files', '--error-unmatch', '--', relative]).status === 0;
    if (tracked) {
      git(cwd, ['restore', '--staged', '--worktree', '--', relative]);
    } else {
      try {
        fs.rmSync(absolute, { recursive: true, force: true });
      } catch {
        // The violation is still reported even when cleanup cannot complete.
      }
    }
  }
}

function roleInstructions(role, request) {
  const common = [
    `Role: ${role}.`,
    'Work only on the bounded request below.',
    'Do not repeat completed investigation or review work.',
    'Return exactly the JSON shape required by the supplied output schema.',
    'Use repository evidence and cite file paths. Never include secrets or raw production data.',
    '',
    `Request: ${request}`
  ];

  if (role === 'context-builder') {
    common.push(
      '',
      'Explore the repository broadly enough to replace the parent Claude session\'s initial code reading.',
      'Summarize the implementation surface, relevant files, constraints, risks, and exact verification commands.',
      'Treat permission, sandbox, network, and command failures as unverified observations, never as proof that a path, tool, or account is absent.',
      'Do not diagnose orchestration session IDs, delivery state, GitHub authentication, or Codex authentication; the parent harness owns those checks.',
      'Do not claim a path or tool is missing unless a direct filesystem or executable lookup succeeded and proved absence.',
      'Do not execute the requested implementation, acceptance, migration, or state-changing command; only inspect and report the context the parent Claude session needs.',
      'If the request is only an explicit operational or acceptance command and needs no repository investigation, return status=ok with an empty files array and tell the parent Claude session to execute it; this is not insufficient context.',
      'Do not call GitHub write operations or repository commands whose purpose is to fulfill the user task.',
      'Do not edit any file.'
    );
  } else if (role === 'bug-reproduction-test' || role === 'contract-test') {
    common.push(
      '',
      'Write only independent tests: bug reproduction tests or public/API/acceptance contract tests.',
      'Do not edit product source, configuration, snapshots outside test trees, or existing implementation code.',
      'If a correct independent test cannot be written, return status=blocked without changing files.'
    );
  } else if (role === 'harness-remediation') {
    common.push(
      '',
      'This is a sanitized defect in the public koupent/ECC fork.',
      'Add a failing regression test first, implement the smallest generic fix, and run relevant tests.',
      'Do not add private paths, repository names, prompts, or customer data.'
    );
  } else if (role === 'review' || role === 'security-review') {
    common.push(
      '',
      'Do not edit any file. Review the complete delivery diff, not only uncommitted changes.',
      'When the worktree is clean, compare the current issue branch against its base branch and inspect the committed changes.',
      'Use the diff to identify the review surface, not as the boundary of inspection. Read every changed file in full and inspect relevant callers, consumers, tests, and configuration.',
      'For documentation, runbooks, migrations, release flows, and CI/CD, validate the complete ordered procedure, prerequisites, rollback path, and the point where each guard can actually run.',
      'Classify each finding as release-blocker, owner-action, or follow-up. Only repository-fixable defects that make this merge unsafe are release-blocker findings.',
      'Use owner-action when the repository change can merge safely but an external host, credential, deployment, approval, or operator step remains. Put the required step in followups and do not block the review solely for it.',
      'Use follow-up for non-blocking repository improvements. CRITICAL findings must be release-blocker; HIGH findings must be release-blocker or owner-action, never follow-up.',
      'Set review_complete=true only after the full requested review scope was inspected; otherwise set it to false.',
      'Set status=blocked only when a release-blocker remains or the review itself could not be completed.',
      'Report only evidence-backed findings that are actionable for this request.'
    );
  } else {
    common.push('', 'Do not edit any file. Report only evidence-backed findings that are actionable for this request.');
  }
  return common.join('\n');
}

function isReviewRole(role) {
  return role === 'review' || role === 'security-review';
}

function reviewSnapshot(cwd, state) {
  const head = gitOutput(cwd, ['rev-parse', 'HEAD']);
  const base = state && state.delivery && state.delivery.base_branch;
  const baseHead = base ? gitOutput(cwd, ['rev-parse', base]) : '';
  const branchDiff = baseHead ? gitOutput(cwd, ['diff', '--binary', `${baseHead}...HEAD`]) : '';
  return hash(`${head}\n${baseHead}\n${branchDiff}\n${workingTreeSignature(cwd)}`, 64);
}

function normalizeReviewResult(result) {
  const findings = Array.isArray(result.findings) ? result.findings : [];
  const releaseBlockers = findings.filter(finding => finding.disposition === 'release-blocker');
  const ownerActions = findings.filter(finding => finding.disposition === 'owner-action');
  // 完了したレビューはfindingsを正本として判定し、未完了レビューは必ずblockedにする。
  // これによりowner-actionだけの完了レビューは進められ、調査未完了は迂回できない。
  const status = result.review_complete === true && releaseBlockers.length === 0 ? 'ok' : 'blocked';
  return {
    result: { ...result, status },
    releaseBlockers,
    ownerActions
  };
}

function validateResult(result, schemaName) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Codex result is not an object');
  if (!['ok', 'blocked', 'insufficient'].includes(result.status)) throw new Error('Codex result has an invalid status');
  if (typeof result.summary !== 'string') throw new Error('Codex result is missing summary');
  if (schemaName === 'context-result.schema.json' && !Array.isArray(result.files)) throw new Error('Context result is missing files');
  if (schemaName === 'assessment-result.schema.json' && !Array.isArray(result.findings)) throw new Error('Assessment result is missing findings');
  if (schemaName === 'assessment-result.schema.json') {
    if (typeof result.review_complete !== 'boolean') throw new Error('Assessment result is missing review_complete');
    const ownerActions = result.findings.filter(finding => finding.disposition === 'owner-action');
    for (const finding of result.findings) {
      if (!['release-blocker', 'owner-action', 'follow-up'].includes(finding.disposition)) {
        throw new Error('Assessment finding has an invalid disposition');
      }
      const severity = String(finding.severity || '').toLowerCase();
      if (severity === 'critical' && finding.disposition !== 'release-blocker') {
        throw new Error('Critical findings must be classified as release-blocker');
      }
      if (severity === 'high' && finding.disposition === 'follow-up') {
        throw new Error('High findings cannot be classified as follow-up');
      }
    }
    if (ownerActions.length > 0 && (!Array.isArray(result.followups) || result.followups.length === 0)) {
      throw new Error('Owner-action findings require at least one explicit follow-up');
    }
  }
  return result;
}

function requireUsableResult(role, result) {
  if (role === 'context-builder' && result.status !== 'ok') {
    throw new Error(`Codex context is insufficient: ${String(result.summary || '').slice(0, 500)}`);
  }
  return result;
}

function diffFingerprint(cwd) {
  const head = gitOutput(cwd, ['rev-parse', 'HEAD']);
  const diff = gitOutput(cwd, ['diff', '--binary', 'HEAD']);
  return hash(`${head}\n${diff}`, 32);
}

function recordDuplicateFindings(role, result, cwd, env) {
  if (!Array.isArray(result.findings)) return 0;
  const diff = diffFingerprint(cwd);
  const prior = readEvents(env, 1000);
  let duplicates = 0;
  for (const finding of result.findings) {
    const fingerprint = String(finding.fingerprint || hash(`${finding.title}|${finding.path}|${finding.evidence}`, 24));
    if (prior.some(event => event.kind === 'finding' && event.fingerprint === fingerprint && event.diff === diff)) {
      duplicates += 1;
      recordIncident(
        {
          type: 'duplicate_finding',
          severity: 'minor',
          role,
          fingerprint: hash(`duplicate|${fingerprint}|${diff}`, 32),
          message: `Finding ${fingerprint} was repeated without a material diff change.`
        },
        { cwd, env }
      );
    }
    appendEvent({ kind: 'finding', role, fingerprint, diff, severity: finding.severity }, env);
  }
  return duplicates;
}

function failureState(role, input, error, cwd, env) {
  const state = readState(input, env);
  writeState(
    input,
    {
      context_status: role === 'context-builder' ? 'fallback' : state.context_status,
      codex_failures: (state.codex_failures || 0) + 1,
      last_role: role,
      last_error: String(error.message || error).slice(0, 500)
    },
    env
  );
  recordIncident(
    {
      type: 'codex_role_failure',
      severity: 'minor',
      role,
      message: error.message || String(error),
      metadata: { fallback: role === 'context-builder' ? 'claude-native-context' : 'claude-native-role' }
    },
    { cwd, env }
  );
}

function runRole(options) {
  const role = String(options.role || '');
  const def = ROLE_DEFS[role];
  if (!def) throw new Error(`Unknown Codex role: ${role}`);
  const env = options.env || process.env;
  const input = { session_id: options.sessionId || resolveSessionId({}, env) };
  // 明示的なcwdがなければ、進行中Deliveryのworktreeで実行する。共有ツリーでレビュー
  // すると、証拠が実装コミットではないHEADに結び付き、完了Gateを通せない。
  const workspace = options.cwd || deliveryWorkspace(readState(input, env), process.cwd());
  if (!workspace) {
    throw new Error(
      'The worktree recorded for the active delivery is missing or belongs to another repository. ' +
        'Restore it or pass an explicit --cwd; Codex roles never fall back to the shared working tree.'
    );
  }
  const cwd = path.resolve(workspace);
  const config = loadConfig(cwd, env);
  if (!config.enabled && !options.force) throw new Error(`Codex integration is not enabled by ${config.projectConfigPath}`);

  const before = workingTreePaths(cwd);
  const beforeSignature = workingTreeSignature(cwd);
  if (def.writePolicy && before.length > 0) {
    throw new Error(`Codex write role requires a clean working tree; found ${before.length} changed path(s)`);
  }

  const model = def.model === 'context' ? config.contextModel : config.reviewModel;
  const priorState = readState(input, env);
  const currentReviewRequestHash = isReviewRole(role) ? hash(options.request || '', 32) : null;
  const currentReviewSnapshot = isReviewRole(role) && before.length === 0
    ? reviewSnapshot(cwd, priorState)
    : null;
  if (
    currentReviewSnapshot &&
    priorState.review_role === role &&
    priorState.review_worktree_clean === true &&
    priorState.review_result && priorState.review_result.review_complete === true &&
    (priorState.review_status === 'ok' || Number(priorState.review_blocking_findings || 0) > 0) &&
    priorState.review_snapshot === currentReviewSnapshot &&
    priorState.review_request_hash === currentReviewRequestHash &&
    priorState.review_result
  ) {
    appendEvent({ kind: 'review_cache_hit', role, diff: currentReviewSnapshot }, env);
    return {
      ok: true,
      role,
      model,
      result: priorState.review_result,
      changedPaths: [],
      cached: true
    };
  }
  const runDir = path.join(stateRoot(env), 'runs', `${Date.now()}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(runDir, { recursive: true });
  const outputPath = path.join(runDir, 'result.json');
  const schemaPath = path.resolve(__dirname, '..', '..', 'schemas', 'codex', def.schema);
  const args = [
    'exec',
    '--model',
    model,
    '-c',
    `model_reasoning_effort="${config.effort}"`,
    '--ephemeral',
    '--ignore-user-config',
    '--output-schema',
    schemaPath,
    '--output-last-message',
    outputPath,
    '--color',
    'never',
    '-C',
    cwd
  ];
  if (config.externalSandbox) {
    const error = new Error('dangerous Codex sandbox bypass is unsupported; restore the Kit-managed standard sandbox');
    failureState(role, input, error, cwd, env);
    return { ok: false, role, model, error: error.message, fallback: true };
  }
  if (def.sandbox === 'workspace-write') args.push('--approve-for-me');
  else args.push('--sandbox', def.sandbox);
  args.push('-');

  if (role === 'context-builder') {
    writeState(input, { context_status: 'pending', context: null, last_role: role }, env);
  }

  const started = Date.now();
  const result = spawnSync(env.ECC_CODEX_BINARY || 'codex', args, {
    cwd,
    env,
    input: roleInstructions(role, options.request || ''),
    encoding: 'utf8',
    timeout: Math.max(1, config.timeoutSeconds) * 1000,
    maxBuffer: 32 * 1024 * 1024
  });

  try {
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`codex exited ${result.status}: ${String(result.stderr || '').slice(-1000)}`);
    let parsed = requireUsableResult(
      role,
      validateResult(JSON.parse(fs.readFileSync(outputPath, 'utf8')), def.schema)
    );
    const after = workingTreePaths(cwd);

    if (!def.writePolicy && workingTreeSignature(cwd) !== beforeSignature) {
      throw new Error('read-only Codex role changed the working tree');
    }
    if (def.writePolicy === 'tests-only') {
      const violations = after.filter(file => !isTestPath(file));
      if (violations.length > 0) {
        removeUnauthorizedChanges(cwd, violations);
        recordIncident(
          {
            type: 'codex_write_scope_violation',
            severity: 'critical',
            role,
            message: `Codex attempted non-test changes: ${violations.join(', ')}`
          },
          { cwd, env }
        );
        throw new Error(`Codex write scope violation: ${violations.join(', ')}`);
      }
    }

    const state = readState(input, env);
    let releaseBlockers = [];
    let ownerActions = [];
    if (isReviewRole(role)) {
      const normalized = normalizeReviewResult(parsed);
      parsed = normalized.result;
      releaseBlockers = normalized.releaseBlockers;
      ownerActions = normalized.ownerActions;
      for (const finding of ownerActions) {
        appendEvent({
          kind: 'review_owner_action',
          role,
          fingerprint: finding.fingerprint,
          severity: finding.severity,
          diff: currentReviewSnapshot || reviewSnapshot(cwd, state)
        }, env);
      }
    }
    const duplicates = recordDuplicateFindings(role, parsed, cwd, env);
    const nextPatch = {
      codex_calls: (state.codex_calls || 0) + 1,
      waste_loops: (state.waste_loops || 0) + duplicates,
      last_role: role,
      last_model: model,
      last_duration_ms: Date.now() - started,
      last_error: null
    };
    if (role === 'context-builder') {
      nextPatch.context_status = 'ready';
      nextPatch.context = parsed;
      nextPatch.context_head = gitOutput(cwd, ['rev-parse', 'HEAD']);
      nextPatch.context_request_hash = options.requestHash || hash(options.request || '', 32);
    }
    if (isReviewRole(role)) {
      nextPatch.review_role = role;
      nextPatch.review_status = parsed.status;
      nextPatch.review_complete = parsed.review_complete;
      nextPatch.review_head = gitOutput(cwd, ['rev-parse', 'HEAD']);
      nextPatch.review_worktree_clean = after.length === 0;
      nextPatch.review_blocking_findings = releaseBlockers.length;
      nextPatch.review_owner_actions = ownerActions;
      nextPatch.review_result = parsed;
      nextPatch.review_snapshot = currentReviewSnapshot || reviewSnapshot(cwd, state);
      nextPatch.review_request_hash = currentReviewRequestHash;
    }
    writeState(input, nextPatch, env);
    appendEvent(
      {
        kind: 'role_run',
        role,
        model,
        status: parsed.status,
        duration_ms: Date.now() - started,
        project: projectFingerprint(cwd),
        diff: diffFingerprint(cwd),
        changed_paths: def.writePolicy ? after : []
      },
      env
    );
    return { ok: true, role, model, result: parsed, changedPaths: def.writePolicy ? after : [] };
  } catch (error) {
    failureState(role, input, error, cwd, env);
    return { ok: false, role, model, error: error.message || String(error), fallback: true };
  }
}

function parseArgs(argv) {
  // cwdは既定値を持たない。指定がないときだけrunRoleがDelivery worktreeへ解決する。
  const options = { role: argv[2], request: '' };
  for (let i = 3; i < argv.length; i += 1) {
    if (argv[i] === '--request') options.request = argv[++i] || '';
    else if (argv[i] === '--request-file') options.request = fs.readFileSync(argv[++i], 'utf8');
    else if (argv[i] === '--cwd') options.cwd = argv[++i];
    else if (argv[i] === '--session') options.sessionId = argv[++i];
    else if (argv[i] === '--force') options.force = true;
  }
  return options;
}

if (require.main === module) {
  const output = runRole(parseArgs(process.argv));
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  process.exitCode = output.ok ? 0 : 2;
}

module.exports = {
  ROLE_DEFS,
  diffFingerprint,
  isTestPath,
  parseArgs,
  recordDuplicateFindings,
  normalizeReviewResult,
  requireUsableResult,
  reviewSnapshot,
  roleInstructions,
  runRole,
  validateResult,
  workingTreeSignature,
  workingTreePaths
};
