---
description: "Python coding style extending common rules"
globs: ["**/*.py", "**/*.pyi"]
alwaysApply: false
---
# Python Coding Style

> This file extends the common coding style rule with Python specific content.

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

- Use the formatter, import sorter, and linter configured by the project.
- In a Ruff-only project, use `ruff format` and `ruff check`; do not require `black` or `isort`.
- Do not introduce or run a second tool unless the project explicitly adopts it.

## Reference

See skill: `python-patterns` for comprehensive Python idioms and patterns.
