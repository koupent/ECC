#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../codex/config');
const { deliveryWorkspace, readState, recordIncident, resolveSessionId, writeState } = require('../codex/runtime-state');

// worktreeの外で走らせるとDeliveryのbranchではなく共有ツリーを変更してしまうGit操作。
// 判定は読み取り側を列挙するfail-closeにする。書き込み側を列挙すると、列挙から漏れた
// `git mv` のようなsubcommandがそのまま共有ツリーへ届いてしまう。
const GIT_READ_SUBCOMMANDS = new Set([
  'blame', 'cat-file', 'check-attr', 'check-ignore', 'check-mailmap', 'check-ref-format',
  'count-objects', 'describe', 'diff', 'diff-files', 'diff-index', 'diff-tree', 'for-each-ref',
  'grep', 'help', 'log', 'ls-files', 'ls-remote', 'ls-tree', 'merge-base', 'name-rev',
  'rev-list', 'rev-parse', 'shortlog', 'show', 'show-branch', 'show-ref', 'status', 'var',
  'verify-commit', 'verify-tag', 'version', 'whatchanged'
]);
// subcommand単位では書き込みもするが、引数がこの列挙だけなら一覧表示しかしない形。
// 引数にoperandを取る形は読み取りだと確認できないので対象にしない。
const GIT_READ_ONLY_FORMS = new Map([
  ['branch', new Set(['', '-a', '--all', '-r', '--remotes', '-l', '--list', '-v', '-vv', '--verbose', '--show-current'])],
  ['config', new Set(['-l', '--list'])],
  ['reflog', new Set(['show'])],
  ['remote', new Set(['', '-v', '--verbose'])],
  ['stash', new Set(['list'])],
  ['submodule', new Set(['', 'status'])],
  ['tag', new Set(['', '-l', '--list', '-n'])],
  ['worktree', new Set(['list', '--porcelain'])]
]);
// 読み取りsubcommandでも、引数次第でファイルを作り、外部programを起動する
// （`git diff --output=<path>`、`--ext-diff`、`--textconv`、`git grep -O`）。共有ツリーで
// 通すのは、副作用がないと確認できたoptionだけにするfail-close。値だけの引数（revision、
// pathspec、message）はそれ自体では何も書かない。
const GIT_READ_SAFE_OPTIONS = new Set([
  '--', '--abbrev', '--abbrev-commit', '--after', '--all', '--all-match', '--author',
  '--author-date-order', '--before', '--boundary', '--branch', '--branches', '--cached', '--cc',
  '--color', '--committer', '--contains', '--count', '--date', '--date-order', '--decorate',
  '--deleted', '--diff-algorithm', '--diff-filter', '--dirstat', '--dst-prefix', '--error-unmatch',
  '--exclude', '--exclude-standard', '--exit-code', '--extended-regexp', '--find-copies',
  '--find-copies-harder', '--find-renames', '--first-parent', '--fixed-strings', '--follow',
  '--format', '--full-history', '--full-index', '--full-name', '--git-common-dir', '--git-dir',
  '--graph', '--grep', '--heads', '--histogram', '--ignore-all-space', '--ignore-blank-lines',
  '--ignore-case', '--ignore-cr-at-eol', '--ignore-space-at-eol', '--ignore-space-change',
  '--ignore-submodules', '--ignored', '--indent-heuristic', '--is-inside-git-dir',
  '--is-inside-work-tree', '--left-right', '--line-number', '--list', '--long', '--max-count',
  '--max-parents', '--merge-base', '--merges', '--min-parents', '--minimal', '--modified',
  '--name-only', '--name-status', '--numstat', '--oneline', '--others', '--parents', '--patch',
  '--patience', '--perl-regexp', '--points-at', '--porcelain', '--pretty', '--quiet', '--raw',
  '--recurse-submodules', '--refs', '--relative', '--remotes', '--reverse', '--short',
  '--shortstat', '--show-cdup', '--show-current', '--show-prefix', '--show-toplevel', '--since',
  '--skip', '--sort', '--src-prefix', '--stage', '--staged', '--stat', '--stdin', '--summary',
  '--symbolic', '--symbolic-full-name', '--tags', '--topo-order', '--unified', '--until',
  '--verbose', '--verify', '--word-diff'
]);
// `--no-…` はいずれも機能を止める向きで、ファイルを作らない。
const GIT_READ_SAFE_NEGATION = /^--no-[a-z][a-z0-9-]*$/;
// 短いoptionは、ファイルを作らず外部programも起動しないものだけを認める。pagerやeditorを
// 起動する `git grep -O` のような形は列挙しない。
const GIT_READ_SAFE_SHORT = /^-(?:\d+|[abcdefhilmnpqrstuvwxz]|[CEFGLMPSUW])\S*$/;
// gitの作業ツリーやgit dirを実行directoryから引き剥がすglobal option。どのツリーを
// 書き換えるかコマンド文字列からは追えない。
const GIT_UNTRACEABLE_OPTIONS = new Set(['--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env']);
// 別のcommandを間接的に起動できるcommand。実際に走るcommandも、その実行directoryも
// コマンド文字列からは追跡できない。
const COMMAND_WRAPPERS = new Set([
  'bash', 'busybox', 'command', 'dash', 'doas', 'env', 'eval', 'exec', 'find', 'fish', 'ionice', 'ksh',
  'nice', 'nohup', 'parallel', 'script', 'setsid', 'sh', 'stdbuf', 'sudo', 'time', 'timeout',
  'watch', 'xargs', 'zsh'
]);
// 共有ツリーのcwdでも通せるcommand。gitに限らずファイルを書き換えるcommandは共有ツリーを
// 汚すため、副作用を持たない読み取りだけを列挙するfail-closeにする。引数次第で書き込む
// `sed -i` や `awk`、任意のcodeを実行する `node` `python` は含めない。
const READ_ONLY_COMMANDS = new Set([
  'basename', 'cat', 'cksum', 'cmp', 'comm', 'cut', 'date', 'df', 'diff', 'dirname', 'du', 'echo',
  'file', 'grep', 'head', 'hostname', 'id', 'jq', 'ls', 'md5sum', 'nl', 'printf', 'ps', 'pwd',
  'readlink', 'realpath', 'rg', 'sha1sum', 'sha256sum', 'sort', 'stat', 'tail', 'tree', 'true',
  'uname', 'uniq', 'wc', 'which', 'whoami'
]);
// 読み取りcommandも、引数次第でファイルを作り、外部programを起動する
// （`sort -o <path>`、`tree -o <path>`、`rg --pre <prog>`、`sort --compress-program=<prog>`）。
// command名だけで通すと隔離が成立しないので、optionは値を取らないと確認できた名前だけを
// 認めるfail-closeにする。ここに並ぶ名前はいずれも出力先も外部programも指さないため、
// `--name=value` の値はそのまま通してよい。
const SHELL_READ_SAFE_OPTIONS = new Set([
  '--', '--all', '--almost-all', '--apparent-size', '--binary', '--brief', '--bytes',
  '--canonicalize', '--check', '--classify', '--color', '--column', '--count', '--dereference',
  '--directory', '--exclude', '--exclude-dir', '--expand-tabs', '--files-with-matches',
  '--files-without-match', '--fixed-strings', '--full-time', '--glob',
  '--group-directories-first', '--heading', '--help', '--hidden', '--human-readable',
  '--ignore-all-space', '--ignore-blank-lines', '--ignore-case', '--include', '--inode',
  '--invert-match', '--json', '--line-number', '--line-regexp', '--lines', '--long',
  '--max-count', '--max-depth', '--null', '--null-data', '--numeric-sort', '--one-file-system',
  '--only-matching', '--perl-regexp', '--quiet', '--raw-output', '--recursive', '--regexp',
  '--reverse', '--si', '--silent', '--size', '--sort', '--stats', '--summarize', '--text',
  '--time', '--total', '--type', '--unified', '--verbose', '--version', '--version-sort',
  '--with-filename', '--word-regexp', '--zero'
]);
// `--no-…` はいずれも機能を止める向きで、ファイルを作らない。
const SHELL_READ_SAFE_NEGATION = /^--no-[a-z][a-z0-9-]*$/;
// 短いoptionは、出力先を取る `-o` と外部programを取る `-O` を除いた文字の組み合わせだけを
// 認める。数字はheadやtailの行数指定。`-o/tmp/x` のように値が続く形は文字集合から外れる。
const SHELL_READ_SAFE_SHORT = /^-[a-np-zA-NP-Z0-9]+$/;
// 形としては読み取りでも、このcommandのこのoptionだけは書き込みや実行になる。
const SHELL_UNSAFE_OPTIONS = new Map([
  ['date', new Set(['-s', '--set'])],
  ['file', new Set(['-C', '--compile'])]
]);
// operandが出力先や状態変更になるcommand。`uniq <in> <out>` は二つ目にファイルを作る。
const SHELL_MAX_OPERANDS = new Map([['hostname', 0], ['uniq', 1]]);
// ECC自身のcommandは記録済みのDeliveryからworktreeを解決して、そこだけを読み書きする。
// 共有ツリーのcwdから起動されても共有ツリーを変更しないので、隔離中でも通す。ただし
// 「scripts/codex/run-role.js で終わるpath」を名前だけで信用すると、worktreeの中に同じ
// 名前で置いた任意のscriptもECC自身として通ってしまう。実体pathがこのplugin自身の
// scriptと一致する場合だけECCのcommandと認める。
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const WORKTREE_AWARE_TOOLS = ['acceptance-audit', 'delivery-lifecycle', 'doctor', 'record-event', 'reset', 'run-role'];
// 展開してからでないと中身が決まらない記法。
const UNTRACEABLE_EXPANSION = /\$\(|\$\{|`|<\(|>\(/;
const SEGMENT_SEPARATORS = ';&|\n\r';
// 共有ツリーへ書き込みうるtool。MultiEditのように編集ごとにpathを持つ形もあるため、
// トップレベルのfile_pathだけを見ない。
const WRITE_TOOLS = new Set(['Edit', 'MultiEdit', 'NotebookEdit', 'Write']);

// 書き込み系toolがファイルを指す形は一つではない。Editのfile_path、NotebookEditの
// notebook_path、MultiEditの編集ごとのfile_pathをすべて集める。集められなかった書き込みは
// 対象を読み取れないので、呼び出し側でfail-closeさせる。
function writeTargets(toolInput) {
  const source = toolInput && typeof toolInput === 'object' ? toolInput : {};
  const targets = [];
  const collect = value => {
    if (typeof value === 'string' && value.trim()) targets.push(value);
  };
  collect(source.file_path);
  collect(source.notebook_path);
  collect(source.path);
  if (Array.isArray(source.edits)) {
    for (const edit of source.edits) {
      if (edit && typeof edit === 'object') {
        collect(edit.file_path);
        collect(edit.notebook_path);
        collect(edit.path);
      }
    }
  }
  return [...new Set(targets)];
}

function deny(reason) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason
    }
  });
}

function gitValue(cwd, env, args) {
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8', timeout: 5000, windowsHide: true });
  return result.status === 0 ? String(result.stdout || '').trim() : '';
}

function branchAt(cwd, env) {
  return gitValue(cwd, env, ['branch', '--show-current']);
}

// 共有ツリーとして守る範囲は、その作業ツリーの根までである。hookに渡されたcwdを境界に
// すると、リポジトリのsubdirectoryから起動されたときに、`../../src/x` のような同じ
// リポジトリ内のpathが境界の外に見え、共有ツリーへの書き込みが通ってしまう。
// Gitが答えられない場所だけ、projectRootへ落とす。
function sharedRoot(cwd, env, fallback) {
  const toplevel = gitValue(cwd, env, ['rev-parse', '--show-toplevel']);
  return path.resolve(toplevel || fallback || cwd);
}

function hasExecutableShellControl(command) {
  let quote = null;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote) {
      if (character === quote) quote = null;
      else if (
        quote === '"' &&
        (character === '`' || (character === '$' && ['(', '{'].includes(command[index + 1])))
      ) return true;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if ('\r\n;&|<>`(){}^'.includes(character) || (character === '$' && command[index + 1] === '(')) return true;
  }
  return quote !== null;
}

function isExactLifecycleCommand(command, action) {
  const value = String(command || '').trim();
  if (!value || hasExecutableShellControl(value)) return false;
  const node = String.raw`(?:node(?:\.exe)?|"[^"]*node(?:\.exe)?"|'[^']*node(?:\.exe)?')`;
  const scriptName = action === 'prepare' ? 'delivery-lifecycle\\.js' : 'reset\\.js';
  const script = String.raw`(?:"[^"]*scripts[\\/]codex[\\/]${scriptName}"|'[^']*scripts[\\/]codex[\\/]${scriptName}'|[^\s]+scripts[\\/]codex[\\/]${scriptName})`;
  const argument = String.raw`(?:"[^"]+"|'[^']+'|[^\s]+)`;
  const tail = action === 'prepare'
    ? String.raw`prepare(?:\s+--session\s+${argument})?`
    : argument;
  return new RegExp(String.raw`^${node}\s+${script}\s+${tail}\s*$`, 'i').test(value);
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

// 存在する最長の親までrealpathで正規化し、残りを繋ぎ直す。まだ無いファイルへの書き込みも、
// 途中のsymlinkを解決した実体で判定できる。
function realPath(target) {
  const absolute = path.resolve(String(target || ''));
  let current = absolute;
  const suffix = [];
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const real = fs.realpathSync(current);
      return suffix.length > 0 ? path.join(real, ...suffix) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
  return absolute;
}

const WORKTREE_AWARE_TOOL_PATHS = new Set(
  WORKTREE_AWARE_TOOLS.map(tool => realPath(path.join(PLUGIN_ROOT, 'scripts', 'codex', `${tool}.js`)))
);

// worktreeの中のsymlinkが共有ツリーを指していると、字面のpathだけではworktreeの中に
// 見える。書き込み先は字面と実体の両方で判定し、どちらかが共有ツリーへ抜けるなら拒否する。
function escapesWorktree(workspace, shared, target) {
  const sharedRoots = [path.resolve(shared), realPath(shared)];
  const workspaceRoots = [path.resolve(workspace), realPath(workspace)];
  return [path.resolve(target), realPath(target)].some(
    candidate =>
      sharedRoots.some(root => isInside(root, candidate)) &&
      !workspaceRoots.some(root => isInside(root, candidate))
  );
}

// commandが走るdirectoryをworktreeの中だと言い切れるか。symlinkで外へ抜ける経路は
// worktreeの中とは見なさない。
function confinedToWorktree(workspace, target) {
  if (!target) return false;
  const roots = [path.resolve(workspace), realPath(workspace)];
  return [path.resolve(target), realPath(target)].every(candidate => roots.some(root => isInside(root, candidate)));
}

// commandをshellの区切り文字で分ける。引用符の中の区切り文字はコマンド境界ではない。
// 各segmentには後続の区切り演算子を添える。`&&` と `||` は `&` `|` と意味が違い、
// 直前のcommandが成功したかどうかで次のcommandの実行directoryが変わる。
function splitCommand(command) {
  const value = String(command || '');
  const segments = [];
  let current = '';
  let quote = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (SEGMENT_SEPARATORS.includes(character)) {
      const doubled = value[index + 1] === character;
      segments.push({ text: current, separator: doubled ? character + character : character });
      if (doubled) index += 1;
      current = '';
      continue;
    }
    current += character;
  }
  segments.push({ text: current, separator: '' });
  return segments.filter(segment => segment.text.trim());
}

function splitSegments(command) {
  return splitCommand(command).map(segment => segment.text);
}

// tokenを、文字ごとに引用されていたかどうかと一緒に持ち帰る。`git commit -m ">note"` の
// `>` はリダイレクトではなく引数であり、両者を取り違えると判定が狂う。
function tokenizeParts(segment) {
  const parts = [];
  let current = null;
  let quote = null;
  const start = () => {
    if (current === null) current = { value: '', quoted: [] };
  };
  const append = (character, quoted) => {
    start();
    current.value += character;
    current.quoted.push(quoted);
  };
  for (const character of String(segment || '')) {
    if (quote) {
      if (character === quote) quote = null;
      else append(character, true);
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      start();
      continue;
    }
    if (/\s/.test(character)) {
      if (current !== null) parts.push(current);
      current = null;
      continue;
    }
    append(character, false);
  }
  if (current !== null) parts.push(current);
  return parts;
}

function tokenize(segment) {
  return tokenizeParts(segment).map(part => part.value);
}

// 一つのtokenを、commandの語とリダイレクトに分ける。shellは `marker>src/x` の `>` も
// リダイレクトとして解釈するので、演算子はtokenの先頭だけでなく途中でも探す。
// `2>` と `&>` の前置きはfd指定であって語ではない。
function splitRedirectionParts(part) {
  const value = String(part && part.value || '');
  const quoted = (part && part.quoted) || [];
  const items = [];
  let buffer = '';
  let pending = null;
  const flush = () => {
    if (pending) items.push({ operator: pending, target: buffer });
    else if (buffer) items.push({ word: buffer });
    pending = null;
    buffer = '';
  };
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (!quoted[index] && (character === '>' || character === '<')) {
      let operator = character;
      if (!quoted[index + 1] && value[index + 1] === character) {
        operator += character;
        index += 1;
      }
      if (!pending && (/^\d+$/.test(buffer) || buffer === '&')) buffer = '';
      flush();
      pending = operator;
      continue;
    }
    buffer += character;
  }
  flush();
  return items;
}

// リダイレクトはcommandの種類に関わらずファイルを作る。`git status > src/x` のように
// 読み取りcommandでも共有ツリーへ書けるので、書き込み先だけを取り出して別に検査する。
function scanRedirections(parts) {
  const tokens = [];
  const writes = [];
  // 書き込み演算子のtargetが次の語にある状態。読み取れないまま終わったら空文字を
  // 書き込み先として残し、呼び出し側でfail-closeさせる。
  let awaiting = false;
  for (const part of parts) {
    for (const item of splitRedirectionParts(part)) {
      if (item.operator) {
        if (awaiting) writes.push('');
        const write = item.operator === '>' || item.operator === '>>';
        awaiting = false;
        // 入力リダイレクトは読み取りで、`>&2` のようなfd複製はファイルを作らない。
        if (!write) continue;
        if (item.target) {
          if (!item.target.startsWith('&')) writes.push(item.target);
          continue;
        }
        awaiting = true;
        continue;
      }
      if (awaiting) {
        awaiting = false;
        if (!item.word.startsWith('&')) writes.push(item.word);
        continue;
      }
      tokens.push(item.word);
    }
  }
  if (awaiting) writes.push('');
  return { tokens, writes };
}

// 展開が必要なtokenは実際のdirectoryを決められない。追跡不能をnullで表し、
// worktreeの中だと決めつけない。
function resolveDirectory(base, target) {
  const value = String(target || '');
  if (!value || /[$`~*?]/.test(value)) return null;
  if (path.isAbsolute(value)) return path.resolve(value);
  return base ? path.resolve(base, value) : null;
}

// `"git.exe"` も同じgitである。判定はcommand名だけで行う。
function commandName(token) {
  const value = String(token || '').replace(/^[({]+/, '');
  return String(value.split(/[\\/]/).pop() || '').replace(/\.exe$/i, '').toLowerCase();
}

// 名前で許すのは、PATHから解決される素のcommand名だけにする。`<worktree>/git` や
// `./sort` のようにpathを付けて起動するprogramは、worktreeの中に同じ名前で置ける。
// 名前だけを見ると、共有ツリーのcwdで任意のprogramが読み取りcommandとして通ってしまう。
function isBareCommand(token) {
  const value = String(token || '').replace(/^[({]+/, '');
  return value !== '' && !/[\\/]/.test(value) && !/[$`]/.test(value);
}

// `node <plugin>/scripts/codex/run-role.js ...` のscript pathを実体で解決する。
// hook自身が同じ値を持つ `$CLAUDE_PLUGIN_ROOT` だけは展開できる。他の変数は展開結果が
// 決まらないので、ECCのcommandとは認めない。
function eccScriptPath(token, base, env) {
  let value = String(token || '');
  if (!value) return '';
  const variable = /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(value);
  if (variable) {
    const replacement = String((env || process.env)[variable[1]] || '');
    if (!replacement) return '';
    value = replacement + value.slice(variable[0].length);
  }
  if (/[$`~*?]/.test(value)) return '';
  if (!path.isAbsolute(value) && !base) return '';
  return realPath(path.isAbsolute(value) ? value : path.resolve(base, value));
}

// `node <plugin>/scripts/codex/run-role.js ...` のような、ECC自身のworktree対応command。
// `node -e "..."` や `node --require x -e "..."` は任意のcodeを実行するので、node自身の
// optionを挟まず、最初の引数がそのままscript pathである形だけを認める。script pathは
// 名前が一致するだけでは足りず、このplugin自身のscriptの実体と一致する必要がある。
function isWorktreeAwareTool(tokens, base, env) {
  if (commandName(tokens[0]) !== 'node' || !isBareCommand(tokens[0])) return false;
  const script = eccScriptPath(tokens[1], base, env);
  return script !== '' && WORKTREE_AWARE_TOOL_PATHS.has(script);
}

// 共有ツリーのcwdで通す読み取りcommandは、引数まで読んで初めて読み取りだと言える。
function isReadOnlyShellCommand(name, args) {
  if (!READ_ONLY_COMMANDS.has(name)) return false;
  const unsafe = SHELL_UNSAFE_OPTIONS.get(name);
  const limit = SHELL_MAX_OPERANDS.has(name) ? SHELL_MAX_OPERANDS.get(name) : Infinity;
  let operands = 0;
  for (const argument of args) {
    const value = String(argument || '');
    // operandはpathやpatternであり、それ自体ではファイルを作らない。
    if (!value.startsWith('-') || value === '-') {
      operands += 1;
      if (operands > limit) return false;
      continue;
    }
    if (unsafe && (unsafe.has(value.split('=')[0]) || (!value.startsWith('--') && [...value.slice(1)].some(letter => unsafe.has(`-${letter}`))))) {
      return false;
    }
    if (value.startsWith('--')) {
      const option = value.split('=')[0];
      if (!SHELL_READ_SAFE_OPTIONS.has(option) && !SHELL_READ_SAFE_NEGATION.test(option)) return false;
      continue;
    }
    if (!SHELL_READ_SAFE_SHORT.test(value)) return false;
  }
  return true;
}

// revisionやpathspecのようなoperandは、それ自体ではファイルを作らない。optionは
// 副作用がないと確認できた形だけを認める。
function isReadOnlyGitArgument(argument) {
  const value = String(argument || '');
  if (!value.startsWith('-')) return true;
  const name = value.split('=')[0];
  if (GIT_READ_SAFE_OPTIONS.has(name) || GIT_READ_SAFE_NEGATION.test(name)) return true;
  return GIT_READ_SAFE_SHORT.test(value);
}

function isReadOnlyGit(subcommand, args) {
  if (!subcommand) return false;
  if (GIT_READ_SUBCOMMANDS.has(subcommand)) return args.every(isReadOnlyGitArgument);
  const forms = GIT_READ_ONLY_FORMS.get(subcommand);
  if (!forms) return false;
  return args.length === 0 ? forms.has('') : args.every(arg => forms.has(arg));
}

// gitの実行directoryと、そのsubcommandが書き込むかどうかを読む。追跡できない指定が
// 混じった書き込みはlocationをnullにして、呼び出し側でfail-closeさせる。
function gitInvocation(args, cwd) {
  let location = cwd;
  let configOverride = false;
  let index = 0;
  while (index < args.length && args[index].startsWith('-')) {
    const arg = args[index];
    // `-C <path>` と `-C<path>` はどちらもgitの実行directoryを移す。複数指定は累積する。
    if (arg === '-C') {
      location = resolveDirectory(location, args[index + 1]);
      index += 2;
      continue;
    }
    if (arg.startsWith('-C') && arg.length > 2) {
      location = resolveDirectory(location, arg.slice(2));
      index += 1;
      continue;
    }
    // `-c core.worktree=...` はgitの書き込み先を実行directoryから引き剥がせる。
    // `-c diff.external=...` のような指定は、読み取りsubcommandでも任意のprogramを
    // 走らせるので、読み取り扱いをやめてworktreeの中だけで通す。
    if (arg === '-c' || arg === '--config-env') {
      if (/^core\./i.test(String(args[index + 1] || ''))) location = null;
      configOverride = true;
      index += 2;
      continue;
    }
    if (arg.startsWith('-c') && arg.length > 2) {
      if (/^core\./i.test(arg.slice(2))) location = null;
      configOverride = true;
      index += 1;
      continue;
    }
    if (GIT_UNTRACEABLE_OPTIONS.has(arg.split('=')[0])) {
      location = null;
      index += arg.includes('=') ? 1 : 2;
      continue;
    }
    index += 1;
  }
  const subcommand = args[index];
  const rest = args.slice(index + 1);
  if (!configOverride && isReadOnlyGit(subcommand, rest)) return { write: false, location };
  // subcommandより前の引数に展開が残っていると、どのツリーを書き換えるか決まらない。
  // subcommand以降はcommit messageなどが入るため、実行directoryの判定には使わない。
  if (args.slice(0, index + 1).some(arg => /[$`]/.test(arg))) return { write: true, location: null };
  return { write: true, location };
}

// worktreeを払い出しても、親CLIのcwdは共有ツリーのままである。隔離中は、実行directoryが
// worktreeへ移っている（`cd <worktree> && ...`）か、gitが `-C <worktree>` でそこを
// 指しているcommandだけを書き込みとして許可する。commandの中にworktree pathの文字列が
// 現れるだけでは、そのcommandが共有ツリーを書き換えないことの証明にならない。
// 共有ツリーのcwdで残せるのは、ファイルを作らない読み取りcommandとgitの読み取り
// subcommandだけである。読み取りかどうかはcommand名では決まらず、引数まで読んで判定する。
// 追跡できない起動の仕方（wrapper、command置換、展開、`||` を挟んだcd、pathを付けた
// 実行ファイル、環境変数の前置き）は、共有ツリーを書き換えないと言い切れないので拒否する。
function targetsWorkspace(command, workspace, cwd = process.cwd(), options = {}) {
  const env = options.env || process.env;
  const start = path.resolve(cwd || process.cwd());
  // 共有ツリーの境界はGitの主作業ツリーの根であって、hookに渡されたcwdではない。
  // subdirectoryを実行directoryにすると、`../../src/x` が境界の外に見えてしまう。
  const shared = path.resolve(options.shared || start);
  let current = start;
  for (const { text, separator } of splitCommand(command)) {
    // 展開してからでないと、何がどのdirectoryで走るか決まらない。
    if (UNTRACEABLE_EXPANSION.test(text)) return false;
    const { tokens, writes } = scanRedirections(tokenizeParts(text));
    for (const target of writes) {
      const resolved = resolveDirectory(current, target);
      // 書き込み先を読み取れない形と、worktreeの外にある共有ツリーのファイルを拒否する。
      if (!resolved) return false;
      if (escapesWorktree(workspace, shared, resolved)) return false;
    }
    // 環境変数の前置きは、gitの書き込み先も、commandがどのprogramに解決されるかも
    // 差し替える（`PATH=<worktree> cat …`）。GIT_* は実行directoryに関わらず拒否し、
    // それ以外はworktreeの中で走ることが読み取れる場合だけ通す。
    let overridesEnvironment = false;
    while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
      // GIT_DIR や GIT_WORK_TREE はgit自身の書き込み先を差し替える。
      if (/^GIT_/i.test(tokens[0])) return false;
      overridesEnvironment = true;
      tokens.shift();
    }
    const executable = tokens[0];
    const name = commandName(executable);
    if (!name) continue;
    if (name === 'cd' || name === 'pushd') {
      // subshellの中のcdは呼び出し元のdirectoryを動かさない。
      const target = /[(){}]/.test(text) ? null : resolveDirectory(current, tokens[1]);
      // cdの結果を次のcommandへ引き継げるのは `&&` のときだけ。`||` は cd が失敗した
      // 経路なので直前のdirectoryのまま、`;` `|` `&` は成否が分からず追跡不能になる。
      if (separator === '&&') current = target;
      else if (separator !== '||') current = null;
      continue;
    }
    if (name === 'popd') {
      current = null;
      continue;
    }
    if (COMMAND_WRAPPERS.has(name)) return false;
    const inWorktree = confinedToWorktree(workspace, current);
    if (overridesEnvironment && !inWorktree) return false;
    if (name === 'git' && isBareCommand(executable)) {
      const { write, location } = gitInvocation(tokens.slice(1), current);
      if (write && !confinedToWorktree(workspace, location)) return false;
      continue;
    }
    if (inWorktree) continue;
    // git以外のcommandも共有ツリーのファイルを書き換える。worktreeの中で走ることが
    // 読み取れないなら、引数まで見て副作用がないと言える読み取りcommandと、実体が
    // このplugin自身のscriptであるECCのcommandだけを通す。
    if (isWorktreeAwareTool(tokens, current, env)) continue;
    if (!isBareCommand(executable) || !isReadOnlyShellCommand(name, tokens.slice(1))) return false;
  }
  return true;
}

// 切り詰められた入力からでも、Deliveryを引くためのsession idだけは拾える。hookの入力は
// tool_inputより前にsession_idを置くため、先頭側に残っている。
function sessionIdFromRaw(rawInput) {
  const match = /"session_?[iI]d"\s*:\s*"([^"\\]{1,200})"/.exec(String(rawInput || ''));
  return match ? match[1] : '';
}

// 共通runnerは1 MiBを超えるtool入力を切り詰め、pass-throughはfail-openする。切り詰められた
// 入力からはtool名も書き込み先も読み取れず、そのcommandが共有ツリーを変更しないと
// 言い切れない。隔離中のDeliveryを抱えたprojectでは、ここをfail-closeさせる。
function truncatedDecision(rawInput, options, env) {
  const cwd = options.cwd || env.CLAUDE_PROJECT_DIR || process.cwd();
  let config;
  try {
    config = loadConfig(cwd, env);
  } catch {
    config = null;
  }
  if (!config || config.deliveryWorkflow !== 'required') return rawInput;
  const reason =
    `[ECC Delivery Gate] The hook payload exceeded ${options.maxStdin || 1024 * 1024} bytes and was truncated, ` +
    'so this gate cannot read the tool call or its write targets while a delivery worktree is in effect. ' +
    'Refusing to fall back to pass-through. Retry with a smaller payload, ' +
    'for example by writing the content inside the delivery worktree in smaller pieces.';
  const sessionId = sessionIdFromRaw(rawInput) || env.CLAUDE_SESSION_ID || env.ECC_SESSION_ID || '';
  // どのDeliveryの入力かを特定できないまま素通しすると、隔離の判定そのものが消える。
  if (!sessionId) return deny(reason);
  const state = readState({ session_id: sessionId }, env);
  if (!state.delivery) return rawInput;
  if (state.delivery.status === 'draft-pr' || state.delivery.status === 'merged') return rawInput;
  return deny(reason);
}

function run(rawInput, options = {}) {
  const env = options.env || process.env;
  if (options.truncated) return truncatedDecision(rawInput, options, env);
  let input;
  try {
    input = typeof rawInput === 'string' ? JSON.parse(rawInput) : rawInput;
  } catch {
    return rawInput;
  }
  const cwd = options.cwd || input.cwd || env.CLAUDE_PROJECT_DIR || process.cwd();
  const config = loadConfig(cwd, env);
  if (config.deliveryWorkflow !== 'required') return rawInput;

  const state = readState(input, env);
  if (!state.delivery) return rawInput;
  if (state.delivery.status === 'draft-pr' || state.delivery.status === 'merged') return rawInput;

  const toolName = String(input.tool_name || '');
  const command = String(input.tool_input && input.tool_input.command || '');
  const sessionId = resolveSessionId(input, env);
  const prepareScript = path.resolve(__dirname, '../codex/delivery-lifecycle.js');
  const resetScript = path.resolve(__dirname, '../codex/reset.js');
  // 記録済みDeliveryを立て直すECC自身のcommandは、Gateがfail-closeしている間も通す。
  // ここまで塞ぐと、拒否理由が案内しているprepareとreset自体を実行できず、隔離を
  // 復旧する手段が残らない。判定は引数まで固定した完全一致で、shellの制御文字を含む形は
  // isExactLifecycleCommandが弾く。
  const isLifecycleCommand = toolName === 'Bash' &&
    (isExactLifecycleCommand(command, 'prepare') || isExactLifecycleCommand(command, 'reset'));
  // 隔離が成立した後のfail-closeでは、script名の一致だけでECCのcommandと認めない。同じ
  // 名前で置いた任意のscriptを通すと、拒否しているはずの共有ツリーへの書き込みが復旧
  // commandの顔で通ってしまう。実体がこのplugin自身のscriptである場合だけ復旧と認める。
  const isLifecycleRecovery = isLifecycleCommand && isWorktreeAwareTool(tokenize(command), cwd, env);

  if (state.delivery.status !== 'ready') {
    const permissionMode = String(input.permission_mode || input.permissionMode || '').toLowerCase();
    // Plan mode中はClaude自身のread-only制約に任せて調査を許可する。承認後は同じ
    // deferred stateが残るため、最初のBash/Edit/Writeをprepare完了までfail-closeする。
    if (state.delivery.status === 'deferred' && permissionMode === 'plan') return rawInput;
    // prepare前は隔離すべきworktreeがまだ無い。ここは従来どおりcommandの形だけで通す。
    if (isLifecycleCommand) return rawInput;
    return deny(
      '[ECC Delivery Gate] Repository tools are blocked until duplicate Issue search, Issue selection/creation, and the issue-linked worktree are recorded. ' +
        'Preparation never switches the shared working tree; it checks the issue-linked branch out in a separate worktree and reports that path. ' +
        `Run node "${prepareScript}" prepare --session "${sessionId}" first, then continue this delivery inside the reported worktree path. ` +
        `If the recorded Delivery is stale or unrecoverable, explicitly reset it with node "${resetScript}" "${sessionId}".`
    );
  }

  const workspace = deliveryWorkspace(state, cwd);
  if (!workspace) {
    // 隔離済みDeliveryのworktreeが失われた。ここで共有ツリーへ戻すと、他の作業を
    // 抱えたツリーをDeliveryのbranchとして扱ってしまう。復旧かresetまで停止する。
    if (!state.delivery.worktree_missing_recorded_at) {
      recordIncident(
        {
          type: 'delivery_worktree_missing',
          severity: 'minor',
          target: 'ecc',
          hook_id: 'delivery-lifecycle-gate',
          message: 'The worktree recorded for the active Delivery is missing or belongs to another repository.',
          metadata: { issue_number: state.delivery.issue_number || null }
        },
        { cwd, env }
      );
      writeState(input, {
        delivery: { ...state.delivery, worktree_missing_recorded_at: new Date().toISOString() }
      }, env);
    }
    if (isLifecycleRecovery) return rawInput;
    return deny(
      `[ECC Delivery Gate] Issue #${state.delivery.issue_number} is bound to the delivery worktree ${state.delivery.worktree_path}, ` +
        'but that path is no longer a working tree of this repository. ' +
        'Restore that worktree outside this session with `git worktree add`, ' +
        `or explicitly reset the delivery with node "${resetScript}" "${sessionId}". ` +
        'This gate never falls back to the shared working tree.'
    );
  }
  // 共有ツリーの境界はGitの主作業ツリーの根であって、hookに渡されたcwdではない。
  // 判定に必要になったときだけ解決し、Deliveryごとに一度で済ませる。
  let sharedCache = '';
  const shared = () => {
    if (!sharedCache) sharedCache = sharedRoot(cwd, env, config.projectRoot);
    return sharedCache;
  };
  const actualBranch = branchAt(workspace, env);
  if (!actualBranch || actualBranch !== state.delivery.branch) {
    // Gateがfail-closeしている復旧可能な不一致は、即criticalではない。同じDeliveryで
    // 同じ不一致を繰り返し記録せず、複数回の独立発生だけを中央昇格の対象にする。
    if (state.delivery.branch_mismatch_actual !== (actualBranch || '<none>')) {
      recordIncident(
        {
          type: 'delivery_branch_mismatch',
          severity: 'minor',
          target: 'ecc',
          hook_id: 'delivery-lifecycle-gate',
          message: 'The current branch did not match the branch recorded for the active Delivery.',
          metadata: { expected: state.delivery.branch, actual: actualBranch || '<none>' }
        },
        { cwd, env }
      );
      writeState(input, {
        delivery: {
          ...state.delivery,
          branch_mismatch_actual: actualBranch || '<none>',
          branch_mismatch_recorded_at: new Date().toISOString()
        }
      }, env);
    }
    // 記録済みworktreeの中でbranchを戻す作業だけは通す。ここまで拒否すると、隔離された
    // worktreeを直す手段が残らず、共有ツリーへ戻る以外の道がなくなる。共有ツリーへ届く
    // commandは、隔離中と同じ判定でそのまま拒否される。編集toolは通さない。
    if (isLifecycleRecovery) return rawInput;
    if (
      toolName === 'Bash' &&
      workspace !== path.resolve(cwd) &&
      targetsWorkspace(command, workspace, cwd, { shared: shared(), env })
    ) {
      return rawInput;
    }
    return deny(
      `[ECC Delivery Gate] Expected issue-linked branch ${state.delivery.branch} in ${workspace}, but its current branch is ${actualBranch || '<none>'}. ` +
        `Restore it with \`git -C "${workspace}" switch ${state.delivery.branch}\` before editing; ` +
        'this gate never falls back to the shared working tree.'
    );
  }

  if (state.delivery.branch_mismatch_actual || state.delivery.worktree_missing_recorded_at) {
    writeState(input, {
      delivery: {
        ...state.delivery,
        branch_mismatch_actual: null,
        branch_mismatch_recorded_at: null,
        worktree_missing_recorded_at: null
      }
    }, env);
  }

  const isEdit = WRITE_TOOLS.has(toolName);
  const isolated = workspace !== path.resolve(cwd);
  if (isolated) {
    const sharedTree = shared();
    if (isEdit) {
      // 払い出したworktreeの外へ書くと、隔離したはずの共有ツリーを再び変更してしまう。
      // 共有ツリー配下だけを拒否し、リポジトリ外のファイルは従来どおり素通しする。
      // 相対pathはtoolの実行directoryから解決し、境界は共有ツリーの根で判定する。
      const targets = writeTargets(input.tool_input).map(target => path.resolve(cwd, target));
      if (targets.length === 0) {
        return deny(
          `[ECC Delivery Gate] ${toolName} did not name a file to write, so this gate cannot tell whether it stays inside the delivery worktree ${workspace}. ` +
            'Reissue the edit with an explicit absolute path inside that worktree.'
        );
      }
      const outside = targets.find(target => escapesWorktree(workspace, sharedTree, target));
      if (outside) {
        // symlinkで抜ける経路は、共有ツリーからの相対pathに置き換えられない。その場合は
        // 具体的な代替pathを示さず、worktreeの中で書き直させる。
        const relative = path.relative(sharedTree, outside);
        const inShared = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
        return deny(
          `[ECC Delivery Gate] Issue #${state.delivery.issue_number} is checked out in the delivery worktree ${workspace}. ` +
            (inShared
              ? `Edit ${path.join(workspace, relative)} instead`
              : `${outside} resolves outside that worktree, so write inside ${workspace} instead`) +
            '; the shared working tree keeps its own branch and uncommitted changes.'
        );
      }
    }
    if (toolName === 'Bash' && !targetsWorkspace(command, workspace, cwd, { shared: sharedTree, env })) {
      return deny(
        `[ECC Delivery Gate] This delivery is isolated in the worktree ${workspace}, but the command is not provably confined to that worktree. ` +
          `Write it as \`cd "${workspace}" && ...\` or \`git -C "${workspace}" ...\`. ` +
          'In the shared working tree only side-effect-free inspection is allowed (read-only `git` subcommands, `ls`, `cat`, `grep`, …), ' +
          'checked argument by argument, so an option that writes a file or starts another program (`sort -o …`, `rg --pre …`) is rejected, ' +
          "and ECC's own worktree-aware commands (`scripts/codex/run-role.js`, …) only when the script is this plugin's own file, " +
          'with no output redirection into that tree. ' +
          'Forms whose working tree cannot be read from the command itself are rejected: wrappers such as `sh -c` or `xargs`, ' +
          'command substitution and `${...}` expansion, `--git-dir`/`--work-tree`/`GIT_*` overrides, and a `cd` that is not chained with `&&`.'
      );
    }
  }
  const head = gitValue(workspace, env, ['rev-parse', 'HEAD']);
  if (
    isEdit &&
    state.delivery.committed_head &&
    state.delivery.committed_head === head &&
    !(
      ['review', 'security-review'].includes(state.review_role) &&
      state.review_status === 'blocked' &&
      state.review_complete === true &&
      state.review_head === head &&
      state.review_worktree_clean === true &&
      Number.isInteger(state.review_blocking_findings) &&
      state.review_blocking_findings > 0
    )
  ) {
    return deny(
      '[ECC Delivery Gate] The clean implementation commit is waiting for an independent Codex review. ' +
      'Run `/ecc:code-review` for the current HEAD before further edits. If the review has no critical/high findings, push and create the Draft PR instead of starting another edit loop.'
    );
  }
  return rawInput;
}

if (require.main === module) {
  // 子processとして起動された場合、切り詰めは親のrunnerが済ませている。自分でも上限を
  // 持ち、どちらで切れてもrun()へtruncatedを伝える。
  const maxStdin = Number(process.env.ECC_HOOK_INPUT_MAX_BYTES) || 1024 * 1024;
  let truncated = /^(1|true|yes)$/i.test(String(process.env.ECC_HOOK_INPUT_TRUNCATED || ''));
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    if (raw.length < maxStdin) {
      const remaining = maxStdin - raw.length;
      raw += chunk.substring(0, remaining);
      if (chunk.length > remaining) truncated = true;
    } else {
      truncated = true;
    }
  });
  process.stdin.on('end', () => process.stdout.write(run(raw, { truncated, maxStdin })));
}

module.exports = {
  branchAt,
  gitValue,
  isExactLifecycleCommand,
  isInside,
  run,
  splitSegments,
  targetsWorkspace,
  tokenize,
  writeTargets
};
