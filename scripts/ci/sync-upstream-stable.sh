#!/usr/bin/env bash
set -euo pipefail

UPSTREAM_REPOSITORY="affaan-m/ECC"
TRACKING_FILE=".github/upstream-stable.json"

if [[ "${FORK_REPOSITORY:-}" != "koupent/ECC" ]]; then
  echo "Refusing to run outside koupent/ECC" >&2
  exit 1
fi

current_tag="$(node -p "require('./${TRACKING_FILE}').tag")"
latest_tag="$(gh api "repos/${UPSTREAM_REPOSITORY}/releases/latest" --jq '.tag_name')"

if [[ -z "${latest_tag}" || "${latest_tag}" == "null" ]]; then
  echo "The upstream latest stable release did not contain a tag" >&2
  exit 1
fi

if [[ ! "${latest_tag}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Refusing unexpected upstream release tag: ${latest_tag}" >&2
  exit 1
fi

if [[ "${latest_tag}" == "${current_tag}" ]]; then
  echo "Already tracking ${latest_tag}"
  exit 0
fi

branch="sync/upstream-${latest_tag//\//-}"
existing_pr="$(gh pr list --repo "${FORK_REPOSITORY}" --head "${branch}" --state open --json number --jq '.[0].number // empty')"
if [[ -n "${existing_pr}" ]]; then
  echo "Sync PR #${existing_pr} already exists"
  exit 0
fi

git config user.name "koute-ecc-upstream-sync"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git remote add upstream "https://github.com/${UPSTREAM_REPOSITORY}.git"
git fetch --no-tags upstream "refs/tags/${latest_tag}:refs/tags/upstream-${latest_tag}"
git switch --create "${branch}"

set +e
git merge --no-edit --no-ff "refs/tags/upstream-${latest_tag}"
merge_status=$?
set -e

if [[ ${merge_status} -ne 0 ]]; then
  conflict_files="$(git diff --name-only --diff-filter=U | sed -E 's#[[:cntrl:]]##g' | head -50)"
  git merge --abort
  issue_title="Upstream ${latest_tag} sync needs manual conflict resolution"
  existing_issue="$(gh issue list --repo "${FORK_REPOSITORY}" --state open --search "${issue_title} in:title" --json number --jq '.[0].number // empty')"
  if [[ -z "${existing_issue}" ]]; then
    gh issue create \
      --repo "${FORK_REPOSITORY}" \
      --title "${issue_title}" \
      --body "Automatic synchronization from ${UPSTREAM_REPOSITORY}@${latest_tag} found merge conflicts. No branch or pull request was published and nothing was merged. Resolve the conflicts manually, run the full test suite, and open a Draft PR.\n\nConflicting paths:\n\n\`\`\`text\n${conflict_files}\n\`\`\`"
  fi
  exit 0
fi

node -e "const fs=require('fs');const p='${TRACKING_FILE}';const v=JSON.parse(fs.readFileSync(p,'utf8'));v.tag=process.argv[1];fs.writeFileSync(p,JSON.stringify(v,null,2)+'\\n');" "${latest_tag}"
git add "${TRACKING_FILE}"
git commit --amend --no-edit

npm ci --ignore-scripts
npm test
node scripts/ci/validate-workflow-security.js

gh auth setup-git
git push --set-upstream origin "${branch}"
gh pr create \
  --repo "${FORK_REPOSITORY}" \
  --base main \
  --head "${branch}" \
  --draft \
  --title "Upstream ${latest_tag}を同期" \
  --body "## 概要\n\n- ${UPSTREAM_REPOSITORY} の最新安定版 ${latest_tag} を同期\n- koute固有のCodex連携を維持\n- 完全テストとworkflow security検証を通過\n\n## 運用\n\nこのPRは自動マージしません。競合解決、差分確認、マージは手動で行います。本家へのPRも作成しません。"
