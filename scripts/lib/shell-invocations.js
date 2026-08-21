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
 * `$(...)`, backticks, `(...)`, `{ ...; }`, `eval` and `bash -c "..."`.
 *
 * A command hidden behind ordinary syntax is still a command, so reserved words
 * (`if gh pr merge; then`), negation (`! gh pr merge`), ANSI-C quoting
 * (`$'gh' pr merge`) and wrapper option values (`sudo -u user gh pr merge`)
 * resolve to the command that actually runs.
 *
 * What the parser cannot enumerate is reported by throwing, so callers fail
 * closed instead of reading an empty list as "nothing is executed here":
 * nesting past `MAX_DEPTH`, more simple commands than `MAX_INVOCATIONS`, a
 * command word that only exists after expansion (`$CMD pr merge`,
 * `$(printf %s gh) pr merge`) and `eval` of an expansion.
 *
 * A script file the command runs (`bash release.sh`) is outside this module:
 * its contents are not part of the string being judged.
 */

const MAX_DEPTH = 5;
const MAX_INVOCATIONS = 512;
const WRAPPERS = new Set(['command', 'doas', 'env', 'exec', 'ionice', 'nice', 'nohup', 'stdbuf', 'sudo', 'time', 'timeout', 'xargs']);
const SHELLS = new Set(['bash', 'dash', 'ksh', 'sh', 'zsh']);
// Reserved words introduce a command, they are not the command. Skipping them
// keeps `if`/`then`/`while`/`!` from hiding the simple command behind them.
const RESERVED = new Set(['!', ']]', 'coproc', 'do', 'done', 'elif', 'else', 'esac', 'fi', 'for', 'function', 'if', 'in', 'select', 'then', 'until', 'while', '{', '}']);
// These reserved words are followed by a word list that is not a command at
// all, so nothing after them may be read as one.
const CONDITIONAL = new Set(['[[', 'case']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const REDIRECTION = /^\d*(?:<{1,3}|>{1,2})&?-?/;
const ANSI_C_ESCAPES = {
  a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v',
  '\\': '\\', "'": "'", '"': '"', '?': '?'
};

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
  // Double quotes still expand `$…`, so the caller is told whether the word it
  // gets back is the literal text or only part of it. A command substitution is
  // reported separately: its output never appears in the returned text at all.
  let expanded = false;
  let substituted = false;
  for (; index < source.length; index += 1) {
    const character = source[index];
    if (character === '\\') {
      value += source[index + 1] || '';
      index += 1;
      continue;
    }
    if (character === '"') return { value, end: index, expanded, substituted };
    if (character === '$' || character === '`') expanded = true;
    if (character === '`') {
      const span = readBackticks(source, index + 1);
      nested.push(span.value);
      substituted = true;
      index = span.end;
      continue;
    }
    // Arithmetic expansion is not a command; command substitution is.
    if (character === '$' && source[index + 1] === '(' && source[index + 2] === '(') {
      index = readBalanced(source, index + 2, '(', ')').end;
      if (source[index + 1] === ')') index += 1;
      continue;
    }
    if (character === '$' && source[index + 1] === '(') {
      const span = readBalanced(source, index + 1, '(', ')');
      nested.push(span.value);
      substituted = true;
      index = span.end;
      continue;
    }
    value += character;
  }
  return { value, end: index, expanded, substituted };
}

// `$'...'` is a quoted word whose escapes bash decodes before running it, so
// `$'\x67h' pr merge` runs gh. Decoding here keeps the command word readable.
function readAnsiCQuoted(source, start) {
  let value = '';
  let index = start;
  while (index < source.length) {
    const character = source[index];
    if (character === "'") return { value, end: index };
    if (character !== '\\') {
      value += character;
      index += 1;
      continue;
    }
    const escape = source[index + 1];
    if (escape === undefined) return { value, end: index + 1 };
    const width = escape === 'x' ? 2 : escape === 'u' ? 4 : escape === 'U' ? 8 : 0;
    if (width) {
      const digits = (source.slice(index + 2, index + 2 + width).match(/^[0-9a-fA-F]+/) || [''])[0];
      const point = digits ? Number.parseInt(digits, 16) : NaN;
      if (Number.isInteger(point) && point <= 0x10ffff) {
        value += String.fromCodePoint(point);
        index += 2 + digits.length;
        continue;
      }
    }
    if (/^[0-7]$/.test(escape)) {
      const digits = source.slice(index + 1, index + 4).match(/^[0-7]+/)[0];
      value += String.fromCharCode(Number.parseInt(digits, 8) & 0xff);
      index += 1 + digits.length;
      continue;
    }
    value += Object.prototype.hasOwnProperty.call(ANSI_C_ESCAPES, escape) ? ANSI_C_ESCAPES[escape] : `\\${escape}`;
    index += 2;
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
  // A word whose text only exists after expansion cannot be read as a literal
  // later, so the expansion is recorded on the word itself. A command
  // substitution is recorded separately: unlike `$VAR`, nothing of it survives
  // into the word text, so `eval` of one cannot be re-parsed at all.
  const markExpanded = () => {
    if (!current) current = { value: '', quoted: false };
    current.expanded = true;
  };
  const markSubstituted = () => {
    markExpanded();
    current.substituted = true;
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

    if (character === '"' || (character === '$' && source[index + 1] === '"')) {
      const start = character === '"' ? index + 1 : index + 2;
      const span = readDoubleQuoted(source, start, nested);
      addWord(span.value, true);
      if (span.expanded) markExpanded();
      if (span.substituted) markSubstituted();
      index = span.end;
      continue;
    }

    if (character === '`') {
      const span = readBackticks(source, index + 1);
      nested.push(span.value);
      addWord('', false);
      markSubstituted();
      index = span.end;
      continue;
    }

    if (character === '$' && source[index + 1] === "'") {
      const span = readAnsiCQuoted(source, index + 2);
      addWord(span.value, true);
      index = span.end;
      continue;
    }

    if (character === '$' && source[index + 1] === '(' && source[index + 2] === '(') {
      addWord('', false);
      markExpanded();
      // Both parentheses of `$(( ))` belong to the expansion; leaving the outer
      // one behind would look like the `)` that closes a `case` pattern.
      index = readBalanced(source, index + 2, '(', ')').end;
      if (source[index + 1] === ')') index += 1;
      continue;
    }

    if (character === '$' && source[index + 1] === '(') {
      const span = readBalanced(source, index + 1, '(', ')');
      nested.push(span.value);
      addWord('', false);
      markSubstituted();
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

    // A `)` that survives the balanced readers above closes a `case` pattern,
    // so the words after it start a new command.
    if (character === '\n' || character === ';' || character === '&' || character === '|' || character === ')') {
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
    // An unquoted `$…` is a parameter expansion; the word text alone no longer
    // says which program runs.
    if (character === '$') markExpanded();
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
    // `[[ "$x" = y ]]` や `case "$mode" in` の続きはコマンド語ではない。ここを
    // コマンドとして読むと、普通の条件分岐まで解析不能として拒否してしまう。
    if (!word.quoted && CONDITIONAL.has(word.value)) return null;
    if (!word.quoted && RESERVED.has(word.value)) {
      index += 1;
      continue;
    }
    break;
  }
  const command = words[index];
  if (!command) return null;
  const name = commandName(command.value);
  // 実行時にしか決まらないコマンド語は「コマンドが無い」ではない。空リストとして
  // 返すとPolicyは黙って通してしまうため、解析不能として呼び出し元へ知らせる。
  // 展開が残るのはpathの前半だけ（`$HOME/bin/gh`）なら、プログラム名は読める。
  if (command.expanded && (!name || name.includes('$'))) {
    const shown = command.value.length > 40 ? `${command.value.slice(0, 40)}…` : command.value;
    throw new Error(`コマンド語${shown ? ` ${shown}` : ''}が展開後にしか決まりません`);
  }
  if (!name) return null;
  const args = words.slice(index + 1).map(word => word.value);
  return { command: name, args, text: [command.value, ...args].join(' '), index };
}

/**
 * Resolve one word list into the commands it can run.
 *
 * A wrapper hides the real command behind an unknown number of its own words:
 * `sudo -u user gh …` and `xargs -I{} gh …` both put `gh` past an option value.
 * Guessing one position is what let a merge slip through, so every following
 * word is offered as a command start instead. The extra entries name arguments
 * that are not commands, which is the safe direction for a policy to be wrong.
 */
function candidates(words) {
  const publish = ({ command, args, text }) => ({ command, args, text });
  const resolved = resolveInvocation(words);
  if (!resolved) return [];
  // `eval "$(…)"` executes text this parser never sees. `eval "gh pr merge $N"`
  // keeps its command word, so it is re-parsed below instead of refused.
  if (resolved.command === 'eval' && words.slice(resolved.index + 1).some(word => word.substituted)) {
    throw new Error('evalが実行する引数が展開後にしか決まりません');
  }
  if (!WRAPPERS.has(resolved.command)) return [publish(resolved)];
  const found = [publish(resolved)];
  for (let index = resolved.index + 1; index < words.length; index += 1) {
    let wrapped;
    try {
      wrapped = resolveInvocation(words.slice(index));
    } catch (error) {
      // A quoted word is one argument the wrapper passes on (`bash -c "…"`),
      // not a command word it could start; only an unquoted expansion can hide
      // a command in this position, and that stays unresolvable.
      if (words[index].quoted) continue;
      throw error;
    }
    if (wrapped) found.push(publish(wrapped));
  }
  return found;
}

// Short options combine in any order, so `-lc`, `-cx` and `-exc` all read the
// next word as the script. Requiring `c` last saw only some of the spellings of
// the same command, which is the direction that lets one through.
const SHELL_COMMAND_OPTION = /^-[A-Za-z]*c[A-Za-z]*$/;

function shellScript(invocation) {
  if (!SHELLS.has(invocation.command)) return null;
  const index = invocation.args.findIndex(arg => SHELL_COMMAND_OPTION.test(arg));
  return index >= 0 ? invocation.args[index + 1] || null : null;
}

/**
 * List the simple commands a Bash string executes.
 *
 * Throws when the string cannot be enumerated within the parser's limits.
 * Callers must treat that as "unknown", never as "no commands".
 *
 * @param {string} command
 * @param {number} [depth]
 * @param {{remaining: number}} [budget]
 * @returns {Array<{command: string, args: string[], text: string}>}
 */
function extractInvocations(command, depth = 0, budget = { remaining: MAX_INVOCATIONS }) {
  if (depth > MAX_DEPTH) throw new Error(`入れ子が深すぎます（上限 ${MAX_DEPTH}）`);
  const { tokens, nested } = lex(stripHeredocBodies(command));
  const invocations = [];
  const add = invocation => {
    if (budget.remaining <= 0) throw new Error(`コマンド数が上限（${MAX_INVOCATIONS}）を超えました`);
    budget.remaining -= 1;
    invocations.push(invocation);
  };
  let words = [];
  const flush = () => {
    if (words.length) {
      for (const invocation of candidates(words)) add(invocation);
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
    // `eval` runs its own arguments, so they are a script, not data.
    if (invocation.command === 'eval' && invocation.args.length) sources.push(invocation.args.join(' '));
  }
  // Nested frames charge the shared budget as they resolve, so their results
  // are collected here without being charged twice.
  for (const source of sources) invocations.push(...extractInvocations(source, depth + 1, budget));
  return invocations;
}

module.exports = { commandName, extractInvocations, stripHeredocBodies };
