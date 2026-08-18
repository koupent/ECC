#!/usr/bin/env node
'use strict';

const path = require('path');
const { loadConfig } = require('../codex/config');
const { readState } = require('../codex/runtime-state');

const BOOTSTRAP_FILES = new Set([
  'agents.md',
  'claude.md',
  'package.json',
  'pyproject.toml',
  'cargo.toml',
  'go.mod',
  'composer.json',
  'pubspec.yaml',
  'config.json'
]);

function isBootstrapRead(toolName, toolInput) {
  if (toolName !== 'Read') return false;
  const file = String(toolInput.file_path || toolInput.path || '');
  const normalized = file.replace(/\\/g, '/').toLowerCase();
  return BOOTSTRAP_FILES.has(path.basename(normalized)) || normalized.includes('/.ecc/config.json');
}

function deny(reason) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason
    }
  });
}

function run(rawInput, options = {}) {
  let input;
  try {
    input = typeof rawInput === 'string' ? JSON.parse(rawInput) : rawInput;
  } catch {
    return rawInput;
  }
  const cwd = options.cwd || input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const env = options.env || process.env;
  const config = loadConfig(cwd, env);
  if (!config.enabled) return rawInput;

  const toolName = String(input.tool_name || '');
  if (!['Read', 'Glob', 'Grep'].includes(toolName) || isBootstrapRead(toolName, input.tool_input || {})) return rawInput;

  const state = readState(input, env);
  if (state.context_status === 'ready' || state.context_status === 'fallback') return rawInput;
  return deny(
    '[ECC Context Gate] Broad repository exploration is reserved for the Codex Context Builder. ' +
      'Wait for the UserPromptSubmit context packet or run /ecc:codex-context. If Codex fails, the recorded Claude fallback will open this gate.'
  );
}

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    if (raw.length < 1024 * 1024) raw += chunk.slice(0, 1024 * 1024 - raw.length);
  });
  process.stdin.on('end', () => process.stdout.write(run(raw)));
}

module.exports = { BOOTSTRAP_FILES, isBootstrapRead, run };
