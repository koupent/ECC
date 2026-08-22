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

- An existing linked worktree for the branch is reused, never deleted or
  overwritten. It is still checked against the same boundary: a registered
  worktree that resolves inside the shared working tree stops preparation instead
  of being adopted.
- When the shared working tree itself has the branch checked out, preparation
  stops instead of adopting that tree: a delivery always runs in a worktree of
  its own. Switch the shared tree to another branch yourself (its uncommitted
  changes stay there) and run preparation again; it then creates the dedicated
  worktree for the same recorded Issue and branch.
- A registered worktree whose directory is gone stops preparation instead of
  pruning it for you.
- A directory that already occupies the target path but is not registered for the
  branch stops preparation; inspect and move it yourself.
- By default the worktree is created next to the repository in
  `<repo>-worktrees/<branch with / replaced by ->`, so it never dirties the shared
  tree. Set `deliveryWorktreeRoot` in `.ecc/config.json` or
  `ECC_DELIVERY_WORKTREE_ROOT` to place it elsewhere. A relative value is resolved
  against the shared working tree, and a root that lands inside that tree stops
  preparation instead of silently dirtying the shared `git status`. Symbolic links
  are resolved on both sides first, so a root that only looks outside the
  repository (a link that points back into it) is rejected too.
- A delivery that was prepared before worktree isolation existed is still bound to
  the shared tree: it records an Issue and a branch but no `worktree_path`. Running
  preparation again moves that same Issue and branch into a worktree without
  searching GitHub or creating a second Issue. Commit or stash the work first if the
  shared tree still has that branch checked out; committed work follows the branch
  into the new worktree, uncommitted changes stay behind.

Once a delivery is bound to its own worktree, every later stage stays bound to it.
The Delivery Gate, the commit observer, `/ecc:code-review`, the Completion Gate and
the acceptance audit read that worktree only. If the recorded directory is gone or
now belongs to another repository, they stop and ask you to restore it or reset the
delivery; none of them falls back to the shared working tree. Recovery stays
reachable while the gate is closed: the exact `delivery-lifecycle.js prepare` and
`reset.js` commands are always allowed, and when the worktree is on the wrong branch
a command that provably acts inside it (`git -C "<worktree_path>" switch <branch>`)
is allowed so the branch can be restored there. While the delivery is
isolated, a command is allowed only when the gate can read out of the command line
itself that it acts on the worktree (`cd "<worktree_path>" && ...` or
`git -C "<worktree_path>" ...`); mentioning the path elsewhere in the command line is
not enough. `Edit`, `Write`, `MultiEdit` and `NotebookEdit` are checked the same way,
including every path inside a `MultiEdit` edit list, and a write whose target path the
gate cannot read is rejected. The check does not depend on where the session runs: once
a delivery records a worktree, the shared working tree and every sibling worktree stay
protected even when the CLI itself already runs inside the delivery worktree, so an
absolute-path `Edit` of the shared tree or a `git -C "<shared tree>" …` is rejected
there as well. The gate fails closed, so these forms are rejected even when they would
have run in the worktree:

- Anything that can create or change a file while the gate cannot prove it runs in
  the worktree: `npm test`, `touch`, `rm`, `mv`, `sed -i`, `node script.js`, …
- Output redirection into the shared tree, whatever the command is
  (`git status > src/out.txt`, `echo x >> src/product.ts`), including an operator
  attached to the preceding word (`echo payload marker>src/product.ts`) or carrying a
  file descriptor (`2>src/product.ts`), and a redirection target the gate cannot
  resolve.
- A `git` subcommand that is not on the read-only list counts as a write, so a
  subcommand the gate does not know is never allowed against the shared tree. A
  read-only subcommand also counts as a write as soon as an argument can create a file
  or start another program (`git diff --output=…`, `--ext-diff`, `git grep -O…`), so
  only arguments that are known to be side-effect-free pass in the shared tree.
- A path that stays inside the worktree only on paper: the gate resolves symbolic
  links, so `cd "<worktree_path>" && echo x > link-to-shared/src/product.ts` and an
  `Edit` of the same path are rejected.
- Indirect invocations (`sh -c`, `eval`, `env`, `xargs`, `find -exec`, `sudo`, …),
  command substitution and `${...}` expansion.
- `--git-dir`, `--work-tree`, `--namespace`, any `-c <key>=<value>` override (it can
  point Git at another tree or at an external program), and any `GIT_*` variable in
  the command's environment prefix.
- A tool call whose hook payload exceeds the 1 MiB limit and is truncated: the gate
  cannot read the call, so it is denied instead of passed through. Reissue it in
  smaller pieces.
- A `cd` that is not chained to the command with `&&`, or that happens inside a
  subshell; `cd <worktree>; git ...` and `cd <worktree> || git ...` both run `git`
  in the shared tree when the `cd` fails.
- Quoting the gate cannot parse: an unclosed quote or a trailing backslash. Escapes
  are read the way the shell reads them, so `echo "a\""; git reset --hard` is two
  commands and the `git reset --hard` is rejected.

Side-effect-free inspection of the shared tree stays available: read-only `git`
subcommands (`git status`, `git log`, `git diff`, `git branch --show-current`,
`git worktree list`, …) and read-only commands such as `ls`, `cat`, `grep` or `head`,
as long as they redirect nothing into that tree. ECC's own worktree-aware commands
(`node "$CLAUDE_PLUGIN_ROOT/scripts/codex/run-role.js" …`, `acceptance-audit.js`,
`reset.js`) also stay available, because they resolve the recorded worktree
themselves.

The branch and base refs must be shell-safe (letters, digits, `.`, `_`, `/`, `-`,
no leading `-` and no `..`). Git also accepts refs containing `;`, `&` or `$()`,
which a shell would read as several commands, so the preparer refuses them instead
of turning them into a worktree path or a handed-off command.
