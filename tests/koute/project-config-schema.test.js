#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Ajv2020 = require('ajv/dist/2020');

const schema = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'schemas', 'ecc-project-config.schema.json'), 'utf8')
);
const validate = new Ajv2020({ strict: false }).compile(schema);

function config(voice) {
  return {
    version: 1,
    profile: 'standard',
    rulePacks: ['common', 'typescript', 'react', 'nextjs'],
    codexSandbox: 'required',
    legacyHarness: 'replace',
    devcontainer: { service: 'app', voice }
  };
}

assert.strictEqual(validate(config({ mode: 'disabled' })), true, JSON.stringify(validate.errors));
assert.strictEqual(validate(config({ mode: 'docker-desktop' })), true, JSON.stringify(validate.errors));
assert.strictEqual(
  validate(config({ mode: 'rancher-desktop', wslDistribution: 'Ubuntu-24.04', port: 24713 })),
  true,
  JSON.stringify(validate.errors)
);
assert.strictEqual(validate(config({ mode: 'rancher-desktop' })), false);
assert.strictEqual(
  validate(config({ mode: 'rancher-desktop', wslDistribution: 'Ubuntu', port: 4713 })),
  false
);
assert.strictEqual(validate(config({ mode: 'auto' })), false);
assert.strictEqual(validate(config({ mode: 'docker-desktop', unexpected: true })), false);

function delivery(overrides) {
  return { ...config({ mode: 'disabled' }), deliveryWorkflow: 'required', ...overrides };
}

const mergeGate = {
  provider: 'commit-status',
  command: 'engineering-kit-merge-gate',
  adapter: 'scripts/ci/project-verify.sh',
  statusContext: 'Local Merge Gate',
  strategy: 'squash'
};

// squash-merge を使うプロジェクト設定がスキーマ検証を通ること。実装がこの2キーを
// 読む以上、additionalProperties: false のまま宣言がないと検証が破綻する。
assert.strictEqual(
  validate(delivery({ deliveryCompletion: 'squash-merge', mergeGate })),
  true,
  JSON.stringify(validate.errors)
);
assert.strictEqual(validate(delivery({ deliveryCompletion: 'draft-pr' })), true, JSON.stringify(validate.errors));
assert.strictEqual(validate(delivery({ deliveryCompletion: 'web-ui' })), false);
assert.strictEqual(validate(delivery({ mergeGate: { ...mergeGate, strategy: 'rebase' } })), false);
assert.strictEqual(validate(delivery({ mergeGate: { ...mergeGate, provider: 'workflow' } })), false);
assert.strictEqual(validate(delivery({ mergeGate: { ...mergeGate, unexpected: true } })), false);

process.stdout.write('ECC project config voice schema tests passed\n');
