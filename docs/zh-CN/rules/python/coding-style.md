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

格式化工具：

1. `pyproject.toml` 中声明了 `[tool.ruff.format]`，或者依赖中有 `ruff` 而没有
   `black` —— 使用 `ruff format`
2. 依赖中有 `black` —— 使用 `black`
3. 两者都不是依赖 —— 提议添加 `ruff` 并使用 `ruff format`，与 ECC 自身的 quality
   gate 保持一致

导入排序：

1. ruff 的 lint 配置选择了 `I`，或声明了 `[tool.ruff.lint.isort]` —— 使用
   `ruff check --select I --fix`
2. 依赖中有 `isort` —— 使用 `isort`
3. 两者都不是依赖 —— 按 PEP 8 手动保持导入顺序，或提议添加 `ruff` 并使用
   `ruff check --select I --fix`

代码检查（linting）：

1. `pyproject.toml` 中声明了 `[tool.ruff]` 或 `[tool.ruff.lint]`，或者依赖中有
   `ruff` —— 使用 `ruff check`
2. 依赖中有 `flake8` 或 `pylint` —— 使用该 linter
3. 都不是依赖 —— 提议添加 `ruff` 并使用 `ruff check`

添加工具的步骤会改变项目依赖：先提出建议，在该依赖真正安装之前不要运行相应命令。

当这里的规则与项目自身的配置冲突时，以项目配置为准：用 `black` 重新格式化已由
ruff 格式化的代码库（或反之）会产生无关的 diff 噪音。

## 参考

查看技能：`python-patterns` 以获取全面的 Python 惯用法和模式。
