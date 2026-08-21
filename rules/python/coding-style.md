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

Use the tools the project already configures. Never introduce a second
formatter, and never run a tool that is not in the project's dependencies.
Resolve the formatter and the import sorter separately — a project may pair
`black` with ruff's import rules, or `ruff format` with `isort`.

Formatter:

1. `pyproject.toml` declares `[tool.ruff.format]`, or `ruff` is a dependency and
   `black` is not — use `ruff format`.
2. `black` is a dependency — use `black`.
3. Neither is a dependency — add `ruff` and use `ruff format`, matching ECC's
   own quality gate.

Import sorting:

1. The ruff lint config selects `I`, or declares `[tool.ruff.lint.isort]` — use
   `ruff check --select I --fix`.
2. `isort` is a dependency — use `isort`.
3. Neither is a dependency — add `ruff` and use `ruff check --select I --fix`.

Use **ruff** for linting in every case.

When a rule here disagrees with the project's own configuration, the project
configuration wins: reformatting a ruff-formatted codebase with `black` (or
vice versa) produces unrelated diff noise.

## Reference

See skill: `python-patterns` for comprehensive Python idioms and patterns.
