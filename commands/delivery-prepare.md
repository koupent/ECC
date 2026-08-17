---
description: Prepare the required GitHub Issue and issue-linked branch before editing.
---

# ECC deterministic delivery preparation

Run the fork-provided lifecycle preparer exactly once:

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/codex/delivery-lifecycle.js" prepare --session "$CLAUDE_SESSION_ID"
```

It searches open Issues before creating one and records the selected Issue and
branch in external ECC state. Do not create a second Issue or a parallel branch
manually. After it succeeds, retry the blocked edit.
