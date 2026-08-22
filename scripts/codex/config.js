#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const FALSE_VALUES = new Set(['0', 'false', 'off', 'no', 'disabled']);

function envEnabled(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  return !FALSE_VALUES.has(String(value).trim().toLowerCase());
}

function findProjectRoot(start = process.cwd()) {
  let current = path.resolve(start);
  for (let i = 0; i < 30; i += 1) {
    if (fs.existsSync(path.join(current, '.git')) || fs.existsSync(path.join(current, '.ecc', 'config.json'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve(start);
}

function readProjectConfig(cwd = process.cwd(), env = process.env) {
  const root = findProjectRoot(cwd);
  const file = env.ECC_PROJECT_CONFIG
    ? path.resolve(env.ECC_PROJECT_CONFIG)
    : path.join(root, '.ecc', 'config.json');
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return {
      root,
      file,
      exists: false,
      status: error && error.code === 'ENOENT' ? 'missing' : 'invalid',
      error: String(error && (error.code || error.message) || 'read failure'),
      value: {}
    };
  }
  try {
    return { root, file, exists: true, status: 'ok', error: null, value: JSON.parse(source) };
  } catch (error) {
    return { root, file, exists: false, status: 'invalid', error: String(error.message || error), value: {} };
  }
}

function loadConfig(cwd = process.cwd(), env = process.env) {
  const project = readProjectConfig(cwd, env);
  const codex = project.value.codex || {};
  const mergeGate = project.value.mergeGate || {};
  const incidentHandling = project.value.incidentHandling || {};
  return {
    projectRoot: project.root,
    projectConfigPath: project.file,
    projectConfigStatus: project.status,
    projectConfigError: project.error,
    projectEnabled: project.exists,
    enabled: project.exists && envEnabled(env.ECC_CODEX_ENABLED, codex.enabled !== false),
    hookProfile: env.ECC_HOOK_PROFILE || project.value.profile || 'standard',
    contextModel: env.ECC_CODEX_CONTEXT_MODEL || codex.contextModel || 'gpt-5.6-terra',
    reviewModel: env.ECC_CODEX_REVIEW_MODEL || codex.reviewModel || 'gpt-5.6-sol',
    effort: env.ECC_CODEX_REASONING_EFFORT || codex.reasoningEffort || 'high',
    timeoutSeconds: Number(env.ECC_CODEX_TIMEOUT_SECONDS || codex.timeoutSeconds || 1800),
    externalSandbox: envEnabled(env.ECC_CODEX_EXTERNAL_SANDBOX, false),
    centralIncidentRepo: env.ECC_INCIDENT_REPOSITORY || incidentHandling.repository || codex.incidentRepository || 'koupent/engineering-environment-kit',
    forkRepo: env.ECC_FORK_REPOSITORY || codex.forkRepository || 'koupent/ECC',
    incidentHandling: {
      mode: 'report-only',
      repository: env.ECC_INCIDENT_REPOSITORY || incidentHandling.repository || codex.incidentRepository || 'koupent/engineering-environment-kit'
    },
    deliveryWorkflow: env.ECC_DELIVERY_WORKFLOW || project.value.deliveryWorkflow || 'advisory',
    deliveryWorktree: env.ECC_DELIVERY_WORKTREE || project.value.deliveryWorktree || 'advisory',
    deliveryBaseBranch: env.ECC_DELIVERY_BASE_BRANCH || project.value.deliveryBaseBranch || 'main',
    deliveryCompletion: env.ECC_DELIVERY_COMPLETION || project.value.deliveryCompletion || 'draft-pr',
    mergeGate: {
      provider: env.ECC_MERGE_GATE_PROVIDER || mergeGate.provider || 'commit-status',
      command: env.ECC_MERGE_GATE_COMMAND || mergeGate.command || 'engineering-kit-merge-gate',
      adapter: env.ECC_MERGE_GATE_ADAPTER || mergeGate.adapter || '',
      statusContext: env.ECC_MERGE_GATE_STATUS_CONTEXT || mergeGate.statusContext || 'Local Merge Gate',
      strategy: env.ECC_MERGE_GATE_STRATEGY || mergeGate.strategy || 'squash'
    }
  };
}

module.exports = { envEnabled, findProjectRoot, loadConfig, readProjectConfig };
