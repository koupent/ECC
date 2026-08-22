---
paths:
  - "**/*.py"
  - "**/*.pyi"
---

# Python 钩子

> 本文档扩展了 [common/hooks.md](../common/hooks.md) 中关于 Python 的特定内容。

## PostToolUse 钩子

在 `~/.claude/settings.json` 中配置：

* **项目配置的格式化工具**：使用项目选定的工具自动格式化编辑后的 `.py` 文件
* **mypy/pyright**：编辑 `.py` 文件后运行类型检查

## 警告

* 对编辑文件中的 `print()` 语句发出警告（应使用 `logging` 模块替代）
