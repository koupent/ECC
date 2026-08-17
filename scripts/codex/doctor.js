#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const { loadConfig } = require('./config');
const { stateRoot } = require('./runtime-state');

function command(args) {
  const result = spawnSync(args[0], args.slice(1), { encoding: 'utf8', timeout: 15000 });
  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    output: String(result.stdout || result.stderr || result.error?.message || '').trim().slice(0, 1000)
  };
}

function diagnose(cwd = process.cwd(), env = process.env) {
  const config = loadConfig(cwd, env);
  return {
    schema_version: 1,
    project_config: config.projectConfigPath,
    project_enabled: config.projectEnabled,
    codex_enabled: config.enabled,
    context_model: config.contextModel,
    review_model: config.reviewModel,
    reasoning_effort: config.effort,
    timeout_seconds: config.timeoutSeconds,
    external_sandbox: config.externalSandbox,
    state_root: stateRoot(env),
    codex_version: command([env.ECC_CODEX_BINARY || 'codex', '--version']),
    codex_auth: command([env.ECC_CODEX_BINARY || 'codex', 'login', 'status']),
    gh_auth: command(['gh', 'auth', 'status'])
  };
}

if (require.main === module) process.stdout.write(`${JSON.stringify(diagnose(), null, 2)}\n`);

module.exports = { command, diagnose };
