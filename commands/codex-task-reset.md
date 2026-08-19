---
description: Reset the current ECC Codex task state so the next request builds fresh context.
---

# Codex Task Reset

Use the resolved `reset.js` command printed by the Delivery Gate. The command is
session-scoped and has this shape:

```bash
node "<resolved-plugin-root>/scripts/codex/reset.js" "<session-id>"
```

Do not assume that `CLAUDE_PLUGIN_ROOT` is exported to the interactive Bash tool.
This removes only the named session's ECC Codex state. It does not modify the
repository or ECC's standard hook configuration. Use it only when the recorded
Delivery is stale or cannot be recovered on its issue-linked branch.
