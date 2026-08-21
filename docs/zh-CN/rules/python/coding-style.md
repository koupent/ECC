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

使用项目已配置的格式化工具。不要引入第二个格式化工具，也不要运行不在项目依赖中的
工具。按以下顺序判断：

1. `pyproject.toml` 中声明了 `[tool.ruff.format]`，或者依赖中有 `ruff` 而没有
   `black` —— 使用 `ruff format` 进行格式化，使用 `ruff check --select I --fix`
   进行导入排序
2. 依赖中有 `black` 和/或 `isort` —— 使用 `black` 进行格式化，使用 `isort` 进行导入排序
3. 两者都未配置 —— 默认使用 `ruff format` 和 `ruff check --select I`，与 ECC 自身的
   quality gate 保持一致

无论哪种情况，都使用 **ruff** 进行代码检查。

当这里的规则与项目自身的格式化配置冲突时，以项目配置为准：用 `black` 重新格式化已由
ruff 格式化的代码库（或反之）会产生无关的 diff 噪音。

## 参考

查看技能：`python-patterns` 以获取全面的 Python 惯用法和模式。
