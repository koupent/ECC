---
description: "Python hooks extending common rules"
globs: ["**/*.py", "**/*.pyi"]
alwaysApply: false
---
# Python Hooks

> This file extends the common hooks rule with Python specific content.

## PostToolUse Hooks

Configure in `~/.claude/settings.json`:

- **Formatter**: Auto-format `.py` files after edit with the formatter the
  project configures — see `python-coding-style.md` (Formatting) for how to
  resolve `ruff format` vs `black`
- **mypy/pyright**: Run type checking after editing `.py` files

## Warnings

- Warn about `print()` statements in edited files (use `logging` module instead)
