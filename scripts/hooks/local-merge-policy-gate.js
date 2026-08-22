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

// Wrapper options whose value is a command line the wrapper runs itself:
// `env -S 'gh pr merge 12'` splits the string into words and executes them, so
// the value is parsed as a command instead of skipped as a plain operand. The
// wrapper's remaining operands are appended to those words, so `env -Sgh pr
// merge 12` runs `gh pr merge 12`.
const SPLIT_STRING_OPTIONS = {
  env: new Set(['-S', '--split-string'])
};

// Shells that execute their `-c` operand as a script, so that operand is parsed
// as its own command instead of being treated as inert text.
const SHELL_BINARIES = new Set(['bash', 'busybox', 'dash', 'ksh', 'sh', 'zsh']);

// Interpreters that execute the script file named by their first operand. The
// role runner is only started from that position: `echo scripts/codex/run-role.js`
// names the same path and starts nothing (central Issue #75).
const SCRIPT_INTERPRETERS = new Set(['bun', 'deno', 'node', 'nodejs', 'ts-node', 'tsx']);

// Subcommands those interpreters accept before the script path (`deno run app.ts`).
const INTERPRETER_SUBCOMMANDS = new Set(['exec', 'run']);

// `find` actions that execute the words after them, up to `;` or `+`, as a
// command of their own: `find . -exec gh pr merge 12 \;` really merges.
const FIND_EXEC_ACTIONS = new Set(['-exec', '-execdir', '-ok', '-okdir']);
const FIND_EXEC_TERMINATORS = new Set([';', '+']);

// Reserved words that only introduce a command instead of being one. Without
// them `if true; then gh pr merge 12; fi` would resolve `then` as the executed
// binary and let the merge through.
const COMMAND_PREFIX_WORDS = new Set([
  '!', 'coproc', 'do', 'done', 'elif', 'else', 'fi', 'if', 'then', 'until', 'while'
]);

// Reserved words whose clause head is a word list rather than a command:
// `for file in src/*.ts` and `case $x in` execute nothing, so those words are
// data and must not be resolved as a binary with arguments.
const DATA_CLAUSE_WORDS = new Set(['case', 'esac', 'for', 'in', 'select']);

// Binaries that can actually publish a commit status. Anything else — `echo`,
// a commit message, a Python or Node snippet that only prints the endpoint —
// is inert text and must stay allowed (central Issue #75).
const HTTP_CLIENTS = new Set(['curl', 'gh', 'http', 'https', 'wget']);

// Name given to a command word this gate cannot resolve, such as `"$GH" pr
// merge 12` or `$(command -v gh) pr merge 12`. It contains a path separator, so
// `binaryName()` can never produce it from real input. Such a command is
// checked as if it were any of the binaries the policy cares about.
const UNRESOLVED_BINARY = 'unresolved/command';

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

// Options whose value is the request target rather than an operand. Without
// them `curl --url=https://api.github.com/repos/acme/example/statuses/abc` hides
// the endpoint inside a `--flag=value` word that the operand scan drops.
const URL_OPTIONS = {
  curl: new Set(['--url'])
};

// Options of the HTTP clients whose value is not the request target. They are
// consumed so a header or an output path is never read as the endpoint, and so
// the endpoint operand of `curl -H "$AUTH" "$URL"` stays visible.
const CLIENT_VALUE_OPTIONS = new Set([
  '-A', '-C', '-D', '-E', '-H', '-K', '-O', '-P', '-U', '-b', '-c', '-e', '-m', '-o', '-u', '-w', '-y', '-z',
  '--connect-timeout', '--cookie', '--directory-prefix', '--header', '--max-time', '--output',
  '--output-document', '--referer', '--retry', '--user', '--user-agent', '--write-out'
]);

const NO_OPTIONS = new Set();

/** @param {Record<string, Set<string>>} map */
function unionOptions(map) {
  return new Set(Object.values(map).flatMap(flags => [...flags]));
}

// An unresolved command word could be any client, so it is measured against
// every option table at once.
METHOD_OPTIONS[UNRESOLVED_BINARY] = unionOptions(METHOD_OPTIONS);
BODY_OPTIONS[UNRESOLVED_BINARY] = unionOptions(BODY_OPTIONS);
FILE_BODY_OPTIONS[UNRESOLVED_BINARY] = unionOptions(FILE_BODY_OPTIONS);
URL_OPTIONS[UNRESOLVED_BINARY] = unionOptions(URL_OPTIONS);

// `gh` uses Cobra, which accepts flags before the subcommand: `gh pr -R
// owner/name merge 12` is a merge. Flags that consume the next word must be
// skipped so the value is not read as the subcommand; flags of unknown arity
// are resolved both ways instead of guessed.
const GH_VALUE_OPTIONS = new Set([
  '-B', '-F', '-H', '-R', '-X', '-b', '-f', '-q', '-t',
  '--author-email', '--base', '--body', '--body-file', '--cache', '--field', '--header',
  '--hostname', '--input', '--jq', '--match-head-commit', '--method', '--raw-field',
  '--repo', '--subject', '--template'
]);

// Nested substitutions terminate because each level parses a strictly shorter
// string, but a hostile input can still nest far enough to be unreadable. Past
// this depth the input is treated as unresolved and denied instead of allowed.
const MAX_PARSE_DEPTH = 12;

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// A parameter expansion left in a token value: the text it produces is unknown.
const EXPANSION = /\$[A-Za-z_{]/;
// Placeholder left in a token value where a command substitution was consumed.
// The substitution body is parsed separately, but the surrounding token stays
// marked as text this gate cannot resolve.
const SUBSTITUTION = '$()';
// Any expansion or substitution left in a token value. A command word or a
// request body carrying one resolves to unknown text at run time, so both fail
// closed rather than being read literally (`"$GH" pr merge`, `-f state="$S"`).
const UNRESOLVED_TEXT = /\$\S|`/;
const WRAPPER_OPERAND = /^\d+(?:\.\d+)?[smhd]?$/i;
// The Codex role runner, matched against a command word or the script operand
// of an interpreter. Text that only mentions the path — a heredoc body, a note,
// a commit message — starts no role, so it must not be read as one (central
// Issue #75).
const ROLE_RUNNER = /(?:^|[\\/])run-role\.js$/i;
const STATUS_ENDPOINT = /(?:\/statuses\/|\/status$)/i;
// `name=value` request field, used to tell a payload that could set the commit
// status apart from one that writes another field (`-f body="$MSG"`).
const REQUEST_FIELD = /^([A-Za-z_][A-Za-z0-9_.-]*)=([\s\S]*)$/;
const STATE_FIELD_NAME = /^state$/i;
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
    // separately and leave a placeholder in the surrounding token value.
    if (ch === '$' && source[i + 1] === '(') {
      const span = readParenSpan(source, i + 1);
      substitutions.push(span.body);
      value += SUBSTITUTION;
      i = span.next;
      continue;
    }
    if (ch === '`') {
      const span = readBacktickSpan(source, i);
      substitutions.push(span.body);
      value += SUBSTITUTION;
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
 * substitutions are returned for separate parsing. A command another program
 * runs on behalf of the caller (`env -S`, `find -exec`) is an argument position
 * that still executes, so it joins the returned commands.
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
    // Reserved words are not the executed binary: `then gh pr merge 12` runs
    // `gh`, and a `for`/`case` clause head runs nothing at all.
    while (tokens.length && COMMAND_PREFIX_WORDS.has(tokens[0])) {
      tokens.shift();
      expanded.shift();
    }
    if (tokens.length && DATA_CLAUSE_WORDS.has(tokens[0])) {
      tokens = [];
      expanded = [];
    }
    if (tokens.length) {
      lastDetail = { tokens, expanded, stdin: stdinData, inputFromUnknown };
      commands.push(tokens);
      details.push(lastDetail);
      tokens = [];
      expanded = [];
    } else {
      lastDetail = null;
    }
    stdinData = [];
    tokenExpanded = false;
    inputFromUnknown = false;
  };
  // A substitution leaves a placeholder in the token it belongs to, so a
  // command word or an argument built from one stays visibly unresolved.
  const noteSubstitution = () => {
    token += SUBSTITUTION;
    started = true;
    tokenExpanded = true;
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
  // `details` grows while it is walked: a delegated command is analyzed like any
  // other, so `find . -exec env -S 'gh pr merge 12' \;` is followed to the end.
  // Each delegation drops at least its own binary and action word, so the token
  // lists get strictly shorter and the walk terminates.
  for (let index = 0; index < details.length; index += 1) {
    const detail = details[index];
    const delegatedScripts = [];
    nested.push(...shellScriptArguments(detail.tokens, delegatedScripts));
    const stdin = shellStdinScripts(detail);
    nested.push(...stdin.scripts);
    if (stdin.unresolved || executesDynamicScript(detail)) unresolved = true;
    for (const delegation of delegatedScripts) {
      nested.push(delegatedScriptLine(delegation));
      // `env -S "$CMD"` runs a command line this gate cannot read.
      if (UNRESOLVED_TEXT.test(delegation.script)) unresolved = true;
    }
    for (const delegated of delegatedCommands(detail.tokens)) {
      commands.push(delegated);
      details.push({ tokens: delegated, expanded: [], stdin: [], inputFromUnknown: false });
    }
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
 * assignment prefixes and wrapper commands are skipped.
 *
 * Only the command position is resolved, never the words after it: `env printf
 * '%s\n' gh pr merge` prints those words and merges nothing, so reading them as
 * a second execution would block an ordinary write (central Issue #75).
 *
 * Wrapper option arity is only known for the wrappers listed above. An option
 * that may still consume the following word leaves that word ambiguous, so both
 * readings are kept and an unrecognized `env --unknown VALUE gh pr merge` stays
 * fail-closed instead of resolving `VALUE` as the binary and allowing the merge.
 *
 * A command word carrying an expansion or a substitution (`"$GH" pr merge 12`)
 * names an unknown binary, so it resolves to {@link UNRESOLVED_BINARY} and its
 * arguments are still checked.
 *
 * A wrapper option that carries a whole command line is not an operand of the
 * wrapper: `env -S 'gh pr merge 12'` executes its value together with the words
 * that follow it, so both are reported through `delegated` and parsed as a
 * script of their own.
 *
 * @param {string[]} tokens
 * @param {{ script: string, rest: string[] }[]} [delegated] receives command
 *   lines a wrapper option runs
 * @returns {{ name: string, args: string[] }[]}
 */
function resolveExecutions(tokens, delegated) {
  const executions = [];
  const commandName = word => (UNRESOLVED_TEXT.test(word) ? UNRESOLVED_BINARY : binaryName(word));
  const addExecution = position => {
    executions.push({ name: commandName(tokens[position]), args: tokens.slice(position + 1) });
  };
  let index = 0;

  while (index < tokens.length) {
    if (ASSIGNMENT.test(tokens[index])) {
      index += 1;
      continue;
    }
    const name = commandName(tokens[index]);
    if (!COMMAND_WRAPPERS.has(name)) {
      addExecution(index);
      break;
    }

    const values = WRAPPER_VALUE_OPTIONS[name] || NO_OPTIONS;
    const scripts = SPLIT_STRING_OPTIONS[name] || NO_OPTIONS;
    // Options of unknown arity that may still swallow the following word. Each
    // one makes the next operand a command candidate as well as a value.
    let unknownOptions = 0;
    index += 1;
    while (index < tokens.length) {
      const argument = tokens[index];
      // `--` ends the wrapper's own options; the next word is the command.
      if (argument === '--') {
        index += 1;
        break;
      }
      if (argument.startsWith('-') && argument !== '-') {
        const separator = argument.indexOf('=');
        const flag = separator === -1 ? argument : argument.slice(0, separator);
        index += 1;
        // `-S value`, `--split-string=value` and the attached `-Svalue`. The
        // wrapper runs that command line with its remaining words appended, so
        // nothing is left for this token list to execute.
        if (scripts.has(flag)) {
          if (separator !== -1) noteScript(delegated, argument.slice(separator + 1), tokens.slice(index));
          else if (index < tokens.length) noteScript(delegated, tokens[index], tokens.slice(index + 1));
          return executions;
        }
        if (!flag.startsWith('--') && flag.length > 2 && scripts.has(flag.slice(0, 2))) {
          noteScript(delegated, flag.slice(2), tokens.slice(index));
          return executions;
        }
        if (values.has(flag)) {
          if (separator === -1 && index < tokens.length) index += 1;
          continue;
        }
        // An attached short form such as `-n5` or `-I{}` carries its own value.
        if (!flag.startsWith('--') && flag.length > 2 && values.has(flag.slice(0, 2))) continue;
        if (separator === -1) unknownOptions += 1;
        continue;
      }
      if (ASSIGNMENT.test(argument) || WRAPPER_OPERAND.test(argument)) {
        index += 1;
        continue;
      }
      // This word is the command unless an option of unknown arity takes it as
      // its value, so it is resolved as a command and the scan goes on.
      if (unknownOptions > 0) {
        unknownOptions -= 1;
        addExecution(index);
        index += 1;
        continue;
      }
      break;
    }
  }
  return executions;
}

function noteScript(delegated, script, rest) {
  if (delegated && script) delegated.push({ script, rest: rest || [] });
}

function quoteWord(word) {
  return `'${String(word).replace(/'/g, "'\\''")}'`;
}

/**
 * The command line a split-string option really runs. `env` appends its own
 * remaining operands to the words split out of the option value, so `env -Sgh
 * pr merge 12 --squash` runs `gh pr merge 12 --squash`. The trailing words are
 * quoted back on so each stays a single word when the line is parsed again.
 *
 * @param {{ script: string, rest: string[] }} delegation
 * @returns {string}
 */
function delegatedScriptLine({ script, rest }) {
  return rest.length ? `${script} ${rest.map(quoteWord).join(' ')}` : script;
}

/**
 * Token lists a command hands to another program to run as a command of its own.
 * Only programs that really execute those words are considered, so `echo -exec
 * gh pr merge 12` stays inert text (central Issue #75).
 *
 * @param {string[]} tokens
 * @returns {string[][]}
 */
function delegatedCommands(tokens) {
  const delegated = [];
  for (const execution of resolveExecutions(tokens)) {
    if (execution.name !== 'find' && execution.name !== UNRESOLVED_BINARY) continue;
    const args = execution.args;
    for (let index = 0; index < args.length; index += 1) {
      if (!FIND_EXEC_ACTIONS.has(args[index])) continue;
      const words = [];
      for (let cursor = index + 1; cursor < args.length && !FIND_EXEC_TERMINATORS.has(args[cursor]); cursor += 1) {
        words.push(args[cursor]);
      }
      if (words.length) delegated.push(words);
      index += words.length;
    }
  }
  return delegated;
}

/**
 * @param {string[]} tokens
 * @returns {{ name: string, args: string[] } | null} the primary execution
 */
function resolveExecution(tokens) {
  return resolveExecutions(tokens)[0] || null;
}

// An unresolved command word can name a shell, so `S=bash; "$S" -c <script>`
// is parsed like `bash -c <script>` instead of being read as opaque arguments.
function runsShellScripts(name) {
  return SHELL_BINARIES.has(name) || name === UNRESOLVED_BINARY;
}

/**
 * Scripts that a token list hands to another interpreter: `sh -c <script>` and
 * `eval <words>` both execute their operands, so they are parsed as commands.
 *
 * @param {string[]} tokens
 * @param {{ script: string, rest: string[] }[]} [delegated] receives command
 *   lines a wrapper option runs
 * @returns {string[]}
 */
function shellScriptArguments(tokens, delegated) {
  const scripts = [];
  for (const execution of resolveExecutions(tokens, delegated)) {
    if (execution.name === 'eval') {
      if (execution.args.length) scripts.push(execution.args.join(' '));
      continue;
    }
    if (!runsShellScripts(execution.name)) continue;
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
    if (!runsShellScripts(execution.name)) continue;
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
 * @param {{ tokens: string[], expanded: boolean[] }} detail
 * @returns {boolean}
 */
function executesDynamicScript({ tokens, expanded }) {
  const dynamic = (index, value) => Boolean(expanded[index]) || EXPANSION.test(String(value || ''));
  return resolveExecutions(tokens).some(execution => {
    const offset = tokens.length - execution.args.length;
    if (execution.name === 'eval') {
      return execution.args.some((argument, index) => dynamic(offset + index, argument));
    }
    if (!runsShellScripts(execution.name)) return false;
    const flag = shellScriptFlagIndex(execution.args);
    if (flag === -1 || flag + 1 >= execution.args.length) return false;
    return dynamic(offset + flag + 1, execution.args[flag + 1]);
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

// `@file`, `-` and an expanded value read the payload from elsewhere, so its
// content cannot be cleared here.
function isOpaqueBody(value) {
  return value === '' || value === '-' || value.startsWith('@') || UNRESOLVED_TEXT.test(value);
}

/**
 * True when the request body sent to a status endpoint cannot be read as a
 * non-success payload: a body file, no body in argv at all, or a value built by
 * an expansion (`-f state="$STATE"` posts `success` when `STATE=success`).
 *
 * @param {string[]} bodies values of the body options found in argv
 * @param {string[]} files values of the file-body options found in argv
 * @returns {boolean}
 */
function hasUnreadablePayload(bodies, files) {
  return files.length > 0 || bodies.length === 0 || bodies.some(isOpaqueBody);
}

/**
 * True when a request body could still carry `state=success` at run time: the
 * payload is not in argv, its field name is unknown, or the `state` field's own
 * value comes from an expansion. A readable field name that is not `state`
 * cannot publish a commit status, so `-f body="$MSG"` stays allowed.
 *
 * @param {string} value
 * @returns {boolean}
 */
function bodyMayCarrySuccess(value) {
  const field = REQUEST_FIELD.exec(value);
  if (field && !UNRESOLVED_TEXT.test(field[1])) {
    if (!STATE_FIELD_NAME.test(field[1])) return false;
    return isOpaqueBody(field[2]) || /^success$/i.test(field[2]);
  }
  return isOpaqueBody(value) || SUCCESS_FIELD.test(value) || SUCCESS_JSON.test(value);
}

/**
 * Positional operands of an invocation, with flag values consumed so a value is
 * never read as a subcommand or as the request target (`gh pr -R owner/name
 * merge 12`, `curl -H "$AUTH" "$URL"`).
 *
 * @param {string[]} args
 * @param {Set<string>} valueOptions flags known to take a separate value
 * @param {boolean} unknownTakesValue how a flag of unknown arity is resolved
 * @returns {string[]}
 */
function commandOperands(args, valueOptions, unknownTakesValue) {
  const operands = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--') {
      operands.push(...args.slice(index + 1));
      break;
    }
    if (!argument.startsWith('-') || argument === '-') {
      operands.push(argument);
      continue;
    }
    // `--flag=value` and attached short forms such as `-Rowner/name` carry
    // their own value; a separate word is consumed only when the flag takes one.
    if (argument.includes('=') || (!argument.startsWith('--') && argument.length > 2)) continue;
    if (valueOptions.has(argument) || unknownTakesValue) index += 1;
  }
  return operands;
}

// Both readings of an unknown flag's arity are checked, so an unrecognized
// `gh pr --unknown value merge 12` cannot shift `merge` out of view.
function ghOperandResolutions(args) {
  return [commandOperands(args, GH_VALUE_OPTIONS, false), commandOperands(args, GH_VALUE_OPTIONS, true)];
}

// The endpoint of a `curl`/`wget`/httpie call is an operand; the known options
// that take a value of their own are consumed so they are not mistaken for it.
function clientOperands(name, args) {
  const valueOptions = new Set([
    ...CLIENT_VALUE_OPTIONS,
    ...(METHOD_OPTIONS[name] || NO_OPTIONS),
    ...(BODY_OPTIONS[name] || NO_OPTIONS),
    ...(FILE_BODY_OPTIONS[name] || NO_OPTIONS),
    ...(URL_OPTIONS[name] || NO_OPTIONS)
  ]);
  return commandOperands(args, valueOptions, false);
}

// Everything a client call can send the request to: the operands plus the value
// of an explicit URL option, in both the separate and the attached form.
function clientTargets(name, args) {
  return [...clientOperands(name, args), ...optionValues(args, URL_OPTIONS[name] || NO_OPTIONS)];
}

/**
 * Compare an operand with the word the policy looks for. An operand built by an
 * expansion is unknown text: `P=pr; gh "$P" merge 12` merges just as much as the
 * literal form, so it matches anything instead of being compared literally.
 *
 * @param {string} operand
 * @param {string|RegExp} expected
 * @returns {boolean}
 */
function operandMatches(operand, expected) {
  if (UNRESOLVED_TEXT.test(operand)) return true;
  return typeof expected === 'string' ? operand === expected : expected.test(operand);
}

/**
 * How far the operands go towards naming a commit-status endpoint: `definite`
 * when a readable operand is one, `possible` when an operand is built by an
 * expansion and could be one at run time (`gh api "$URL"`), `no` otherwise.
 *
 * @param {string[][]} resolutions operand lists to consider
 * @returns {'definite'|'possible'|'no'}
 */
function statusEndpointReach(resolutions) {
  const operands = resolutions.flat();
  if (operands.some(operand => !UNRESOLVED_TEXT.test(operand) && STATUS_ENDPOINT.test(operand))) return 'definite';
  if (operands.some(operand => UNRESOLVED_TEXT.test(operand))) return 'possible';
  return 'no';
}

/**
 * Decide a mutation whose target may be a commit-status endpoint. A readable
 * endpoint keeps the strict reading: any payload that cannot be cleared as
 * non-success is denied. An endpoint this gate cannot read is only treated as a
 * status endpoint when the payload could still carry `state=success`, so
 * ordinary writes such as `gh api "$REPO/issues/1/comments" -f body="$MSG"`
 * stay allowed (central Issue #75).
 */
function publishesToStatusEndpoint(reach, bodies, files) {
  if (reach === 'definite') return hasSuccessValue(bodies) || hasUnreadablePayload(bodies, files);
  return files.length > 0 || bodies.some(bodyMayCarrySuccess);
}

function mergesPullRequest(tokens) {
  return resolveExecutions(tokens).some(execution => {
    if (execution.name !== 'gh' && execution.name !== UNRESOLVED_BINARY) return false;
    return ghOperandResolutions(execution.args).some(operands => operands.some((operand, index) => (
      index + 1 < operands.length && operandMatches(operand, 'pr') && operandMatches(operands[index + 1], 'merge')
    )));
  });
}

function ghPublishesSuccessStatus(args) {
  const resolutions = ghOperandResolutions(args);
  if (!resolutions.some(operands => operands.length > 0 && operandMatches(operands[0], 'api'))) return false;
  const reach = statusEndpointReach(resolutions);
  if (reach === 'no') return false;
  const bodies = optionValues(args, BODY_OPTIONS.gh);
  const files = optionValues(args, FILE_BODY_OPTIONS.gh);
  const methods = optionValues(args, METHOD_OPTIONS.gh);
  // `gh api` only sends a request body for field/input flags or an explicit
  // mutating method; a plain read of the statuses endpoint stays allowed.
  if (!bodies.length && !files.length && !methods.some(method => MUTATING_METHOD.test(method))) return false;
  return publishesToStatusEndpoint(reach, bodies, files);
}

function clientPublishesSuccessStatus(name, args) {
  const reach = statusEndpointReach([clientTargets(name, args)]);
  if (reach === 'no') return false;
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
  if (hasSuccessValue(operands)) return true;
  // An httpie item can also be the field that sets the state.
  const items = reach === 'definite' ? [] : operands.filter(operand => REQUEST_FIELD.test(operand));
  return publishesToStatusEndpoint(reach, bodies, files) || items.some(bodyMayCarrySuccess);
}

/**
 * True only when the token list runs an HTTP client that writes a success commit
 * status. Printing the same endpoint and payload (`echo`, a commit message, a
 * Python snippet) executes no request and stays allowed. A command word this
 * gate cannot resolve is measured as any of the clients.
 *
 * @param {string[]} tokens
 * @returns {boolean}
 */
function publishesSuccessStatus(tokens) {
  return resolveExecutions(tokens).some(execution => {
    if (execution.name === UNRESOLVED_BINARY) {
      return ghPublishesSuccessStatus(execution.args)
        || clientPublishesSuccessStatus(UNRESOLVED_BINARY, execution.args);
    }
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

/**
 * The operands an interpreter can take as the script it executes: the first one,
 * or the one after a `run`/`exec` subcommand. Both readings of an unknown flag's
 * arity are kept, so `node -r dotenv/config scripts/codex/run-role.js` is seen
 * whichever way `-r` is resolved.
 *
 * @param {string[]} args
 * @returns {string[]}
 */
function scriptOperands(args) {
  const candidates = [];
  for (const unknownTakesValue of [false, true]) {
    const operands = commandOperands(args, NO_OPTIONS, unknownTakesValue);
    const start = INTERPRETER_SUBCOMMANDS.has(operands[0]) ? 1 : 0;
    if (operands.length > start) candidates.push(operands[start]);
  }
  return candidates;
}

/**
 * True only when the token list actually starts the Codex role runner: the
 * runner is the command word (`scripts/codex/run-role.js review`), or it sits in
 * the script position of an interpreter (`node "$ROOT/…/run-role.js" review`).
 * A path this gate cannot read in either position could be the runner, so it
 * fails closed; the same path written as ordinary text — `echo`, a note, a
 * commit message — starts nothing and stays allowed (central Issue #75).
 *
 * @param {string[]} tokens
 * @returns {boolean}
 */
function runsCodexRole(tokens) {
  return resolveExecutions(tokens).some(execution => {
    if (execution.name === UNRESOLVED_BINARY || ROLE_RUNNER.test(execution.name)) return true;
    if (!SCRIPT_INTERPRETERS.has(execution.name)) return false;
    return scriptOperands(execution.args)
      .some(operand => ROLE_RUNNER.test(operand) || UNRESOLVED_TEXT.test(operand));
  });
}

function isCodexRoleRunner(command) {
  return executedCommands(command).some(runsCodexRole);
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
  const { commands, unresolved } = analyzeCommand(command);
  if (input.tool_input && input.tool_input.run_in_background === true && commands.some(runsCodexRole)) {
    return deny('必須Codex roleはforegroundで完了させてください。backgroundではClaude CLI終了時に子processと外部state証拠が失われます。実行するcommandやscript pathが展開で解決できない場合も、role起動と区別できないため同じく拒否します。');
  }
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
  run,
  runsCodexRole
};
