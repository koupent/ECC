---
paths:
  - "**/*.py"
  - "**/*.pyi"
---
# Python Kodlama Stili

> Bu dosya [common/coding-style.md](../common/coding-style.md) dosyasını Python'a özgü içerikle genişletir.

## Standartlar

- **PEP 8** konvansiyonlarını takip et
- Tüm fonksiyon imzalarında **type annotation'lar** kullan

## Immutability

Immutable veri yapılarını tercih et:

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

## Formatlama

- Projenin yapılandırdığı biçimlendirici, import sıralayıcı ve linter'ı kullanın
- Ruff-only projede `ruff format` ve `ruff check` kullanın; black veya isort istemeyin
- Projenin benimsemediği ikinci bir aracı eklemeyin veya çalıştırmayın

## Referans

Kapsamlı Python idiom'ları ve pattern'leri için skill: `python-patterns` dosyasına bakın.
