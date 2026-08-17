#!/usr/bin/env node
/**
 * Config Protection Hook
 *
 * Blocks modifications to linter/formatter config files.
 * Agents frequently modify these to make checks pass instead of fixing
 * the actual code. This hook steers the agent back to fixing the source.
 *
 * Exit codes:
 *   0 = allow (not a config file, or first-time creation of one)
 *   2 = block (existing config file modification attempted)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { readState, appendEvent } = require('../codex/runtime-state');

const MAX_STDIN = 1024 * 1024;
let raw = '';

const PROTECTED_FILES = new Set([
  // ESLint (legacy + v9 flat config, JS/TS/MJS/CJS)
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yml',
  '.eslintrc.yaml',
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  'eslint.config.mts',
  'eslint.config.cts',
  // Prettier (all config variants including ESM)
  '.prettierrc',
  '.prettierrc.js',
  '.prettierrc.cjs',
  '.prettierrc.json',
  '.prettierrc.yml',
  '.prettierrc.yaml',
  'prettier.config.js',
  'prettier.config.cjs',
  'prettier.config.mjs',
  // Biome
  'biome.json',
  'biome.jsonc',
  // Ruff (Python)
  '.ruff.toml',
  'ruff.toml',
  // Note: pyproject.toml is intentionally NOT included here because it
  // contains project metadata alongside linter config. Blocking all edits
  // to pyproject.toml would prevent legitimate dependency changes.
  // Shell / Style / Markdown
  '.shellcheckrc',
  '.stylelintrc',
  '.stylelintrc.json',
  '.stylelintrc.yml',
  '.markdownlint.json',
  '.markdownlint.yaml',
  '.markdownlintrc'
]);

function parseInput(inputOrRaw) {
  if (typeof inputOrRaw === 'string') {
    try {
      return inputOrRaw.trim() ? JSON.parse(inputOrRaw) : {};
    } catch {
      return {};
    }
  }

  return inputOrRaw && typeof inputOrRaw === 'object' ? inputOrRaw : {};
}

function contextCoversFile(state, filePath) {
  const files = state && state.context && Array.isArray(state.context.files) ? state.context.files : [];
  const target = String(filePath || '').replace(/\\/g, '/').toLowerCase();
  return files.some(candidate => {
    const normalized = String(candidate || '').replace(/\\/g, '/').toLowerCase();
    return normalized && (target === normalized || target.endsWith(`/${normalized}`) || path.basename(target) === path.basename(normalized));
  });
}

function isAdditiveNonWeakeningEdit(toolInput) {
  const before = String(toolInput.old_string || '');
  const after = String(toolInput.new_string || '');
  if (!before || after.length < before.length) return false;

  // Every meaningful pre-change line must survive. The additions are limited
  // to ignore/exclude declarations, comments, and punctuation. This permits a
  // scoped generated-directory exclusion while rejecting rule removal,
  // severity downgrades, parser changes, and wholesale rewrites.
  const quoted = value => [...value.matchAll(/['\"]([^'\"]+)['\"]/g)].map(match => match[1]);
  const oldValues = quoted(before);
  const newValues = quoted(after);
  if (!oldValues.every(value => newValues.includes(value))) return false;
  const addedValues = newValues.filter(value => !oldValues.includes(value));
  if (addedValues.length === 0) return false;
  const generatedPath = /^(?:\.worktrees(?:\/\*\*)?|\.next(?:\/\*\*)?|dist(?:\/\*\*)?|build(?:\/\*\*)?|coverage(?:\/\*\*)?)$/i;
  return addedValues.every(value => generatedPath.test(value)) &&
    /(?:ignore|exclude)/i.test(after) &&
    !/(?:rules?|severity|parser|plugin|extends?)\s*[:=]/i.test(after.replace(before, ''));
}

/**
 * Exportable run() for in-process execution via run-with-flags.js.
 * Avoids the ~50-100ms spawnSync overhead when available.
 */
function run(inputOrRaw, options = {}) {
  if (options.truncated) {
    return {
      exitCode: 2,
      stderr:
        `BLOCKED: Hook input exceeded ${options.maxStdin || MAX_STDIN} bytes. ` +
        'Refusing to bypass config-protection on a truncated payload. ' +
        'Retry with a smaller edit; otherwise request explicit owner review.'
    };
  }

  const input = parseInput(inputOrRaw);
  const filePath = input?.tool_input?.file_path || input?.tool_input?.file || '';
  if (!filePath) return { exitCode: 0 };

  const basename = path.basename(filePath);
  // Match case-insensitively. Every PROTECTED_FILES entry is lowercase, and on
  // case-insensitive filesystems (macOS APFS/HFS+, Windows NTFS) a write to
  // `.ESLINTRC.JS` lands on the very same inode as `.eslintrc.js`. A
  // case-sensitive Set lookup therefore let a single case-variant Write
  // silently overwrite the real config while the guard returned exit 0.
  // On genuinely case-sensitive filesystems this only costs a false positive
  // on a distinct file that differs from a protected name by case alone.
  if (PROTECTED_FILES.has(basename) || PROTECTED_FILES.has(basename.toLowerCase())) {
    // Allow first-time creation — there's no existing config to weaken.
    // The hook's purpose is blocking modifications; writing a brand-new
    // config file in a project that has none is a legitimate bootstrap
    // path (e.g. scaffolding ESLint into a fresh repo).
    //
    // Fail closed on any stat error other than ENOENT. Use lstatSync so a
    // symlink at the protected path is treated as present even if its target
    // is missing — a dangling symlink at e.g. .eslintrc.js still represents
    // an existing config entry that an agent should not silently replace.
    // fs.existsSync would swallow EACCES/EPERM as false; lstatSync exposes
    // the error code so we can treat only genuine "path not found" (ENOENT)
    // as absent.
    let exists = true;
    try {
      fs.lstatSync(filePath);
      // lstat succeeded — something (file, dir, or symlink) exists here.
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        exists = false;
      }
      // Any other error (EACCES, EPERM, ELOOP, etc.) leaves exists=true
      // so the guard is never silently weakened.
    }

    if (!exists) {
      return { exitCode: 0 };
    }

    const env = options.env || process.env;
    const state = readState(input, env);
    if (
      state.delivery && state.delivery.status === 'ready' &&
      state.context_status === 'ready' && contextCoversFile(state, filePath) &&
      isAdditiveNonWeakeningEdit(input.tool_input || {})
    ) {
      appendEvent({
        kind: 'evidence',
        type: 'protected_config_additive_change',
        status: 'PASS',
        project: state.project,
        message: `Allowed additive generated-path exclusion in ${basename}`
      }, env);
      return { exitCode: 0 };
    }

    return {
      exitCode: 2,
      stderr:
        `BLOCKED: Modifying ${basename} is not allowed. ` +
        'Fix the source code to satisfy linter/formatter rules instead of ' +
        'weakening the config. If this is a legitimate config change, ' +
        'keep the hook enabled and request explicit owner review. Additive generated-path exclusions are allowed only on a prepared delivery branch when the independent Context Builder covered this file.'
    };
  }

  return { exitCode: 0 };
}

module.exports = { contextCoversFile, isAdditiveNonWeakeningEdit, run };

// Stdin fallback for spawnSync execution
let truncated = /^(1|true|yes)$/i.test(String(process.env.ECC_HOOK_INPUT_TRUNCATED || ''));
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  if (raw.length < MAX_STDIN) {
    const remaining = MAX_STDIN - raw.length;
    raw += chunk.substring(0, remaining);
    if (chunk.length > remaining) truncated = true;
  } else {
    truncated = true;
  }
});

process.stdin.on('end', () => {
  const result = run(raw, {
    truncated,
    maxStdin: Number(process.env.ECC_HOOK_INPUT_MAX_BYTES) || MAX_STDIN
  });

  if (result.stderr) {
    process.stderr.write(result.stderr + '\n');
  }

  if (result.exitCode === 2) {
    process.exit(2);
  }

  process.stdout.write(raw);
});
