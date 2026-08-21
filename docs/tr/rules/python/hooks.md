---
paths:
  - "**/*.py"
  - "**/*.pyi"
---
# Python Hooks

> Bu dosya [common/hooks.md](../common/hooks.md) dosyasını Python'a özgü içerikle genişletir.

## PostToolUse Hooks

`~/.claude/settings.json` içinde yapılandır:

- **Formatlayıcı**: Edit'ten sonra `.py` dosyalarını projenin yapılandırdığı
  formatlayıcı ile otomatik formatla — `ruff format` ve `black` arasındaki seçim
  için [coding-style.md](./coding-style.md#formatlama) dosyasına bakın
- **mypy/pyright**: `.py` dosyalarını düzenledikten sonra tip kontrolü çalıştır

## Uyarılar

- Düzenlenen dosyalarda `print()` ifadeleri hakkında uyar (bunun yerine `logging` modülü kullan)
