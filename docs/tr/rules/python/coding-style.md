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

Projenin halihazırda yapılandırdığı formatlayıcıyı kullanın. Asla ikinci bir
formatlayıcı eklemeyin ve projenin bağımlılıklarında olmayan bir aracı
çalıştırmayın. Şu sırayla belirleyin:

1. `pyproject.toml` içinde `[tool.ruff.format]` varsa ya da `ruff` bağımlılıkta
   olup `black` yoksa — formatlama için `ruff format`, import sıralama için
   `ruff check --select I --fix` kullanın.
2. `black` ve/veya `isort` bağımlılıkta ise — formatlama için `black`, import
   sıralama için `isort` kullanın.
3. Hiçbiri yapılandırılmamışsa — ECC'nin kendi quality gate'i ile uyumlu olacak
   şekilde `ruff format` ve `ruff check --select I` varsayılan olsun.

Linting için her durumda **ruff** kullanın.

Buradaki bir kural projenin kendi formatlayıcı yapılandırmasıyla çelişirse proje
yapılandırması kazanır: ruff ile formatlanmış bir kod tabanını `black` ile (ya da
tersi) yeniden formatlamak ilgisiz diff gürültüsü üretir.

## Referans

Kapsamlı Python idiom'ları ve pattern'leri için skill: `python-patterns` dosyasına bakın.
