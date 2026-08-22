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

* 使用项目配置中选定的格式化、导入排序和检查工具
* Ruff-only 项目使用 `ruff format` 和 `ruff check`，不得要求 black 或 isort
* 不得添加或运行项目未采用的第二套工具

## 参考

查看技能：`python-patterns` 以获取全面的 Python 惯用法和模式。
