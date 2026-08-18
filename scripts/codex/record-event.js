#!/usr/bin/env node
'use strict';

const { appendEvent, projectFingerprint, recordIncident, redactText } = require('./runtime-state');

const ALLOWED_EVIDENCE_STATUS = new Set(['PASS', 'FAIL', 'INCONCLUSIVE']);
const ALLOWED_SEVERITY = new Set(['minor', 'critical']);

function usage() {
  return 'usage: record-event.js evidence <type> <PASS|FAIL|INCONCLUSIVE> <message> | incident <type> <minor|critical> <message>';
}

function record(argv, options = {}) {
  const env = options.env || process.env;
  const cwd = options.cwd || process.cwd();
  const [kind, type, value, ...messageParts] = argv;
  const message = messageParts.join(' ').trim();
  if (!/^[a-z][a-z0-9_-]{1,80}$/.test(type || '') || !message) throw new Error(usage());

  if (kind === 'evidence') {
    if (!ALLOWED_EVIDENCE_STATUS.has(value)) throw new Error(usage());
    return appendEvent({
      kind: 'evidence',
      type,
      status: value,
      project: projectFingerprint(cwd),
      message: redactText(message),
      promotable: false
    }, env);
  }
  if (kind === 'incident') {
    if (!ALLOWED_SEVERITY.has(value)) throw new Error(usage());
    return recordIncident({ type, severity: value, message, target: env.ECC_INCIDENT_TARGET }, { cwd, env });
  }
  throw new Error(usage());
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(record(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}

module.exports = { record, usage };
