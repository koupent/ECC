---
paths:
  - "**/*.py"
  - "**/*.pyi"
---
# Python Hooks

> This file extends [common/hooks.md](../common/hooks.md) with Python specific content.

## PostToolUse Hooks

Configure in `~/.claude/settings.json`:

- **Formatter**: Auto-format `.py` files after edit with the formatter the
  project configures — see [coding-style.md](./coding-style.md#formatting) for
  how to resolve `ruff format` vs `black`
- **mypy/pyright**: Run type checking after editing `.py` files

## Warnings

- Warn about `print()` statements in edited files (use `logging` module instead)
