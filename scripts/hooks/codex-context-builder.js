#!/usr/bin/env node
'use strict';

const { loadConfig } = require('../codex/config');
const { initializeDelivery } = require('../codex/delivery-lifecycle');
const { runRole } = require('../codex/run-role');
const { hash, readState, resolveSessionId } = require('../codex/runtime-state');

const MAX_STDIN = 1024 * 1024;

function shouldSkip(prompt) {
  const value = String(prompt || '').trim();
  return !value || /^\/(?:ecc:)?(?:codex-|help|clear|compact|status)/i.test(value);
}

function run(rawInput, options = {}) {
  let input;
  try {
    input = typeof rawInput === 'string' ? JSON.parse(rawInput) : rawInput;
  } catch {
    return rawInput;
  }
  const cwd = options.cwd || input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const config = loadConfig(cwd, options.env || process.env);
  const sessionId = resolveSessionId(input, options.env || process.env);
  const prepareInstruction = `Before the first edit, run node \"$CLAUDE_PLUGIN_ROOT/scripts/codex/delivery-lifecycle.js\" prepare --session \"${sessionId}\". The Delivery Gate will fail closed until Issue deduplication and the issue-linked branch are recorded.`;
  const prompt = input.prompt || input.user_prompt || '';
  if (!config.enabled || shouldSkip(prompt)) return rawInput;

  const delivery = initializeDelivery(input, prompt, { cwd, env: options.env || process.env });

  const existing = readState(input, options.env || process.env);
  if (
    existing.context_status === 'ready' && existing.context &&
    existing.context_request_hash === hash(prompt, 32)
  ) {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: [
          '[ECC Codex Context Builder cached packet]',
          'Reuse the existing task context below. Do not rerun broad exploration.',
          delivery && delivery.status === 'pending'
            ? prepareInstruction
            : '',
          'This packet is bound to the current request fingerprint; a different request automatically rebuilds it.',
          JSON.stringify(existing.context)
        ].join('\n')
      }
    });
  }

  const output = runRole({
    role: 'context-builder',
    request: prompt,
    cwd,
    sessionId: input.session_id,
    env: options.env || process.env
  });
  const additionalContext = output.ok
    ? [
        '[ECC Codex Context Builder]',
        'Codex completed the initial repository investigation. Do not repeat broad exploration already covered below.',
        delivery && delivery.status === 'pending'
          ? prepareInstruction
          : '',
        'If GateGuard requests first-touch facts, present the relevant facts from this packet and retry; do not re-read the same files merely to satisfy the gate.',
        JSON.stringify(output.result)
      ].join('\n')
    : [
        '[ECC Codex Context Builder fallback]',
        `Codex was unavailable or invalid: ${output.error}`,
        'Continue with ECC native Claude investigation. This fallback has been recorded as an incident.'
      ].join('\n');

  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext
    }
  });
}

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    if (raw.length < MAX_STDIN) raw += chunk.slice(0, MAX_STDIN - raw.length);
  });
  process.stdin.on('end', () => process.stdout.write(run(raw)));
}

module.exports = { run, shouldSkip };
