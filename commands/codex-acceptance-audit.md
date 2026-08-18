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

Report the JSON result without changing product files, harness files, Git state,
GitHub state, or ECC external state. Do not reinterpret a failed check as a pass.
The overall result is PASS only when the script returns `status: "PASS"` and exits
zero. If it fails, list the failed check IDs and stop for harness correction.
