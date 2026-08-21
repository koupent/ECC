#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { commandName, extractInvocations, stripHeredocBodies } = require('../../scripts/lib/shell-invocations');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (error) {
    failed += 1;
    process.stderr.write(`  ✗ ${name}: ${error.message}\n`);
  }
}

function commands(command) {
  return extractInvocations(command).map(invocation => invocation.command);
}

function runsPrMerge(command) {
  return extractInvocations(command).some(invocation =>
    invocation.command === 'gh' && invocation.args[0] === 'pr' && invocation.args[1] === 'merge');
}

process.stdout.write('\n=== ECC shell invocation extraction tests ===\n');

test('plain commands expose their command word and arguments', () => {
  const [invocation] = extractInvocations('gh pr merge 12 --squash');
  assert.strictEqual(invocation.command, 'gh');
  assert.deepStrictEqual(invocation.args, ['pr', 'merge', '12', '--squash']);
});

test('command words are compared by program name, not by path or extension', () => {
  assert.strictEqual(commandName('/usr/bin/gh'), 'gh');
  assert.strictEqual(commandName('C:\\Program Files\\GitHub CLI\\gh.exe'), 'gh');
  assert.strictEqual(extractInvocations('/usr/local/bin/gh pr merge 12')[0].command, 'gh');
});

test('heredoc bodies are data, not commands', () => {
  const command = [
    "cat > /tmp/issue-body.md <<'BODY'",
    '## 提案',
    'Local Merge Policy が `gh pr merge 12 --squash` を誤検出します。',
    'BODY',
    'gh issue create --title policy --body-file /tmp/issue-body.md'
  ].join('\n');
  assert.deepStrictEqual(commands(command), ['cat', 'gh']);
  assert.strictEqual(runsPrMerge(command), false);
  assert.ok(!stripHeredocBodies(command).includes('誤検出'));
});

test('an indented heredoc terminator closes a <<- body', () => {
  const command = ['\tcat <<-EOF', '\tgh pr merge 12', '\tEOF', '\tgit status'].join('\n');
  assert.deepStrictEqual(commands(command), ['cat', 'git']);
});

test('a here-string does not swallow the commands that follow it', () => {
  const command = 'grep -q merge <<< "gh pr merge 12"\ngh pr merge 12';
  assert.strictEqual(runsPrMerge(command), true);
  assert.deepStrictEqual(commands(command), ['grep', 'gh']);
});

test('a left shift is not read as a heredoc opener', () => {
  const command = 'echo $((1 << 2))\ngh pr merge 12';
  assert.strictEqual(runsPrMerge(command), true);
});

test('quoted argument values are single words, so documents are not commands', () => {
  for (const command of [
    'gh issue create --title policy --body "PRのmergeはCompletion Gateだけが実行できます: gh pr merge 12"',
    "printf '%s' 'gh pr merge 12' > notes.md",
    'gh pr view 12 --json state',
    'gh issue comment 69 --body "gh pr merge を直接実行しないでください"'
  ]) {
    assert.strictEqual(runsPrMerge(command), false, command);
  }
});

test('commands that really run are still found through operators and grouping', () => {
  for (const command of [
    'npm test && gh pr merge 12 --squash',
    'npm test; gh pr merge 12',
    'npm test || gh pr merge 12',
    'git push\ngh pr merge 12',
    'echo $(gh pr merge 12)',
    'echo "$(gh pr merge 12)"',
    'echo `gh pr merge 12`',
    '(cd repo && gh pr merge 12)',
    '{ gh pr merge 12; }',
    'gh pr merge 12 > merge.log 2>&1',
    '> merge.log gh pr merge 12',
    'GH_TOKEN=x gh pr merge 12',
    'env GH_TOKEN=x gh pr merge 12',
    'sudo gh pr merge 12',
    'nohup gh pr merge 12',
    'echo 12 | xargs gh pr merge',
    'bash -lc "gh pr merge 12"',
    "gh 'pr' merge 12",
    'gh pr\\ merge 12 && gh pr merge 12'
  ]) {
    assert.strictEqual(runsPrMerge(command), true, command);
  }
});

test('an unterminated heredoc keeps its body out of the executed commands', () => {
  const command = ["cat <<'EOF'", 'gh pr merge 12'].join('\n');
  assert.deepStrictEqual(commands(command), ['cat']);
});

test('reserved words and negation introduce a command instead of hiding it', () => {
  for (const command of [
    'if gh pr merge 12 --squash; then echo merged; fi',
    'if true; then gh pr merge 12; fi',
    'if false; then :; else gh pr merge 12; fi',
    '! gh pr merge 12',
    'while ! gh pr merge 12; do sleep 1; done',
    'until gh pr merge 12; do sleep 1; done',
    'for pr in 12; do gh pr merge "$pr"; done',
    'case 12 in 12) gh pr merge 12;; esac'
  ]) {
    assert.strictEqual(runsPrMerge(command), true, command);
  }
  // 条件式の中身はコマンドではない。普通の分岐まで解析不能として扱ってはいけない。
  assert.strictEqual(runsPrMerge('[[ "$mode" == squash ]] && gh pr merge 12'), true);
  assert.deepStrictEqual(commands('case "$mode" in squash) echo ok;; esac'), ['echo']);
});

test('eval runs its arguments, so they are a script rather than data', () => {
  for (const command of [
    'eval "gh pr merge 12 --squash"',
    "eval 'gh pr merge' 12",
    'eval "gh pr merge $NUMBER"'
  ]) {
    assert.strictEqual(runsPrMerge(command), true, command);
  }
  assert.throws(() => extractInvocations('eval "$(printf %s \'gh pr merge 12\')"'), /eval/);
});

test('a command word that only exists after expansion is not read as "no command"', () => {
  assert.throws(() => extractInvocations('$(printf %s gh) pr merge 12'), /展開後/);
  assert.throws(() => extractInvocations('$CMD pr merge 12'), /展開後/);
  assert.throws(() => extractInvocations('npm test && `printf %s gh` pr merge 12'), /展開後/);
  // 展開されるのが引数やpath前半なら、コマンド語は読める。
  assert.strictEqual(extractInvocations('"$HOME/bin/gh" pr merge 12')[0].command, 'gh');
  assert.strictEqual(extractInvocations('git commit -m "$(cat message.txt)"')[0].command, 'git');
});

test('ANSI-C and locale quoting resolve to the word bash runs', () => {
  for (const command of ["$'gh' pr merge 12", "gh $'pr' merge 12", "$'\\x67h' pr merge 12", '$"gh" pr merge 12']) {
    assert.strictEqual(runsPrMerge(command), true, command);
  }
  assert.strictEqual(extractInvocations("$'\\x67\\150' pr merge 12")[0].command, 'gh');
});

test('a wrapper option value does not shadow the command the wrapper runs', () => {
  for (const command of [
    'sudo -u ci gh pr merge 12',
    'env -u GH_TOKEN gh pr merge 12',
    'nice -n 10 gh pr merge 12',
    'timeout 30 gh pr merge 12',
    'xargs -I{} gh pr merge {} <<< 12',
    'sudo -u ci bash -lc "gh pr merge 12"'
  ]) {
    assert.strictEqual(runsPrMerge(command), true, command);
  }
});

test('input the parser cannot enumerate fails closed instead of reporting no commands', () => {
  assert.deepStrictEqual(extractInvocations(''), []);
  assert.deepStrictEqual(extractInvocations('   '), []);
  const deep = `${'echo $('.repeat(8)}gh pr merge 12${')'.repeat(8)}`;
  assert.throws(() => extractInvocations(deep), /入れ子が深すぎます/);
  const many = Array.from({ length: 600 }, () => 'gh pr merge 12').join('; ');
  assert.throws(() => extractInvocations(many), /上限/);
});

process.stdout.write(`\nPassed: ${passed}\nFailed: ${failed}\n`);
process.exitCode = failed ? 1 : 0;
