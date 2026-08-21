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

function readFailure(error) {
  if (error && error.code === 'ENOENT') return 'missing';
  if (error instanceof SyntaxError) return 'invalid-json';
  return error && error.code ? String(error.code) : 'unreadable';
}

function readProjectConfig(cwd = process.cwd(), env = process.env) {
  const root = findProjectRoot(cwd);
  const file = env.ECC_PROJECT_CONFIG
    ? path.resolve(env.ECC_PROJECT_CONFIG)
    : path.join(root, '.ecc', 'config.json');
  try {
    return { root, file, exists: true, failure: null, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (error) {
    // The failure reason travels with the config so callers can tell a silent
    // fallback from a deliberate setting. It never carries file contents.
    return { root, file, exists: false, failure: readFailure(error), value: {} };
  }
}

function loadConfig(cwd = process.cwd(), env = process.env) {
  const project = readProjectConfig(cwd, env);
  const codex = project.value.codex || {};
  const mergeGate = project.value.mergeGate || {};
  const incidentHandling = project.value.incidentHandling || {};
  const deliveryCompletionSource = env.ECC_DELIVERY_COMPLETION
    ? 'environment'
    : project.value.deliveryCompletion
      ? 'project-config'
      : 'default';
  const deliveryWorkflowSource = env.ECC_DELIVERY_WORKFLOW
    ? 'environment'
    : project.value.deliveryWorkflow
      ? 'project-config'
      : 'default';
  return {
    projectRoot: project.root,
    projectConfigPath: project.file,
    projectEnabled: project.exists,
    projectConfigFailure: project.failure,
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
      mode: env.ECC_INCIDENT_HANDLING_MODE || incidentHandling.mode || 'report-only',
      repository: env.ECC_INCIDENT_REPOSITORY || incidentHandling.repository || codex.incidentRepository || 'koupent/engineering-environment-kit'
    },
    deliveryWorkflow: env.ECC_DELIVERY_WORKFLOW || project.value.deliveryWorkflow || 'advisory',
    deliveryWorkflowSource,
    deliveryBaseBranch: env.ECC_DELIVERY_BASE_BRANCH || project.value.deliveryBaseBranch || 'main',
    deliveryCompletion: env.ECC_DELIVERY_COMPLETION || project.value.deliveryCompletion || 'draft-pr',
    deliveryCompletionSource,
    mergeGate: {
      provider: env.ECC_MERGE_GATE_PROVIDER || mergeGate.provider || 'commit-status',
      command: env.ECC_MERGE_GATE_COMMAND || mergeGate.command || 'engineering-kit-merge-gate',
      adapter: env.ECC_MERGE_GATE_ADAPTER || mergeGate.adapter || '',
      statusContext: env.ECC_MERGE_GATE_STATUS_CONTEXT || mergeGate.statusContext || 'Local Merge Gate',
      strategy: env.ECC_MERGE_GATE_STRATEGY || mergeGate.strategy || 'squash'
    }
  };
}

/**
 * True when the completion method fell back to the default *because* the
 * project config could not be read. A project that names no method in a
 * readable config, or that sets it through the environment, chose it.
 */
function deliveryCompletionDefaulted(config) {
  return config.deliveryCompletionSource === 'default' && Boolean(config.projectConfigFailure);
}

/**
 * True when the delivery workflow fell back to `advisory` only because the
 * project config could not be read. A readable config that names no workflow
 * chose the default; an unreadable one said nothing at all, so callers that
 * would disable a required gate must not read this as "no delivery required".
 */
function deliveryWorkflowDefaulted(config) {
  return config.deliveryWorkflowSource === 'default' && Boolean(config.projectConfigFailure);
}

/**
 * squash-merge completion is one contract with two halves: the Completion Gate
 * merges the reviewed PR, and the Local Merge Policy keeps every other actor
 * from merging it first. A project that enables one half only would forbid the
 * manual merge without ever performing the automatic one, so every hook decides
 * that the method is active through this single predicate.
 */
function squashMergeCompletion(config) {
  return config.deliveryCompletion === 'squash-merge' && config.deliveryWorkflow === 'required';
}

module.exports = {
  deliveryCompletionDefaulted,
  deliveryWorkflowDefaulted,
  envEnabled,
  findProjectRoot,
  loadConfig,
  readProjectConfig,
  squashMergeCompletion
};
