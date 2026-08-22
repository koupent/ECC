#!/usr/bin/env node
'use strict';

function splitSegments(source) {
  const segments = [];
  let buffer = '';
  let quote = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) { buffer += character; escaped = false; continue; }
    if (character === '\\' && quote !== "'") { buffer += character; escaped = true; continue; }
    if (quote) {
      buffer += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; buffer += character; continue; }
    const pair = source.slice(index, index + 2);
    const groupingBoundary = '(){}'.includes(character) && !(character === '(' && source[index - 1] === '$');
    if (character === '\n' || character === ';' || character === '|' || character === '&' || pair === '&&' || pair === '||' || groupingBoundary) {
      if (buffer.trim()) segments.push(buffer.trim());
      buffer = '';
      if (pair === '&&' || pair === '||') index += 1;
      continue;
    }
    buffer += character;
  }
  if (buffer.trim()) segments.push(buffer.trim());
  return segments;
}

function tokenize(segment) {
  const tokens = [];
  let buffer = '';
  let quote = null;
  let escaped = false;
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index];
    if (escaped) { buffer += character; escaped = false; continue; }
    if (character === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote) {
      if (character === quote) quote = null;
      else buffer += character;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (/\s/.test(character)) {
      if (buffer) { tokens.push(buffer); buffer = ''; }
      continue;
    }
    buffer += character;
  }
  if (buffer) tokens.push(buffer);
  return tokens;
}

function substitutions(source) {
  const results = [];
  let quote = null;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "'" && quote !== '"') { quote = quote === "'" ? null : "'"; continue; }
    if (character === '"' && quote !== "'") { quote = quote === '"' ? null : '"'; continue; }
    if (quote === "'") continue;
    if (character === '`') {
      const end = source.indexOf('`', index + 1);
      if (end > index) { results.push(source.slice(index + 1, end)); index = end; }
      continue;
    }
    if (character === '$' && source[index + 1] === '(') {
      let depth = 1;
      let innerQuote = null;
      let end = index + 2;
      for (; end < source.length && depth > 0; end += 1) {
        const current = source[end];
        if ((current === '"' || current === "'") && (!innerQuote || innerQuote === current)) {
          innerQuote = innerQuote ? null : current;
          continue;
        }
        if (innerQuote === "'") continue;
        if (current === '(') depth += 1;
        else if (current === ')') depth -= 1;
      }
      if (depth === 0) { results.push(source.slice(index + 2, end - 1)); index = end - 1; }
    }
  }
  return results;
}

function findHeredocDeclaration(line) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length - 1; index += 1) {
    const character = line[index];
    if (escaped) { escaped = false; continue; }
    if (character === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character !== '<' || line[index + 1] !== '<') continue;
    const match = line.slice(index).match(/^<<-?\s*(?:(['"])([A-Za-z_][A-Za-z0-9_]*)\1|([A-Za-z_][A-Za-z0-9_]*))/);
    if (!match) continue;
    return {
      index,
      length: match[0].length,
      quoted: Boolean(match[1]),
      delimiter: match[2] || match[3]
    };
  }
  return null;
}

function withoutHeredocBodies(source) {
  const lines = String(source || '').split(/\r?\n/);
  const kept = [];
  let heredoc = null;
  for (const line of lines) {
    if (heredoc) {
      if (line.trim() === heredoc.delimiter) { heredoc = null; continue; }
      if (!heredoc.quoted) kept.push(...substitutions(line));
      continue;
    }
    const declaration = findHeredocDeclaration(line);
    if (!declaration) { kept.push(line); continue; }
    kept.push(`${line.slice(0, declaration.index)} ${line.slice(declaration.index + declaration.length)}`);
    heredoc = { quoted: declaration.quoted, delimiter: declaration.delimiter };
  }
  return kept.join('\n');
}

function unwrap(tokens) {
  let index = 0;
  const control = new Set(['if', 'then', 'elif', 'else', 'while', 'until', 'do', '!', '{', '(']);
  let advanced = true;
  while (advanced) {
    advanced = false;
    while (index < tokens.length) {
      const token = tokens[index];
      if (/^\d*(?:>>?|<<?|<>|>&|<&)\S+$/.test(token)) {
        index += 1;
        advanced = true;
        continue;
      }
      if (/^\d*(?:>>?|<<?|<>|>&|<&)$/.test(token)) {
        index += Math.min(2, tokens.length - index);
        advanced = true;
        continue;
      }
      break;
    }
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] || '')) { index += 1; advanced = true; }
    while (control.has(tokens[index])) { index += 1; advanced = true; }
    while (['command', 'builtin', 'exec', 'nohup'].includes(tokens[index])) {
      index += 1;
      while (/^-/.test(tokens[index] || '')) index += 1;
      advanced = true;
    }
    if ((tokens[index] || '').split(/[\\/]/).pop() === 'time') {
      index += 1;
      while (/^-/.test(tokens[index] || '')) index += 1;
      advanced = true;
    }
    if (tokens[index] === 'sudo') {
      index += 1;
      while (/^-/.test(tokens[index] || '')) {
        const option = tokens[index++];
        if (['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '--chdir'].includes(option)) index += 1;
      }
      advanced = true;
    }
    if (tokens[index] === 'env') {
      index += 1;
      while (/^-/.test(tokens[index] || '')) {
        const option = tokens[index++];
        if (['-u', '--unset', '-C', '--chdir', '-S', '--split-string'].includes(option)) index += 1;
      }
      advanced = true;
    }
  }
  return tokens.slice(index);
}

function executableInvocations(command) {
  const source = withoutHeredocBodies(command);
  const invocations = [];
  const visit = value => {
    for (const nested of substitutions(value)) visit(nested);
    for (const segment of splitSegments(value)) {
      const tokens = unwrap(tokenize(segment));
      if (!tokens.length) continue;
      const executable = tokens[0].split(/[\\/]/).pop().replace(/\.exe$/i, '');
      const args = tokens.slice(1);
      invocations.push({ executable, args, raw: segment });
      if (executable === 'eval' && args.length) visit(args.join(' '));
      if (['sh', 'bash', 'zsh', 'pwsh', 'powershell'].includes(executable)) {
        const scriptIndex = args.findIndex(arg => /^-[a-z]*c[a-z]*$/i.test(arg) || /^-(?:command)$/i.test(arg));
        if (scriptIndex >= 0 && args[scriptIndex + 1]) visit(args[scriptIndex + 1]);
      }
    }
  };
  visit(source);
  return invocations;
}

module.exports = { executableInvocations, splitSegments, substitutions, tokenize, withoutHeredocBodies };
