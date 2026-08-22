#!/usr/bin/env node
'use strict';

const { loadConfig } = require('../codex/config');
const { explicitIssueNumber, initializeDelivery, isActiveDelivery, runCommand } = require('../codex/delivery-lifecycle');
const { runRole } = require('../codex/run-role');
const { hash, readState, resolveSessionId } = require('../codex/runtime-state');

const MAX_STDIN = 1024 * 1024;
const MAX_ISSUE_BODY = 64 * 1024;

function shouldSkip(prompt) {
  const value = String(prompt || '').trim();
  return !value || /^\/(?:ecc:)?(?:codex-|help|clear|compact|status)/i.test(value);
}

// awaiting-branchは、worktree払い出し以前のstateにIssueとbranchだけが記録された状態である。
// prepareの案内を外すと、worktreeを持たないまま止まる。
function needsPreparation(delivery) {
  return Boolean(delivery && ['deferred', 'pending', 'awaiting-branch'].includes(delivery.status));
}

function isPlanMode(input) {
  const mode = input && (input.permission_mode || input.permissionMode);
  return String(mode || '').toLowerCase() === 'plan';
}

function requestWithExplicitIssueSnapshot(prompt, options = {}) {
  const issueNumber = explicitIssueNumber(prompt);
  if (!issueNumber) return prompt;
  const execute = options.runCommand || runCommand;
  try {
    const raw = execute(
      'gh',
      ['issue', 'view', String(issueNumber), '--json', 'number,title,url,state,body'],
      { cwd: options.cwd, env: options.env }
    );
    const issue = JSON.parse(raw || '{}');
    if (Number(issue.number) !== issueNumber) return prompt;
    const snapshot = {
      number: issueNumber,
      title: String(issue.title || '').slice(0, 500),
      url: String(issue.url || '').slice(0, 2000),
      state: String(issue.state || '').slice(0, 32),
      body: String(issue.body || '').slice(0, MAX_ISSUE_BODY)
    };
    return [
      prompt,
      '',
      '[ECC authoritative referenced Issue snapshot]',
      'The parent Hook fetched this snapshot before entering the Codex sandbox. Use it instead of querying GitHub again.',
      JSON.stringify(snapshot)
    ].join('\n');
  } catch {
    return prompt;
  }
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
  const prepareInstruction = `Before the first edit, run node "$CLAUDE_PLUGIN_ROOT/scripts/codex/delivery-lifecycle.js" prepare --session "${sessionId}". The Delivery Gate will fail closed until Issue deduplication and the issue-linked branch are recorded. Preparation checks that branch out in its own worktree and reports the path in worktree_path; continue the normal CLI workflow - edits, tests, commits, review, and push - inside that path, and leave the shared working tree on its own branch.`;
  const prompt = input.prompt || input.user_prompt || '';
  if (!config.enabled || shouldSkip(prompt)) return rawInput;

  // plan modeではIssue作成やbranch切替を行わず、Deliveryの意図だけを外部stateへ
  // deferredとして記録する。ExitPlanMode承認後にUserPromptSubmitが再発火しなくても、
  // 最初の変更をDelivery Gateで確実に止められる。
  const delivery = initializeDelivery(input, prompt, {
    cwd,
    env: options.env || process.env,
    deferred: isPlanMode(input)
  });

  const existing = readState(input, options.env || process.env);
  if (
    existing.context_status === 'ready' && existing.context &&
    (
      existing.context_request_hash === hash(prompt, 32) ||
      (isActiveDelivery(delivery) && existing.context_request_hash === delivery.request_hash)
    )
  ) {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: [
          '[ECC Codex Context Builder cached packet]',
          'Reuse the existing task context below. Do not rerun broad exploration.',
          needsPreparation(delivery) ? prepareInstruction : '',
          'This packet is bound to the active Delivery. Follow-up prompts reuse it until the Delivery completes.',
          JSON.stringify(existing.context)
        ].join('\n')
      }
    });
  }

  const roleRequest = requestWithExplicitIssueSnapshot(prompt, {
    cwd,
    env: options.env || process.env,
    runCommand: options.runCommand
  });
  const roleRunner = options.runRole || runRole;
  const output = roleRunner({
    role: 'context-builder',
    request: roleRequest,
    requestHash: delivery ? delivery.request_hash : hash(prompt, 32),
    // Hookが知っているのはSessionのproject directoryだけで、作業場所の指定ではない。
    // 隔離済みDeliveryのContext Builderは、ここではなく記録済みworktreeで走る。
    projectDir: cwd,
    sessionId: input.session_id,
    env: options.env || process.env
  });
  const additionalContext = output.ok
    ? [
        '[ECC Codex Context Builder]',
        'Codex completed the initial repository investigation. Do not repeat broad exploration already covered below.',
        needsPreparation(delivery) ? prepareInstruction : '',
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

module.exports = { isPlanMode, needsPreparation, requestWithExplicitIssueSnapshot, run, shouldSkip };
