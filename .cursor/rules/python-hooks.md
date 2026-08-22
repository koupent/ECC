---
description: "Python hooks extending common rules"
globs: ["**/*.py", "**/*.pyi"]
alwaysApply: false
---
# Python Hooks

> This file extends the common hooks rule with Python specific content.

## PostToolUse Hooks

Configure in `~/.claude/settings.json`:

- **Configured formatter**: Auto-format `.py` files after edit with the formatter selected by the project
- **mypy/pyright**: Run type checking after editing `.py` files

## Warnings

- Warn about `print()` statements in edited files (use `logging` module instead)
