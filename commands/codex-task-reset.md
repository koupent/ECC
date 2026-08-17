---
description: Reset the current ECC Codex task state so the next request builds fresh context.
---

# Codex Task Reset

Run:

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/codex/reset.js" "$CLAUDE_SESSION_ID"
```

This removes only the current session's ECC Codex state. It does not modify the
repository or ECC's standard hook configuration.
