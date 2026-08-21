---
description: Prepare the required GitHub Issue and issue-linked worktree before editing.
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

The preparer never switches the shared working tree. It checks the issue-linked
branch out in a worktree of its own and records the absolute path in
`worktree_path`, reporting the same path on stderr. Continue the normal CLI
workflow there: every edit, test run, commit, `/ecc:code-review`, and push for
this delivery must happen inside that path (`cd "<worktree_path>"` or
`git -C "<worktree_path>" ...`). The shared tree keeps its own branch and its
uncommitted changes, so a build or test that is still running is never moved onto
another commit.

Worktree handling is deliberately fail-closed:

- An existing worktree for the branch is reused, never deleted or overwritten.
  When the shared tree already has the branch checked out, that tree is the
  delivery worktree and `worktree_shared` is `true`.
- A registered worktree whose directory is gone stops preparation instead of
  pruning it for you.
- A directory that already occupies the target path but is not registered for the
  branch stops preparation; inspect and move it yourself.
- By default the worktree is created next to the repository in
  `<repo>-worktrees/<branch with / replaced by ->`, so it never dirties the shared
  tree. Set `deliveryWorktreeRoot` in `.ecc/config.json` or
  `ECC_DELIVERY_WORKTREE_ROOT` to place it elsewhere.

Once a delivery is bound to its own worktree, every later stage stays bound to it.
The Delivery Gate, the commit observer, `/ecc:code-review`, the Completion Gate and
the acceptance audit read that worktree only. If the recorded directory is gone or
now belongs to another repository, they stop and ask you to restore it or reset the
delivery; none of them falls back to the shared working tree. While the delivery is
isolated, a write-capable `git` command is allowed only when it actually runs in the
worktree (`cd "<worktree_path>" && git ...` or `git -C "<worktree_path>" ...`);
mentioning the path elsewhere in the command line is not enough.

The branch and base refs must be shell-safe (letters, digits, `.`, `_`, `/`, `-`,
no leading `-` and no `..`). Git also accepts refs containing `;`, `&` or `$()`,
which a shell would read as several commands, so the preparer refuses them instead
of turning them into a worktree path or a handed-off command.
