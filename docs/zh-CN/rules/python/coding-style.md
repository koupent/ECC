---
paths:
  - "**/*.py"
  - "**/*.pyi"
---

# Python 编码风格

> 本文件在 [common/coding-style.md](../common/coding-style.md) 的基础上扩展了 Python 特定的内容。

## 标准

* 遵循 **PEP 8** 规范
* 在所有函数签名上使用 **类型注解**

## 不变性

优先使用不可变数据结构：

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

## 格式化

使用项目已配置的工具。不要引入第二个格式化工具，也不要运行不在项目依赖中的工具。
格式化工具、导入排序工具与 linter 需分别判断：项目可能将 `black` 与 ruff 的导入规则
搭配使用，也可能将 `ruff format` 与 `isort`、`flake8` 搭配使用。

`ruff` 可以承担全部三种角色，因此依赖中存在 `ruff` 本身并不能决定任何一种角色。
先看当前角色的配置，再看该角色对应的依赖。若某个角色没有自己的配置，而 `ruff`
与某个单一用途工具都能胜任，则单一用途工具优先 —— `ruff` 可能只是为其他角色而
安装的。若同一角色配置了两个工具，请询问由哪一个负责，而不是直接运行其中之一。

格式化工具：

1. 配置指明了工具 —— `[tool.ruff.format]` 表示 `ruff format`，`[tool.black]` 表示
   `black`，`.pre-commit-config.yaml` 中的 formatter 或 `format` target 表示其所
   运行的工具
2. 没有格式化配置，且依赖中只有一个格式化工具 —— 使用该工具
3. 没有格式化配置，且 `black` 与 `ruff` 并存 —— 使用 `black`
4. 依赖中没有格式化工具 —— 提议添加 `ruff` 并使用 `ruff format`，与 ECC 自身的
   quality gate 保持一致

导入排序：

1. 配置指明了工具 —— ruff 的 lint 配置选择了 `I` 或声明了 `[tool.ruff.lint.isort]`
   表示 `ruff check --select I --fix`；`[tool.isort]` 或 `.isort.cfg` 表示 `isort`
2. 没有导入排序配置，且依赖中只有一个导入排序工具 —— 使用该工具
3. 没有导入排序配置，且 `isort` 与 `ruff` 并存 —— 使用 `isort`
4. 依赖中没有导入排序工具 —— 按 PEP 8 手动保持导入顺序，或提议添加 `ruff` 并使用
   `ruff check --select I --fix`

代码检查（linting）：

1. 配置指明了工具 —— `[tool.ruff.lint]` 或 `[tool.ruff]` 下的 `select` 表示
   `ruff check`；`.flake8` 或 `[flake8]` 小节表示 `flake8`；`[tool.pylint]` 或
   `.pylintrc` 表示 `pylint`
2. 没有 lint 配置，且依赖中只有一个 linter —— 使用该 linter
3. 没有 lint 配置，且 `flake8` 或 `pylint` 与 `ruff` 并存 —— 使用该 linter
4. 依赖中没有 linter —— 提议添加 `ruff` 并使用 `ruff check`

上述顺序的实例：

| 项目 | 格式化工具 | 导入排序 | 代码检查 |
| --- | --- | --- | --- |
| 仅 `ruff`、有 `[tool.ruff.format]`、lint 选择了 `I` | `ruff format` | `ruff check --select I --fix` | `ruff check` |
| `ruff` + `flake8`、有 `[tool.ruff.format]`、没有 ruff lint 配置 | `ruff format` | `ruff check --select I --fix` | `flake8` |
| `ruff` + `black`、ruff lint 选择了 `I`、没有 `[tool.ruff.format]` | `black` | `ruff check --select I --fix` | `ruff check` |
| `black` + `isort` + `flake8`、没有 `ruff` | `black` | `isort` | `flake8` |

添加工具的步骤会改变项目依赖：先提出建议，在该依赖真正安装之前不要运行相应命令。

当这里的规则与项目自身的配置冲突时，以项目配置为准：用 `black` 重新格式化已由
ruff 格式化的代码库（或反之）会产生无关的 diff 噪音。

## 参考

查看技能：`python-patterns` 以获取全面的 Python 惯用法和模式。
