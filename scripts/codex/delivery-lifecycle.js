#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const { loadConfig } = require('./config');
const fs = require('fs');
const path = require('path');
const { hash, projectFingerprint, readJson, readState, recordIncident, resolveSessionId, stateRoot, writeState } = require('./runtime-state');

const DELIVERY_REQUEST = /(?:\b(?:implement|fix|change|add|remove|refactor|build|create|update)\b|実装|修正|変更|追加|削除|作成|更新|直して)/i;

function isDeliveryRequest(prompt) {
  const value = String(prompt || '').trim();
  return value.length >= 8 && DELIVERY_REQUEST.test(value) && !/^\s*\/(?:help|clear|compact|status)\b/i.test(value);
}

function titleFromRequest(request) {
  const first = String(request || '').split(/\r?\n/).map(line => line.trim()).find(Boolean) || 'ECC delivery task';
  return first.replace(/\s+/g, ' ').replace(/^#+\s*/, '').slice(0, 90);
}

function slug(value) {
  const ascii = String(value || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36);
  return ascii || 'task';
}

function initializeDelivery(input, request, options = {}) {
  const env = options.env || process.env;
  const cwd = options.cwd || input.cwd || process.cwd();
  const config = loadConfig(cwd, env);
  if (config.deliveryWorkflow !== 'required' || !isDeliveryRequest(request)) return null;

  const current = readState(input, env);
  const requestHash = hash(request, 32);
  if (current.delivery && current.delivery.request_hash === requestHash) return current.delivery;

  const delivery = {
    status: 'pending',
    request_hash: requestHash,
    title: titleFromRequest(request),
    base_branch: config.deliveryBaseBranch,
    issue_number: null,
    issue_url: null,
    branch: null,
    draft_pr_url: null
  };
  writeState(input, { delivery, project: projectFingerprint(cwd) }, env);
  return delivery;
}

function pendingSessionForProject(cwd, env = process.env) {
  const sessionsDir = path.join(stateRoot(env), 'sessions');
  const project = projectFingerprint(cwd);
  let candidates = [];
  try {
    candidates = fs.readdirSync(sessionsDir)
      .filter(file => file.endsWith('.json'))
      .map(file => readJson(path.join(sessionsDir, file)))
      .filter(state => state && state.project === project && state.delivery && state.delivery.status === 'pending')
      .sort((left, right) => String(right.updated_at || '').localeCompare(String(left.updated_at || '')));
  } catch {
    return '';
  }
  return candidates.length === 1 ? resolveSessionId(candidates[0], env) : '';
}

function runCommand(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: 'utf8',
    timeout: options.timeout || 30000,
    windowsHide: true
  });
  if (result.error || result.status !== 0) {
    const detail = result.error ? result.error.message : String(result.stderr || result.stdout || '').trim();
    throw new Error(`${binary} ${args[0] || ''} failed: ${detail || `exit ${result.status}`}`);
  }
  return String(result.stdout || '').trim();
}

function parseIssueNumber(url) {
  const match = String(url || '').match(/\/issues\/(\d+)(?:\D|$)/);
  if (!match) throw new Error('GitHub did not return an issue URL');
  return Number(match[1]);
}

function findDuplicateIssue(delivery, options = {}) {
  const raw = runCommand('gh', ['issue', 'list', '--state', 'open', '--limit', '100', '--json', 'number,title,url,body'], options);
  const issues = JSON.parse(raw || '[]');
  const needle = delivery.title.toLowerCase();
  return issues.find(issue => {
    const title = String(issue.title || '').toLowerCase();
    const body = String(issue.body || '');
    const sameFingerprint = body.includes(`Request fingerprint: \`${delivery.request_hash}\``);
    const strongTitleOverlap = title.length >= 24 && needle.length >= 24 && (title.includes(needle) || needle.includes(title));
    return sameFingerprint || title === needle || strongTitleOverlap;
  }) || null;
}

function prepareDelivery(input = {}, options = {}) {
  const env = options.env || process.env;
  const cwd = options.cwd || input.cwd || process.cwd();
  const state = readState(input, env);
  const delivery = state.delivery;
  if (!delivery || delivery.status !== 'pending') {
    throw new Error('No pending required delivery task. Submit the implementation request first.');
  }

  try {
    const dirty = runCommand('git', ['status', '--porcelain'], { cwd, env });
    if (dirty) throw new Error('Delivery preparation requires a clean working tree; preserve or commit existing changes first.');

    let issue = findDuplicateIssue(delivery, { cwd, env });
    if (!issue) {
      const body = [
        'ECC deterministic delivery workflow がユーザー要求から自動作成しました。',
        '',
        `Request fingerprint: \`${delivery.request_hash}\``,
        '',
        'このIssueに紐づくDraft PRが作成されるまで自動クローズしません。'
      ].join('\n');
      const url = runCommand('gh', ['issue', 'create', '--title', delivery.title, '--body', body], { cwd, env });
      issue = { number: parseIssueNumber(url), title: delivery.title, url };
    }

    const branch = `codex/issue-${issue.number}-${slug(delivery.title)}`;
    const currentBranch = runCommand('git', ['branch', '--show-current'], { cwd, env });
    if (currentBranch !== branch) {
      const existing = runCommand('git', ['branch', '--list', branch], { cwd, env });
      if (existing) {
        runCommand('git', ['switch', branch], { cwd, env });
      } else {
        runCommand('git', ['rev-parse', '--verify', delivery.base_branch], { cwd, env });
        runCommand('git', ['switch', '-c', branch, delivery.base_branch], { cwd, env });
      }
    }

    const next = {
      ...delivery,
      status: 'ready',
      issue_number: Number(issue.number),
      issue_url: issue.url,
      branch,
      prepared_at: new Date().toISOString()
    };
    writeState(input, { delivery: next }, env);
    return next;
  } catch (error) {
    recordIncident(
      { type: 'delivery_prepare_failure', severity: 'critical', message: error.message, hook_id: 'delivery-lifecycle' },
      { cwd, env }
    );
    throw error;
  }
}

function main() {
  const command = process.argv[2];
  const sessionIndex = process.argv.indexOf('--session');
  const explicitSession = sessionIndex >= 0 ? process.argv[sessionIndex + 1] : process.env.CLAUDE_SESSION_ID;
  const sessionId = explicitSession || pendingSessionForProject(process.cwd(), process.env);
  if (command !== 'prepare') throw new Error('usage: delivery-lifecycle.js prepare --session <id>');
  if (!sessionId) throw new Error('No unique pending delivery session for this project; retry the exact session-bound command from the Delivery Gate.');
  process.stdout.write(`${JSON.stringify(prepareDelivery({ session_id: sessionId, cwd: process.cwd() }), null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[ECC Delivery] ${error.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  findDuplicateIssue,
  initializeDelivery,
  isDeliveryRequest,
  parseIssueNumber,
  pendingSessionForProject,
  prepareDelivery,
  runCommand,
  slug,
  titleFromRequest
};
