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

---

## 現在の運用状態（2026-06-28 構築）

このリポジトリは初版を作って本番稼働まで通してある。

- **公開URL**: `https://otp-mcp.ojimpo.com/mcp`（claude.aiカスタムコネクタ用、HTTP/Streamable、認証なし＝Cosense MCPと同じ運用）
  - 推奨登録名: **`OTP`**
- **稼働**: arigato-nas 上で `docker compose up -d`（host 4101 → container 3000、TRANSPORT=http）
  - `arigatai-score_internal` ネットワークに external で相乗りし `http://otp:8080` のOTPに到達
  - `.env` は gitignore（`MCP_AUTH_TOKEN=` 空、`OTP_BASE_URL=http://otp:8080`）
- **Cloudflare Tunnel**: `/etc/cloudflared/config.yml` に `otp-mcp.ojimpo.com → http://localhost:4101` のingressを追加済み。DNS CNAMEも作成済み（tunnel `0cfa43b6-...`）。cloudflaredはsystemサービス（編集・再起動は要sudo）
- **検証済み**: 公開URLで `tools/list`（plan_journey / suggest_stations）と `plan_journey 新宿→渋谷` が動作。精度は OTP由来で正確（例 鶴見→赤羽 43分、Yahoo乗換案内と一致）
- **背景**: 公開の Transit API（MCP付き）は便利だが関東のJR直通系統で精度が約5倍悪く、arigatai-score では採用見送り。その「便利なMCP体験」を自前OTPの正確データで実現したのが本ツール。詳細は arigatai-score の docs/transit-api-evaluation.md

## グラフィカル経路表示 `plan_route_map`（実装済み・2026-06-30）

claude.aiはツールが返す**画像をインライン表示できる**ので、経路を描いたPNGを返すツール `plan_route_map` を追加した。

**当初はOSMタイル地図を想定していたが、最終的に「Yahoo乗換案内アプリのルート詳細」のような縦タイムライン図にした**（地理的な地図ではなく、駅・発着時刻・路線カラー・乗換を縦に並べたダイヤグラム）。地図より一目で経路がわかる、外部タイル取得が不要、という判断。

**実装の要点**:
- 描画は `@napi-rs/canvas`（prebuiltバイナリ。nativeビルド不要、node:22-slimで動く）。staticmaps/sharp/OSMタイルは使わない
- `src/otp.ts`: `Leg` に leg単位の `startISO`/`endISO`、`color`/`textColor`（GTFS路線カラー、#なし6桁HEX）、`routeShortName` を追加。GraphQLに `start { scheduledTime } end { scheduledTime } route { color textColor }` を追加
- `src/timeline.ts` 新規: `renderRouteTimeline(from, to, itinerary) -> Buffer`
  - legから駅ノード列を組み、駅ごとに 着/発 時刻（乗換駅は2行）を表示
  - 区間は路線カラーの縦バー＋路線名チップ（チップ背景=路線カラー、文字色=textColorか明度判定で白黒）。WALKは灰色破線＋「徒歩N分」
  - 始点=緑、終点=赤、中間=白抜きノード
  - 日本語フォントは `GlobalFonts.registerFromPath` で明示登録（napi-rs/canvasはfontconfigを見ない）。候補パスを自動探索＋`OTP_FONT_PATH`で上書き可
- `src/index.ts`: ツール `plan_route_map`（入力 from/to＋任意の routeIndex）を登録。返り値は
  `{ content: [{ type: "image", data: <base64>, mimeType: "image/png" }, { type: "text", text: <整形済み経路> }] }`
- `Dockerfile`: runtimeステージに `fonts-noto-cjk` を apt で追加（画像の日本語描画用）
- 動作確認CLI: `node build/index.js map 新宿 渋谷 route.png [routeIndex]`

**検証済み（2026-06-30, ローカルCLI）**: 新宿→渋谷（JR山手線・緑チップ）、鶴見→赤羽（2回乗換・着/発時刻・京浜東北/東海道/宇都宮線の各カラー）、座標→池袋（徒歩legの灰色破線）でPNG生成を確認。日本語も正しく描画される。

**残課題 / 今後**:
- 本番反映: `docker compose up -d --build` → 公開URL経由で claude.ai にインライン表示されることを未確認（要デプロイ）。フォント入りでイメージサイズ・ビルド時間が増える点に注意
- 複数ルートの並列表示や、運賃・番線表示は未対応（GTFSの運賃精度に不安があり今は出していない）
- 座標入力時の端点名はOTPの "Origin"/"Destination" を解決済み地点名に置換済み
