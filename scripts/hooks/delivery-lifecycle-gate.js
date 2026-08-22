#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../codex/config');
const {
  deliveryWorkspace,
  needsWorktreeMigration,
  readState,
  recordIncident,
  resolveSessionId,
  writeState
} = require('../codex/runtime-state');

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
// 書き込み先が、走らせたworktreeの作業ツリー・index・そのworktreeが今いるbranchに収まる
// subcommand。refも設定もgit common-dirにあり、主作業ツリーと全worktreeで共有されるため、
// 実行directoryをworktreeに限っても守れない書き込みがある（`git update-ref refs/heads/main`、
// `git branch -f main`、`git tag -f`、`git notes`、`git remote`、`git config`）。共有ツリーが
// 今いるbranchを実行中に動かせてしまい、Issue #79が報告した衝突がそのまま戻る。許可する形を
// 列挙するfail-closeにして、ここにも読み取りの列挙にも無い名前（未知のsubcommandとalias）は
// 実行directoryを問わず拒否する。
// `stash` も共有領域への書き込みである。退避先の `refs/stash` はgit common-dirにあって
// 全worktreeで一つしかなく、worktreeの中で走らせた `git stash drop` や `git stash clear` が
// 別のworktreeや共有ツリーの退避データを消す。Issueが報告した衝突と同じ「他の作業を
// 巻き添えにする」経路なので、書き込む形は通さず、`git stash list` だけを読み取りとして残す。
const GIT_WORKTREE_LOCAL_SUBCOMMANDS = new Set([
  'add', 'am', 'apply', 'checkout', 'cherry-pick', 'clean', 'commit', 'fetch', 'merge', 'mv',
  'pull', 'push', 'rebase', 'reset', 'restore', 'revert', 'rm', 'switch'
]);
// 許可した名前でも、引数次第で共有refへ書く形がある。`-B` と `-C` は既にあるbranchを強制的に
// 付け替え（`git checkout -B main`）、`<src>:<dst>` のrefspecはremoteが自リポジトリなら
// refs/heads/<dst> をそのまま書き換える（`git push . HEAD:main`）。remoteが何を指すかは
// command文字列からは読めないので、refspecの形をまとめて拒否する。
const GIT_FORCE_CREATE_SUBCOMMANDS = new Set(['checkout', 'switch']);
const GIT_REFSPEC_SUBCOMMANDS = new Set(['fetch', 'pull', 'push']);
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
// bashの `printf -v PATH …` は外部programを呼ばずにshell変数を書き換えるため、以後の
// commandが解決する実行ファイルごと差し替えられる。
const SHELL_UNSAFE_OPTIONS = new Map([
  ['date', new Set(['-s', '--set'])],
  ['file', new Set(['-C', '--compile'])],
  ['printf', new Set(['-v'])]
]);
// このshellの変数・別名・関数を書き換えるcommand。実行位置がworktreeの中でも、効果は
// 同じcommand行の後続segmentに残り、共有ツリーで走るcommandがどのprogramに解決されるかを
// 変えてしまう（`PATH` の差し替え）。以後は共有ツリーで走る形を通さない。
const SHELL_STATE_COMMANDS = new Set([
  '.', 'alias', 'declare', 'export', 'hash', 'let', 'local', 'read', 'readonly', 'set',
  'shopt', 'source', 'typeset', 'unalias', 'unset'
]);
// operandが出力先や状態変更になるcommand。`uniq <in> <out>` は二つ目にファイルを作る。
const SHELL_MAX_OPERANDS = new Map([['hostname', 0], ['uniq', 1]]);
// 引数のcodeをそのまま実行する起動の仕方。何をどこへ書くかはcommand文字列から追えない
// ので、worktreeの中で走っていても拒否する。scriptやmoduleを指す形（`node tests/x.js`）は、
// そのpathが境界検査を通る限り通す。worktreeの中のscript自身が何をするかまではこのGateでは
// 決められない。そこまで塞ぐには、共有ツリーをprocessから見えなくするOS側の隔離が要る。
const INLINE_CODE_COMMANDS = new Map([
  ['node', { options: new Set(['-e', '--eval', '-p', '--print']), letters: 'ep' }],
  ['bun', { options: new Set(['-e', '--eval', 'eval']), letters: 'e' }],
  ['deno', { options: new Set(['eval']), letters: '' }],
  ['python', { options: new Set(['-c']), letters: 'c' }],
  ['python3', { options: new Set(['-c']), letters: 'c' }],
  ['perl', { options: new Set(['-e', '-E']), letters: 'eE' }],
  ['ruby', { options: new Set(['-e']), letters: 'e' }],
  ['php', { options: new Set(['-r']), letters: 'r' }]
]);
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
// 二重引用符の中でバックスラッシュが意味を消せる文字。
const DOUBLE_QUOTE_ESCAPES = new Set(['"', '\\', '$', '`', '\n']);
// 引用されていなければ、字面とは別の名前へ展開される文字。
const SHELL_EXPANSION_CHARACTERS = '*?[]{}';
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

// 守るべき境界は、このリポジトリの主作業ツリーと、Delivery以外のlinked worktreeである。
// cwdの作業ツリーだけを境界にすると、手順書どおりDeliveryのworktreeの中から起動した
// 瞬間に共有ツリーも兄弟worktreeも境界の外に見え、絶対pathの書き込みや
// `git -C <共有ツリー>` が検査されないまま通ってしまう。
function protectedRoots(cwd, env, fallback, workspace) {
  const roots = gitValue(cwd, env, ['worktree', 'list', '--porcelain'])
    .split(/\r?\n/)
    .filter(line => line.startsWith('worktree '))
    .map(line => path.resolve(line.slice('worktree '.length).trim()));
  // Gitが一覧を返せない場所でも、少なくとも実行中の作業ツリーの根は守る。
  if (roots.length === 0) roots.push(sharedRoot(cwd, env, fallback));
  const workspaceRoots = new Set([path.resolve(workspace), realPath(workspace)]);
  return roots.filter(root => !workspaceRoots.has(root) && !workspaceRoots.has(realPath(root)));
}

// bashはバックスラッシュで次の1文字の特別な意味を消す。二重引用符の中でも `"` に効くため、
// 引用符の開閉だけを追うと `echo "a\""; git reset --hard` の `;` を引用の中と読み違え、
// 共有ツリーへ届くcommandを安全と判定してしまう。commandの各文字がshellにとってどの状態に
// あるかを一度に読み出し、以降の解析はこの結果だけを使う。
//   operative: 引用もエスケープもされておらず、区切りやリダイレクトとして働く
//   quoted:    引用の中にある文字
//   escaped:   バックスラッシュで意味を消された文字
//   syntax:    引用符やバックスラッシュ自身（語には残らない）
// 引用が閉じない、行末がバックスラッシュで終わるといった読み切れない形はvalid=falseで返し、
// 呼び出し側でfail-closeさせる。
function scanQuoting(value) {
  const text = String(value || '');
  const kinds = new Array(text.length).fill('operative');
  const quotes = new Array(text.length).fill(null);
  let quote = null;
  let valid = true;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    quotes[index] = quote;
    if (character === '\\' && quote !== "'") {
      const next = text[index + 1];
      // 続きの行が無い行末のバックスラッシュは、次に何が来るのか読み切れない。
      if (next === undefined) {
        valid = false;
        break;
      }
      // 二重引用符の中でバックスラッシュが意味を消せる文字は限られており、それ以外の前では
      // バックスラッシュ自身が文字として残る。
      if (quote === '"' && !DOUBLE_QUOTE_ESCAPES.has(next)) {
        kinds[index] = 'quoted';
        continue;
      }
      kinds[index] = 'syntax';
      kinds[index + 1] = 'escaped';
      quotes[index + 1] = quote;
      index += 1;
      continue;
    }
    if (quote) {
      if (character === quote) {
        kinds[index] = 'syntax';
        quote = null;
      } else {
        kinds[index] = 'quoted';
      }
      continue;
    }
    if (character === '"' || character === "'") {
      kinds[index] = 'syntax';
      quote = character;
    }
  }
  // 閉じない引用符が残る形は、どこまでが一つのcommandなのかを決められない。
  if (quote) valid = false;
  return { kinds, quotes, valid };
}

function hasExecutableShellControl(command) {
  const value = String(command || '');
  const { kinds, quotes, valid } = scanQuoting(value);
  // 読み切れない形は、制御文字が残っていないと言い切れない。
  if (!valid) return true;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (
      kinds[index] === 'operative' &&
      ('\r\n;&|<>`(){}^'.includes(character) || (character === '$' && value[index + 1] === '('))
    ) return true;
    // 二重引用符の中でも、command置換と `${...}` 展開はそのまま動く。
    if (
      kinds[index] === 'quoted' &&
      quotes[index] === '"' &&
      (character === '`' || (character === '$' && ['(', '{'].includes(value[index + 1])))
    ) return true;
  }
  return false;
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
// 見える。書き込み先は字面と実体の両方で判定し、どちらかが守るべきツリーへ抜けるなら
// 拒否する。守る側は主作業ツリーだけでなく、兄弟worktreeも含む複数の根になりうる。
function escapesWorktree(workspace, shared, target) {
  const sharedRoots = [];
  for (const root of Array.isArray(shared) ? shared : [shared]) {
    sharedRoots.push(path.resolve(root), realPath(root));
  }
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
  const { kinds } = scanQuoting(value);
  const segments = [];
  let current = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    // 区切りとして働くのは、引用もエスケープもされていない演算子だけである。
    if (kinds[index] === 'operative' && SEGMENT_SEPARATORS.includes(character)) {
      const doubled = value[index + 1] === character && kinds[index + 1] === 'operative';
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
  const value = String(segment || '');
  const { kinds } = scanQuoting(value);
  const parts = [];
  let current = null;
  const start = () => {
    if (current === null) current = { value: '', quoted: [] };
  };
  for (let index = 0; index < value.length; index += 1) {
    const kind = kinds[index];
    // 引用符とバックスラッシュ自身は語に残らないが、`""` のような空の語は語として数える。
    if (kind === 'syntax') {
      start();
      continue;
    }
    if (kind === 'operative' && /\s/.test(value[index])) {
      if (current !== null) parts.push(current);
      current = null;
      continue;
    }
    // エスケープされた文字も引用された文字と同じく、演算子ではなく語の一部である。
    start();
    current.value += value[index];
    current.quoted.push(kind !== 'operative');
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
  // 語のどの文字が引用されていたかは、後段の展開判定で要る。語を組み立てる間、同じ順で
  // 引用状態も持ち回る。
  let bufferQuoted = [];
  let pending = null;
  const flush = () => {
    if (pending) items.push({ operator: pending, target: buffer });
    else if (buffer) items.push({ word: buffer, quoted: bufferQuoted });
    pending = null;
    buffer = '';
    bufferQuoted = [];
  };
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (!quoted[index] && (character === '>' || character === '<')) {
      let operator = character;
      if (!quoted[index + 1] && value[index + 1] === character) {
        operator += character;
        index += 1;
      }
      if (!pending && (/^\d+$/.test(buffer) || buffer === '&')) {
        buffer = '';
        bufferQuoted = [];
      }
      flush();
      pending = operator;
      continue;
    }
    buffer += character;
    bufferQuoted.push(Boolean(quoted[index]));
  }
  flush();
  return items;
}

// globが広がる範囲の根。`node_modules/*` なら `node_modules`、`*` だけなら実行directory
// そのものである。globは `..` へは展開されないので、展開後のpathはこのprefixの下に留まる。
function globPrefix(value) {
  const segments = String(value || '').split(/[\\/]/);
  const index = segments.findIndex(segment => /[*?[\]]/.test(segment));
  if (index < 0) return String(value || '');
  return index === 0 ? '.' : segments.slice(0, index).join(path.sep);
}

// 引用されていないglobとbrace展開を持つ語かどうか。`rm -rf ../*/src` は共有ツリーの
// srcへ広がるが、引用された `git commit -m "why?"` は語のまま渡る。字面のpathだけで
// 境界を測ると前者を見落とすので、展開しうる語を別に見分ける。
function hasUnquotedExpansion(item) {
  const value = String(item && item.word || '');
  const quoted = (item && item.quoted) || [];
  for (let index = 0; index < value.length; index += 1) {
    if (!quoted[index] && SHELL_EXPANSION_CHARACTERS.includes(value[index])) return true;
  }
  return false;
}

// リダイレクトはcommandの種類に関わらずファイルを作る。`git status > src/x` のように
// 読み取りcommandでも共有ツリーへ書けるので、書き込み先だけを取り出して別に検査する。
function scanRedirections(parts) {
  const tokens = [];
  const writes = [];
  // 展開しうる語は、同じ字面の語が引用付きで現れても展開する側に寄せて数える。
  const expanded = new Set();
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
      if (hasUnquotedExpansion(item)) expanded.add(item.word);
    }
  }
  if (awaiting) writes.push('');
  return { tokens, writes, expanded };
}

// 展開が必要なtokenは実際のdirectoryを決められない。追跡不能をnullで表し、
// worktreeの中だと決めつけない。glob（`*` `?` `[…]`）とbrace展開（`{a,b}`）は、字面とは
// 別の名前へ広がるため、字面で境界を測っても意味がない。
function resolveDirectory(base, target) {
  const value = String(target || '');
  if (!value || /[$`~*?[\]{}]/.test(value)) return null;
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
  if (/[$`~*?[\]{}]/.test(value)) return '';
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

// ECC自身のcommandでも、`--cwd <共有ツリー>` を渡せば隔離した先ではなくそのpathで走る。
// 明示的な実行directoryは、記録済みworktreeの中を指す場合だけ通す。値を読み取れない形は
// どこで走るか決まらないので拒否する。
function toolWorkspaceOptions(tokens, base, workspace) {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = String(tokens[index] || '');
    const name = token.split('=')[0];
    if (name !== '--cwd' && name !== '-C') continue;
    const value = token.includes('=') ? token.slice(token.indexOf('=') + 1) : tokens[index + 1];
    if (!confinedToWorktree(workspace, resolveDirectory(base, value))) return false;
  }
  return true;
}

// worktreeの中で走ると読み取れても、commandの引数は外のpathを指せる
// （`cd <worktree> && rm -rf <共有ツリー>/src`、`ln -s <共有ツリー> link`）。実行位置だけで
// 任意のcommandを通さず、語として現れるpathを実行directoryから解決し、守る根へ届く形を
// 拒否する。`--name=<path>` のように値を抱えた形も同じに見る。
// 先頭の `~` と変数展開は展開結果が決まらないので、worktreeの中だと言い切れず拒否する。
// 引用されていないglobは字面のままでは判定できない。`../../*/src` は字面としては守る根の
// どれも指さないのに、展開されると共有ツリーのsrcへ届く。globが広がる範囲は、glob要素より
// 前のpath（prefix）の下に限られるので、そのprefixがworktreeの中にあることを求める。
function confinedOperands(tokens, base, workspace, shared, expanded) {
  for (const token of tokens) {
    const value = String(token || '');
    if (!value) continue;
    const separator = value.indexOf('=');
    const candidates = separator > 0 ? [value, value.slice(separator + 1)] : [value];
    for (const candidate of candidates) {
      if (!candidate) continue;
      if (candidate.startsWith('~') || candidate.includes('$')) return false;
      if (expanded && expanded.has(value)) {
        // brace展開は `{..,x}` のように上へ抜ける語も作るため、広がる範囲を決められない。
        if (/[{}]/.test(candidate)) return false;
        if (!confinedToWorktree(workspace, path.resolve(base, globPrefix(candidate)))) return false;
        continue;
      }
      if (escapesWorktree(workspace, shared, path.resolve(base, candidate))) return false;
    }
  }
  return true;
}

function runsInlineCode(name, args) {
  const inline = INLINE_CODE_COMMANDS.get(name);
  if (!inline) return false;
  return args.some(argument => {
    const value = String(argument || '');
    if (inline.options.has(value.split('=')[0])) return true;
    // `node -pe "…"` のようにまとめて書いた短いoptionも、引数のcodeを実行する。
    return inline.letters !== '' && /^-[A-Za-z]+$/.test(value) &&
      [...value.slice(1)].some(letter => inline.letters.includes(letter));
  });
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

// 実行directoryがworktreeの中でも通してはいけない書き込みか。gitのref領域と設定は
// common-dirで共有されるため、worktreeの中から走らせても共有ツリーと兄弟worktreeに届く。
function writesSharedGitState(subcommand, args) {
  const name = String(subcommand || '');
  // 読み取りsubcommandは、引数次第でファイルを作り外部programを起動することはあっても
  // （`git diff --output=…`）、refや設定は書き換えない。その書き込み先は実行directoryと
  // 引数の境界検査が守るので、ここでは共有領域への書き込みとして扱わない。
  if (!GIT_WORKTREE_LOCAL_SUBCOMMANDS.has(name) && !GIT_READ_SUBCOMMANDS.has(name)) return true;
  const values = args.map(argument => String(argument || ''));
  if (
    GIT_FORCE_CREATE_SUBCOMMANDS.has(name) &&
    values.some(value => /^-[BC]/.test(value) || value.split('=')[0] === '--force-create')
  ) return true;
  // optionではない語の `:` は、書き込み先のrefを名指しするrefspecか、remoteをURLで直に
  // 指す形である。どちらもremoteが自リポジトリかどうかをcommand文字列からは決められない。
  return GIT_REFSPEC_SUBCOMMANDS.has(name) &&
    values.some(value => !value.startsWith('-') && value.includes(':'));
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
  let untraceable = false;
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
    // 設定の上書きは、実行directoryがworktreeのままでもgitの書き込み先と、gitが起動する
    // programを差し替える（`core.worktree`、`alias.x=!<command>`、`include.path`、
    // `diff.external`）。安全な鍵を列挙しても、aliasやincludeが指す先の中身までは
    // command文字列から読めない。鍵を問わず追跡不能として扱い、読み取りsubcommandでも
    // 通さない。
    if (arg === '-c' || arg.split('=')[0] === '--config-env') {
      location = null;
      untraceable = true;
      index += arg.includes('=') ? 1 : 2;
      continue;
    }
    if (arg.startsWith('-c') && arg.length > 2) {
      location = null;
      untraceable = true;
      index += 1;
      continue;
    }
    // 作業ツリーやgit dir、gitが起動するprogramの置き場所を差し替えるglobal optionも、
    // 読み取りsubcommandを名乗る形（`git --exec-path=<dir> status`）で任意のprogramを
    // 走らせられる。読み取り扱いをやめて追跡不能にする。
    if (GIT_UNTRACEABLE_OPTIONS.has(arg.split('=')[0])) {
      location = null;
      untraceable = true;
      index += arg.includes('=') ? 1 : 2;
      continue;
    }
    index += 1;
  }
  const subcommand = args[index];
  const rest = args.slice(index + 1);
  if (!untraceable && isReadOnlyGit(subcommand, rest)) return { write: false, location, subcommand, args: rest };
  // common-dirの共有領域への書き込みは、worktreeの中で走っても隔離の外に効く。refを直接
  // 動かす形（`git update-ref`、`git branch -f`、`git tag -f`）は共有ツリーのHEADが指す
  // branchを実行中に付け替え、設定への書き込みは `alias.x=!<command>` や `include.path` と
  // して残り、後のgitに共有ツリーへ届くcommandを起動させる。実行directoryでは正当化
  // できないので、locationを持たせずに拒否させる。
  if (writesSharedGitState(subcommand, rest)) return { write: true, location: null, subcommand, args: rest };
  // subcommandより前の引数に展開が残っていると、どのツリーを書き換えるか決まらない。
  // subcommand以降はcommit messageなどが入るため、実行directoryの判定には使わない。
  if (args.slice(0, index + 1).some(arg => /[$`]/.test(arg))) {
    return { write: true, location: null, subcommand, args: rest };
  }
  return { write: true, location, subcommand, args: rest };
}

// このsegmentが、後続のcommandに残るshellの状態を書き換えるか。
function mutatesShellState(name, args) {
  if (SHELL_STATE_COMMANDS.has(name)) return true;
  // `printf -v VAR …` はprintf自身の出力ではなく、shell変数への代入である。
  return name === 'printf' && args.some(argument => /^-[A-Za-z]*v/.test(String(argument || '')));
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
  // 守る境界はGitの主作業ツリーと兄弟worktreeの根であって、hookに渡されたcwdではない。
  // subdirectoryを実行directoryにすると、`../../src/x` が境界の外に見えてしまう。
  const shared = (Array.isArray(options.shared) ? options.shared : [options.shared || start]).map(root =>
    path.resolve(root)
  );
  // 引用が閉じない、行末がバックスラッシュで終わるといった読み切れない形は、どこからが
  // 次のcommandなのかを決められない。共有ツリーを書き換えないとは言えないので拒否する。
  if (!scanQuoting(command).valid) return false;
  let current = start;
  // 直前までのsegmentがこのshellの変数や別名を書き換えたか。書き換えた後は、command名が
  // どの実行ファイルへ解決されるかをcommand文字列から読めない。
  let shellStateMutated = false;
  for (const { text, separator } of splitCommand(command)) {
    // 展開してからでないと、何がどのdirectoryで走るか決まらない。
    if (UNTRACEABLE_EXPANSION.test(text)) return false;
    const { tokens, writes, expanded } = scanRedirections(tokenizeParts(text));
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
    const assignments = [];
    while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
      // GIT_DIR や GIT_WORK_TREE はgit自身の書き込み先を差し替える。
      if (/^GIT_/i.test(tokens[0])) return false;
      overridesEnvironment = true;
      assignments.push(tokens.shift());
    }
    const executable = tokens[0];
    const name = commandName(executable);
    // 語を持たない代入だけのsegment（`PATH=<worktree>` 単独）は、このshellに値を残す。
    // 何も実行しないのでここでは拒否せず、以後のcommandを共有ツリーで通さない。
    if (!name) {
      if (overridesEnvironment) shellStateMutated = true;
      continue;
    }
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
    // 変数を書き換えた後の共有ツリーは、`git` や `cat` という名前が本当にそのprogramだと
    // 言えない（`printf -v PATH <worktree>` の後の `git status` はworktreeの同名ファイルを
    // 起動しうる）。worktreeの中で走ることが読み取れるcommandだけを通す。
    if (shellStateMutated && !inWorktree) return false;
    if (mutatesShellState(name, tokens.slice(1))) shellStateMutated = true;
    if (name === 'git') {
      // pathを付けたgit（`/usr/bin/git`、`./git`）は、名前がgitのままGit専用検査を素通りし、
      // worktreeの中で走ることだけを根拠に一般commandとして通ってしまう。本物のgitなら
      // `update-ref refs/heads/main` や `config` がcommon-dirの共有領域へ届き、worktreeの外に
      // 効く書き込みになる。実体が本当にgitかどうかもcommand文字列からは決められないので、
      // pathを付けた形は実行位置を問わず拒否し、素の `git` として書き直させる。
      if (!isBareCommand(executable)) return false;
      const { write, location, args } = gitInvocation(tokens.slice(1), current);
      if (write && !confinedToWorktree(workspace, location)) return false;
      // worktreeで走るgitでも、引数は外のpathを指せる（`git diff --output=<共有ツリー>/x`）。
      // subcommand以降の引数はgitの実行directoryから解決して境界を検査する。
      if (write && !confinedOperands(args, location, workspace, shared, expanded)) return false;
      continue;
    }
    // ECC自身のcommandは記録済みDeliveryのworktreeを解決して、そこだけを読み書きする。
    // 実行位置が共有ツリーでもworktreeでも、明示的な実行directoryが外を指さない限り通す。
    if (isWorktreeAwareTool(tokens, current, env)) {
      if (!toolWorkspaceOptions(tokens, current, workspace)) return false;
      continue;
    }
    if (inWorktree) {
      // 実行位置がworktreeの中でも、引数は共有ツリーや兄弟worktreeを指せる。実行位置
      // だけで任意のcommandを通さない。
      if (runsInlineCode(name, tokens.slice(1))) return false;
      // 副作用がないと引数まで確認できた読み取りは、共有ツリーのファイルを引数に取っても
      // 何も書き換えない。環境変数の前置きがあると、どのprogramが走るか決まらない。
      if (!overridesEnvironment && isBareCommand(executable) && isReadOnlyShellCommand(name, tokens.slice(1))) continue;
      if (!confinedOperands([...assignments, ...tokens], current, workspace, shared, expanded)) return false;
      continue;
    }
    // git以外のcommandも共有ツリーのファイルを書き換える。worktreeの中で走ることが
    // 読み取れないなら、引数まで見て副作用がないと言える読み取りcommandだけを通す。
    if (!isBareCommand(executable) || !isReadOnlyShellCommand(name, tokens.slice(1))) return false;
  }
  return true;
}

// 記録済みworktreeが別branchにある間に通してよいcommandか。worktreeの中で走ることだけを
// 条件にすると、誤ったbranchのまま編集も削除もコミットもできてしまう（`cd <worktree> &&
// rm -rf src`）。ここでは期待branchへ戻す `git switch`／`git checkout` と、状況を確かめる
// 読み取りだけを認める。実際にそのcommandがworktreeの中で走るかどうかは、
// targetsWorkspaceが別に判定する。
function isBranchRestoreCommand(command, branch, cwd) {
  const expected = String(branch || '');
  if (!expected || !scanQuoting(command).valid) return false;
  for (const text of splitSegments(command)) {
    if (UNTRACEABLE_EXPANSION.test(text)) return false;
    const { tokens, writes } = scanRedirections(tokenizeParts(text));
    // 復旧の途中でファイルを作る必要はない。
    if (writes.length > 0) return false;
    // 環境変数の前置きは、どのprogramが走るかを変える。
    if (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(String(tokens[0]))) return false;
    const name = commandName(tokens[0]);
    if (!name) continue;
    // 実行directoryの移動そのものは、何も書き換えない。
    if (name === 'cd' || name === 'pushd' || name === 'popd') continue;
    if (name === 'git' && isBareCommand(tokens[0])) {
      const { write, subcommand, args } = gitInvocation(tokens.slice(1), cwd);
      if (!write) continue;
      if (subcommand !== 'switch' && subcommand !== 'checkout') return false;
      // 引数は期待branchちょうどに限る。`-B`、`--detach`、pathspecを許すと、復旧の顔で
      // 別branchの作成やファイルの巻き戻しが通る。
      if (args.length !== 1 || args[0] !== expected) return false;
      continue;
    }
    if (!isBareCommand(tokens[0]) || !isReadOnlyShellCommand(name, tokens.slice(1))) return false;
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
  // ただしcommandの形だけでは、そのscriptがECC自身のものだとは言えない。
  // `scripts/codex/reset.js` はprojectの中にも同じ名前で置けるため、名前の一致で通すと、
  // Gateが止めているはずの共有ツリーへの書き込みが復旧commandの顔で走ってしまう。
  // 実体pathがこのplugin自身のscriptと一致する場合だけ、Deliveryの状態を問わず復旧と認める。
  const isLifecycleRecovery = isLifecycleCommand && isWorktreeAwareTool(tokenize(command), cwd, env);

  if (state.delivery.status !== 'ready') {
    const permissionMode = String(input.permission_mode || input.permissionMode || '').toLowerCase();
    // Plan mode中はClaude自身のread-only制約に任せて調査を許可する。承認後は同じ
    // deferred stateが残るため、最初のBash/Edit/Writeをprepare完了までfail-closeする。
    if (state.delivery.status === 'deferred' && permissionMode === 'plan') return rawInput;
    // prepare前は隔離すべきworktreeがまだ無いが、共有ツリーは既に守る対象である。
    // 実体がplugin自身のscriptだと確認できたprepare／resetだけを通す。
    if (isLifecycleRecovery) return rawInput;
    return deny(
      '[ECC Delivery Gate] Repository tools are blocked until duplicate Issue search, Issue selection/creation, and the issue-linked worktree are recorded. ' +
        'Preparation never switches the shared working tree; it checks the issue-linked branch out in a separate worktree and reports that path. ' +
        `Run node "${prepareScript}" prepare --session "${sessionId}" first, then continue this delivery inside the reported worktree path. ` +
        `If the recorded Delivery is stale or unrecoverable, explicitly reset it with node "${resetScript}" "${sessionId}". ` +
        "Only those exact script paths are accepted here: a same-named script that is not this plugin's own file is rejected."
    );
  }

  const workspace = deliveryWorkspace(state, cwd);
  // worktree払い出し以前に `ready` となったDeliveryは、共有作業ツリーの上で進んでいる。
  // 記録済みのIssueとbranchのままprepareを実行すれば専用worktreeへ移せるので、移行が
  // 済むまでprepareとreset以外を止める。ここを通すと、Issueが報告した衝突経路が
  // 移行期のDeliveryにだけ残り続ける。
  if (!workspace && needsWorktreeMigration(state.delivery)) {
    if (isLifecycleRecovery) return rawInput;
    return deny(
      `[ECC Delivery Gate] Issue #${state.delivery.issue_number} was prepared before deliveries were isolated, so no worktree is bound to it and work would land in the shared working tree. ` +
        `Run node "${prepareScript}" prepare --session "${sessionId}" to check the recorded branch ${state.delivery.branch} out in its own worktree, then continue there. ` +
        'Preparation keeps the recorded Issue and branch; if the shared working tree still has that branch checked out, commit that work or set it aside yourself outside this session, then switch it to another branch first. ' +
        `If the recorded Delivery is stale or unrecoverable, explicitly reset it with node "${resetScript}" "${sessionId}". ` +
        "Only those exact script paths are accepted here: a same-named script that is not this plugin's own file is rejected."
    );
  }
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
  // 守る境界はGitの主作業ツリーと兄弟worktreeの根であって、hookに渡されたcwdではない。
  // 判定に必要になったときだけ解決し、Deliveryごとに一度で済ませる。
  let sharedCache = null;
  const shared = () => {
    if (!sharedCache) sharedCache = protectedRoots(cwd, env, config.projectRoot, workspace);
    return sharedCache;
  };
  // 隔離が成立しているかは、Deliveryがworktreeを記録しているかで決まる。cwdがworktreeと
  // 違うかどうかで判定すると、手順書どおりworktreeの中から起動した通常経路で境界検査が
  // まるごと消え、共有ツリーへの絶対path書き込みも `git -C <共有ツリー>` も素通りする。
  const isolated = Boolean(state.delivery.worktree_path);
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
      isolated &&
      isBranchRestoreCommand(command, state.delivery.branch, cwd) &&
      targetsWorkspace(command, workspace, cwd, { shared: shared(), env })
    ) {
      return rawInput;
    }
    return deny(
      `[ECC Delivery Gate] Expected issue-linked branch ${state.delivery.branch} in ${workspace}, but its current branch is ${actualBranch || '<none>'}. ` +
        `Restore it with \`git -C "${workspace}" switch ${state.delivery.branch}\` before editing; ` +
        'until that branch is back, this gate only allows that exact switch and side-effect-free inspection inside the worktree, ' +
        'and it never falls back to the shared working tree.'
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
  if (isolated) {
    const sharedTree = shared();
    if (isEdit) {
      // 払い出したworktreeの外へ書くと、隔離したはずの共有ツリーや兄弟worktreeを再び
      // 変更してしまう。守る根の配下だけを拒否し、リポジトリ外のファイルは従来どおり
      // 素通しする。相対pathはtoolの実行directoryから解決する。
      const targets = writeTargets(input.tool_input).map(target => path.resolve(cwd, target));
      if (targets.length === 0) {
        return deny(
          `[ECC Delivery Gate] ${toolName} did not name a file to write, so this gate cannot tell whether it stays inside the delivery worktree ${workspace}. ` +
            'Reissue the edit with an explicit absolute path inside that worktree.'
        );
      }
      const outside = targets.find(target => escapesWorktree(workspace, sharedTree, target));
      if (outside) {
        // symlinkで抜ける経路は、守る根からの相対pathに置き換えられない。その場合は
        // 具体的な代替pathを示さず、worktreeの中で書き直させる。
        const container = sharedTree.find(root => isInside(root, outside));
        const relative = container ? path.relative(container, outside) : '';
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
          'Running inside that worktree is not enough on its own: every argument must resolve inside it, ' +
          'so a path that reaches the shared working tree or a sibling worktree (`rm -rf <shared>/src`, `ln -s <shared> link`, ' +
          '`git diff --output=<shared>/file`), an argument only a shell expansion could resolve (`$VAR`, `~/…`), ' +
          'a glob whose expansion can leave the worktree (`rm -rf ../../*/src`) or any brace expansion (`{a,b}`), ' +
          'a write to this shell\'s variables that changes how later commands resolve (`export`, `set`, a bare `PATH=…`, `printf -v PATH …`), ' +
          'and inline code (`node -e`, `python -c`) are rejected. ' +
          'In the shared working tree only side-effect-free inspection is allowed (read-only `git` subcommands, `ls`, `cat`, `grep`, …), ' +
          'checked argument by argument, so an option that writes a file or starts another program (`sort -o …`, `rg --pre …`) is rejected, ' +
          "and ECC's own worktree-aware commands (`scripts/codex/run-role.js`, …) only when the script is this plugin's own file, " +
          'with no output redirection into that tree and no `--cwd` outside the delivery worktree. ' +
          'Forms whose working tree cannot be read from the command itself are rejected: wrappers such as `sh -c` or `xargs`, ' +
          'command substitution and `${...}` expansion, `--git-dir`/`--work-tree`/`GIT_*` overrides, ' +
          'any `-c <key>=<value>`/`--config-env` override and `git config` itself (an alias or `include.path` can point Git back at the shared tree), ' +
          'a command started through a path instead of a bare name (`/usr/bin/git`, `./git`, `<worktree>/sort`), ' +
          'which for `git` is rejected inside the worktree as well because the Git-specific checks below cannot be tied to it, ' +
          'a `cd` that is not chained with `&&`, ' +
          'and quoting the gate cannot parse (an unclosed quote or a trailing backslash). ' +
          'Every Git write that lands in the shared common directory instead of this worktree is rejected as well, even from inside it, ' +
          'because refs and configuration are shared with the tree that has another branch checked out: ' +
          '`git update-ref`, `git branch -f`, `git tag`, `git symbolic-ref`, `git remote`, `git notes`, `git worktree`, ' +
          '`git checkout -B`/`git switch -C`, a `<src>:<dst>` refspec (`git push . HEAD:main`) and any subcommand this gate does not know. ' +
          '`git stash` is rejected there too, in every writing form (`push`, `pop`, `drop`, `clear`): the single shared `refs/stash` ' +
          'also holds what another worktree put aside, so only `git stash list` is allowed; commit on the delivery branch to set work aside. ' +
          'The same boundary applies when this session already runs inside the worktree: the shared working tree and every sibling worktree stay protected.'
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
  isBranchRestoreCommand,
  isExactLifecycleCommand,
  isInside,
  run,
  splitSegments,
  targetsWorkspace,
  tokenize,
  writeTargets
};
