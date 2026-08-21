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
blocked. Only a request naming a different Issue or PR — by number, as
`Pull Request #300`, or as a canonical GitHub `/issues/300` or `/pull/300` URL —
starts a new delivery that needs this command.
