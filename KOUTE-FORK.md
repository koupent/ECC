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
  "deliveryWorkflow": "required",
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

`deliveryCompletion: "squash-merge"` is one contract with two halves: the Stop
Completion Gate merges the reviewed PR, and the Local Merge Policy keeps any
other actor from merging it first. Both halves live in the required delivery
workflow and in the `standard` or `strict` hook profile, so the three settings
above are only valid together — a project that names the completion method
alone would have its manual merges refused without ever getting an automatic
one. While the method is active, Bash may not merge a pull request through any
route — `gh pr merge`, the REST merge endpoint, or the GraphQL mutation — may
not publish a commit status, and may not write through the raw GitHub API at
all; reads and the ordinary `gh` subcommands stay available, and a document that
merely quotes such a call is not one.

`.ecc/config.json` must also stay readable on the delivery branch: when it
cannot be read, the Completion Gate refuses to finish a delivery whose intended
completion method it can no longer confirm.

The `rules` array is consumed by the private environment-kit installer; ECC
itself only uses this file to enable the fork-specific runtime. Runtime state
and raw incidents are stored outside the repository under the user's local
state directory. Only redacted summaries may be promoted to central issues.

Run `/ecc:codex-doctor` after installation. Use `/ecc:codex-task-reset` only
when starting a new task in an existing Claude session.

The original ECC project remains copyright its contributors and is licensed
under the repository's MIT license.
