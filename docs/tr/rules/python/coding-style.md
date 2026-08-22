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

`ruff` üç rolü de üstlenebilir, bu yüzden bağımlılıklarda bulunması tek başına
hiçbir rolü belirlemez. Önce ilgili rolün yapılandırmasını, ardından aynı rolün
bağımlılıklarını okuyun. Bir rolün kendi yapılandırması yoksa ve o rolü hem
`ruff` hem de tek amaçlı bir araç üstlenebiliyorsa, tek amaçlı araç kazanır:
`ruff` yalnızca diğer roller için kurulmuş olabilir. Aynı rol için iki araç
yapılandırılmışsa, birini çalıştırmak yerine hangisinin sahip olduğunu sorun.

Formatlayıcı:

1. Bir yapılandırma araç belirtiyorsa — `[tool.ruff.format]` `ruff format`,
   `[tool.black]` `black` demektir; `.pre-commit-config.yaml` içindeki bir
   formatlayıcı ya da bir `format` hedefi ise orada çalışan aracı belirtir.
2. Format yapılandırması yoksa ve bağımlılıkta tek bir formatlayıcı varsa — onu
   kullanın.
3. Format yapılandırması yoksa ve `black`, `ruff` ile birlikte duruyorsa —
   `black` kullanın.
4. Bağımlılıkta formatlayıcı yoksa — ECC'nin kendi quality gate'i ile uyumlu
   olacak şekilde `ruff` eklenmesini önerip `ruff format` kullanın.

Import sıralama:

1. Bir yapılandırma araç belirtiyorsa — `I` seçen bir ruff lint yapılandırması
   ya da `[tool.ruff.lint.isort]` `ruff check --select I --fix`, `[tool.isort]`
   ya da `.isort.cfg` ise `isort` demektir.
2. Import yapılandırması yoksa ve bağımlılıkta tek bir import sıralayıcı varsa —
   onu kullanın.
3. Import yapılandırması yoksa ve `isort`, `ruff` ile birlikte duruyorsa —
   `isort` kullanın.
4. Bağımlılıkta import sıralayıcı yoksa — import sırasını PEP 8'e göre elle
   koruyun ya da `ruff` eklenmesini önerip `ruff check --select I --fix`
   kullanın.

Linting:

1. Bir yapılandırma araç belirtiyorsa — `[tool.ruff.lint]` ya da `[tool.ruff]`
   altındaki `select` `ruff check`, `.flake8` ya da bir `[flake8]` bölümü
   `flake8`, `[tool.pylint]` ya da `.pylintrc` ise `pylint` demektir.
2. Lint yapılandırması yoksa ve bağımlılıkta tek bir linter varsa — onu
   kullanın.
3. Lint yapılandırması yoksa ve `flake8` ya da `pylint`, `ruff` ile birlikte
   duruyorsa — o linter'ı kullanın.
4. Bağımlılıkta linter yoksa — `ruff` eklenmesini önerip `ruff check` kullanın.

Yukarıdaki sıraların çözümlü örnekleri:

| Proje | Formatlayıcı | Import sıralama | Linting |
| --- | --- | --- | --- |
| Yalnızca `ruff`, `[tool.ruff.format]`, lint `I` seçiyor | `ruff format` | `ruff check --select I --fix` | `ruff check` |
| `ruff` + `flake8`, `[tool.ruff.format]`, ruff lint yapılandırması yok | `ruff format` | `ruff check --select I --fix` | `flake8` |
| `ruff` + `black`, ruff lint `I` seçiyor, `[tool.ruff.format]` yok | `black` | `ruff check --select I --fix` | `ruff check` |
| `black` + `isort` + `flake8`, `ruff` yok | `black` | `isort` | `flake8` |

Araç ekleyen bir adım projenin bağımlılıklarını değiştirir: önce önerin ve o
bağımlılık gerçekten kurulana kadar komutu çalıştırmayın.

Buradaki bir kural projenin kendi yapılandırmasıyla çelişirse proje
yapılandırması kazanır: ruff ile formatlanmış bir kod tabanını `black` ile (ya da
tersi) yeniden formatlamak ilgisiz diff gürültüsü üretir.

## Referans

Kapsamlı Python idiom'ları ve pattern'leri için skill: `python-patterns` dosyasına bakın.
