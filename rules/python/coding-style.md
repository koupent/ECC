---
paths:
  - "**/*.py"
  - "**/*.pyi"
---
# Python Coding Style

> This file extends [common/coding-style.md](../common/coding-style.md) with Python specific content.

## Standards

- Follow **PEP 8** conventions
- Use **type annotations** on all function signatures

## Immutability

Prefer immutable data structures:

```python
from dataclasses import dataclass

@dataclass(frozen=True)
class User:
    name: str
    email: str

from typing import NamedTuple

class Point(NamedTuple):
    x: float
    y: float
```

## Formatting

Use the formatter the project already configures. Never introduce a second
formatter, and never run a tool that is not in the project's dependencies.
Resolve it in this order:

1. `pyproject.toml` declares `[tool.ruff.format]`, or `ruff` is a dependency and
   `black` is not — use `ruff format` for formatting and
   `ruff check --select I --fix` for import sorting.
2. `black` and/or `isort` are dependencies — use `black` for formatting and
   `isort` for import sorting.
3. Neither is configured — default to `ruff format` plus
   `ruff check --select I`, matching ECC's own quality gate.

Use **ruff** for linting in every case.

When a rule here disagrees with the project's own formatter configuration, the
project configuration wins: reformatting a ruff-formatted codebase with `black`
(or vice versa) produces unrelated diff noise.

## Reference

See skill: `python-patterns` for comprehensive Python idioms and patterns.
