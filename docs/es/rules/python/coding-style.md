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

`ruff` puede cubrir los tres roles, así que tenerlo entre las dependencias no
decide ninguno. Lee primero la configuración del rol en cuestión y después las
dependencias de ese mismo rol. Cuando un rol no tiene configuración propia y
tanto `ruff` como una herramienta de un solo propósito podrían cubrirlo, gana la
de un solo propósito: `ruff` puede estar instalado solo para los otros roles.
Cuando hay dos herramientas configuradas para un mismo rol, pregunta cuál manda
en lugar de ejecutar cualquiera de ellas.

Formateador:

1. Una configuración nombra una — `[tool.ruff.format]` significa `ruff format`,
   `[tool.black]` significa `black`, y un formateador en
   `.pre-commit-config.yaml` o un target `format` significa lo que ese ejecute.
2. Sin configuración de formateo y con un formateador en las dependencias — usa
   ese.
3. Sin configuración de formateo y con `black` junto a `ruff` — usa `black`.
4. Sin formateador en las dependencias — propón añadir `ruff` y usa
   `ruff format`, igual que el quality gate del propio ECC.

Ordenación de imports:

1. Una configuración nombra una — una configuración de lint de ruff que
   selecciona `I` o declara `[tool.ruff.lint.isort]` significa
   `ruff check --select I --fix`; `[tool.isort]` o `.isort.cfg` significa
   `isort`.
2. Sin configuración de imports y con un ordenador en las dependencias — usa
   ese.
3. Sin configuración de imports y con `isort` junto a `ruff` — usa `isort`.
4. Sin ordenador de imports en las dependencias — mantén el orden de PEP 8 a
   mano, o propón añadir `ruff` y usa `ruff check --select I --fix`.

Linting:

1. Una configuración nombra uno — `[tool.ruff.lint]`, o `select` dentro de
   `[tool.ruff]`, significa `ruff check`; `.flake8` o una sección `[flake8]`
   significa `flake8`; `[tool.pylint]` o `.pylintrc` significa `pylint`.
2. Sin configuración de lint y con un linter en las dependencias — usa ese.
3. Sin configuración de lint y con `flake8` o `pylint` junto a `ruff` — usa ese
   linter.
4. Sin linter en las dependencias — propón añadir `ruff` y usa `ruff check`.

Ejemplos resueltos de los órdenes anteriores:

| Proyecto | Formateador | Ordenación de imports | Linting |
| --- | --- | --- | --- |
| Solo `ruff`, `[tool.ruff.format]`, lint selecciona `I` | `ruff format` | `ruff check --select I --fix` | `ruff check` |
| `ruff` + `flake8`, `[tool.ruff.format]`, sin configuración de lint de ruff | `ruff format` | `ruff check --select I --fix` | `flake8` |
| `ruff` + `black`, lint de ruff selecciona `I`, sin `[tool.ruff.format]` | `black` | `ruff check --select I --fix` | `ruff check` |
| `black` + `isort` + `flake8`, sin `ruff` | `black` | `isort` | `flake8` |

Un paso que añade una herramienta cambia las dependencias del proyecto:
propónlo primero y no ejecutes el comando hasta que esa dependencia esté
instalada.

Cuando una regla de aquí contradiga la configuración del propio proyecto, gana
la configuración del proyecto: reformatear con `black` un código formateado con
ruff (o al revés) produce ruido de diff sin relación con el cambio.

## Referencia

Ver skill: `python-patterns` para idiomas y patrones completos de Python.
