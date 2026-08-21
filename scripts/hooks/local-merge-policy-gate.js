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

// Wrapper options that consume the following word as their own operand. Without
// these, `env -u GH_TOKEN gh pr merge 12` would resolve `GH_TOKEN` as the
// executed binary and let the merge through.
const WRAPPER_VALUE_OPTIONS = {
  doas: new Set(['-C', '-u']),
  env: new Set(['-C', '-S', '-u', '--chdir', '--split-string', '--unset']),
  exec: new Set(['-a']),
  nice: new Set(['-n', '--adjustment']),
  stdbuf: new Set(['-e', '-i', '-o', '--error', '--input', '--output']),
  sudo: new Set([
    '-C', '-D', '-R', '-U', '-g', '-h', '-p', '-r', '-t', '-u',
    '--close-from', '--chdir', '--chroot', '--other-user', '--group', '--host', '--prompt', '--role', '--type', '--user'
  ]),
  time: new Set(['-f', '-o', '--format', '--output']),
  timeout: new Set(['-k', '-s', '--kill-after', '--signal']),
  xargs: new Set([
    '-E', '-I', '-L', '-P', '-a', '-d', '-n', '-s',
    '--arg-file', '--delimiter', '--eof', '--max-args', '--max-chars', '--max-lines', '--max-procs', '--replace'
  ])
};

// Shells that execute their `-c` operand as a script, so that operand is parsed
// as its own command instead of being treated as inert text.
const SHELL_BINARIES = new Set(['bash', 'busybox', 'dash', 'ksh', 'sh', 'zsh']);

// Binaries that can actually publish a commit status. Anything else — `echo`,
// a commit message, a Python or Node snippet that only prints the endpoint —
// is inert text and must stay allowed (central Issue #75).
const HTTP_CLIENTS = new Set(['curl', 'gh', 'http', 'https', 'wget']);

const METHOD_OPTIONS = {
  curl: new Set(['-X', '--request']),
  gh: new Set(['-X', '--method']),
  wget: new Set(['--method'])
};

// Options whose value is the request body of the executed HTTP call.
const BODY_OPTIONS = {
  curl: new Set([
    '-d', '-F', '--data', '--data-ascii', '--data-binary', '--data-raw', '--data-urlencode', '--form', '--json'
  ]),
  gh: new Set(['-F', '-f', '--field', '--raw-field']),
  wget: new Set(['--body-data', '--post-data'])
};

// Options whose value is a path: the payload never appears in argv, so a
// mutation aimed at a commit-status endpoint cannot be cleared and fails closed.
const FILE_BODY_OPTIONS = {
  curl: new Set(['-T', '--upload-file']),
  gh: new Set(['--input']),
  wget: new Set(['--body-file', '--post-file'])
};

const NO_OPTIONS = new Set();

// Nested substitutions terminate because each level parses a strictly shorter
// string, but a hostile input can still nest far enough to be unreadable. Past
// this depth the input is treated as unresolved and denied instead of allowed.
const MAX_PARSE_DEPTH = 12;

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// A parameter expansion left in a token value: the text it produces is unknown.
const EXPANSION = /\$[A-Za-z_{]/;
const WRAPPER_OPERAND = /^\d+(?:\.\d+)?[smhd]?$/i;
const STATUS_ENDPOINT = /(?:\/statuses\/|\/status$)/i;
const SUCCESS_FIELD = /(?:^|=)state=success$/i;
const SUCCESS_JSON = /["']state["']\s*:\s*["']success["']/i;
const MUTATING_METHOD = /^(?:post|put|patch)$/i;

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

function skipHeredocBodies(source, start, pending, substitutions, bodies) {
  let index = start;
  for (const doc of pending) {
    const body = [];
    while (index < source.length) {
      const lineEnd = source.indexOf('\n', index);
      const end = lineEnd === -1 ? source.length : lineEnd;
      const line = source.slice(index, end).replace(/\r$/, '');
      index = lineEnd === -1 ? source.length : lineEnd + 1;
      if ((doc.stripTabs ? line.replace(/^\t+/, '') : line) === doc.delimiter) break;
      body.push(doc.stripTabs ? line.replace(/^\t+/, '') : line);
    }
    const text = body.join('\n');
    if (doc.expand && text) collectHeredocSubstitutions(text, substitutions);
    if (text) bodies.push(text);
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
 * Tokenize a Bash tool input into the simple commands it actually executes.
 *
 * The gate used to match regexes against the whole command string, so a
 * `gh pr merge` written inside a Python heredoc or a quoted note was blocked as
 * if it were an execution (central Issue #75). Tokenizing instead keeps the
 * decision on real argument positions: heredoc bodies are skipped, quotes are
 * resolved into token values, redirection operators and their targets are
 * dropped (`gh pr </dev/null merge 12` still merges), and command
 * substitutions are returned for separate parsing.
 *
 * @param {string} source
 * @returns {{ commands: string[][], nested: string[], unresolved: boolean }}
 */
function tokenizeScript(source) {
  const commands = [];
  const details = [];
  const substitutions = [];
  const heredocs = [];
  let tokens = [];
  // Parallel to `tokens`: whether the token was built from a substitution.
  let expanded = [];
  // Heredoc bodies and here-strings feeding this command's stdin.
  let stdinData = [];
  let bareExpansion = false;
  let tokenExpanded = false;
  let inputFromUnknown = false;
  let lastDetail = null;
  let token = '';
  let started = false;
  let redirectTarget = null;
  let i = 0;

  const endToken = () => {
    if (!started) return;
    // A redirection target is a file, not an argument of the command; a
    // here-string is data the command reads.
    if (!redirectTarget) {
      tokens.push(token);
      expanded.push(tokenExpanded);
    } else if (redirectTarget === 'stdin') {
      stdinData.push(token);
    }
    redirectTarget = null;
    tokenExpanded = false;
    token = '';
    started = false;
  };
  const endCommand = () => {
    endToken();
    redirectTarget = null;
    if (tokens.length) {
      lastDetail = { tokens, expanded, bareExpansion, stdin: stdinData, inputFromUnknown };
      commands.push(tokens);
      details.push(lastDetail);
      tokens = [];
      expanded = [];
    } else {
      lastDetail = null;
    }
    stdinData = [];
    bareExpansion = false;
    tokenExpanded = false;
    inputFromUnknown = false;
  };
  const noteSubstitution = () => {
    if (started) tokenExpanded = true;
    else bareExpansion = true;
  };
  // Consumes `>`, `>>`, `<`, `>|`, `<>`, `>&2`, and any `N` file-descriptor
  // prefix already accumulated in the current token.
  const startRedirection = index => {
    const operator = source[index];
    if (started && /^\d+$/.test(token)) {
      token = '';
      started = false;
      tokenExpanded = false;
    }
    endToken();
    let next = index + 1;
    if (source[next] === operator || source[next] === '|' || source[next] === '>') next += 1;
    if (source[next] === '&') {
      next += 1;
      while (next < source.length && /[\d-]/.test(source[next])) next += 1;
      return next;
    }
    // `<file` replaces stdin with content this gate cannot read.
    if (operator === '<') inputFromUnknown = true;
    redirectTarget = 'file';
    return next;
  };

  while (i < source.length) {
    const ch = source[i];

    if (ch === '\n') {
      endCommand();
      const owner = lastDetail;
      if (heredocs.length) {
        const bodies = [];
        i = skipHeredocBodies(source, i + 1, heredocs, substitutions, bodies);
        if (owner) owner.stdin.push(...bodies);
      } else i += 1;
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
      const before = substitutions.length;
      const span = readDoubleQuoted(source, i, substitutions);
      if (substitutions.length > before) tokenExpanded = true;
      token += span.value;
      started = true;
      i = span.next;
      continue;
    }
    if (ch === '$' && source[i + 1] === '(') {
      const span = readParenSpan(source, i + 1);
      substitutions.push(span.body);
      noteSubstitution();
      i = span.next;
      continue;
    }
    if (ch === '`') {
      const span = readBacktickSpan(source, i);
      substitutions.push(span.body);
      noteSubstitution();
      i = span.next;
      continue;
    }
    // `<<<` is a here-string, not a heredoc: its operand is data on the same line.
    if (ch === '<' && source[i + 1] === '<' && source[i + 2] === '<') {
      endToken();
      redirectTarget = 'stdin';
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
    // `&>file` and `&>>file` redirect both streams instead of backgrounding.
    if (ch === '&' && source[i + 1] === '>') {
      i = startRedirection(i + 1);
      continue;
    }
    if (ch === '<' || ch === '>') {
      i = startRedirection(i);
      continue;
    }
    // A pipeline feeds the next command's stdin with output this gate cannot read.
    if (ch === '|') {
      endCommand();
      if (source[i + 1] === '|') {
        i += 2;
        continue;
      }
      inputFromUnknown = true;
      i += 1;
      continue;
    }
    if (ch === ';' || ch === '&' || ch === '(' || ch === ')') {
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

  const nested = [...substitutions];
  let unresolved = false;
  for (const detail of details) {
    nested.push(...shellScriptArguments(detail.tokens));
    const stdin = shellStdinScripts(detail);
    nested.push(...stdin.scripts);
    if (stdin.unresolved || executesDynamicScript(detail)) unresolved = true;
  }
  return { commands, nested, unresolved };
}

/**
 * Parse a command and everything it executes indirectly: substitutions,
 * `sh -c` scripts, `eval` arguments, and scripts a shell reads from stdin.
 *
 * @param {string} command
 * @param {number} [depth]
 * @returns {{ commands: string[][], unresolved: boolean }} `unresolved` marks
 *   input whose executed text cannot be recovered — a script built by an
 *   expansion, piped into a shell, or nested past {@link MAX_PARSE_DEPTH}.
 *   The gate denies those instead of allowing them.
 */
function analyzeCommand(command, depth = 0) {
  const { commands, nested, unresolved } = tokenizeScript(String(command || ''));
  if (!nested.length) return { commands, unresolved };
  if (depth >= MAX_PARSE_DEPTH) return { commands, unresolved: true };

  let deep = unresolved;
  for (const body of nested) {
    const inner = analyzeCommand(body, depth + 1);
    commands.push(...inner.commands);
    deep = deep || inner.unresolved;
  }
  return { commands, unresolved: deep };
}

/**
 * @param {string} command
 * @returns {string[][]} token lists, one per executed simple command
 */
function executedCommands(command) {
  return analyzeCommand(command).commands;
}

function binaryName(token) {
  return String(token).split(/[\\/]/).pop().replace(/\.(?:exe|cmd|bat|ps1)$/i, '').toLowerCase();
}

/**
 * Resolve the executions a token list can start: the binary left after
 * assignment prefixes and wrapper commands are skipped, plus — when a wrapper is
 * involved — every later operand position.
 *
 * Wrapper option arity is only known for the wrappers listed above, so the extra
 * candidates keep an unrecognized `env --unknown VALUE gh pr merge` fail-closed
 * instead of resolving `VALUE` as the binary and allowing the merge.
 *
 * @param {string[]} tokens
 * @returns {{ name: string, args: string[] }[]}
 */
function resolveExecutions(tokens) {
  const executions = [];
  let index = 0;
  let wrapped = false;

  while (index < tokens.length) {
    if (ASSIGNMENT.test(tokens[index])) {
      index += 1;
      continue;
    }
    const name = binaryName(tokens[index]);
    if (!COMMAND_WRAPPERS.has(name)) {
      executions.push({ name, args: tokens.slice(index + 1) });
      if (!wrapped) break;
      index += 1;
      continue;
    }

    wrapped = true;
    const values = WRAPPER_VALUE_OPTIONS[name] || NO_OPTIONS;
    index += 1;
    while (index < tokens.length) {
      const argument = tokens[index];
      if (argument.startsWith('-') && argument !== '-') {
        index += 1;
        if (values.has(argument) && index < tokens.length) index += 1;
        continue;
      }
      if (ASSIGNMENT.test(argument) || WRAPPER_OPERAND.test(argument)) {
        index += 1;
        continue;
      }
      break;
    }
  }
  return executions;
}

/**
 * @param {string[]} tokens
 * @returns {{ name: string, args: string[] } | null} the primary execution
 */
function resolveExecution(tokens) {
  return resolveExecutions(tokens)[0] || null;
}

/**
 * Scripts that a token list hands to another interpreter: `sh -c <script>` and
 * `eval <words>` both execute their operands, so they are parsed as commands.
 *
 * @param {string[]} tokens
 * @returns {string[]}
 */
function shellScriptArguments(tokens) {
  const scripts = [];
  for (const execution of resolveExecutions(tokens)) {
    if (execution.name === 'eval') {
      if (execution.args.length) scripts.push(execution.args.join(' '));
      continue;
    }
    if (!SHELL_BINARIES.has(execution.name)) continue;
    const flag = shellScriptFlagIndex(execution.args);
    if (flag !== -1 && flag + 1 < execution.args.length) scripts.push(execution.args[flag + 1]);
  }
  return scripts;
}

function shellScriptFlagIndex(args) {
  return args.findIndex(argument => /^-[a-z]*c$/i.test(argument));
}

/**
 * Scripts a shell reads from stdin instead of from `-c`: `bash <<'EOF' ... EOF`
 * and `bash <<< "gh pr merge 12"` both execute their data, so it is parsed as a
 * command. When the same shell is fed by a pipe or a file redirection the
 * script text is unknown and the input is unresolved. A shell given a script
 * file operand keeps its previous treatment: the file is not read here.
 *
 * @param {{ tokens: string[], stdin: string[], inputFromUnknown: boolean }} detail
 * @returns {{ scripts: string[], unresolved: boolean }}
 */
function shellStdinScripts({ tokens, stdin, inputFromUnknown }) {
  const scripts = [];
  let unresolved = false;
  for (const execution of resolveExecutions(tokens)) {
    if (!SHELL_BINARIES.has(execution.name)) continue;
    if (shellScriptFlagIndex(execution.args) !== -1) continue;
    if (execution.args.some(argument => !argument.startsWith('-'))) continue;
    if (stdin.length) scripts.push(...stdin);
    else if (inputFromUnknown) unresolved = true;
  }
  return { scripts, unresolved };
}

/**
 * True when a command hands an interpreter a script this gate cannot read
 * because the script text comes from a substitution or an expansion —
 * `eval "$(printf ...)"`, `SCRIPT='gh pr merge 12'; eval $SCRIPT`.
 *
 * Such input is reported as unresolved and denied instead of allowed; the
 * script it would run is unknown, so no allow decision can be justified.
 *
 * @param {{ tokens: string[], expanded: boolean[], bareExpansion: boolean }} detail
 * @returns {boolean}
 */
function executesDynamicScript({ tokens, expanded, bareExpansion }) {
  const dynamic = (index, value) => Boolean(expanded[index]) || EXPANSION.test(String(value || ''));
  return resolveExecutions(tokens).some(execution => {
    const offset = tokens.length - execution.args.length;
    if (execution.name === 'eval') {
      return bareExpansion || execution.args.some((argument, index) => dynamic(offset + index, argument));
    }
    if (!SHELL_BINARIES.has(execution.name)) return false;
    const flag = shellScriptFlagIndex(execution.args);
    if (flag === -1 || flag + 1 >= execution.args.length) return false;
    return bareExpansion || dynamic(offset + flag + 1, execution.args[flag + 1]);
  });
}

/**
 * Values passed to the given options, handling `--opt value`, `--opt=value` and
 * attached short forms such as `-XPOST`.
 *
 * @param {string[]} args
 * @param {Set<string>} flags
 * @returns {string[]}
 */
function optionValues(args, flags) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith('-') || argument === '-') continue;
    const separator = argument.indexOf('=');
    const name = separator === -1 ? argument : argument.slice(0, separator);
    if (flags.has(name)) {
      if (separator !== -1) values.push(argument.slice(separator + 1));
      else if (index + 1 < args.length) {
        values.push(args[index + 1]);
        index += 1;
      } else values.push('');
      continue;
    }
    if (!argument.startsWith('--') && argument.length > 2 && flags.has(argument.slice(0, 2))) {
      values.push(argument.slice(2));
    }
  }
  return values;
}

function hasSuccessValue(values) {
  return values.some(value => SUCCESS_FIELD.test(value) || SUCCESS_JSON.test(value));
}

// `@file` and `-` read the payload from elsewhere, so its content cannot be
// cleared here. An empty list means a mutation whose body is not in argv at all.
function isOpaqueBody(value) {
  return value === '' || value === '-' || value.startsWith('@');
}

function mergesPullRequest(tokens) {
  return resolveExecutions(tokens).some(execution => {
    if (execution.name !== 'gh') return false;
    const operands = execution.args.filter(argument => !argument.startsWith('-'));
    return operands.some((operand, index) => operand === 'pr' && operands[index + 1] === 'merge');
  });
}

function ghPublishesSuccessStatus(args) {
  const operands = args.filter(argument => !argument.startsWith('-'));
  if (operands[0] !== 'api') return false;
  if (!operands.some(operand => STATUS_ENDPOINT.test(operand))) return false;
  const bodies = optionValues(args, BODY_OPTIONS.gh);
  const files = optionValues(args, FILE_BODY_OPTIONS.gh);
  const methods = optionValues(args, METHOD_OPTIONS.gh);
  // `gh api` only sends a request body for field/input flags or an explicit
  // mutating method; a plain read of the statuses endpoint stays allowed.
  if (!bodies.length && !files.length && !methods.some(method => MUTATING_METHOD.test(method))) return false;
  return hasSuccessValue(bodies) || files.length > 0 || bodies.every(isOpaqueBody);
}

function clientPublishesSuccessStatus(name, args) {
  if (!args.some(argument => STATUS_ENDPOINT.test(argument))) return false;
  const bodies = optionValues(args, BODY_OPTIONS[name] || NO_OPTIONS);
  const files = optionValues(args, FILE_BODY_OPTIONS[name] || NO_OPTIONS);
  const methods = optionValues(args, METHOD_OPTIONS[name] || NO_OPTIONS);
  // httpie takes the method and `key=value` items as operands.
  const operands = args.filter(argument => !argument.startsWith('-'));
  const mutating = bodies.length > 0
    || files.length > 0
    || methods.some(method => MUTATING_METHOD.test(method))
    || operands.some(operand => MUTATING_METHOD.test(operand));
  if (!mutating) return false;
  return hasSuccessValue(bodies) || hasSuccessValue(operands) || files.length > 0 || bodies.every(isOpaqueBody);
}

/**
 * True only when the token list runs an HTTP client that writes a success commit
 * status. Printing the same endpoint and payload (`echo`, a commit message, a
 * Python snippet) executes no request and stays allowed.
 *
 * @param {string[]} tokens
 * @returns {boolean}
 */
function publishesSuccessStatus(tokens) {
  return resolveExecutions(tokens).some(execution => {
    if (!HTTP_CLIENTS.has(execution.name)) return false;
    return execution.name === 'gh'
      ? ghPublishesSuccessStatus(execution.args)
      : clientPublishesSuccessStatus(execution.name, execution.args);
  });
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
  const { commands, unresolved } = analyzeCommand(command);
  if (commands.some(mergesPullRequest)) {
    return deny('PRのmergeはCompletion Gateだけが実行できます。Local Merge Gateを通し、通常のStopフローへ戻ってください。');
  }
  if (commands.some(publishesSuccessStatus)) {
    return deny('success commit statusの直接投稿は禁止です。engineering-kit-merge-gateが検査結果に基づいて投稿します。');
  }
  if (unresolved) {
    return deny('生成した文字列をそのままscriptとして実行するコマンドは、実行内容を確認できないため許可できません。eval・sh -c・shellへのpipeに渡さず、実行するコマンドを直接記述してください。');
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
  analyzeCommand,
  deny,
  executedCommands,
  isCodexRoleRunner,
  isDirectMerge,
  isDirectSuccessStatus,
  mergesPullRequest,
  publishesSuccessStatus,
  resolveExecution,
  resolveExecutions,
  run
};
