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

Usa el formateador que el proyecto ya tiene configurado. Nunca introduzcas un
segundo formateador ni ejecutes una herramienta que no esté en las dependencias
del proyecto. Resuélvelo en este orden:

1. `pyproject.toml` declara `[tool.ruff.format]`, o `ruff` es una dependencia y
   `black` no lo es — usa `ruff format` para formatear y
   `ruff check --select I --fix` para ordenar imports.
2. `black` y/o `isort` son dependencias — usa `black` para formatear e `isort`
   para ordenar imports.
3. Ninguno está configurado — por defecto usa `ruff format` y
   `ruff check --select I`, igual que el quality gate del propio ECC.

Usa **ruff** para linting en todos los casos.

Cuando una regla de aquí contradiga la configuración de formateo del proyecto,
gana la configuración del proyecto: reformatear con `black` un código formateado
con ruff (o al revés) produce ruido de diff sin relación con el cambio.

## Referencia

Ver skill: `python-patterns` para idiomas y patrones completos de Python.
