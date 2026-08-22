# xgomi-bot（Discord Bot / Cloudflare Workers）

設計メモの「Discord Bot（Interactions）」を担当する部分。GitHub側のデータリポジトリ（xgomi-discord）
とは別リポジトリとして運用する想定。

## 現状（このステップで実装済み）

- 署名検証（Ed25519） — 全インタラクションの唯一の関所
- `/idlookup` — フル実装（メッセージリンク→投稿者ID・ユーザー名をephemeral返信）
- `/check` `/report` — コマンド登録のみ済み、呼ぶと「準備中」を返すスタブ
- コマンド登録スクリプト（`npm run register`）
- 署名検証のユニットテスト（実際にEd25519鍵ペアで署名・改ざん検知まで確認済み）

## 構成

```
src/
  index.ts              # エントリポイント。署名検証→type別ディスパッチ
  env.ts                # Env（バインディング）の型
  discord/
    verify.ts           # 署名検証本体
    verify.test.ts       # ↑のユニットテスト（node --import tsx --test）
    responses.ts          # ephemeral返信・PONGのヘルパー
    rest.ts                 # Discord REST APIの薄いラッパー（Bot token認証）
  commands/
    definitions.ts          # /report /check /idlookup のコマンド定義（登録・型の単一情報源）
    dispatch.ts               # コマンド名→ハンドラのルーティング
    idlookup.ts                 # /idlookup の実装
scripts/
  register-commands.ts          # definitions.tsをDiscordへ一括登録（PUTで上書き）
```

`tsconfig.json`（Workers用）と`tsconfig.node.json`（登録スクリプト・テスト用）を分けているのは、
`@cloudflare/workers-types`と`@types/node`が`fetch`/`Response`等の同名グローバルを競合宣言するため。

## セットアップ

### 1. Discord Developer Portalでアプリケーションを準備

1. https://discord.com/developers/applications で新規アプリケーションを作成
2. **General Information** タブから `Application ID` と `Public Key` を控える
3. **Bot** タブでBotを作成し、トークンを発行して控える（一度しか表示されないので保存を忘れずに）
4. **Bot** タブの Privileged Gateway Intents は今回は不要（Interactionsのみで完結するため）

### 2. 依存関係のインストール

```bash
npm install
```

### 3. ローカル動作確認（任意）

```bash
cp .dev.vars.example .dev.vars
# .dev.vars に DISCORD_PUBLIC_KEY / DISCORD_BOT_TOKEN / DISCORD_APPLICATION_ID を記入
npm run typecheck
npm test
npm run dev
```

`wrangler dev`はローカルにHTTPサーバーを立てるだけで、Discord側からは直接届かない
（後述のIngress URL設定にはデプロイ後の本番URLか、`wrangler dev --remote`やトンネルが必要）。

### 4. デプロイ

```bash
npx wrangler login          # 初回のみ。Cloudflareアカウントとの連携
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_BOT_TOKEN
npx wrangler secret put DISCORD_APPLICATION_ID
npm run deploy
```

デプロイ後に表示される `https://xgomi-bot.<your-subdomain>.workers.dev` のようなURLを控える。

### 5. Discord側にInteractions Endpoint URLを設定

Developer Portalの **General Information** タブ→ **Interactions Endpoint URL** に、
上記のデプロイ先URLを設定して保存する。Discordがそこへ即座にPINGを送り、Workerが
正しく `{"type":1}` を返せれば緑のチェックが付く（保存できなければ署名検証やURL自体を疑う）。

### 6. スラッシュコマンドを登録

```bash
DISCORD_APPLICATION_ID=xxx DISCORD_BOT_TOKEN=xxx DISCORD_GUILD_ID=yyy npm run register
```

`DISCORD_GUILD_ID`（動作確認したいサーバーのID）を指定すると即時反映される。開発中はこちらを推奨。
本番で全サーバー向けに登録する場合は `DISCORD_GUILD_ID` を外す（グローバル登録、反映まで最大1時間程度）。

### 7. Botをサーバーに招待

`https://discord.com/api/oauth2/authorize?client_id=<Application ID>&scope=applications.commands`
（このBotは現状メッセージ内容の読み書き権限は不要 — `/idlookup`は指定されたメッセージ1件をIDで
直接取得するだけで、bot権限は`applications.commands`スコープのみで足りる。`/report`実装時に
メンテナ専用チャンネルへの投稿権限が別途必要になる想定）

## 動作確認

サーバー内のメッセージを右クリック→「メッセージリンクをコピー」→ `/idlookup message_link:<貼り付け>` で、
そのメッセージの投稿者ID・ユーザー名がephemeral（自分にしか見えない）で返る。

## 未実装（次のステップ）

- `/report`: カテゴリSelect Menu・同意ボタン・メンテナ専用チャンネルへの転送・承認/却下ボタン・
  却下理由モーダル・GitHub Contents API直接commit・D1連携・報告者へのDM通知
- `/check`: D1（報告者本人の履歴）・`dist/users.json`（全体検索）の参照
- D1スキーマ・マイグレーション
- 検索・統計サイト
