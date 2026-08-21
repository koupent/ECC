#!/usr/bin/env node
'use strict';

const { loadConfig } = require('../codex/config');

// Shell words that wrap another command without changing what is executed.
// `env gh pr merge` and `timeout 10 gh pr merge` must still be recognized as
// merges, so the resolver skips these wrappers together with their own flags,
// `VAR=value` prefixes, and numeric operands.
const COMMAND_WRAPPERS = new Set([
  'builtin', 'command', 'doas', 'env', 'exec', 'nice', 'nohup', 'setsid', 'stdbuf', 'sudo', 'time', 'timeout', 'xargs'
]);

// Shells that execute their `-c` operand as a script, so that operand is parsed
// as its own command instead of being treated as inert text.
const SHELL_BINARIES = new Set(['bash', 'busybox', 'dash', 'ksh', 'sh', 'zsh']);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRAPPER_OPERAND = /^\d+(?:\.\d+)?[smhd]?$/i;
const STATUS_ENDPOINT = /(?:\/statuses\/|\/status$)/i;
const SUCCESS_FIELD = /(?:^|=)state=success$/i;
const SUCCESS_JSON = /["']state["']\s*:\s*["']success["']/i;

function deny(reason) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `[ECC Local Merge Policy] ${reason}`
    }
  });
}

function readSingleQuoted(source, start) {
  let i = start + 1;
  let value = '';
  while (i < source.length && source[i] !== "'") {
    value += source[i];
    i += 1;
  }
  return { value, next: i < source.length ? i + 1 : i };
}

function readParenSpan(source, start) {
  let depth = 1;
  let body = '';
  let quote = null;
  let i = start + 1;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === '\\' && i + 1 < source.length) {
      body += ch + source[i + 1];
      i += 2;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      body += ch;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      body += ch;
      i += 1;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        i += 1;
        break;
      }
    }
    body += ch;
    i += 1;
  }
  return { body, next: i };
}

function readBacktickSpan(source, start) {
  let i = start + 1;
  let body = '';
  while (i < source.length && source[i] !== '`') {
    if (source[i] === '\\' && i + 1 < source.length) {
      body += source[i + 1];
      i += 2;
      continue;
    }
    body += source[i];
    i += 1;
  }
  return { body, next: i < source.length ? i + 1 : i };
}

function readDoubleQuoted(source, start, substitutions) {
  let i = start + 1;
  let value = '';
  while (i < source.length && source[i] !== '"') {
    const ch = source[i];
    if (ch === '\\' && i + 1 < source.length) {
      const next = source[i + 1];
      if (next === '\n') {
        i += 2;
        continue;
      }
      if (next === '"' || next === '\\' || next === '$' || next === '`') {
        value += next;
        i += 2;
        continue;
      }
      value += ch;
      i += 1;
      continue;
    }
    // Substitutions still execute inside double quotes; their bodies are parsed
    // separately and contribute nothing to the surrounding token value.
    if (ch === '$' && source[i + 1] === '(') {
      const span = readParenSpan(source, i + 1);
      substitutions.push(span.body);
      i = span.next;
      continue;
    }
    if (ch === '`') {
      const span = readBacktickSpan(source, i);
      substitutions.push(span.body);
      i = span.next;
      continue;
    }
    value += ch;
    i += 1;
  }
  return { value, next: i < source.length ? i + 1 : i };
}

function readHeredocRedirection(source, start) {
  let i = start + 2;
  let stripTabs = false;
  let expand = true;
  if (source[i] === '-') {
    stripTabs = true;
    i += 1;
  }
  while (source[i] === ' ' || source[i] === '\t') i += 1;
  let delimiter = '';
  while (i < source.length && !/[\s;&|<>()]/.test(source[i])) {
    const ch = source[i];
    if (ch === "'" || ch === '"') {
      const span = ch === "'" ? readSingleQuoted(source, i) : readDoubleQuoted(source, i, []);
      delimiter += span.value;
      expand = false;
      i = span.next;
      continue;
    }
    if (ch === '\\' && i + 1 < source.length) {
      delimiter += source[i + 1];
      expand = false;
      i += 2;
      continue;
    }
    delimiter += ch;
    i += 1;
  }
  return { delimiter, stripTabs, expand, next: i };
}

/**
 * Collect substitution bodies from a heredoc body whose delimiter was unquoted.
 * Quotes are literal text inside a heredoc, so `$(...)` and backticks expand
 * wherever they appear.
 */
function collectHeredocSubstitutions(body, substitutions) {
  let i = 0;
  while (i < body.length) {
    if (body[i] === '\\' && i + 1 < body.length) {
      i += 2;
      continue;
    }
    if (body[i] === '$' && body[i + 1] === '(') {
      const span = readParenSpan(body, i + 1);
      substitutions.push(span.body);
      i = span.next;
      continue;
    }
    if (body[i] === '`') {
      const span = readBacktickSpan(body, i);
      substitutions.push(span.body);
      i = span.next;
      continue;
    }
    i += 1;
  }
}

function skipHeredocBodies(source, start, pending, substitutions) {
  let index = start;
  for (const doc of pending) {
    const body = [];
    while (index < source.length) {
      const lineEnd = source.indexOf('\n', index);
      const end = lineEnd === -1 ? source.length : lineEnd;
      const line = source.slice(index, end).replace(/\r$/, '');
      index = lineEnd === -1 ? source.length : lineEnd + 1;
      if ((doc.stripTabs ? line.replace(/^\t+/, '') : line) === doc.delimiter) break;
      if (doc.expand) body.push(line);
    }
    if (doc.expand && body.length) collectHeredocSubstitutions(body.join('\n'), substitutions);
  }
  pending.length = 0;
  return index;
}

function isBraceGroupOpen(source, index) {
  return /\s/.test(source[index + 1] || '') && (index === 0 || /[\s;|&(]/.test(source[index - 1]));
}

function isBraceGroupClose(source, index) {
  return index === 0 || /[\s;]/.test(source[index - 1]);
}

/**
 * Split a Bash tool input into the simple commands it actually executes.
 *
 * The gate used to match regexes against the whole command string, so a
 * `gh pr merge` written inside a Python heredoc or a quoted note was blocked as
 * if it were an execution (central Issue #75). Tokenizing instead keeps the
 * decision on real argument positions: heredoc bodies are skipped, quotes are
 * resolved into token values, and command substitutions are parsed as their own
 * commands so `"$(gh pr merge 1)"` stays covered.
 *
 * @param {string} command
 * @param {number} [depth] recursion guard for nested substitutions
 * @returns {string[][]} token lists, one per executed simple command
 */
function executedCommands(command, depth = 0) {
  const source = String(command || '');
  const commands = [];
  const substitutions = [];
  const heredocs = [];
  let tokens = [];
  let token = '';
  let started = false;
  let i = 0;

  const endToken = () => {
    if (!started) return;
    tokens.push(token);
    token = '';
    started = false;
  };
  const endCommand = () => {
    endToken();
    if (tokens.length) {
      commands.push(tokens);
      tokens = [];
    }
  };

  while (i < source.length) {
    const ch = source[i];

    if (ch === '\n') {
      endCommand();
      i = heredocs.length ? skipHeredocBodies(source, i + 1, heredocs, substitutions) : i + 1;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      endToken();
      i += 1;
      continue;
    }
    if (ch === '\\') {
      if (source[i + 1] === '\n') {
        i += 2;
        continue;
      }
      if (i + 1 < source.length) {
        token += source[i + 1];
        started = true;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (ch === "'") {
      const span = readSingleQuoted(source, i);
      token += span.value;
      started = true;
      i = span.next;
      continue;
    }
    if (ch === '"') {
      const span = readDoubleQuoted(source, i, substitutions);
      token += span.value;
      started = true;
      i = span.next;
      continue;
    }
    if (ch === '$' && source[i + 1] === '(') {
      const span = readParenSpan(source, i + 1);
      substitutions.push(span.body);
      i = span.next;
      continue;
    }
    if (ch === '`') {
      const span = readBacktickSpan(source, i);
      substitutions.push(span.body);
      i = span.next;
      continue;
    }
    // `<<<` is a here-string, not a heredoc: its operand is data on the same line.
    if (ch === '<' && source[i + 1] === '<' && source[i + 2] === '<') {
      endToken();
      i += 3;
      continue;
    }
    if (ch === '<' && source[i + 1] === '<') {
      const doc = readHeredocRedirection(source, i);
      endToken();
      if (doc.delimiter) heredocs.push(doc);
      i = doc.next;
      continue;
    }
    if (ch === '<' || ch === '>') {
      endToken();
      i += 1;
      continue;
    }
    if (ch === ';' || ch === '&' || ch === '|' || ch === '(' || ch === ')') {
      endCommand();
      i += 1;
      continue;
    }
    if (ch === '{' && isBraceGroupOpen(source, i)) {
      endCommand();
      i += 1;
      continue;
    }
    if (ch === '}' && isBraceGroupClose(source, i)) {
      endCommand();
      i += 1;
      continue;
    }
    token += ch;
    started = true;
    i += 1;
  }
  endCommand();

  if (depth < 4) {
    for (const parsed of [...commands]) substitutions.push(...shellScriptArguments(parsed));
    for (const body of substitutions) commands.push(...executedCommands(body, depth + 1));
  }
  return commands;
}

function binaryName(token) {
  return String(token).split(/[\\/]/).pop().replace(/\.(?:exe|cmd|bat|ps1)$/i, '').toLowerCase();
}

/**
 * Resolve the binary a token list actually runs, skipping assignment prefixes
 * and wrapper commands, and return it with its arguments.
 *
 * @param {string[]} tokens
 * @returns {{ name: string, args: string[] } | null}
 */
function resolveExecution(tokens) {
  let index = 0;
  while (index < tokens.length) {
    if (ASSIGNMENT.test(tokens[index])) {
      index += 1;
      continue;
    }
    const name = binaryName(tokens[index]);
    if (!COMMAND_WRAPPERS.has(name)) return { name, args: tokens.slice(index + 1) };
    index += 1;
    while (
      index < tokens.length &&
      (tokens[index].startsWith('-') || ASSIGNMENT.test(tokens[index]) || WRAPPER_OPERAND.test(tokens[index]))
    ) {
      index += 1;
    }
  }
  return null;
}

function shellScriptArguments(tokens) {
  const execution = resolveExecution(tokens);
  if (!execution || !SHELL_BINARIES.has(execution.name)) return [];
  const flag = execution.args.findIndex(argument => /^-[a-z]*c$/i.test(argument));
  if (flag === -1 || flag + 1 >= execution.args.length) return [];
  return [execution.args[flag + 1]];
}

function mergesPullRequest(tokens) {
  const execution = resolveExecution(tokens);
  if (!execution || execution.name !== 'gh') return false;
  const operands = execution.args.filter(arg => !arg.startsWith('-'));
  return operands.some((arg, index) => arg === 'pr' && operands[index + 1] === 'merge');
}

function publishesSuccessStatus(tokens) {
  if (!tokens.some(argument => STATUS_ENDPOINT.test(argument))) return false;
  return tokens.some(argument => SUCCESS_FIELD.test(argument) || SUCCESS_JSON.test(argument));
}

function isDirectMerge(command) {
  return executedCommands(command).some(mergesPullRequest);
}

function isDirectSuccessStatus(command) {
  return executedCommands(command).some(publishesSuccessStatus);
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
  if (config.deliveryCompletion !== 'squash-merge') return rawInput;

  const command = String(input.tool_input && input.tool_input.command || '');
  if (input.tool_input && input.tool_input.run_in_background === true && isCodexRoleRunner(command)) {
    return deny('必須Codex roleはforegroundで完了させてください。backgroundではClaude CLI終了時に子processと外部state証拠が失われます。');
  }
  const commands = executedCommands(command);
  if (commands.some(mergesPullRequest)) {
    return deny('PRのmergeはCompletion Gateだけが実行できます。Local Merge Gateを通し、通常のStopフローへ戻ってください。');
  }
  if (commands.some(publishesSuccessStatus)) {
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

module.exports = {
  deny,
  executedCommands,
  isCodexRoleRunner,
  isDirectMerge,
  isDirectSuccessStatus,
  mergesPullRequest,
  publishesSuccessStatus,
  resolveExecution,
  run
};
