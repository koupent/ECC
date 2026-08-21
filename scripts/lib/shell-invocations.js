'use strict';

/**
 * Shell-aware extraction of the commands a Bash string actually executes.
 *
 * PreToolUse policies used to match patterns against the whole command string,
 * so a document that *describes* a command was indistinguishable from running
 * it: writing an Issue body through a heredoc, or passing it as a quoted
 * `--body`, tripped the same guard as the command itself.
 *
 * This module removes heredoc bodies, tokenizes with shell quoting rules, and
 * returns one entry per executed simple command — including the ones nested in
 * `$(...)`, backticks, `(...)`, `{ ...; }` and `bash -c "..."`.
 *
 * The goal is to describe what bash would execute, not to sandbox a hostile
 * operator: wrappers whose options take separate values (`sudo -u user cmd`)
 * resolve to that value instead of the wrapped command.
 */

const MAX_DEPTH = 5;
const WRAPPERS = new Set(['command', 'doas', 'env', 'exec', 'ionice', 'nice', 'nohup', 'stdbuf', 'sudo', 'time', 'xargs']);
const SHELLS = new Set(['bash', 'dash', 'ksh', 'sh', 'zsh']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const REDIRECTION = /^\d*(?:<{1,3}|>{1,2})&?-?/;

function readBackticks(source, start) {
  let value = '';
  let index = start;
  for (; index < source.length; index += 1) {
    const character = source[index];
    if (character === '\\') {
      value += source[index + 1] || '';
      index += 1;
      continue;
    }
    if (character === '`') return { value, end: index };
    value += character;
  }
  return { value, end: index };
}

function readBalanced(source, start, open, close) {
  let depth = 0;
  let value = '';
  let index = start;
  for (; index < source.length; index += 1) {
    const character = source[index];
    if (character === '\\') {
      value += character + (source[index + 1] || '');
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      const quote = character;
      value += character;
      index += 1;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === '\\' && quote === '"') {
          value += source[index] + (source[index + 1] || '');
          index += 2;
          continue;
        }
        value += source[index];
        index += 1;
      }
      value += source[index] || '';
      continue;
    }
    if (character === open) {
      depth += 1;
      if (depth === 1) continue;
    } else if (character === close) {
      depth -= 1;
      if (depth === 0) return { value, end: index };
    }
    value += character;
  }
  return { value, end: index };
}

function readDoubleQuoted(source, start, nested) {
  let value = '';
  let index = start;
  for (; index < source.length; index += 1) {
    const character = source[index];
    if (character === '\\') {
      value += source[index + 1] || '';
      index += 1;
      continue;
    }
    if (character === '"') return { value, end: index };
    if (character === '`') {
      const span = readBackticks(source, index + 1);
      nested.push(span.value);
      index = span.end;
      continue;
    }
    // Arithmetic expansion is not a command; command substitution is.
    if (character === '$' && source[index + 1] === '(' && source[index + 2] === '(') {
      index = readBalanced(source, index + 2, '(', ')').end;
      continue;
    }
    if (character === '$' && source[index + 1] === '(') {
      const span = readBalanced(source, index + 1, '(', ')');
      nested.push(span.value);
      index = span.end;
      continue;
    }
    value += character;
  }
  return { value, end: index };
}

function readHeredocDelimiter(source, start) {
  let index = start;
  let word = '';
  let quoted = false;
  while (index < source.length) {
    const character = source[index];
    if (character === '"' || character === "'") {
      quoted = true;
      index += 1;
      while (index < source.length && source[index] !== character) {
        word += source[index];
        index += 1;
      }
      index += 1;
      continue;
    }
    if (character === '\\') {
      quoted = true;
      index += 1;
      if (index < source.length) {
        word += source[index];
        index += 1;
      }
      continue;
    }
    if (/[\s;&|<>()]/.test(character)) break;
    word += character;
    index += 1;
  }
  if (!word) return null;
  // An unquoted delimiter is a plain word. Requiring that shape keeps
  // `$((1 << 2))`-style shifts from being read as heredoc openers.
  if (!quoted && !/^[A-Za-z0-9_.-]+$/.test(word)) return null;
  return { word, end: index };
}

function heredocOpeners(line) {
  const source = String(line || '');
  const openers = [];
  let quote = null;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '\\' && quote !== "'") {
      index += 1;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '$' && source[index + 1] === '(' && source[index + 2] === '(') {
      index = readBalanced(source, index + 2, '(', ')').end;
      continue;
    }
    if (character !== '<' || source[index + 1] !== '<') continue;
    if (source[index + 2] === '<') {
      index += 2;
      continue;
    }
    let cursor = index + 2;
    let stripTabs = false;
    if (source[cursor] === '-') {
      stripTabs = true;
      cursor += 1;
    }
    while (source[cursor] === ' ' || source[cursor] === '\t') cursor += 1;
    const delimiter = readHeredocDelimiter(source, cursor);
    if (!delimiter) {
      index += 1;
      continue;
    }
    openers.push({ word: delimiter.word, stripTabs });
    index = delimiter.end - 1;
  }
  return openers;
}

/**
 * Drop heredoc bodies, keeping the lines that bash actually executes.
 *
 * An unterminated heredoc swallows the rest of the input, which is also what
 * bash does: those lines are data for the pending redirection, not commands.
 *
 * @param {string} command
 * @returns {string}
 */
function stripHeredocBodies(command) {
  const lines = String(command || '').split('\n');
  const kept = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    kept.push(line);
    index += 1;
    for (const opener of heredocOpeners(line)) {
      while (index < lines.length) {
        const raw = lines[index].replace(/\r$/, '');
        const candidate = opener.stripTabs ? raw.replace(/^\t+/, '') : raw;
        index += 1;
        if (candidate === opener.word) break;
      }
    }
  }
  return kept.join('\n');
}

function lex(source) {
  const tokens = [];
  const nested = [];
  let current = null;

  const endWord = () => {
    if (current) tokens.push(current);
    current = null;
  };
  const addWord = (text, quoted) => {
    if (!current) current = { value: '', quoted: false };
    current.value += text;
    if (quoted) current.quoted = true;
  };
  const pushOperator = () => {
    endWord();
    tokens.push({ operator: true });
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];

    if (character === '\\') {
      const next = source[index + 1];
      index += 1;
      if (next === undefined) break;
      if (next !== '\n') addWord(next, true);
      continue;
    }

    if (character === "'") {
      let value = '';
      index += 1;
      while (index < source.length && source[index] !== "'") {
        value += source[index];
        index += 1;
      }
      addWord(value, true);
      continue;
    }

    if (character === '"') {
      const span = readDoubleQuoted(source, index + 1, nested);
      addWord(span.value, true);
      index = span.end;
      continue;
    }

    if (character === '`') {
      const span = readBackticks(source, index + 1);
      nested.push(span.value);
      addWord('', false);
      index = span.end;
      continue;
    }

    if (character === '$' && source[index + 1] === '(' && source[index + 2] === '(') {
      addWord('', false);
      index = readBalanced(source, index + 2, '(', ')').end;
      continue;
    }

    if (character === '$' && source[index + 1] === '(') {
      const span = readBalanced(source, index + 1, '(', ')');
      nested.push(span.value);
      addWord('', false);
      index = span.end;
      continue;
    }

    if (character === '(') {
      const span = readBalanced(source, index, '(', ')');
      nested.push(span.value);
      pushOperator();
      index = span.end;
      continue;
    }

    if (character === '\n' || character === ';' || character === '&' || character === '|') {
      pushOperator();
      continue;
    }

    if (character === ' ' || character === '\t' || character === '\r') {
      endWord();
      continue;
    }

    // `{` and `}` are reserved words only at the start of a word; a brace group
    // runs in the current shell, so its body stays in this token stream.
    if (!current && (character === '}' || (character === '{' && /\s/.test(source[index + 1] || '')))) {
      pushOperator();
      continue;
    }

    addWord(character, false);
  }

  endWord();
  return { tokens, nested };
}

function commandName(value) {
  return String(value || '')
    .split(/[\\/]/)
    .pop()
    .replace(/\.(?:exe|cmd|bat)$/i, '')
    .toLowerCase();
}

function resolveInvocation(words) {
  let index = 0;
  while (index < words.length) {
    const word = words[index];
    if (!word.quoted && ASSIGNMENT.test(word.value)) {
      index += 1;
      continue;
    }
    if (!word.quoted && REDIRECTION.test(word.value)) {
      const target = word.value.replace(REDIRECTION, '');
      index += target ? 1 : 2;
      continue;
    }
    break;
  }
  const command = words[index];
  if (!command || !command.value) return null;
  const args = words.slice(index + 1).map(word => word.value);
  return { command: commandName(command.value), args, text: [command.value, ...args].join(' ') };
}

function unwrap(invocation, words) {
  let current = invocation;
  let rest = words;
  for (let guard = 0; guard < 4 && current && WRAPPERS.has(current.command); guard += 1) {
    const start = rest.findIndex(word => commandName(word.value) === current.command);
    if (start < 0) break;
    rest = rest.slice(start + 1);
    while (rest.length && !rest[0].quoted && rest[0].value.startsWith('-')) rest = rest.slice(1);
    const wrapped = resolveInvocation(rest);
    if (!wrapped) break;
    current = wrapped;
  }
  return current;
}

function shellScript(invocation) {
  if (!SHELLS.has(invocation.command)) return null;
  const index = invocation.args.findIndex(arg => /^-[a-z]*c$/i.test(arg));
  return index >= 0 ? invocation.args[index + 1] || null : null;
}

/**
 * List the simple commands a Bash string executes.
 *
 * @param {string} command
 * @param {number} [depth]
 * @returns {Array<{command: string, args: string[], text: string}>}
 */
function extractInvocations(command, depth = 0) {
  if (depth > MAX_DEPTH) return [];
  const { tokens, nested } = lex(stripHeredocBodies(command));
  const invocations = [];
  let words = [];
  const flush = () => {
    if (words.length) {
      const invocation = unwrap(resolveInvocation(words), words);
      if (invocation) invocations.push(invocation);
    }
    words = [];
  };
  for (const token of tokens) {
    if (token.operator) flush();
    else words.push(token);
  }
  flush();

  const sources = [...nested];
  for (const invocation of invocations) {
    const script = shellScript(invocation);
    if (script) sources.push(script);
  }
  for (const source of sources) invocations.push(...extractInvocations(source, depth + 1));
  return invocations;
}

module.exports = { commandName, extractInvocations, stripHeredocBodies };
