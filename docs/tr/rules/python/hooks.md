---
paths:
  - "**/*.py"
  - "**/*.pyi"
---
# Python Hooks

> Bu dosya [common/hooks.md](../common/hooks.md) dosyasını Python'a özgü içerikle genişletir.

## PostToolUse Hooks

`~/.claude/settings.json` içinde yapılandır:

- **Yapılandırılmış biçimlendirici**: Edit'ten sonra `.py` dosyalarını projenin seçtiği araçla biçimlendir
- **mypy/pyright**: `.py` dosyalarını düzenledikten sonra tip kontrolü çalıştır

## Uyarılar

- Düzenlenen dosyalarda `print()` ifadeleri hakkında uyar (bunun yerine `logging` modülü kullan)
