---
paths:
  - "**/*.py"
  - "**/*.pyi"
---
# Hooks de Python

> Este archivo extiende [common/hooks.md](../common/hooks.md) con contenido específico de Python.

## Hooks PostToolUse

Configurar en `~/.claude/settings.json`:

- **Formateador**: Auto-formatear archivos `.py` después de editar con el
  formateador que el proyecto configura — ver
  [coding-style.md](./coding-style.md#formateo) para resolver `ruff format` vs `black`
- **mypy/pyright**: Ejecutar verificación de tipos después de editar archivos `.py`

## Advertencias

- Advertir sobre sentencias `print()` en los archivos editados (usar el módulo `logging` en su lugar)
