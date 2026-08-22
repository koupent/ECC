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

**Expectation.** When such a tool is available and higher-priority instructions permit it, judge
for yourself whether to delegate. A separate request from the user is not required.

**Precedence.** Higher-priority system, runtime or harness, organization, and user instructions
always take precedence over this rule. When the harness restricts delegation — for example
"do not call the Agent tool unless the user requested it" — follow the harness. This rule then
tells you which perspectives to cover, not that you may override the restriction.

When delegation tools are available and higher-priority instructions permit their use:
1. Complex feature requests - Consider the **planner** agent
2. Code just written/modified - Consider the **code-reviewer** agent
3. Bug fix or new feature - Consider the **tdd-guide** agent
4. Architectural decision - Consider the **architect** agent

When delegation is unavailable or prohibited, keep the work in the parent context and apply the
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
