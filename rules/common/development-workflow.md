# Development Workflow

> This file extends [common/git-workflow.md](./git-workflow.md) with the full feature development process that happens before git operations.

The Feature Implementation Workflow keeps one implementation owner from planning through local
verification, then uses one independent Codex review before delivery.

## Feature Implementation Workflow

> Every "use the X agent" step below follows [agents.md](./agents.md): delegate when a delegation
> tool is available and higher-priority instructions permit it, and otherwise carry out the same
> step in the parent context.

0. **Context once**
   - Use the Context Builder packet before broad repository reading.
   - Consult primary documentation or existing implementations only when a dependency choice,
     unfamiliar API, or version-sensitive behavior actually requires it. Do not perform a generic
     ecosystem search for routine repository changes.

1. **Plan proportionally**
   - The implementation owner records acceptance criteria, affected surface, and verification.
   - Keep routine changes in the active task context. Create a plan document or use a planner only
     for multi-phase, ambiguous, destructive, or architectural work.

2. **Implement and test in one context**
   - The same implementation owner carries the task through implementation and normal verification.
   - Use RED/GREEN for a bug reproduction, public contract, or behavior with a stable acceptance
     boundary. For routine changes, add or update the smallest relevant test without forcing a
     ceremonial failing-test step.
   - Run changed-area checks during implementation. Run the project's required gate once on the
     final candidate; do not rerun an unchanged check merely for another agent.

3. **One independent release review**
   - Run the independent Codex review after implementation and local verification.
   - Do not duplicate it with a full Claude or specialist review. A Claude specialist is optional
     only for a distinct, bounded question whose perspective is not covered by Codex.
   - Fix only `release-blocker` findings in the current Delivery. Record non-blocking improvements
     as a grouped follow-up Issue and continue.
   - After blocker fixes, perform a focused re-review of those blockers and their regressions only.
     ECC stops after the initial review plus two focused re-reviews.

4. **Commit & Push**
   - Detailed commit messages
   - Follow conventional commits format
   - See [git-workflow.md](./git-workflow.md) for commit message format and PR process

5. **Pre-Review Checks**
   - Verify all automated checks (CI/CD) are passing
   - Resolve any merge conflicts
   - Ensure branch is up to date with target branch
   - Only request review after these checks pass
