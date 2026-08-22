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
blocked.

The gate inspects every tool call, not only `Bash`, `Edit`, `Write`, and
`MultiEdit`. Tools confirmed not to change the repository (`Read`,
`NotebookRead`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, `TodoWrite`, `Task`)
are allowed; every other tool — including `NotebookEdit`, `SlashCommand`,
MCP tools, and any tool the gate does not know — is denied by default, so a
newer write path cannot silently bypass the "read-only until it resumes"
guarantee. The same default applies before preparation completes.

Read-only shell inspection is allowlisted per argument and, for `git`, per
subcommand, so options that run another program (`rg --pre`, `file -C`,
`git -c` / `--ext-diff` / `cat-file --filters`, `gh --web`) are denied together
with every unknown option. Only bare executable names resolved through `PATH`
are allowed: a path-qualified executable such as `./git` or `/tmp/gh` is denied,
because its base name says nothing about what actually runs. Escaped quotes and
trailing line continuations are treated as command separators, so a chained
command can never be read as a single quoted argument.

Because the shell rewrites a command after this check, every unquoted `$`
expansion is denied: `rg $IFS--pre=rm` and `gh api ... $IFS-X PUT` would
otherwise pass the argument check as positional arguments and then reach the
shell as denied options. Quotes and backslashes are removed the way the shell
removes them before the arguments are checked, so `''--pre=rm` and `\-\-pre=rm`
are inspected as the option they become.

Only a request naming a different Issue or PR — by number, as
`Pull Request #300`, or as a canonical GitHub `/issues/300` or `/pull/300`
URL — starts a new delivery that needs this command. A request that names two
different Issues, or two different PRs, does not pick the first number:
preparation fails closed and asks for exactly one target, so a negated mention
("not Issue #271 but Issue #300") never delivers to the branch of the Issue that
was ruled out.

A URL is matched against this clone's `origin` remote by host, owner, and
repository, not by number alone. The host comes from the URL authority, so an
`origin`-looking path inside another host's URL
(`https://other.example/github.com/owner/repo/pull/300`) is treated as that
other host. A reference to another repository — including the same number on
another host or owner — never resumes the recorded delivery and is never
resolved as a local Issue or PR: preparation fails closed instead of creating an
Issue and branch for it. Run such a request in that repository's own clone, or
name the Issue or PR of this repository.

When the request names a PR, the preparer resolves that PR before any Issue
search: the delivery is bound to the PR's head branch, base branch, and linked
`Closes #<number>` Issue, and no Issue or branch is created. If the PR is not
open, comes from a fork, links no Issue, or its head branch is not in this clone,
preparation fails closed so the named PR is never replaced by a generated Issue
and branch.
