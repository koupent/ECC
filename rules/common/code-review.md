# Code Review Standards

## Purpose

Code review ensures quality, security, and maintainability before code is merged. This rule defines when and how to conduct code reviews.

## When to Review

**Release review trigger:**

- Once after the final implementation commit
- When security-sensitive code is changed (auth, payments, user data)
- Before merging pull requests

**Pre-Review Requirements:**

Before requesting review, ensure:

- Required local checks are passing for the current HEAD
- Merge conflicts are resolved
- Branch is up to date with target branch

## Review Checklist

Before marking code complete:

- [ ] Code is readable and well-named
- [ ] No hardcoded secrets or credentials
- [ ] Stated acceptance criteria and core flows are verified
- [ ] Required checks pass because of the current change
- [ ] Public contracts and destructive operations have a safe migration or rollback

## Security Review Triggers

Use the independent Codex `security-review` role when the change materially affects:

- Authentication or authorization code
- User input handling
- Database queries
- File system operations
- External API calls
- Cryptographic operations
- Payment or financial code

## Review Severity Levels

| Level | Meaning | Action |
|-------|---------|--------|
| CRITICAL | Security vulnerability or data loss risk | **BLOCK** - Must fix before merge |
| HIGH | Serious issue whose disposition depends on concrete merge risk | **ASSESS** - May block or become follow-up |
| MEDIUM | Maintainability concern | **INFO** - Consider fixing |
| LOW | Style or minor suggestion | **NOTE** - Optional |

## Agent Usage

> Every "use the X agent" step in this file follows [agents.md](agents.md): delegate when a
> delegation tool is available and higher-priority instructions permit it, and otherwise apply the
> same review perspectives in the parent context.

The standard Delivery has one release-review authority: Codex. These Claude agents are optional
for a distinct bounded advisory question and must not repeat the full review:

| Agent | Purpose |
|-------|---------|
| **code-reviewer** | General code quality, patterns, best practices |
| **security-reviewer** | Security vulnerabilities, OWASP Top 10 |
| **typescript-reviewer** | TypeScript/JavaScript specific issues |
| **python-reviewer** | Python specific issues |
| **go-reviewer** | Go specific issues |
| **rust-reviewer** | Rust specific issues |

## Review Workflow

```
1. Run required local verification once on the final candidate
2. Commit the candidate
3. Run the independent Codex review once
4. Fix only release blockers
5. Re-review blocker fixes only, with at most two focused rounds
6. Group non-blocking findings into a follow-up Issue
```

## Common Issues to Catch

### Security

- Hardcoded credentials (API keys, passwords, tokens)
- SQL injection (string concatenation in queries)
- XSS vulnerabilities (unescaped user input)
- Path traversal (unsanitized file paths)
- CSRF protection missing
- Authentication bypasses

### Code Quality

- Large functions (>50 lines) - split into smaller
- Large files (>800 lines) - extract modules
- Deep nesting (>4 levels) - use early returns
- Missing error handling - handle explicitly
- Mutation patterns - prefer immutable operations
- Missing tests - add test coverage

### Performance

- N+1 queries - use JOINs or batching
- Missing pagination - add LIMIT to queries
- Unbounded queries - add constraints
- Missing caching - cache expensive operations

## Approval Criteria

- **Approve**: No `release-blocker` remains
- **Follow-up**: Non-blocking repository improvements or external owner actions remain
- **Block**: A concrete security, data-loss, acceptance, required-check, or compatibility blocker remains

## Integration with Other Rules

This rule works with:

- [testing.md](testing.md) - Risk-based test requirements
- [security.md](security.md) - Security checklist
- [git-workflow.md](git-workflow.md) - Commit standards
- [agents.md](agents.md) - Agent delegation
