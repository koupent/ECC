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
Resolve the formatter, the import sorter, and the linter separately — a project
may pair `black` with ruff's import rules, or `ruff format` with `isort` and
`flake8`.

`ruff` can fill all three roles, so having it in the dependencies decides none
of them. Read the config for the role at hand first, then the dependencies for
that same role. Where a role has no config of its own and both `ruff` and a
single-purpose tool could fill it, the single-purpose tool wins — `ruff` may be
installed for the other roles alone. Where two tools are configured for one
role, ask which one owns it instead of running either.

Formatter:

1. A config names one — `[tool.ruff.format]` means `ruff format`, `[tool.black]`
   means `black`, and a formatter in `.pre-commit-config.yaml` or a `format`
   target means whatever that runs.
2. No formatter config, and one formatter is a dependency — use that one.
3. No formatter config, and `black` sits alongside `ruff` — use `black`.
4. No formatter in the dependencies — propose adding `ruff` and use
   `ruff format`, matching ECC's own quality gate.

Import sorting:

1. A config names one — a ruff lint config that selects `I` or declares
   `[tool.ruff.lint.isort]` means `ruff check --select I --fix`; `[tool.isort]`
   or `.isort.cfg` means `isort`.
2. No import config, and one import sorter is a dependency — use that one.
3. No import config, and `isort` sits alongside `ruff` — use `isort`.
4. No import sorter in the dependencies — keep imports in PEP 8 order by hand,
   or propose adding `ruff` and use `ruff check --select I --fix`.

Linting:

1. A config names one — `[tool.ruff.lint]`, or `select` under `[tool.ruff]`,
   means `ruff check`; `.flake8` or a `[flake8]` section means `flake8`;
   `[tool.pylint]` or `.pylintrc` means `pylint`.
2. No lint config, and one linter is a dependency — use that one.
3. No lint config, and `flake8` or `pylint` sits alongside `ruff` — use that
   linter.
4. No linter in the dependencies — propose adding `ruff` and use `ruff check`.

Worked examples of the orders above:

| Project | Formatter | Import sorting | Linting |
| --- | --- | --- | --- |
| `ruff` only, `[tool.ruff.format]`, lint selects `I` | `ruff format` | `ruff check --select I --fix` | `ruff check` |
| `ruff` + `flake8`, `[tool.ruff.format]`, no ruff lint config | `ruff format` | `ruff check --select I --fix` | `flake8` |
| `ruff` + `black`, ruff lint selects `I`, no `[tool.ruff.format]` | `black` | `ruff check --select I --fix` | `ruff check` |
| `black` + `isort` + `flake8`, no `ruff` | `black` | `isort` | `flake8` |

A step that adds a tool changes the project's dependencies: propose it first,
and do not run the command until that dependency is actually installed.

When a rule here disagrees with the project's own configuration, the project
configuration wins: reformatting a ruff-formatted codebase with `black` (or
vice versa) produces unrelated diff noise.

## Reference

See skill: `python-patterns` for comprehensive Python idioms and patterns.
