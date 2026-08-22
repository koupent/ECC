---
description: "Development workflow: plan, TDD, review, commit pipeline"
alwaysApply: true
---
# Development Workflow

> This rule extends the git workflow rule with the full feature development process that happens before git operations.

The Feature Implementation Workflow describes the development pipeline: planning, TDD, code review, and then committing to git.

## Feature Implementation Workflow

> Every "use the X agent" step below follows the agent orchestration rule: delegate when a
> delegation tool is available and higher-priority instructions permit it, and otherwise carry out
> the same step in the parent context.

1. **Plan First**
   - Use **planner** agent to create implementation plan
   - Identify dependencies and risks
   - Break down into phases

2. **TDD Approach**
   - Use **tdd-guide** agent
   - Write tests first (RED)
   - Implement to pass tests (GREEN)
   - Refactor (IMPROVE)
   - Verify 80%+ coverage

3. **Code Review**
   - Run the mandatory independent Codex review after implementation and local verification
   - Use a Claude **code-reviewer** only for a distinct advisory perspective; it does not replace
     or duplicate the Codex review and cannot satisfy the release evidence gate
   - Address CRITICAL and HIGH issues
   - Fix MEDIUM issues when possible

4. **Commit & Push**
   - Detailed commit messages
   - Follow conventional commits format
   - See the git workflow rule for commit message format and PR process
