#!/usr/bin/env node
'use strict';

/**
 * Session end marker hook - performs lightweight observer cleanup and
 * outputs stdin to stdout unchanged. Exports run() for in-process execution.
 */

const {
  resolveProjectContext,
  removeSessionLease,
  listSessionLeases,
  stopObserverForContext,
  resolveSessionId
} = require('../lib/observer-sessions');
const { run: finalizeDelivery } = require('./delivery-session-finalizer');

function log(message) {
  process.stderr.write(`[SessionEnd] ${message}\n`);
}

function run(rawInput) {
  const output = rawInput || '';
  const sessionId = resolveSessionId();

  // incident-workerは既存イベントを送信するだけなので、その前段で未完了Deliveryを
  // 明示的にイベント化する。二重SessionEndはfinalizer側で冪等に処理する。
  try {
    finalizeDelivery(output, { mode: 'end' });
  } catch (error) {
    log(`Incomplete delivery finalization failed: ${error.message}`);
  }

  if (!sessionId) {
    log('No CLAUDE_SESSION_ID available; skipping observer cleanup');
    return output;
  }

  try {
    const observerContext = resolveProjectContext();
    removeSessionLease(observerContext, sessionId);
    const remainingLeases = listSessionLeases(observerContext);

    if (remainingLeases.length === 0) {
      if (stopObserverForContext(observerContext)) {
        log(`Stopped observer for project ${observerContext.projectId} after final session lease ended`);
      } else {
        log(`No running observer to stop for project ${observerContext.projectId}`);
      }
    } else {
      log(`Retained observer for project ${observerContext.projectId}; ${remainingLeases.length} session lease(s) remain`);
    }
  } catch (err) {
    log(`Observer cleanup skipped: ${err.message}`);
  }

  return output;
}

// Legacy CLI execution (when run directly)
if (require.main === module) {
  const MAX_STDIN = 1024 * 1024;
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    if (raw.length < MAX_STDIN) {
      const remaining = MAX_STDIN - raw.length;
      raw += chunk.substring(0, remaining);
    }
  });
  process.stdin.on('end', () => {
    process.stdout.write(run(raw));
  });
}

module.exports = { run };
