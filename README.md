# xgomi-discord（データリポジトリ）

Discord悪質ユーザー報告・蓄積システムのうち、GitHubリポジトリ構造とスキーマ検証を担う部分。
Bot本体（Cloudflare Workers）は別コンポーネント（未着手）。

## 構成

```
schema/
  user.schema.json    # users/<id>.json のスキーマ（ドキュメント・エディタ補完用）
  stats.schema.json   # dist/stats.json のスキーマ（生成物の自己検証用）
src/
  validation.mjs      # 実行時バリデーションの正本。eval不使用・依存ゼロのESM。
                       # Worker（本番の関所）とCI（監査）が同じこのファイルを使う。
scripts/
  build-dist.mjs       # users/*.json を検証してdist/users.json・dist/stats.jsonを再生成
  validation.test.mjs  # validation.mjsのユニットテスト（node --test、追加依存なし）
users/
  <discordID>.json    # 報告データ本体（Workerが承認時にmainへ直接commit）
dist/
  users.json           # 公開一覧（status:"listed"のみ。delistedは含めない）
  stats.json            # 公開統計
  failures.json          # 直近ビルドで検証に失敗したファイルの一覧（失敗時のみ生成）
.github/workflows/build-dist.yml
```

## なぜAjv等を使わず手書きバリデータなのか

Cloudflare Workersは既定で `eval` / `new Function` を禁止している。AjvはデフォルトでJSコード生成に
`new Function` を使うため、Worker側でそのまま使うと落ちる（standalone codegenで回避も可能だがビルド
ステップが増える）。

この設計はPRレビュー工程を挟まない（メンテナのボタン操作＝唯一のレビュー）ため、**Worker側の
事前検証が実質唯一の関所**になる。CIの検証はその後追いの監査でしかなく、CIとWorkerで検証ロジックが
食い違うと「Workerは通したのにCIは弾く（またはその逆）」という事故の温床になる。そのため
`src/validation.mjs` を依存ゼロ・eval不使用のプレーンESMにして、Node（CI）にもWorkers（本番）にも
そのままimportできる形に統一した。schema/*.jsonはドキュメントとして残すが、実行時の正はこのファイル。

## Worker側との連携方法（次のステップ用メモ）

このリポジトリとWorkerリポジトリは別リポジトリになる想定（設計メモ通り）。ロジックの二重管理を
避けるため、Worker側の package.json に

```json
{
  "dependencies": {
    "xgomi-discord": "github:OWNER/REPO#main"
  }
}
```

のように直接GitHub参照でインストールし、

```js
import { validateUserRecord } from "xgomi-discord/validation";
```

として使う想定。`package.json` の `exports` はそのために用意済み。
`OWNER/REPO` は実リポジトリ確定後に `package.json` と `schema/*.json` の `$id` を置き換える。

## CIの失敗時の挙動（意図的な設計）

1件の不正ファイルがあってもビルド全体を止めない（distから該当ファイルだけ除外し、他は公開を継続する）。
ただし黙って握りつぶさないよう、以下をすべて行う。

- `dist/failures.json` に詳細を書き出す（自分自身も公開データなので監査可能）
- GitHub Issue を起票／追記する（`data-validation` ラベル）
- ジョブ自体は失敗させる（`exit 1`）— Actionsが赤くなるので気づける

Worker側の事前検証をすり抜けるケースとして想定しているのは (a) Workerのバグ、(b) メンテナが
GitHub UI経由で直接ファイルを編集、(c) スキーマ変更に既存ファイルが追従できていない、の3パターン。

## このタスクの範囲でClaudeが独自に決めた・追加した点（要レビュー）

設計メモに明記がなかった、または実装の都合で新たに判断した箇所。運用しながら変えて構わない。

- `note` に1000文字の上限を追加（メモに規定なし）
- `username` / `display_name` / `username_history`の各要素に32文字上限を追加（Discordの表示名の実仕様に近い値）
- `username_history` は最大50件（無制限にすると1レコードが際限なく肥大化するため）
- **`dist/users.json`・`dist/stats.json` は `status:"listed"` のみを含め、`delisted`は公開面から除外**
  （撤回済みの通報を公開統計に積み上げ続けるのは実態と合わないと判断。`/check`で「過去に掲載歴あり」を
  出したい場合はこの前提を変える必要あり — 未決定なら確認したい）
- `updated_at` が `added_at` より前であることを検証エラーとして扱う
- ファイル名（`<id>.json`）と中身の`id`フィールドの一致チェックを、JSON Schemaでは表現できないため
  `validation.mjs`側の追加ロジックとして実装

## 実行方法

```bash
npm test    # バリデータのユニットテスト
npm run build   # users/*.json → dist/*.json
```

## 未決定（設計メモから持ち越し・このコンポーネントの範囲外）

- Worker本体の実装（GitHub Contents API直接commit、D1連携）
- `/report` `/check` `/idlookup` のインタラクションハンドリング
- 検索・統計サイト側の実装
- 児童安全関連の別動線
