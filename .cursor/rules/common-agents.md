---
description: "Agent orchestration: available agents, parallel execution, multi-perspective analysis"
alwaysApply: true
---
# Agent Orchestration

## Available Agents

Located in `~/.claude/agents/`:

| Agent | Purpose | When to Use |
|-------|---------|-------------|
| planner | Implementation planning | Complex features, refactoring |
| architect | System design | Architectural decisions |
| tdd-guide | Test-driven development | New features, bug fixes |
| code-reviewer | Code review | After writing code |
| security-reviewer | Security analysis | Before commits |
| build-error-resolver | Fix build errors | When build fails |
| e2e-runner | E2E testing | Critical user flows |
| refactor-cleaner | Dead code cleanup | Code maintenance |
| doc-updater | Documentation | Updating docs |

## Agent Usage Policy

`rules/common/agents.md` is the canonical delegation policy; this file restates it for Cursor.

**Scope.** This policy governs every "use the X agent" step in every other Cursor rule of this
pack, regardless of how absolutely that step is phrased. Read each such step as "delegate when
this policy permits delegation".

**Mechanism.** This rule describes when delegation is useful; it does not automatically spawn an
agent, and no runtime spawns one on its own. An agent runs only when the parent model invokes an
available Agent or Task tool and collects the result.

**Project-owner authorization.** Installing and enabling this rule pack is the project owner's
standing request to use available Agent or Task tools autonomously for bounded work. When a
runtime permits delegation only when the user requested it, this standing request satisfies that
condition; no fresh per-session request is required.

**Precedence.** Higher-priority system, runtime or harness, organization, and user instructions
always take precedence over this rule. An unconditional prohibition, unavailable tool, security
boundary, or task-specific opt-out still wins. A condition that merely requires a user request is
satisfied by the standing request above.

**Claude / Codex role boundary.** The parent Claude session owns decisions, integration, product
implementation, and completion. Codex owns the initial Context Builder packet and the independent
release/security review. Claude sub-agents handle bounded planning, implementation, tests,
diagnosis, and distinct specialist analysis. Reviewer-named Claude agents are advisory only: they
must not replace or duplicate the mandatory Codex review or satisfy its evidence gate. Run the
Context Builder before broad Claude or sub-agent exploration.

When delegation tools are available and higher-priority instructions permit their use:
1. Complex feature requests - Consider the **planner** agent
2. Independent implementation or specialist work - Consider a matching Claude sub-agent
3. Bug fix or new feature - Consider the **tdd-guide** agent
4. Architectural decision - Consider the **architect** agent

When delegation is unavailable or unconditionally prohibited, keep the work in the parent context and apply the
same planning, testing, and review checklists directly. Never claim that an agent ran when no
tool invocation and result collection occurred.

## Parallel Task Execution

Use parallel Task execution for genuinely independent operations only when the runtime permits
delegation and the parent can collect every result before ending its turn. Fire-and-forget
delegation is forbidden:

```markdown
# GOOD: Parallel execution
Launch 3 agents in parallel:
1. Agent 1: Security analysis of auth module
2. Agent 2: Performance review of cache system
3. Agent 3: Type checking of utilities

# BAD: Sequential when unnecessary
First agent 1, then agent 2, then agent 3
```

## Multi-Perspective Analysis

For complex problems, consider split role sub-agents when delegation is permitted and the
perspectives are genuinely independent:
- Factual reviewer
- Senior engineer
- Security expert
- Consistency reviewer
- Redundancy checker

When delegation is unavailable, run the same perspectives as separate passes in the parent
context. The perspective is what catches defects a diff-scoped review misses, such as a wrong
step order in a procedure whose diff touches a single line; the agent is only the vehicle.
