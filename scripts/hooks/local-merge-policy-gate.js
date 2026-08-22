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

// Builtins that run the content of the file named by their first operand in the
// current shell. A path on disk keeps the treatment a script operand already
// gets — the file is not read here — but a generated script is denied.
const SOURCE_BUILTINS = new Set(['.', 'source']);

// Shell options that take a value of their own, so the word after them is not
// the script operand (`bash --rcfile init.sh -s`).
const SHELL_VALUE_OPTIONS = new Set(['-O', '+O', '--init-file', '--rcfile']);

// Operands that name stdin itself: the script still comes from the heredoc or
// the here-string, so it is parsed (`bash /dev/stdin <<EOF`).
const STDIN_OPERANDS = new Set(['-', '/dev/stdin', '/proc/self/fd/0']);

// Interpreters that execute the script file named by their first operand. The
// role runner is only started from that position: `echo scripts/codex/run-role.js`
// names the same path and starts nothing (central Issue #75).
const SCRIPT_INTERPRETERS = new Set(['bun', 'deno', 'node', 'nodejs', 'ts-node', 'tsx']);

// Subcommands those interpreters accept before the script path (`deno run app.ts`).
const INTERPRETER_SUBCOMMANDS = new Set(['exec', 'run']);

// Interpreters that run a script written inline in the command, or read from the
// data written into them. Their scripts are not shell, so they are not parsed;
// they are only searched for a child process that would run the policy commands.
const INLINE_SCRIPT_INTERPRETERS = new Set([
  'bun', 'deno', 'node', 'nodejs', 'perl', 'php', 'python', 'python2', 'python3', 'ruby', 'ts-node', 'tsx'
]);

// Options and subcommands whose value is such an inline script (`python3 -c`,
// `node -e`, `php -r`, `deno eval`).
const INLINE_SCRIPT_OPTIONS = new Set(['-c', '-e', '-E', '-p', '-r', '--eval', '--execute', '--print']);
const INLINE_SCRIPT_SUBCOMMANDS = new Set(['eval']);

// Calls that start a child process from such a script. The names are written out
// instead of matched loosely, so ordinary prose in a note — the text that made
// this gate misfire — cannot look like one (central Issue #75).
const SPAWN_API = new RegExp([
  'subprocess', 'os\\.system', 'os\\.popen', 'os\\.exec\\w*', 'os\\.spawn\\w*', 'pty\\.spawn',
  'commands\\.getoutput', 'child_process', 'execSync', 'execFileSync', 'spawnSync', 'execFile',
  'popen\\s*\\(', 'system\\s*\\(', 'passthru\\s*\\(', 'shell_exec', 'proc_open', 'qx[({\\[/|]',
  'Open3', 'IO\\.popen', 'Kernel\\.(?:system|exec|spawn)', 'Deno\\.(?:Command|run)', 'Bun\\.spawn',
  'execvp?e?\\b'
].join('|'));

// What such a child process would have to name for this gate to care. A script
// that starts child processes and also names a merge, the statuses endpoint or
// the role runner cannot be cleared by reading it, so it fails closed; one that
// names none of them is ordinary work and stays allowed (central Issue #75).
const POLICY_KEYWORD = /\bgh\b|\bpr[\s'",\]]+merge\b|\/statuses\/|run-role\.js/i;

// Programs whose operands are a command line they run themselves: `watch 'gh pr
// merge 12'` re-runs those words every couple of seconds.
const COMMAND_STRING_BINARIES = new Set(['watch']);
const COMMAND_STRING_VALUE_OPTIONS = {
  watch: new Set(['-n', '--interval'])
};

// Options whose value is a command line the program hands to a shell
// (`flock /tmp/lock -c 'gh pr merge 12'`).
const COMMAND_STRING_OPTIONS = {
  flock: new Set(['-c', '--command']),
  script: new Set(['-c', '--command'])
};

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

// Word that introduces a function definition (`function deploy { … }`).
const FUNCTION_KEYWORD = 'function';
// A name a function definition can carry. It holds no expansion and no shell
// metacharacter, so `f()` is told apart from a subshell or a command word this
// gate cannot read.
const FUNCTION_NAME = /^[A-Za-z0-9_.:+-]+$/;

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
    '-d', '-F', '--data', '--data-ascii', '--data-binary', '--data-raw', '--data-urlencode', '--form',
    '--form-string', '--json'
  ]),
  gh: new Set(['-F', '-f', '--field', '--raw-field']),
  wget: new Set(['--body-data', '--post-data'])
};

// Body options whose value is taken literally. Everywhere else a leading `@`
// names a file whose content becomes the payload, so the payload is not in
// argv: `gh api -F state=@state.txt` reads that file, while `gh api -f
// state=@state.txt` posts the text `@state.txt` and sets no success state.
// `--form-string` is curl's literal counterpart of `--form` and sends the value
// as written, so it is a body option that reads no file (central Issue #75).
const LITERAL_BODY_OPTIONS = {
  curl: new Set(['--data-raw', '--form-string']),
  gh: new Set(['-f', '--raw-field']),
  wget: new Set(['--body-data', '--post-data'])
};

// Body options that also read a file when the `@` follows a field name:
// `curl --data-urlencode state@state.txt` sends the content of that file as the
// `state` field, so the payload never appears in argv and fails closed.
const FILE_FIELD_BODY_OPTIONS = {
  curl: new Set(['--data-urlencode'])
};
// A body value whose `@` comes before any `=`: `@file` and `name@file` both name
// a file, while `name=@file` is the literal text `@file`.
const FILE_FIELD_REFERENCE = /^[^=@]*@/;

// Body options whose value is a urlencoded field list rather than a single
// field, so `-d 'context=ci&state=success'` is read field by field.
const FORM_BODY_OPTIONS = {
  curl: new Set(['-d', '--data', '--data-ascii', '--data-binary', '--data-raw', '--data-urlencode']),
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
// the endpoint operand of `curl -H "$AUTH" "$URL"` stays visible. Arity belongs
// to one client at a time: curl's `-O` writes to a remote-named file and takes
// no value while wget's `-O` names the output file, so a shared table let
// `curl -O <statuses URL>` swallow the endpoint (central Issue #75).
const HTTPIE_VALUE_OPTIONS = new Set([
  '-A', '-a', '-o', '-p',
  '--auth', '--auth-type', '--cert', '--cert-key', '--format-options', '--max-redirects', '--output',
  '--print', '--proxy', '--session', '--session-read-only', '--style', '--timeout', '--verify'
]);

const CLIENT_VALUE_OPTIONS = {
  curl: new Set([
    '-A', '-C', '-D', '-E', '-H', '-K', '-P', '-U', '-Y', '-b', '-c', '-e', '-m', '-o', '-u', '-w', '-x', '-y', '-z',
    '--cacert', '--capath', '--cert', '--connect-timeout', '--cookie', '--cookie-jar', '--dump-header', '--header',
    '--interface', '--key', '--limit-rate', '--max-filesize', '--max-redirs', '--max-time', '--oauth2-bearer',
    '--output', '--output-dir', '--proxy', '--proxy-user', '--referer', '--retry', '--user', '--user-agent',
    '--write-out'
  ]),
  wget: new Set([
    '-A', '-D', '-O', '-P', '-Q', '-R', '-T', '-U', '-e', '-i', '-o', '-t', '-w',
    '--accept', '--bind-address', '--ca-certificate', '--certificate', '--connect-timeout', '--directory-prefix',
    '--dns-timeout', '--domains', '--header', '--input-file', '--limit-rate', '--load-cookies', '--max-redirect',
    '--output-document', '--output-file', '--password', '--private-key', '--proxy-password', '--proxy-user',
    '--read-timeout', '--referer', '--reject', '--save-cookies', '--timeout', '--tries', '--user', '--user-agent',
    '--wait'
  ]),
  http: HTTPIE_VALUE_OPTIONS,
  https: HTTPIE_VALUE_OPTIONS
};

// The clients an unresolved command word could name. Every reading is kept
// instead of merging the tables, so one client's option arity cannot hide the
// endpoint another client would send the request to.
const CLIENT_NAMES = ['curl', 'wget', 'http'];

const NO_OPTIONS = new Set();

/** @param {Record<string, Set<string>>} map */
function unionOptions(map) {
  return new Set(Object.values(map).flatMap(flags => [...flags]));
}

// An unresolved command word could be any client, so it is measured against
// every option table at once. `LITERAL_BODY_OPTIONS` stays per client on
// purpose: an unknown client is read with no literal body option, so an `@file`
// payload fails closed instead of being read as the text of a file name.
METHOD_OPTIONS[UNRESOLVED_BINARY] = unionOptions(METHOD_OPTIONS);
BODY_OPTIONS[UNRESOLVED_BINARY] = unionOptions(BODY_OPTIONS);
FORM_BODY_OPTIONS[UNRESOLVED_BINARY] = unionOptions(FORM_BODY_OPTIONS);
FILE_FIELD_BODY_OPTIONS[UNRESOLVED_BINARY] = unionOptions(FILE_FIELD_BODY_OPTIONS);
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
// Placeholder left in the word a process substitution produces. The body runs
// and is parsed like any other substitution, while the word itself is a
// `/dev/fd` path whose content this gate cannot read. It keeps a `$`, so the
// word also stays unresolved text everywhere else.
const PROCESS_SUBSTITUTION = '$<proc>';
const PROCESS_SUBSTITUTION_TOKEN = /\$<proc>/;
// Any expansion or substitution left in a token value. A command word or a
// request body carrying one resolves to unknown text at run time, so both fail
// closed rather than being read literally (`"$GH" pr merge`, `-f state="$S"`).
const UNRESOLVED_TEXT = /\$\S|`/;
// Marker appended to an argument whose value comes from an unquoted expansion or
// substitution. Bash splits such a value into words at run time, so one written
// argument can become several: `ARGS='pr merge'; gh $ARGS 12` runs `gh pr merge
// 12`. The marker keeps a `$`, so a marked argument also stays unresolved text;
// input that happens to contain the marker is unresolved text as well and can
// therefore only make the decision stricter.
const SPLIT_MARK = '$<split>';
const SPLIT_TOKEN = /\$<split>/;
// `$@`, `$*` and `${files[@]}` are split into words even inside double quotes.
const SPLIT_EXPANSION = /\$[@*]|\$\{[^{}]*\[[@*]/;
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
// httpie request items. A data item makes the call a POST on its own, so
// `http <statuses URL> state=success` publishes a status with no method word:
// `name=value` is a string field, `name:=value` a raw JSON one and `name@path`
// an uploaded file. `name==value` is a query parameter and `Name:value` a
// header, and neither adds a body, so a plain read stays allowed. The name
// carries no path separator, so an endpoint operand is never read as a field.
const HTTPIE_DATA_ITEM = /^[A-Za-z0-9_.+-]+(?::=|=|@)/;
const HTTPIE_QUERY_ITEM = /^[A-Za-z0-9_.+-]+==/;
const HTTPIE_RAW_ITEM = /^([A-Za-z0-9_.+-]+):=([\s\S]*)$/;
const STATE_FIELD_NAME = /^state$/i;
const SUCCESS_STATE = /^success$/i;
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

// `{` opens a group when it is a word of its own. The character before it also
// closes a function definition in the compact form `f(){ gh pr merge 12;}`, so
// `)` belongs here: without it the brace is read as part of the command word and
// the body is never resolved as an execution.
function isBraceGroupOpen(source, index) {
  return /\s/.test(source[index + 1] || '') && (index === 0 || /[\s;|&()]/.test(source[index - 1]));
}

function isBraceGroupClose(source, index) {
  return index === 0 || /[\s;]/.test(source[index - 1]);
}

// The `()` of a function definition: an empty pair, spaces allowed inside.
// Returns the index after `)`, or -1 when the parenthesis opens something else.
function emptyParensEnd(source, index) {
  let cursor = index + 1;
  while (source[cursor] === ' ' || source[cursor] === '\t') cursor += 1;
  return source[cursor] === ')' ? cursor + 1 : -1;
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
 * that still executes, so it joins the returned commands. An argument whose
 * value goes through an unquoted expansion carries {@link SPLIT_MARK}, because
 * Bash turns such a value into several words before the command runs.
 *
 * Shell grammar also decides what does not execute: a `#` comment ends the line,
 * and a function body waits for a call, so neither is read as an execution.
 *
 * @param {string} source
 * @returns {{ commands: string[][], nested: string[], unresolved: boolean }}
 */
function tokenizeScript(source) {
  const details = [];
  const substitutions = [];
  const heredocs = [];
  // Open `{ … }` and `( … )` groups, and the function definitions whose bodies
  // they are. A command inside such a body is only executed when the function is
  // called, so it is recorded with the name that has to be called.
  const functionScopes = [];
  let groupDepth = 0;
  let pendingFunction = null;
  let tokens = [];
  // Parallel to `tokens`: whether the token was built from a substitution.
  let expanded = [];
  // Heredoc bodies and here-strings feeding this command's stdin.
  let stdinData = [];
  let tokenExpanded = false;
  let tokenSplits = false;
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
      // Word splitting only applies to the arguments the command receives.
      tokens.push(tokenSplits || SPLIT_EXPANSION.test(token) ? token + SPLIT_MARK : token);
      expanded.push(tokenExpanded);
    } else if (redirectTarget === 'stdin') {
      stdinData.push(token);
    }
    redirectTarget = null;
    tokenExpanded = false;
    tokenSplits = false;
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
      // The outermost enclosing definition: an inner function is only defined
      // once the outer body runs, so that is the name that has to be called.
      const fn = functionScopes.length ? functionScopes[0].name : null;
      lastDetail = { tokens, expanded, stdin: stdinData, inputFromUnknown, fn };
      details.push(lastDetail);
      tokens = [];
      expanded = [];
    } else {
      lastDetail = null;
    }
    stdinData = [];
    tokenExpanded = false;
    tokenSplits = false;
    inputFromUnknown = false;
  };
  // A substitution leaves a placeholder in the token it belongs to, so a
  // command word or an argument built from one stays visibly unresolved.
  const noteSubstitution = () => {
    token += SUBSTITUTION;
    started = true;
    tokenExpanded = true;
    tokenSplits = true;
  };
  // Consumes `>`, `>>`, `<`, `>|`, `<>`, `>&2`, and any `N` file-descriptor
  // prefix already accumulated in the current token.
  const startRedirection = index => {
    const operator = source[index];
    if (started && /^\d+$/.test(token)) {
      token = '';
      started = false;
      tokenExpanded = false;
      tokenSplits = false;
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
  // `{ … }` and `( … )` both delimit a function body, so either form opens and
  // closes a group the definition can be attached to.
  const openGroup = () => {
    groupDepth += 1;
    if (pendingFunction) {
      functionScopes.push({ name: pendingFunction, depth: groupDepth });
      pendingFunction = null;
    }
  };
  const closeGroup = () => {
    const scope = functionScopes[functionScopes.length - 1];
    if (scope && scope.depth === groupDepth) functionScopes.pop();
    if (groupDepth > 0) groupDepth -= 1;
  };
  // The name a `name()` or `function name` definition gives to the body that
  // follows. The words are consumed, because a definition executes nothing on
  // its own: `f() { gh pr merge 12; }` merges only once something calls `f`.
  const takeFunctionName = () => {
    const words = started ? tokens.concat([token]) : tokens;
    const name = words.length === 1
      ? words[0]
      : words.length === 2 && words[0] === FUNCTION_KEYWORD ? words[1] : null;
    if (!name || !FUNCTION_NAME.test(name)) return null;
    tokens = [];
    expanded = [];
    token = '';
    started = false;
    return name;
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
    // An unquoted parameter expansion: Bash splits its value into words before
    // the command runs, so the argument is marked as one that can become several.
    if (ch === '$') {
      token += ch;
      started = true;
      tokenSplits = true;
      i += 1;
      continue;
    }
    // A process substitution runs its body and hands the caller a `/dev/fd` path.
    // The body is parsed like any other substitution; the word it leaves behind
    // is an argument, so `source <(printf 'gh pr merge 12')` keeps its operand
    // instead of losing it to the redirection scan.
    if ((ch === '<' || ch === '>') && source[i + 1] === '(') {
      const span = readParenSpan(source, i + 1);
      substitutions.push(span.body);
      token += PROCESS_SUBSTITUTION;
      started = true;
      tokenExpanded = true;
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
    // `f()` opens a function definition; any other parenthesis opens a subshell.
    if (ch === '(') {
      const close = emptyParensEnd(source, i);
      const name = close === -1 ? null : takeFunctionName();
      if (name) {
        pendingFunction = name;
        i = close;
        continue;
      }
      endCommand();
      openGroup();
      i += 1;
      continue;
    }
    if (ch === ')') {
      endCommand();
      closeGroup();
      i += 1;
      continue;
    }
    if (ch === ';' || ch === '&') {
      endCommand();
      i += 1;
      continue;
    }
    if (ch === '{' && isBraceGroupOpen(source, i)) {
      endToken();
      // `function name { … }` names its body without a `()` of its own.
      if (tokens.length > 1 && tokens[0] === FUNCTION_KEYWORD) pendingFunction = takeFunctionName();
      endCommand();
      openGroup();
      i += 1;
      continue;
    }
    if (ch === '}' && isBraceGroupClose(source, i)) {
      endCommand();
      closeGroup();
      i += 1;
      continue;
    }
    // A comment runs to the end of the line and executes nothing, so
    // `git commit -m x  # gh pr merge 12` merges nothing (central Issue #75).
    if (ch === '#' && !started && !redirectTarget) {
      const end = source.indexOf('\n', i);
      i = end === -1 ? source.length : end;
      continue;
    }
    token += ch;
    started = true;
    i += 1;
  }
  endCommand();

  const nested = [...substitutions];
  let unresolved = false;
  // A body whose function is never called executes nothing; one left open by an
  // unbalanced group is read as executed instead of guessed at.
  const called = calledFunctions(details, functionScopes);
  const executed = details.filter(detail => !detail.fn || called.has(binaryName(detail.fn)));
  // `executed` grows while it is walked: a delegated command is analyzed like any
  // other, so `find . -exec env -S 'gh pr merge 12' \;` is followed to the end.
  // Each delegation drops at least its own binary and action word, so the token
  // lists get strictly shorter and the walk terminates.
  for (let index = 0; index < executed.length; index += 1) {
    const detail = executed[index];
    const delegatedScripts = [];
    nested.push(...shellScriptArguments(detail.tokens, delegatedScripts));
    const stdin = shellStdinScripts(detail);
    nested.push(...stdin.scripts);
    nested.push(...commandStringScripts(detail.tokens));
    const alias = ghAliasScripts(detail.tokens);
    nested.push(...alias.scripts);
    if (stdin.unresolved || executesDynamicScript(detail) || executesGeneratedScript(detail)) unresolved = true;
    // A script an interpreter runs inline is not shell: it is only denied when
    // it starts a child process that could run the policy commands.
    if (alias.unresolved || spawnsPolicyCommand(detail) || appendsUnknownWords(detail.tokens)) unresolved = true;
    for (const delegation of delegatedScripts) {
      nested.push(delegatedScriptLine(delegation));
      // `env -S "$CMD"` runs a command line this gate cannot read.
      if (UNRESOLVED_TEXT.test(delegation.script)) unresolved = true;
    }
    for (const delegated of delegatedCommands(detail.tokens)) {
      executed.push({ tokens: delegated, expanded: [], stdin: [], inputFromUnknown: false, fn: detail.fn });
    }
  }
  return { commands: executed.map(detail => detail.tokens), nested, unresolved };
}

/**
 * Names of the functions a script really calls. A definition only registers a
 * body; the body runs when the name is used as a command word, so an uncalled
 * `f() { gh pr merge 12; }` executes nothing and must stay allowed (central
 * Issue #75). A command word this gate cannot read could name any of them, and a
 * body whose group is never closed cannot be delimited, so both are read as
 * called. A definition made in one tool call and used in another is outside what
 * a per-command gate can see.
 *
 * @param {{ tokens: string[] }[]} details
 * @param {{ name: string }[]} openScopes definitions left unclosed by the input
 * @returns {Set<string>}
 */
function calledFunctions(details, openScopes) {
  const called = new Set(openScopes.map(scope => binaryName(scope.name)));
  for (const detail of details) {
    for (const execution of resolveExecutions(detail.tokens)) {
      if (execution.name !== UNRESOLVED_BINARY) {
        called.add(execution.name);
        continue;
      }
      // A command word this gate cannot read could name any of the definitions.
      for (const other of details) if (other.fn) called.add(binaryName(other.fn));
    }
  }
  return called;
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

// True when an argument is split into words at run time, so one written word can
// become several (`ARGS='pr merge'; gh $ARGS 12`).
function splitsIntoWords(word) {
  return SPLIT_TOKEN.test(String(word || ''));
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
 * @returns {{ name: string, args: string[], appendsInput: boolean }[]}
 *   `appendsInput` marks an execution whose command line is completed by words
 *   read from stdin, as `xargs` does.
 */
function resolveExecutions(tokens, delegated) {
  const executions = [];
  const commandName = word => (UNRESOLVED_TEXT.test(word) ? UNRESOLVED_BINARY : binaryName(word));
  // `xargs` appends the words it reads from stdin to the command line, so the
  // execution it starts has arguments that are not in argv.
  let appendsInput = false;
  const addExecution = position => {
    executions.push({ name: commandName(tokens[position]), args: tokens.slice(position + 1), appendsInput });
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

    if (name === 'xargs') appendsInput = true;
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
 * Command lines a program runs as text instead of as argv: `watch 'gh pr merge
 * 12'` re-runs those words on a timer, and `flock /tmp/lock -c '…'` hands its
 * value to a shell. Both readings of an unknown flag's arity are kept, so an
 * option this gate does not know cannot shift the command line out of view.
 *
 * @param {string[]} tokens
 * @returns {string[]}
 */
function commandStringScripts(tokens) {
  const scripts = [];
  for (const execution of resolveExecutions(tokens)) {
    const options = COMMAND_STRING_OPTIONS[execution.name];
    if (options) scripts.push(...optionValues(execution.args, options));
    if (!COMMAND_STRING_BINARIES.has(execution.name)) continue;
    const values = COMMAND_STRING_VALUE_OPTIONS[execution.name] || NO_OPTIONS;
    for (const unknownTakesValue of [false, true]) {
      const operands = commandOperands(execution.args, values, unknownTakesValue);
      if (operands.length) scripts.push(operands.join(' '));
    }
  }
  return scripts.filter(Boolean);
}

/**
 * Command lines stored by `gh alias set`. gh runs them later under the alias
 * name, so `gh alias set m 'pr merge'` writes a merge one call ahead of time and
 * is read as one. A shell alias keeps its `!` line as a script, and any other
 * expansion is gh's own arguments; both readings are parsed, because the form is
 * also chosen by a `--shell` flag. `gh alias import` takes its aliases from a
 * file this gate cannot read and fails closed. An alias created before this
 * command is outside what a per-command gate can see.
 *
 * @param {string[]} tokens
 * @returns {{ scripts: string[], unresolved: boolean }}
 */
function ghAliasScripts(tokens) {
  const scripts = [];
  let unresolved = false;
  for (const execution of resolveExecutions(tokens)) {
    if (execution.name !== 'gh' && execution.name !== UNRESOLVED_BINARY) continue;
    for (const operands of ghOperandResolutions(execution.args)) {
      if (!operands.length || !operandMatches(operands[0], 'alias')) continue;
      const action = operands[1] || '';
      if (operandMatches(action, 'import')) unresolved = true;
      if (!operandMatches(action, 'set') || !operands[3]) continue;
      const line = operands[3].startsWith('!') ? operands[3].slice(1) : operands[3];
      scripts.push(line, `gh ${line}`);
    }
  }
  return { scripts, unresolved };
}

/**
 * True when `xargs` appends words this gate cannot read to a `gh` invocation
 * whose command group or subcommand is still open: `echo 'pr merge 12' | xargs
 * gh` merges, while `echo 12 | xargs gh pr view` can only add an operand to a
 * read whose subcommand is already written out.
 *
 * @param {string[]} tokens
 * @returns {boolean}
 */
function appendsUnknownWords(tokens) {
  return resolveExecutions(tokens).some(execution => {
    if (!execution.appendsInput) return false;
    if (execution.name !== 'gh' && execution.name !== UNRESOLVED_BINARY) return false;
    return ghOperandResolutions(execution.args).some(operands => operands.length < 2);
  });
}

/**
 * True when a command runs a script inline in an interpreter that is not a
 * shell — `python3 -c`, `node -e`, or a heredoc fed to either — and that script
 * both starts a child process and names a command this policy reserves. Such a
 * script is not shell, so it cannot be parsed here and fails closed. A script
 * that starts no child process, or that names none of those commands, is
 * ordinary work: the memory note this gate used to block writes `gh pr merge`
 * as text and spawns nothing, so it stays allowed (central Issue #75).
 *
 * @param {{ tokens: string[], stdin: string[] }} detail
 * @returns {boolean}
 */
function spawnsPolicyCommand({ tokens, stdin }) {
  return inlineInterpreterScripts(tokens, stdin)
    .some(script => SPAWN_API.test(script) && POLICY_KEYWORD.test(script));
}

function inlineInterpreterScripts(tokens, stdin) {
  const scripts = [];
  for (const execution of resolveExecutions(tokens)) {
    if (!INLINE_SCRIPT_INTERPRETERS.has(execution.name)) continue;
    scripts.push(...optionValues(execution.args, INLINE_SCRIPT_OPTIONS));
    const operands = commandOperands(execution.args, NO_OPTIONS, false);
    if (operands.length > 1 && INLINE_SCRIPT_SUBCOMMANDS.has(operands[0])) scripts.push(operands[1]);
    // A heredoc or a here-string is the interpreter's script only when it reads
    // one from stdin; otherwise it is input data of the script it was given.
    if (interpreterReadsStdin(execution.args)) scripts.push(...(stdin || []));
  }
  return scripts;
}

/**
 * True when an interpreter takes its script from the data written into it: it
 * has no script operand at all, or its first operand names stdin itself
 * (`python3 - <<'PY'`). A readable operand names the script on disk, so the
 * heredoc is that script's input data rather than its text and a note written
 * through `python3 tools/write-note.py <<'EOF'` keeps its words — the same
 * treatment `bash script.sh <<'EOF'` already gets (central Issue #75). An
 * operand that only appears in one reading of an unknown flag's arity leaves the
 * script source ambiguous, so the data is read as a script instead.
 *
 * @param {string[]} args
 * @returns {boolean}
 */
function interpreterReadsStdin(args) {
  const operands = scriptOperands(args);
  if (operands.length < 2) return true;
  return operands.some(operand => STDIN_OPERANDS.has(operand) || UNRESOLVED_TEXT.test(operand));
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
 * Where a shell invocation takes its script from: `stdin` when it has no operand
 * at all, when `-s` turns every operand into a positional parameter (`bash -s
 * marker <<EOF`), or when the first operand names stdin itself (`bash - <<EOF`,
 * `bash /dev/stdin <<EOF`). Any other first operand is the script file, which is
 * not read here.
 *
 * @param {string[]} args
 * @returns {{ stdin: boolean, operand: string }}
 */
function shellScriptSource(args) {
  let optionsEnded = false;
  for (let index = 0; index < args.length; index += 1) {
    // The word-splitting marker is not part of the option letters.
    const argument = args[index].replace(SPLIT_TOKEN, '');
    if (!optionsEnded && argument === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && argument.length > 1 && (argument[0] === '-' || argument[0] === '+')) {
      // `-s` reads the script from stdin, on its own or inside a group (`-es`).
      if (!argument.startsWith('--') && argument.includes('s')) return { stdin: true, operand: '' };
      const separator = argument.indexOf('=');
      const flag = separator === -1 ? argument : argument.slice(0, separator);
      if (separator === -1 && SHELL_VALUE_OPTIONS.has(flag)) index += 1;
      continue;
    }
    return { stdin: STDIN_OPERANDS.has(argument), operand: argument };
  }
  return { stdin: true, operand: '' };
}

function shellReadsStdin(args) {
  return shellScriptSource(args).stdin;
}

// The file `source` and `.` execute: their first operand, options aside.
function sourceScriptOperand(args) {
  for (const argument of args) {
    if (argument === '--') continue;
    return argument;
  }
  return '';
}

/**
 * True when a command executes a script whose text comes from a process
 * substitution: `source <(printf 'gh pr merge 12 --squash')` and `bash <(...)`
 * run words this gate never sees, since the body only prints them. Such input is
 * unresolved and denied. A plain path keeps its previous treatment — the file is
 * not read here — so `source .venv/bin/activate` stays allowed.
 *
 * @param {{ tokens: string[] }} detail
 * @returns {boolean}
 */
function executesGeneratedScript({ tokens }) {
  return resolveExecutions(tokens).some(execution => {
    if (SOURCE_BUILTINS.has(execution.name)) {
      return PROCESS_SUBSTITUTION_TOKEN.test(sourceScriptOperand(execution.args));
    }
    if (!runsShellScripts(execution.name)) return false;
    // A `-c` script is read directly; the operands after it are not executed.
    if (shellScriptFlagIndex(execution.args) !== -1) return false;
    return PROCESS_SUBSTITUTION_TOKEN.test(shellScriptSource(execution.args).operand);
  });
}

/**
 * Scripts a shell reads from stdin instead of from `-c`: `bash <<'EOF' ... EOF`
 * and `bash <<< "gh pr merge 12"` both execute their data, so it is parsed as a
 * command. `source /dev/stdin <<EOF` runs its data the same way. When the same
 * shell is fed by a pipe or a file redirection the script text is unknown and
 * the input is unresolved. A shell given a script file operand keeps its
 * previous treatment: the file is not read here.
 *
 * @param {{ tokens: string[], stdin: string[], inputFromUnknown: boolean }} detail
 * @returns {{ scripts: string[], unresolved: boolean }}
 */
function shellStdinScripts({ tokens, stdin, inputFromUnknown }) {
  const scripts = [];
  let unresolved = false;
  for (const execution of resolveExecutions(tokens)) {
    // `source /dev/stdin <<EOF` runs its heredoc just as a shell does.
    const sourcing = SOURCE_BUILTINS.has(execution.name);
    if (!sourcing && !runsShellScripts(execution.name)) continue;
    if (!sourcing && shellScriptFlagIndex(execution.args) !== -1) continue;
    // A script operand this gate cannot read could name stdin itself, so data
    // written into the command is parsed as well. A file or a pipe behind such
    // an operand stays the caller's own script and is not guessed at.
    const opaqueOperand = stdin.length > 0 && execution.args.some(argument => UNRESOLVED_TEXT.test(argument));
    const readsStdin = sourcing
      ? STDIN_OPERANDS.has(sourceScriptOperand(execution.args))
      : shellReadsStdin(execution.args);
    if (!readsStdin && !opaqueOperand) continue;
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

/**
 * Request bodies found in argv, each with how its option reads the value:
 * `literal` when a leading `@` is data rather than a file name, `form` when the
 * value is a urlencoded field list rather than a single field, `fileField` when
 * `name@path` also reads the payload from a file.
 *
 * @param {string} name
 * @param {string[]} args
 * @returns {{ value: string, literal: boolean, form: boolean, fileField: boolean }[]}
 */
function requestBodies(name, args) {
  const all = BODY_OPTIONS[name] || NO_OPTIONS;
  const literal = LITERAL_BODY_OPTIONS[name] || NO_OPTIONS;
  const form = FORM_BODY_OPTIONS[name] || NO_OPTIONS;
  const fileField = FILE_FIELD_BODY_OPTIONS[name] || NO_OPTIONS;
  const bodies = [];
  for (const flag of all) {
    for (const value of optionValues(args, new Set([flag]))) {
      bodies.push({ value, literal: literal.has(flag), form: form.has(flag), fileField: fileField.has(flag) });
    }
  }
  return bodies;
}

/**
 * How a JSON request body reads: `success` when it sets the commit state to
 * success, `unreadable` when it looks like JSON but cannot be decoded, `no`
 * otherwise. The decision is made on the decoded data, so a field name or a
 * value written with JSON escapes cannot pass as text that matches nothing
 * (central Issue #75).
 *
 * @param {string} value
 * @returns {'success'|'unreadable'|'no'}
 */
function jsonBodyReading(value) {
  const text = String(value).trim();
  if (!text.startsWith('{') && !text.startsWith('[')) return 'no';
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'unreadable';
  }
  return carriesSuccessState(parsed) ? 'success' : 'no';
}

function carriesSuccessState(node) {
  if (Array.isArray(node)) return node.some(carriesSuccessState);
  if (!node || typeof node !== 'object') return false;
  return Object.keys(node).some(key => {
    const value = node[key];
    if (STATE_FIELD_NAME.test(key) && typeof value === 'string' && SUCCESS_STATE.test(value)) return true;
    return carriesSuccessState(value);
  });
}

// True when a readable value sets the commit state to success.
function valueCarriesSuccess(value) {
  return SUCCESS_FIELD.test(value) || SUCCESS_JSON.test(value) || jsonBodyReading(value) === 'success';
}

// `@file`, `-` and an expanded value read the payload from elsewhere, so its
// content cannot be cleared here. An option that takes its value literally
// sends the text itself, so `@` starts no file read there.
function isOpaqueBody(value, literal) {
  if (value === '' || UNRESOLVED_TEXT.test(value)) return true;
  return !literal && (value === '-' || value.startsWith('@'));
}

/**
 * True when a request body could still carry `state=success` at run time: the
 * payload is not in argv, its field name is unknown, or the `state` field's own
 * value comes from an expansion or from a file. A readable field name that is
 * not `state` cannot publish a commit status, so `-f body="$MSG"` stays allowed.
 * A urlencoded body is read field by field, so `-d 'context=ci&state=success'`
 * is not mistaken for a single `context` field.
 *
 * @param {{ value: string, literal: boolean, form: boolean, fileField: boolean }} body
 * @returns {boolean}
 */
function bodyMayCarrySuccess(body) {
  const value = String(body.value);
  // `--data-urlencode state@state.txt` sends the content of that file as the
  // field value, so the payload is not in argv and cannot be cleared.
  if (body.fileField && FILE_FIELD_REFERENCE.test(value)) return true;
  const parts = body.form ? value.split('&') : [];
  const fields = parts.length > 1 && parts.every(part => REQUEST_FIELD.test(part)) ? parts : [value];
  return fields.some(field => fieldMayCarrySuccess(field, body.literal));
}

function fieldMayCarrySuccess(value, literal) {
  const field = REQUEST_FIELD.exec(value);
  if (field && !UNRESOLVED_TEXT.test(field[1])) {
    if (!STATE_FIELD_NAME.test(field[1])) return false;
    return isOpaqueBody(field[2], literal) || SUCCESS_STATE.test(field[2]);
  }
  return isOpaqueBody(value, literal) || valueCarriesSuccess(value) || jsonBodyReading(value) === 'unreadable';
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
// A command word this gate cannot resolve could name any of the clients, so
// every client's arity is read separately instead of merged into one table.
function clientOperandResolutions(name, args) {
  const clients = name === UNRESOLVED_BINARY ? CLIENT_NAMES : [name];
  return clients.map(client => commandOperands(args, new Set([
    ...(CLIENT_VALUE_OPTIONS[client] || NO_OPTIONS),
    ...(METHOD_OPTIONS[client] || NO_OPTIONS),
    ...(BODY_OPTIONS[client] || NO_OPTIONS),
    ...(FILE_BODY_OPTIONS[client] || NO_OPTIONS),
    ...(URL_OPTIONS[client] || NO_OPTIONS)
  ]), false));
}

// Everything a client call can send the request to: the operands of every
// reading plus the value of an explicit URL option, separate or attached.
function clientTargets(name, args) {
  return [...clientOperandResolutions(name, args), optionValues(args, URL_OPTIONS[name] || NO_OPTIONS)];
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
 * endpoint keeps the strict reading: the request is denied unless every body in
 * argv is readable and writes a field other than the commit state. An endpoint
 * this gate cannot read is treated the same way once a payload could still
 * carry `state=success`, so ordinary writes such as `gh api
 * "$REPO/issues/1/comments" -f body="$MSG"` stay allowed (central Issue #75).
 */
function publishesToStatusEndpoint(reach, bodies, files) {
  // A body read from a file never appears in argv, so it cannot be cleared.
  if (files.length > 0) return true;
  if (reach === 'definite' && bodies.length === 0) return true;
  return bodies.some(bodyMayCarrySuccess);
}

// `gh` prints help instead of running the subcommand as soon as it is asked for,
// so `gh pr merge 12 --help` merges nothing.
const GH_HELP_OPTIONS = new Set(['-h', '--help']);

function ghRequestsHelp(args) {
  return args.some(argument => GH_HELP_OPTIONS.has(String(argument).replace(SPLIT_TOKEN, '')));
}

function mergesPullRequest(tokens) {
  return resolveExecutions(tokens).some(execution => {
    if (execution.name !== 'gh' && execution.name !== UNRESOLVED_BINARY) return false;
    if (ghRequestsHelp(execution.args)) return false;
    return ghOperandResolutions(execution.args).some(operands => (
      // `gh` dispatches on its first two operands, the command group and the
      // subcommand: `gh help pr merge` prints the help page of the `help` group
      // and merges nothing, so `pr merge` further along is not an execution
      // (central Issue #75). An unquoted expansion in the group position is
      // split into words at run time — `ARGS='pr merge'; gh $ARGS 12` runs the
      // merge with a single written operand — so that reading fails closed.
      splitsIntoWords(operands[0]) || (
        operands.length > 1 && operandMatches(operands[0], 'pr') && operandMatches(operands[1], 'merge')
      )
    ));
  });
}

function ghPublishesSuccessStatus(args) {
  if (ghRequestsHelp(args)) return false;
  const resolutions = ghOperandResolutions(args);
  if (!resolutions.some(operands => operands.length > 0 && operandMatches(operands[0], 'api'))) return false;
  const reach = statusEndpointReach(resolutions);
  if (reach === 'no') return false;
  const bodies = requestBodies('gh', args);
  const files = optionValues(args, FILE_BODY_OPTIONS.gh);
  const methods = optionValues(args, METHOD_OPTIONS.gh);
  // `gh api` only sends a request body for field/input flags or an explicit
  // mutating method; a plain read of the statuses endpoint stays allowed.
  if (!bodies.length && !files.length && !methods.some(method => MUTATING_METHOD.test(method))) return false;
  return publishesToStatusEndpoint(reach, bodies, files);
}

function clientPublishesSuccessStatus(name, args) {
  const reach = statusEndpointReach(clientTargets(name, args));
  if (reach === 'no') return false;
  const bodies = requestBodies(name, args);
  const files = optionValues(args, FILE_BODY_OPTIONS[name] || NO_OPTIONS);
  const methods = optionValues(args, METHOD_OPTIONS[name] || NO_OPTIONS);
  // httpie takes the method and `key=value` items as operands.
  const operands = args.filter(argument => !argument.startsWith('-'));
  const items = operands.filter(operand => !HTTPIE_QUERY_ITEM.test(operand) && HTTPIE_DATA_ITEM.test(operand));
  const mutating = bodies.length > 0
    || files.length > 0
    || methods.some(method => MUTATING_METHOD.test(method))
    || operands.some(operand => MUTATING_METHOD.test(operand))
    // A data item is a request body, and httpie sends it as a POST without any
    // method word of its own. A command word this gate cannot resolve can name
    // httpie, so the same reading applies to it (central Issue #75).
    || (mayBeHttpie(name) && items.length > 0);
  if (!mutating) return false;
  if (operands.some(valueCarriesSuccess)) return true;
  // An httpie item can also be the field that sets the state.
  const fields = reach === 'definite' ? [] : items.map(httpieItemBody);
  return publishesToStatusEndpoint(reach, bodies, files) || fields.some(bodyMayCarrySuccess);
}

function mayBeHttpie(name) {
  return name === 'http' || name === 'https' || name === UNRESOLVED_BINARY;
}

// An httpie data item read as a request body. `state:=success` is the raw JSON
// form of `state=success`, and a value written `@path` is read from that file.
function httpieItemBody(item) {
  const raw = HTTPIE_RAW_ITEM.exec(item);
  return { value: raw ? `${raw[1]}=${raw[2]}` : item, literal: false, form: false, fileField: true };
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
    return deny('実行内容を確認できないコマンドは許可できません。生成した文字列をそのままscriptとして実行する形（eval・sh -c・shellへのpipe・process substitutionのsource）や、python/nodeなどのinline scriptから子processでghを起動する形を避け、実行するコマンドを直接記述してください。');
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
