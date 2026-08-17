#!/usr/bin/env node
'use strict';

const { resetState, resolveSessionId } = require('./runtime-state');

function reset(sessionId, env = process.env) {
  const input = { session_id: sessionId || resolveSessionId({}, env) };
  resetState(input, env);
  return input.session_id;
}

if (require.main === module) {
  const sessionId = reset(process.argv[2]);
  process.stdout.write(`Reset ECC Codex task state for ${sessionId}\n`);
}

module.exports = { reset };
