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

Usa las herramientas que el proyecto ya tiene configuradas. Nunca introduzcas un
segundo formateador ni ejecutes una herramienta que no esté en las dependencias
del proyecto. Resuelve el formateador, el ordenador de imports y el linter por
separado: un proyecto puede combinar `black` con las reglas de imports de ruff, o
`ruff format` con `isort` y `flake8`.

Formateador:

1. `pyproject.toml` declara `[tool.ruff.format]`, o `ruff` es una dependencia y
   `black` no lo es — usa `ruff format`.
2. `black` es una dependencia — usa `black`.
3. Ninguno es dependencia — propón añadir `ruff` y usa `ruff format`, igual que
   el quality gate del propio ECC.

Ordenación de imports:

1. La configuración de lint de ruff selecciona `I`, o declara
   `[tool.ruff.lint.isort]` — usa `ruff check --select I --fix`.
2. `isort` es una dependencia — usa `isort`.
3. Ninguno es dependencia — mantén el orden de PEP 8 a mano, o propón añadir
   `ruff` y usa `ruff check --select I --fix`.

Linting:

1. `pyproject.toml` declara `[tool.ruff]` o `[tool.ruff.lint]`, o `ruff` es una
   dependencia — usa `ruff check`.
2. `flake8` o `pylint` es una dependencia — usa ese linter.
3. Ninguno es dependencia — propón añadir `ruff` y usa `ruff check`.

Un paso que añade una herramienta cambia las dependencias del proyecto:
propónlo primero y no ejecutes el comando hasta que esa dependencia esté
instalada.

Cuando una regla de aquí contradiga la configuración del propio proyecto, gana
la configuración del proyecto: reformatear con `black` un código formateado con
ruff (o al revés) produce ruido de diff sin relación con el cambio.

## Referencia

Ver skill: `python-patterns` para idiomas y patrones completos de Python.
