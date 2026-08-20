# Koupent ECC fork

This public fork is based on upstream ECC `v2.1.0` and keeps ECC's standard
workflow and hook profile intact. Its fork-specific surface is intentionally
limited to:

- Codex-backed context building, diagnosis, review, and contract-test roles;
- a context gate that prevents duplicate broad repository exploration;
- persistent, privacy-preserving waste-loop and incident telemetry;
- a Codex-aware status line; and
- local incident remediation that can open draft PRs only in `koupent/ECC`.

The fork never opens pull requests against `affaan-m/ECC` automatically. Any
upstream contribution requires a separate human decision.

## Installation identity

Marketplace: `koute-ecc`

Plugin: `ecc`

Install ID: `ecc@koute-ecc`

In Claude Code, add the public fork as a marketplace and install the plugin:

```text
/plugin marketplace add https://github.com/koupent/ECC
/plugin install ecc@koute-ecc
```

Do not install this fork together with upstream ECC or a copied hook bundle.
The project opts in by committing `.ecc/config.json`:

```json
{
  "profile": "standard",
  "rules": ["common", "typescript", "react", "nextjs"],
  "deliveryCompletion": "squash-merge",
  "mergeGate": {
    "provider": "commit-status",
    "command": "engineering-kit-merge-gate",
    "adapter": "scripts/ci/project-verify.sh",
    "statusContext": "Local Merge Gate",
    "strategy": "squash"
  },
  "codex": {
    "enabled": true,
    "contextModel": "gpt-5.6-terra",
    "reviewModel": "gpt-5.6-sol",
    "reasoningEffort": "high",
    "timeoutSeconds": 1800
  }
}
```

The `rules` array is consumed by the private environment-kit installer; ECC
itself only uses this file to enable the fork-specific runtime. Runtime state
and raw incidents are stored outside the repository under the user's local
state directory. Only redacted summaries may be promoted to central issues.

Run `/ecc:codex-doctor` after installation. Use `/ecc:codex-task-reset` only
when starting a new task in an existing Claude session.

The original ECC project remains copyright its contributors and is licensed
under the repository's MIT license.
