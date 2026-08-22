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

Before preparation the Delivery Gate blocks every repository tool except this
preparer and `reset.js`, and it accepts them only when the script path resolves to
this plugin's own file: a script with the same name inside the repository is
rejected, so it can never run as a recovery command.

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
- A delivery that was prepared before worktree isolation existed records an Issue and
  a branch but no `worktree_path`. It is treated as waiting for migration, not as a
  delivery that may keep using the shared tree: the Delivery Gate, the commit observer,
  the Completion Gate, the acceptance audit and every Codex role stop until it has a
  worktree, and only `delivery-lifecycle.js prepare` and `reset.js` stay available.
  Running preparation again moves that same Issue and branch into a worktree without
  searching GitHub or creating a second Issue. If the shared tree still has that branch
  checked out, put its work away yourself outside this session (the gate allows nothing
  but those two commands until the migration is done); committed work follows the branch
  into the new worktree, uncommitted changes stay behind.

Once a delivery is bound to its own worktree, every later stage stays bound to it.
The Delivery Gate, the Context Builder, the commit observer, `/ecc:code-review`, the
Completion Gate and the acceptance audit read that worktree only. Every Codex role
resolves it from the recorded delivery, so the session itself may keep running in the
shared working tree without pointing a role at it. Each of them re-checks, every time,
that the recorded path is still a working tree of the repository the delivery was
recorded against; that check is never skipped and never cached, not even when the
session itself already runs in that path. If the recorded directory is gone, or has been
replaced by a directory that belongs to another repository, they stop and ask you to
restore it or reset the delivery; none of them falls back to the shared working tree. Recovery stays
reachable while the gate is closed: the exact `delivery-lifecycle.js prepare` and
`reset.js` commands are always allowed — but only when the script path resolves to this
plugin's own file, so a project script with the same name never passes as a recovery
command — and when the worktree is on the wrong branch
the branch can be restored there. That recovery is narrow: only a `git switch` or
`git checkout` whose single argument is the recorded branch
(`git -C "<worktree_path>" switch <branch>`) and side-effect-free inspection are
allowed, so editing, deleting or committing on the wrong branch stays rejected inside
the worktree as well. While the delivery is
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
- Running inside the worktree is not a blanket permission. Every argument must
  resolve inside it, so `cd "<worktree_path>" && rm -rf "<shared tree>/src"`,
  `cp file "<sibling worktree>/file"`, `ln -s "<shared tree>" link` and
  `git diff --output="<shared tree>/x"` are rejected there too. Arguments only a
  shell expansion could resolve (`$VAR`, `~/…`, an environment prefix such as
  `PATH=…`) and inline code (`node -e`, `node -p`, `python -c`, `perl -e`, …) are
  rejected because the gate cannot read their target. An unquoted glob is read as
  what it can expand to, not as its literal path: `rm -rf node_modules/*` stays
  allowed inside the worktree because every match stays under `node_modules`, while
  `rm -rf ../../*/src` is rejected because the expansion reaches the shared tree. A
  brace expansion (`{a,b}`) is rejected outright, since it can also produce `..`.
  A command that only reads
  (`cat`, `grep`, `ls`, …) may still take a shared-tree path as an argument.
  Scripts inside the worktree (`node tests/run-all.js`, `npm test`) run as before;
  what such a script does at runtime is beyond a command-line gate, so treat
  OS-level isolation as the stronger boundary when you need one.
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
- A `git` write that lands in the shared common directory instead of the worktree, even
  when it provably runs inside the worktree. Refs, remotes, notes and the configuration
  are shared by the main working tree and every worktree, so `git update-ref`,
  `git branch -f`/`-D`/`-M`, `git tag`, `git symbolic-ref`, `git remote`, `git notes`,
  `git worktree`, `git gc` and `git config` could move the branch the shared tree has
  checked out while it is running — exactly the collision this isolation exists to
  prevent. `git stash` is rejected there for the same reason: the stash is kept in the
  single shared `refs/stash`, so `git stash drop`, `git stash clear` and even a plain
  `git stash` reach the entries another worktree put aside. Only `git stash list` stays
  available as a read; set work aside with a commit on the delivery branch instead.
  Only writes that stay inside the worktree's own working tree, index and
  current branch pass there (`git add`, `git commit`, `git mv`, `git rm`, `git restore`,
  `git reset`, `git merge`, `git rebase`, `git cherry-pick`, `git revert`,
  `git switch`/`git checkout`, `git fetch`, `git pull`, `git push`), and a subcommand the
  gate does not know — an alias included — is rejected there as well. Two argument forms
  of those allowed subcommands reach shared refs and are rejected too: `git checkout -B`
  and `git switch -C` move an existing branch, and in `git push`/`git fetch`/`git pull`
  any argument containing `:` — a `<src>:<dst>` refspec or a URL remote — is rejected,
  because a refspec writes the named ref directly when the remote is this repository
  (`git push . HEAD:main`, `git fetch . main:main`). Push with a named remote
  (`git push -u origin HEAD`) stays available.
- A path that stays inside the worktree only on paper: the gate resolves symbolic
  links, so `cd "<worktree_path>" && echo x > link-to-shared/src/product.ts` and an
  `Edit` of the same path are rejected.
- Indirect invocations (`sh -c`, `eval`, `env`, `xargs`, `find -exec`, `sudo`, …),
  command substitution and `${...}` expansion.
- `--git-dir`, `--work-tree`, `--namespace`, `--exec-path`, any `-c <key>=<value>` or
  `--config-env` override, and any `GIT_*` variable in the command's environment
  prefix. A configuration override is rejected whatever its key and whatever the
  subcommand is, including a read-only one: `core.worktree` points Git at another
  tree, and `alias.…=!<command>`, `include.path` or `diff.external` make Git start a
  program the gate cannot read. `git config` itself is rejected for the same reason,
  in the worktree as well: it writes to the repository-wide configuration, so an
  alias or an `include.path` stored there outlives the command that stored it.
  `git config --list` stays available as a read.
- A tool call whose hook payload exceeds the 1 MiB limit and is truncated: the gate
  cannot read the call, so it is denied instead of passed through. Reissue it in
  smaller pieces.
- Anything that writes this shell's variables, aliases or functions (`export`,
  `set`, `unset`, `source`, a bare `PATH=…` segment, `printf -v PATH …`). The
  assignment outlives the command that made it, so after it the gate can no longer
  tell which program a bare command name resolves to; every later command in the same
  command line that is not provably inside the worktree is rejected.
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
themselves. An explicit working directory does not override that: `run-role.js`
refuses a `--cwd` that is not the recorded worktree, and the gate rejects such a
command as well, so a Codex role can never be pointed at the shared tree or a
sibling worktree.

The branch and base refs must be shell-safe (letters, digits, `.`, `_`, `/`, `-`,
no leading `-` and no `..`). Git also accepts refs containing `;`, `&` or `$()`,
which a shell would read as several commands, so the preparer refuses them instead
of turning them into a worktree path or a handed-off command.
