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
