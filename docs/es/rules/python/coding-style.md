---
paths:
  - "**/*.py"
  - "**/*.pyi"
---
# Estilo de Código en Python

> Este archivo extiende [common/coding-style.md](../common/coding-style.md) con contenido específico de Python.

## Estándares

- Seguir las convenciones de **PEP 8**
- Usar **anotaciones de tipos** en todas las firmas de funciones

## Inmutabilidad

Preferir estructuras de datos inmutables:

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

## Formateo

- Use el formateador, ordenador de imports y linter configurados por el proyecto
- En proyectos Ruff-only, use `ruff format` y `ruff check`; no exija black ni isort
- No agregue ni ejecute una segunda herramienta que el proyecto no haya adoptado

## Referencia

Ver skill: `python-patterns` para idiomas y patrones completos de Python.
