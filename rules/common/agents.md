# Agent Orchestration

## Available Agents

Located in `~/.claude/agents/`:

| Agent | Purpose | When to Use |
|-------|---------|-------------|
| planner | Implementation planning | Complex features, refactoring |
| architect | System design | Architectural decisions |
| tdd-guide | Test-driven development | New features, bug fixes |
| code-reviewer | Advisory code review | Optional scoped pre-check; never the release review authority |
| security-reviewer | Advisory security analysis | Optional scoped pre-check; never the release security review authority |
| build-error-resolver | Fix build errors | When build fails |
| e2e-runner | E2E testing | Critical user flows |
| refactor-cleaner | Dead code cleanup | Code maintenance |
| doc-updater | Documentation | Updating docs |
| rust-reviewer | Rust code review | Rust projects |
| harmonyos-app-resolver | HarmonyOS app development | HarmonyOS/ArkTS projects |

## Agent Usage Policy

This file is the canonical delegation policy. `AGENTS.md`, the platform copies
(`.cursor/rules/common-agents.md`, `.opencode/instructions/INSTRUCTIONS.md`,
`.kiro/steering/agents.md`), and the translations under `docs/` restate it and must stay
semantically identical to it.

**Scope.** This policy governs every "use the X agent" step in every other rule file of this
pack — including its platform copies and translations — regardless of how absolutely that step
is phrased. Read each such step as "delegate when this policy permits delegation".

**Mechanism.** This rule describes when delegation is useful; it does not automatically spawn an
agent, and no runtime spawns one on its own. An agent runs only when the parent model invokes an
available Agent or Task tool and collects the result.

**Project-owner authorization.** Installing and enabling this rule pack is the project owner's
standing request to use available Agent or Task tools autonomously for bounded planning,
implementation, testing, and specialist review work. No fresh per-task or per-session request is
required. When a runtime permits delegation only when the user requested it, this standing request
satisfies that condition.

**Precedence.** Higher-priority system, runtime or harness, organization, and user instructions
always take precedence over this rule. The standing request does not override an unconditional
prohibition, an unavailable tool, a security boundary, or a task-specific user instruction not to
delegate. A condition that merely requires a user request is not an unconditional prohibition.

## Claude / Codex Role Boundary

- The parent Claude session owns decisions, integration, product implementation, and completion.
- Codex owns the initial Context Builder packet and the independent release review. Use the Codex
  `security-review` role when an independent security review is required.
- Claude sub-agents are for bounded planning, implementation, tests, diagnosis, or specialist
  analysis that can run independently. Reviewer-named Claude agents are advisory specialists;
  they do not replace or duplicate the mandatory Codex review and do not satisfy its evidence gate.
- Run the Context Builder before any broad Claude or sub-agent repository exploration. After its
  packet is ready (or a recorded fallback opens the gate), give sub-agents bounded files and tasks.
- Do not run a Claude reviewer and Codex over the same review scope by default. Add an advisory
  specialist only when its distinct perspective is material, and hand its result to the parent.

When delegation tools are available and higher-priority instructions permit their use:
1. Complex feature requests - Consider the **planner** agent
2. Independent implementation or specialist work - Consider a matching Claude sub-agent
3. Bug fix or new feature - Consider the **tdd-guide** agent
4. Architectural decision - Consider the **architect** agent

When delegation is unavailable or unconditionally prohibited, keep the work in the parent context and apply
the same planning, testing, and review checklists directly. Never claim that an agent ran when
no tool invocation and result collection occurred.

## Parallel Task Execution

Use parallel Task execution for genuinely independent operations only when the runtime permits
delegation and the parent can collect every result before ending its turn:

```markdown
# GOOD: Parallel execution
Launch 3 agents in parallel:
1. Agent 1: Security analysis of auth module
2. Agent 2: Performance review of cache system
3. Agent 3: Type checking of utilities

# BAD: Sequential when unnecessary
First agent 1, then agent 2, then agent 3
```

## Delegation Completion Contract

Applies to every agent at every depth (parent, child, grandchild):

1. **Your final message IS the deliverable.** Never end your turn with "waiting for background agents" — a spawned task is not a completed task. Ending your turn while children are running orphans their results (completed children cannot notify a parent whose turn has ended).
2. **If you delegate, you own collection.** Wait for results, integrate them, then return. Fire-and-forget delegation is forbidden.
3. **Decompose only when the work cannot fit in one context.** Do not re-delegate a task already sized for a single agent — depth is an outcome, not a plan.

> Rationale: observed failure mode — research agents followed "Parallel Task Execution" above, spawned children, and returned "waiting" as their final answer. All children completed successfully but their results were orphaned. The parallel rule without a completion contract produces zombie tasks.

## Multi-Perspective Analysis

For complex problems, consider split-role sub-agents when delegation is permitted and the
perspectives are genuinely independent:

- Factual reviewer
- Senior engineer
- Security expert
- Consistency reviewer
- Redundancy checker

When delegation is unavailable, run the same perspectives as separate passes in the parent
context. The perspective is what catches defects a diff-scoped review misses, such as a wrong
step order in a procedure whose diff touches a single line; the agent is only the vehicle.
