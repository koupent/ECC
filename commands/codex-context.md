---
description: Run the Codex Context Builder and return a compact repository evidence packet.
argument-hint: [implementation request]
---

# Codex Context Builder

Run the fork-provided Context Builder before broad Claude exploration:

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/codex/run-role.js" context-builder --request "$ARGUMENTS" --session "$CLAUDE_SESSION_ID"
```

Use the returned JSON packet as the implementation context. If the command
reports `fallback: true`, continue with ECC's native Claude investigation; do
not retry Codex in the same task.
