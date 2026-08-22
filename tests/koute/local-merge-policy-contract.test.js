#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const policy = require('../../scripts/hooks/local-merge-policy-gate');
const completion = require('../../scripts/hooks/delivery-completion-gate');
const { writeState } = require('../../scripts/codex/runtime-state');
const { executableInvocations } = require('../../scripts/lib/shell-invocations');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`✓ ${name}`); }
  catch (error) { failed += 1; console.error(`✗ ${name}\n${error.stack}`); }
}

test('説明文やquoted heredoc内のgh pr mergeを操作と誤認しない', () => {
  assert.strictEqual(policy.isMergeInvocation("echo 'gh pr merge 1 --squash'"), false);
  assert.strictEqual(policy.isMergeInvocation("cat <<'EOF'\ngh pr merge 1 --squash\nEOF"), false);
});

test('実コマンド、shell wrapper、展開されるheredocは検出する', () => {
  assert.strictEqual(policy.isMergeInvocation('gh pr merge 1 --squash'), true);
  assert.strictEqual(policy.isMergeInvocation("bash -c 'gh pr merge 1 --squash'"), true);
  assert.strictEqual(policy.isMergeInvocation('cat <<EOF\n$(gh pr merge 1 --squash)\nEOF'), true);
  assert.strictEqual(policy.isMergeInvocation('if gh pr merge 1 --squash; then echo ok; fi'), true);
  assert.strictEqual(policy.isMergeInvocation('! gh pr merge 1 --squash'), true);
  assert.strictEqual(policy.isMergeInvocation('{ gh pr merge 1 --squash; }'), true);
  assert.strictEqual(policy.isMergeInvocation("bash -lc 'gh pr merge 1 --squash'"), true);
  assert.strictEqual(policy.isMergeInvocation('(gh pr merge 1 --squash)'), true);
  assert.strictEqual(policy.isMergeInvocation('f(){ gh pr merge 1 --squash; }; f'), true);
  assert.strictEqual(policy.isMergeInvocation('env -i gh pr merge 1 --squash'), true);
  assert.strictEqual(policy.isMergeInvocation('gh -R acme/repo pr merge 1 --squash'), true);
  assert.strictEqual(policy.isMergeInvocation('gh pr --repo acme/repo merge 1 --squash'), true);
  assert.strictEqual(policy.isMergeInvocation('exec gh pr merge 1 --squash'), true);
  assert.strictEqual(policy.isMergeInvocation('nohup gh pr merge 1 --squash'), true);
  assert.strictEqual(policy.isMergeInvocation("eval 'gh pr merge 1 --squash'"), true);
  assert.strictEqual(policy.isMergeInvocation('>/tmp/merge.log gh pr merge 1 --squash'), true);
  assert.strictEqual(policy.isMergeInvocation('time gh pr merge 1 --squash'), true);
  assert.strictEqual(policy.isMergeInvocation("cat <<'EOF'; gh pr merge 1 --squash\n説明\nEOF"), true);
  assert.strictEqual(policy.isMergeInvocation('echo "<<EOF"\ngh pr merge 1 --squash'), true);
  assert.ok(executableInvocations('echo $(( $(gh pr merge 1 --squash) + 1 ))').some(item => item.executable === 'gh'));
});

test('success statusは実際のgh api呼び出しだけを拒否する', () => {
  assert.strictEqual(policy.isDirectSuccessStatus("echo 'gh api repos/x/y/statuses/abc -f state=success'"), false);
  assert.strictEqual(policy.isDirectSuccessStatus('gh api repos/x/y/statuses/abc -f state=success'), true);
  assert.strictEqual(policy.isDirectSuccessStatus("printf '{\"state\":\"success\"}' | gh api repos/x/y/statuses/abc --input -"), true);
  assert.strictEqual(policy.isDirectSuccessStatus('gh api repos/x/y/statuses/abc --input payload.json'), true);
  assert.strictEqual(policy.isDirectSuccessStatus('gh api repos/x/y/statuses/abc -fstate=success'), true);
  assert.strictEqual(policy.isDirectSuccessStatus("bash -lc 'gh api repos/x/y/statuses/abc -f state=success'"), true);
  assert.strictEqual(policy.isDirectSuccessStatus('gh --repo acme/repo api repos/x/y/statuses/abc -f state=success'), true);
  assert.strictEqual(policy.isDirectSuccessStatus("curl -d '{\"state\":\"success\"}' https://api.github.com/repos/x/y/statuses/abc"), true);
  assert.strictEqual(policy.isDirectSuccessStatus("curl --json '{\"state\":\"success\"}' https://api.github.com/repos/x/y/statuses/abc"), true);
  assert.strictEqual(policy.isDirectSuccessStatus('curl -X POST https://api.github.com/repos/x/y/statuses/abc'), true);
  assert.strictEqual(policy.isDirectSuccessStatus('curl -XPOST https://api.github.com/repos/x/y/statuses/abc'), true);
  assert.strictEqual(policy.isDirectSuccessStatus("curl -d'{\"state\":\"success\"}' https://api.github.com/repos/x/y/statuses/abc"), true);
  assert.strictEqual(policy.isDirectSuccessStatus('curl -Fstate=success https://api.github.com/repos/x/y/statuses/abc'), true);
  assert.strictEqual(policy.isDirectSuccessStatus('curl -Tpayload https://api.github.com/repos/x/y/statuses/abc'), true);
  assert.strictEqual(policy.isDirectSuccessStatus('wget --post-data payload https://api.github.com/repos/x/y/statuses/abc'), true);
  assert.strictEqual(policy.isDirectSuccessStatus('wget --method POST --body-data=payload https://api.github.com/repos/x/y/statuses/abc'), true);
  assert.strictEqual(policy.isDirectSuccessStatus('http https://api.github.com/repos/x/y/statuses/abc state=success'), true);
  assert.strictEqual(policy.isDirectSuccessStatus('xh https://api.github.com/repos/x/y/statuses/abc state=success'), true);
  assert.strictEqual(policy.isDirectSuccessStatus('gh api repos/x/y/statuses/abc --method GET'), false);
});

test('記録済みsquash契約は現在の設定で無効化できない', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-merge-policy-sticky-'));
  fs.mkdirSync(path.join(cwd, '.ecc'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.ecc', 'config.json'), JSON.stringify({ deliveryCompletion: 'draft-pr' }));
  const env = { ...process.env, ECC_KOUTE_STATE_DIR: path.join(cwd, 'state') };
  const input = { session_id: 'sticky-policy', cwd };
  writeState(input, { delivery: { workflow_mode: 'required', completion_method: 'squash-merge' } }, env);
  const denied = JSON.parse(policy.run(JSON.stringify({
    ...input,
    tool_name: 'Bash',
    tool_input: { command: 'gh pr merge 12 --squash' }
  }), { cwd, env }));
  assert.strictEqual(denied.hookSpecificOutput.permissionDecision, 'deny');
});

test('既merge PRもmergeCommitを再取得して復旧する', () => {
  const calls = [];
  const result = completion.completeBySquashMerge((binary, args) => {
    calls.push(`${binary} ${args.join(' ')}`);
    if (args[0] === 'repo') return { ok: true, stdout: 'acme/repo', stderr: '' };
    if (args[0] === 'api') return { ok: true, stdout: JSON.stringify({ sha: 'abc', statuses: [{ context: 'Local Merge Gate', state: 'success' }] }), stderr: '' };
    if (args[0] === 'pr' && args[1] === 'view') return {
      ok: true,
      stdout: JSON.stringify({ number: 12, state: 'MERGED', isDraft: false, headRefOid: 'abc', url: 'https://example.invalid/pull/12', mergeCommit: { oid: 'merged' } }),
      stderr: ''
    };
    return { ok: false, stdout: '', stderr: 'unexpected call' };
  }, {
    mergeGate: { provider: 'commit-status', strategy: 'squash', statusContext: 'Local Merge Gate' }
  }, {}, { number: 12, state: 'MERGED', headRefOid: 'abc' }, 'abc', '.', process.env);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.pr.mergeCommit.oid, 'merged');
  assert.ok(calls.some(call => call.includes('pr view 12')));
  assert.ok(!calls.some(call => call.includes('pr merge 12')));
});

test('Local Merge Gateのmissingとpendingは障害ではなく待機状態にする', () => {
  for (const statuses of [[], [{ context: 'Local Merge Gate', state: 'pending' }]]) {
    const result = completion.verifyCommitStatus((binary, args) => {
      if (args[0] === 'repo') return { ok: true, stdout: 'acme/repo', stderr: '' };
      return { ok: true, stdout: JSON.stringify({ sha: 'abc', statuses }), stderr: '' };
    }, { mergeGate: { statusContext: 'Local Merge Gate' } }, 'abc', '.', process.env);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.expectedProgress, true);
  }
});

console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exit(failed ? 1 : 0);
