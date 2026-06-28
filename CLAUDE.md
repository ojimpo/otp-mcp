# otp-mcp

セルフホストのOpenTripPlanner (OTP) をMCPサーバー越しに使えるようにするツール。Claude Code / claude.ai から正確な関東の経路検索・駅サジェストを叩けるようにする。

## これは何か / 何でないか
- **これは**: OTPのGraphQL（`planConnection` / `stops`）を叩いて結果を整形する薄いMCPラッパー
- **これでない**: OTP本体・GTFS・グラフは含まない。経路検索の精度・カバレッジはOTP側に依存する

## 技術構成
- TypeScript + `@modelcontextprotocol/sdk`、stdio / HTTP 両対応
- 足場は scrapbox-cosense-mcp（worldnine）の構成を踏襲（`src/http-server.ts` は汎用なのでほぼ流用）
- `src/otp.ts` … OTPクライアント＋整形（ここが本体）
- `src/index.ts` … ツール登録（`plan_journey` / `suggest_stations`）とトランスポート分岐（`TRANSPORT` env）
- `src/cli.ts` … 動作確認用CLI（`node build/index.js plan 新宿 渋谷`）

## OTPへの接続
- `OTP_BASE_URL`（既定 `http://localhost:8080`）。Dockerでは arigatai-score の `arigatai-score_internal` ネットワークに相乗りして `http://otp:8080`
- OTPは別リポジトリ [arigatai-score](https://github.com/ojimpo/arigatai-score) の docker compose で稼働

## 開発
- ビルド: `npm install && npm run build`（→ `build/`）
- 動作確認: OTP稼働中に `node build/index.js plan 新宿 渋谷` / `suggest 新宿`
- Docker: `docker compose up -d --build`（HTTP, ポート4101→3000）

## 方針
- OTPのクエリは arigatai-score の backend/services/otp.py で実証済みのものを基にする
- 駅名は一部GTFSが英語併記を含むため `normalizeName` で日本語部分のみに正規化
- 経路は RAIL / SUBWAY に限定（OTPのmodes指定）
