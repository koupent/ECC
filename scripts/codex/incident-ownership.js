#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const OPERATOR_OWNER = 'engineering-environment-kit-operator';
const ALLOWED_REPOSITORIES = new Set([
  'koupent/engineering-environment-kit',
  'koupent/ECC'
]);

function readOperatorAttestation(env = process.env) {
  const stateRoot = String(env.ECC_OPERATOR_STATE_ROOT || '').trim();
  if (!stateRoot) throw new Error('central-remediateには専用operator state rootが必要です');
  const file = String(env.ECC_OPERATOR_ATTESTATION || '').trim();
  if (!file) throw new Error('central-remediateにはoperator attestationが必要です');
  const trustedRoot = fs.realpathSync(path.resolve(stateRoot));
  const resolved = fs.realpathSync(path.resolve(file));
  if (resolved !== trustedRoot && !resolved.startsWith(`${trustedRoot}${path.sep}`)) {
    throw new Error('operator attestationが専用state root外です');
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error('operator attestationが通常ファイルではありません');
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error('operator attestationの権限は0600である必要があります');
  }
  const value = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  if (value.schemaVersion !== 1 || value.owner !== OPERATOR_OWNER) {
    throw new Error('operator attestationの所有者またはschemaが不正です');
  }
  if (!Array.isArray(value.repositories) || value.repositories.some(repo => !ALLOWED_REPOSITORIES.has(repo))) {
    throw new Error('operator attestationに許可されていないrepositoryが含まれます');
  }
  return value;
}

function assertCentralRemediationAllowed({ mode, targetRepository, env = process.env }) {
  if (mode !== 'central-remediate') {
    throw new Error('incidentHandling.mode=report-onlyでは中央修正を開始できません');
  }
  if (!ALLOWED_REPOSITORIES.has(targetRepository)) {
    throw new Error(`中央修正対象として許可されていません: ${targetRepository}`);
  }
  const attestation = readOperatorAttestation(env);
  if (!attestation.repositories.includes(targetRepository)) {
    throw new Error(`operator attestationが対象repositoryを許可していません: ${targetRepository}`);
  }
  return attestation;
}

module.exports = {
  ALLOWED_REPOSITORIES,
  OPERATOR_OWNER,
  assertCentralRemediationAllowed,
  readOperatorAttestation
};
