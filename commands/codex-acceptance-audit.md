---
description: Audit a completed ECC delivery from external state, Git, and GitHub evidence.
argument-hint: --issue <number>
---

# ECC delivery acceptance audit

Run the deterministic audit below from the repository root after the preceding
delivery response has completed and its Stop Hook has fired:

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/codex/acceptance-audit.js" $ARGUMENTS
```

Git evidence is read from the worktree recorded for the delivery, not from the
shared working tree. When that worktree is gone or now belongs to another
repository, the Git checks fail instead of auditing whatever the shared tree holds.

Report the JSON result without changing product files, harness files, Git state,
GitHub state, or ECC external state. Do not reinterpret a failed check as a pass.
The overall result is PASS only when the script returns `status: "PASS"` and exits
zero. If it fails, list the failed check IDs and stop for harness correction.
