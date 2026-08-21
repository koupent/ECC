---
description: Prepare the required GitHub Issue and issue-linked branch before editing.
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

A delivery that already reached its Draft PR is not prepared again: the next
explicit change request resumes it on the recorded Issue and branch, drops the
recorded completion and review evidence, and requires a fresh review before the
task can stop. Until it resumes, only read-only inspection and the reset command
are allowed, so file edits, shell mutations, branch switches, and commits stay
blocked. Read-only inspection is allowlisted per argument, so options that run
another program (`rg --pre`, `file -C`, `git -c` / `--ext-diff`, `gh --web`) are
denied together with every unknown option. Only a request naming a different
Issue or PR — by number, as `Pull Request #300`, or as a canonical GitHub
`/issues/300` or `/pull/300` URL — starts a new delivery that needs this command.

When the request names a PR, the preparer resolves that PR before any Issue
search: the delivery is bound to the PR's head branch, base branch, and linked
`Closes #<number>` Issue, and no Issue or branch is created. If the PR is not
open, comes from a fork, links no Issue, or its head branch is not in this clone,
preparation fails closed so the named PR is never replaced by a generated Issue
and branch.
