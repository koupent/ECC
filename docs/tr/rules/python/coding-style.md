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

Projenin halihazırda yapılandırdığı araçları kullanın. Asla ikinci bir
formatlayıcı eklemeyin ve projenin bağımlılıklarında olmayan bir aracı
çalıştırmayın. Formatlayıcıyı, import sıralayıcıyı ve linter'ı ayrı ayrı
belirleyin: bir proje `black` ile ruff'un import kurallarını ya da `ruff format`
ile `isort` ve `flake8` kullanıyor olabilir.

Formatlayıcı:

1. `pyproject.toml` içinde `[tool.ruff.format]` varsa ya da `ruff` bağımlılıkta
   olup `black` yoksa — `ruff format` kullanın.
2. `black` bağımlılıkta ise — `black` kullanın.
3. Hiçbiri bağımlılıkta değilse — ECC'nin kendi quality gate'i ile uyumlu olacak
   şekilde `ruff` eklenmesini önerip `ruff format` kullanın.

Import sıralama:

1. ruff lint yapılandırması `I` seçiyorsa ya da `[tool.ruff.lint.isort]` varsa —
   `ruff check --select I --fix` kullanın.
2. `isort` bağımlılıkta ise — `isort` kullanın.
3. Hiçbiri bağımlılıkta değilse — import sırasını PEP 8'e göre elle koruyun ya da
   `ruff` eklenmesini önerip `ruff check --select I --fix` kullanın.

Linting:

1. `pyproject.toml` içinde `[tool.ruff]` ya da `[tool.ruff.lint]` varsa, ya da
   `ruff` bağımlılıkta ise — `ruff check` kullanın.
2. `flake8` ya da `pylint` bağımlılıkta ise — o linter'ı kullanın.
3. Hiçbiri bağımlılıkta değilse — `ruff` eklenmesini önerip `ruff check`
   kullanın.

Araç ekleyen bir adım projenin bağımlılıklarını değiştirir: önce önerin ve o
bağımlılık gerçekten kurulana kadar komutu çalıştırmayın.

Buradaki bir kural projenin kendi yapılandırmasıyla çelişirse proje
yapılandırması kazanır: ruff ile formatlanmış bir kod tabanını `black` ile (ya da
tersi) yeniden formatlamak ilgisiz diff gürültüsü üretir.

## Referans

Kapsamlı Python idiom'ları ve pattern'leri için skill: `python-patterns` dosyasına bakın.
