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

`ruff` は 3 つの役割すべてを担えるため、依存関係に `ruff` があるという事実だけでは
どの役割も決まりません。まず対象の役割の設定を読み、次に同じ役割についての依存関係を
見ます。ある役割に専用の設定が無く、`ruff` と単機能ツールのどちらでも担える場合は、
単機能ツールが優先されます。`ruff` は他の役割のためだけに入っている可能性があるためです。
1 つの役割に 2 つのツールが設定されている場合は、どちらかを実行せず、どちらが担当かを
確認してください。

フォーマッター:

1. 設定がツールを示している場合 — `[tool.ruff.format]` は `ruff format`、`[tool.black]`
   は `black`、`.pre-commit-config.yaml` の formatter や `format` ターゲットは
   そこで実行されるツールを意味する
2. フォーマッターの設定が無く、依存関係にフォーマッターが 1 つある場合 — それを使用する
3. フォーマッターの設定が無く、`black` が `ruff` と同居している場合 — `black` を使用する
4. 依存関係にフォーマッターが無い場合 — ECC 自身の quality gate に合わせて `ruff` の追加を
   提案し `ruff format` を使用する

インポート整列:

1. 設定がツールを示している場合 — ruff の lint 設定が `I` を選択している、または
   `[tool.ruff.lint.isort]` がある場合は `ruff check --select I --fix`、`[tool.isort]`
   や `.isort.cfg` は `isort` を意味する
2. インポートの設定が無く、依存関係にインポート整列ツールが 1 つある場合 — それを使用する
3. インポートの設定が無く、`isort` が `ruff` と同居している場合 — `isort` を使用する
4. 依存関係にインポート整列ツールが無い場合 — PEP 8 の順序を手動で保つか、`ruff` の追加を
   提案し `ruff check --select I --fix` を使用する

リンティング:

1. 設定がツールを示している場合 — `[tool.ruff.lint]` や `[tool.ruff]` の `select` は
   `ruff check`、`.flake8` や `[flake8]` セクションは `flake8`、`[tool.pylint]` や
   `.pylintrc` は `pylint` を意味する
2. lint の設定が無く、依存関係にリンターが 1 つある場合 — それを使用する
3. lint の設定が無く、`flake8` または `pylint` が `ruff` と同居している場合 —
   そのリンターを使用する
4. 依存関係にリンターが無い場合 — `ruff` の追加を提案し `ruff check` を使用する

上記の順序の具体例:

| プロジェクト | フォーマッター | インポート整列 | リンティング |
| --- | --- | --- | --- |
| `ruff` のみ、`[tool.ruff.format]` あり、lint が `I` を選択 | `ruff format` | `ruff check --select I --fix` | `ruff check` |
| `ruff` + `flake8`、`[tool.ruff.format]` あり、ruff の lint 設定なし | `ruff format` | `ruff check --select I --fix` | `flake8` |
| `ruff` + `black`、ruff の lint が `I` を選択、`[tool.ruff.format]` なし | `black` | `ruff check --select I --fix` | `ruff check` |
| `black` + `isort` + `flake8`、`ruff` なし | `black` | `isort` | `flake8` |

ツールを追加する手順はプロジェクトの依存関係を変更します。まず提案し、その依存関係が
実際にインストールされるまでコマンドを実行してはいけません。

ここでのルールがプロジェクト自身の設定と食い違う場合は、プロジェクト設定が優先されます。
ruff でフォーマットされたコードベースを `black` で（またはその逆で）再フォーマットすると、
無関係な差分ノイズが発生します。

## リファレンス

スキル: `python-patterns` で包括的な Python のイディオムとパターンを参照してください。
