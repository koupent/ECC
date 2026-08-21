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

test('recursion is bounded and empty input yields no commands', () => {
  assert.deepStrictEqual(extractInvocations(''), []);
  assert.deepStrictEqual(extractInvocations('   '), []);
  const deep = `${'$('.repeat(8)}gh pr merge 12${')'.repeat(8)}`;
  assert.ok(Array.isArray(extractInvocations(deep)));
});

process.stdout.write(`\nPassed: ${passed}\nFailed: ${failed}\n`);
process.exitCode = failed ? 1 : 0;
