---
paths:
  - "**/*.py"
  - "**/*.pyi"
---
# Python コーディングスタイル

> このファイルは [common/coding-style.md](../common/coding-style.md) を Python 固有のコンテンツで拡張します。

## 標準

- **PEP 8** 規約に従う
- すべての関数シグネチャに**型アノテーション**を使用する

## 不変性

不変データ構造を優先する:

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

## フォーマット

プロジェクトが設定済みのフォーマッターを使用してください。2 つ目のフォーマッターを
導入したり、プロジェクトの依存関係に無いツールを実行したりしてはいけません。
次の順序で解決します。

1. `pyproject.toml` に `[tool.ruff.format]` がある、または `ruff` が依存関係にあり
   `black` が無い場合 — フォーマットは `ruff format`、インポート整列は
   `ruff check --select I --fix` を使用する
2. `black` や `isort` が依存関係にある場合 — フォーマットは `black`、インポート整列は
   `isort` を使用する
3. どちらも設定されていない場合 — ECC 自身の quality gate に合わせて
   `ruff format` と `ruff check --select I` を既定とする

リンティングにはいずれの場合も **ruff** を使用してください。

ここでのルールがプロジェクト自身のフォーマッター設定と食い違う場合は、プロジェクト
設定が優先されます。ruff でフォーマットされたコードベースを `black` で（またはその逆で）
再フォーマットすると、無関係な差分ノイズが発生します。

## リファレンス

スキル: `python-patterns` で包括的な Python のイディオムとパターンを参照してください。
