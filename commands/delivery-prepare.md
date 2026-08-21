---
description: Prepare the required GitHub Issue and issue-linked branch before editing.
type: general
---

# ECC deterministic delivery preparation

Run the fork-provided lifecycle preparer exactly once:

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/codex/delivery-lifecycle.js" prepare
```

It searches open Issues before creating one and records the selected Issue and
branch in external ECC state. Do not create a second Issue or a parallel branch
manually. The preparer resolves the single pending session for the current
project. When the Delivery Gate provides an explicit session-bound command, use
that exact command instead. After it succeeds, retry the blocked edit.

## Naming the Issue and the branch

Without an explicit name, the Issue title is only a request fingerprint
(`ECC delivery 18bf1502e0`), and its slug becomes the branch suffix. Name the
delivery on this first run instead:

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/codex/delivery-lifecycle.js" prepare \
  --session "<id>" \
  --title "Collapse edition duplicates into one work" \
  --branch-suffix edition-duplicates
```

- `--title` replaces the recorded title before duplicate search, Issue creation,
  and branch naming. One line, at most 120 characters, no leading `-`.
- `--branch-suffix` is optional and takes ASCII only. The branch slug drops
  non-ASCII characters, so a Japanese-only title would otherwise collapse to
  `task`; give the suffix when `--title` is not ASCII.
- Both are rejected once the Issue and branch are recorded, because renaming a
  recorded branch breaks the branch match that the Delivery and Completion Gates
  require. Reset the delivery if the name must change.

The Delivery Gate accepts `prepare` with `--session`, `--title` and
`--branch-suffix`, each at most once, and nothing else. Quote any value that
contains spaces.

The branch prefix comes from `deliveryBranchPrefix` in `.ecc/config.json`
(or `ECC_DELIVERY_BRANCH_PREFIX`) and defaults to `codex`, so a project can use
`"deliveryBranchPrefix": "feat"` to get `feat/issue-278-edition-duplicates`.
After the prefix changes, branches already named `codex/issue-<number>-*` are
still reused for the same Issue instead of being duplicated.

The preparer never switches branches itself: a long build or test run leaves the
working tree clean, so it cannot tell whether switching would invalidate work in
progress. When the recorded branch differs from the current one, it records the
delivery as `awaiting-branch` and reports the required switch in the
`branch_switch` field (`from`, `to`, `create`, `base_branch`, `command`), with the
same request on stderr. Finish or stop any running verification, run that exact
command yourself, then run the preparer again to reach `ready`. The Delivery Gate
allows that one switch command while the delivery waits for it.

Both refs in that command must be shell-safe (letters, digits, `.`, `_`, `/`, `-`,
no leading `-` and no `..`). Git also accepts refs containing `;`, `&` or `$()`,
which a shell would read as several commands, so the preparer refuses them instead
of handing back a command the Delivery Gate would reject.
