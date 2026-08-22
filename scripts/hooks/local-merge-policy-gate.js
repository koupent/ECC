#!/usr/bin/env node
'use strict';

const { loadConfig } = require('../codex/config');
const { readState } = require('../codex/runtime-state');
const { executableInvocations } = require('../lib/shell-invocations');

function ghCommandArgs(args) {
  const result = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (/^(?:-R|--repo|--hostname)$/.test(arg)) {
      index += 1;
      continue;
    }
    if (/^(?:-R|--repo|--hostname)=/.test(arg)) continue;
    result.push(arg);
  }
  return result;
}

function deny(reason) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `[ECC Local Merge Policy] ${reason}`
    }
  });
}

function isDirectSuccessStatus(command) {
  return executableInvocations(command).some(({ executable, args: rawArgs }) => {
    const args = ghCommandArgs(rawArgs);
    const statusEndpoint = args.some(arg => /(?:\/statuses\/|\/status(?:\?|$))/i.test(arg));
    if (!statusEndpoint) return false;
    if (executable === 'gh' && args[0] === 'api') return args.some((arg, index) => {
      if (/^(?:-[fF].+|--(?:field|raw-field|input)(?:=|$)|-[fF]$)/.test(arg)) return true;
      const inlineMethod = arg.match(/^(?:-X|--method)=(.+)$/);
      if (inlineMethod) return !/^GET$/i.test(inlineMethod[1]);
      if (/^(?:-X|--method)$/.test(arg)) return !/^GET$/i.test(args[index + 1] || '');
      return false;
    });
    const client = executable.toLowerCase();
    const explicitMutation = (names) => args.some((arg, index) => {
      const compactShort = names.find(name => /^-[A-Za-z]$/.test(name) && arg.startsWith(name) && arg.length > name.length);
      if (compactShort) return !/^(?:GET|HEAD)$/i.test(arg.slice(compactShort.length));
      const inline = arg.match(new RegExp(`^(?:${names.join('|')})=(.+)$`, 'i'));
      if (inline) return !/^(?:GET|HEAD)$/i.test(inline[1]);
      if (new RegExp(`^(?:${names.join('|')})$`, 'i').test(arg)) {
        return !/^(?:GET|HEAD)$/i.test(args[index + 1] || '');
      }
      return false;
    });
    if (client === 'curl') {
      return explicitMutation(['-X', '--request']) || args.some(arg =>
        /^(?:-d(?:.|$)|-F(?:.|$)|-T(?:.|$)|--data(?:-ascii|-binary|-raw|-urlencode)?(?:=|$)|--json(?:=|$)|--form(?:-string)?(?:=|$)|--upload-file(?:=|$))/i.test(arg));
    }
    if (client === 'wget') {
      return explicitMutation(['--method']) || args.some(arg => /^(?:--post-data|--post-file|--body-data|--body-file)(?:=|$)/i.test(arg));
    }
    if (['http', 'https', 'xh'].includes(client)) {
      const method = args.find(arg => /^(?:GET|HEAD|POST|PUT|PATCH|DELETE)$/i.test(arg));
      if (method) return !/^(?:GET|HEAD)$/i.test(method);
      return args.some(arg => !/^https?:\/\//i.test(arg) && /^[^-=@][^=]*?(?::=|==|=|@)/.test(arg));
    }
    if (['invoke-restmethod', 'invoke-webrequest'].includes(client)) {
      return explicitMutation(['-Method']) || args.some(arg => /^(?:-Body|-InFile)$/i.test(arg));
    }
    return false;
  });
}

function isMergeInvocation(command) {
  return executableInvocations(command).some(({ executable, args }) => {
    const normalized = ghCommandArgs(args);
    return executable === 'gh' && normalized[0] === 'pr' && normalized[1] === 'merge';
  });
}

function isCodexRoleRunner(command) {
  return /(?:^|[\\/])run-role\.js(?:["']?\s|$)/i.test(String(command || ''));
}

function run(rawInput, options = {}) {
  let input;
  try {
    input = typeof rawInput === 'string' ? JSON.parse(rawInput) : rawInput;
  } catch {
    return rawInput;
  }
  if (String(input.tool_name || '') !== 'Bash') return rawInput;

  const cwd = options.cwd || input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const env = options.env || process.env;
  const config = loadConfig(cwd, env);
  const state = readState(input, env);
  const delivery = state.delivery || {};
  const recordedCompletion = delivery.completion_method;
  const invalidRequiredDelivery = !recordedCompletion &&
    delivery.workflow_mode === 'required' &&
    config.projectConfigStatus === 'invalid';
  if (recordedCompletion !== 'squash-merge' && config.deliveryCompletion !== 'squash-merge' && !invalidRequiredDelivery) {
    return rawInput;
  }

  const command = String(input.tool_input && input.tool_input.command || '');
  if (input.tool_input && input.tool_input.run_in_background === true && isCodexRoleRunner(command)) {
    return deny('必須Codex roleはforegroundで完了させてください。backgroundではClaude CLI終了時に子processと外部state証拠が失われます。');
  }
  if (isMergeInvocation(command)) {
    return deny('PRのmergeはCompletion Gateだけが実行できます。Local Merge Gateを通し、通常のStopフローへ戻ってください。');
  }
  if (isDirectSuccessStatus(command)) {
    return deny('success commit statusの直接投稿は禁止です。engineering-kit-merge-gateが検査結果に基づいて投稿します。');
  }
  return rawInput;
}

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { raw += chunk; });
  process.stdin.on('end', () => process.stdout.write(run(raw)));
}

module.exports = { deny, isCodexRoleRunner, isDirectSuccessStatus, isMergeInvocation, run };
