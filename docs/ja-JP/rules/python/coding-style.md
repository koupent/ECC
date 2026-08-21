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

プロジェクトが設定済みのツールを使用してください。2 つ目のフォーマッターを導入したり、
プロジェクトの依存関係に無いツールを実行したりしてはいけません。フォーマッター、
インポート整列ツール、リンターは別々に判断します。`black` と ruff のインポートルール、
あるいは `ruff format` と `isort`・`flake8` を組み合わせているプロジェクトもあるためです。

フォーマッター:

1. `pyproject.toml` に `[tool.ruff.format]` がある、または `ruff` が依存関係にあり
   `black` が無い場合 — `ruff format` を使用する
2. `black` が依存関係にある場合 — `black` を使用する
3. どちらも依存関係に無い場合 — ECC 自身の quality gate に合わせて `ruff` の追加を
   提案し `ruff format` を使用する

インポート整列:

1. ruff の lint 設定が `I` を選択している、または `[tool.ruff.lint.isort]` がある場合 —
   `ruff check --select I --fix` を使用する
2. `isort` が依存関係にある場合 — `isort` を使用する
3. どちらも依存関係に無い場合 — PEP 8 の順序を手動で保つか、`ruff` の追加を提案し
   `ruff check --select I --fix` を使用する

リンティング:

1. `pyproject.toml` に `[tool.ruff]` または `[tool.ruff.lint]` がある、または `ruff` が
   依存関係にある場合 — `ruff check` を使用する
2. `flake8` または `pylint` が依存関係にある場合 — そのリンターを使用する
3. いずれも依存関係に無い場合 — `ruff` の追加を提案し `ruff check` を使用する

ツールを追加する手順はプロジェクトの依存関係を変更します。まず提案し、その依存関係が
実際にインストールされるまでコマンドを実行してはいけません。

ここでのルールがプロジェクト自身の設定と食い違う場合は、プロジェクト設定が優先されます。
ruff でフォーマットされたコードベースを `black` で（またはその逆で）再フォーマットすると、
無関係な差分ノイズが発生します。

## リファレンス

スキル: `python-patterns` で包括的な Python のイディオムとパターンを参照してください。
