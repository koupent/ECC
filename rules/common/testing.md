# Testing Requirements

## Risk-Based Test Coverage

Choose the smallest test layer that proves the acceptance criteria:
1. **Unit tests** - Pure logic and bounded utilities
2. **Integration tests** - Contracts between components, APIs, or persistence
3. **E2E tests** - Changed critical user flows, not every change

## Test-Driven Development

Use RED/GREEN when it provides independent evidence: bug reproduction, public/API contracts, and
stable acceptance behavior. Do not require a ceremonial RED step for documentation, configuration,
mechanical refactors, generated files, or behavior already covered by an existing test.

Coverage is a diagnostic signal, not a universal release gate. Preserve any product-specific
threshold already configured, but do not introduce or chase an 80% target solely because ECC is
installed. Prefer tests that cover the changed risk over broad low-value line coverage.

## Troubleshooting Test Failures

> The delegation step below follows [agents.md](agents.md): delegate when a delegation tool is
> available and higher-priority instructions permit it, and otherwise work through the same steps
> in the parent context.

1. Use a **tdd-guide** only when an independent test design materially reduces implementation bias
2. Check test isolation
3. Verify mocks are correct
4. Fix implementation, not tests (unless tests are wrong)

## Agent Support

- **tdd-guide** - Optional for bug reproduction and public-contract test design; it is not a
  mandatory handoff for every feature

## Test Structure (AAA Pattern)

Prefer Arrange-Act-Assert structure for tests:

```typescript
test('calculates similarity correctly', () => {
  // Arrange
  const vector1 = [1, 0, 0]
  const vector2 = [0, 1, 0]

  // Act
  const similarity = calculateCosineSimilarity(vector1, vector2)

  // Assert
  expect(similarity).toBe(0)
})
```

### Test Naming

Use descriptive names that explain the behavior under test:

```typescript
test('returns empty array when no markets match query', () => {})
test('throws error when API key is missing', () => {})
test('falls back to substring search when Redis is unavailable', () => {})
```
