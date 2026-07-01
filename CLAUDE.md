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

## グラフィカル経路表示 `plan_route_map`（MCP Apps方式・2026-07-01 作り替え）

「Yahoo乗換案内アプリのルート詳細」風の縦タイムライン（駅・発着時刻・路線カラー・乗換を縦に並べたダイヤグラム）を claude.ai にインライン表示するツール。

**重要な経緯（回り道の記録）**:
1. 最初は `@napi-rs/canvas` で**PNG画像**を生成し image content（`{type:"image"}`）で返した。CLIでは正しく描けたが、**claude.aiのチャットには画像が表示されなかった**（テキストのみ表示）。
2. 調査の結果、**claude.aiのリモートコネクタは tool result の image content block をインライン表示しない**（既知の制限。Claude自身は画像を分析できるがUIには出ない）。
3. だが公開の **Transit乗換案内 MCP（`https://api.transit.ls8h.com/mcp`）は claude.ai で経路図を出せている**。その実レスポンスを直接叩いて調べたところ、正体は **MCP Apps（MCP-UI）拡張**だった:
   - initializeで `capabilities.extensions["io.modelcontextprotocol/ui"] = { mimeTypes:["text/html;profile=mcp-app"] }` を宣言
   - `ui://.../route-map` という **HTMLアプリ**を resource として公開
   - ツール定義に `_meta.ui.resourceUri` を付け、ツールは **structuredContent** を返す
   - claude.aiがそのHTMLアプリをiframeでインライン表示し、`postMessage` で structuredContent を渡す → アプリがSVGで描画
4. → **PNG方式を捨て、Transit APIと同じMCP Apps方式に作り替えた**（この方式ならHTML内でSVGが描け、ホスト提供フォントで日本語も出る＝フォント同梱不要）。

**現在の実装**:
- `src/otp.ts`: `Leg` に leg単位の `startISO`/`endISO`、`color`/`textColor`（GTFS路線カラー、#なし6桁HEX）、`routeShortName`。GraphQLに `start { scheduledTime } end { scheduledTime } route { color textColor }` を追加
- `src/routemap.ts` 新規: `buildRouteMapData(from, to, itinerary) -> RouteMapData`。経路を描画用の構造化データ（title/subtitle/stops[]/segments[]）に整形。時刻はISO文字列の壁掛け時刻を直接取り出す（実行環境TZ非依存）
- `src/ui/routeMapHtml.ts` 新規: MCP Appのビュー（HTML文字列 `ROUTE_MAP_HTML`）。MCP-UIの postMessageブリッジ（`ui/initialize`→`initialized`、`ui/notifications/tool-result` 受信、host-context/テーマ適用、size通知、ping/teardown応答）を実装し、structuredContentから**SVGで縦タイムライン**を描く。ホストのCSS変数/フォントを使うのでダークモード対応・日本語フォント同梱不要。**注意: 路線名チップ幅は `getBBox` で測るので、SVGをDOMに追加してから描画すること**（未追加だとBBox=0でチップが潰れる。ここで一度ハマった）
- `src/index.ts`: `io.modelcontextprotocol/ui` 拡張を宣言＋ `resources/list`・`resources/read` で `ui://otp/route-map`（=ROUTE_MAP_HTML, mime `text/html;profile=mcp-app`）を公開。`plan_route_map` ツール定義に `_meta.ui.resourceUri` を付与。ツールは `{ content:[text], structuredContent, _meta }` を返す（textは非UIクライアント/モデル用フォールバック）
- 動作確認CLI: `node build/index.js map 新宿 渋谷 route.html [routeIndex]` → window.__ROUTE__ を注入した単体プレビューHTMLを出力（ブラウザで開ける）

**やめたもの**: `@napi-rs/canvas` 依存、`fonts-noto-cjk`（Dockerfile）、`src/timeline.ts`（PNG生成）。MCP Apps方式では不要。

**検証済み（2026-07-01）**:
- ローカル起動＋curlでMCP契約を確認: initializeに拡張が出る / `plan_route_map` に `_meta.ui.resourceUri` / resources/read でHTML取得 / tools/call が structuredContent を返す（SDK ^1.29 は `_meta`・`structuredContent` を素通しする）
- ヘッドレスChromeで実レンダリング確認（座標→鶴見→川崎→東京→赤羽・徒歩leg＋2回乗換）: 路線カラーのバー＆チップ、着/発2段、始点緑/終点赤、日本語表示すべてOK
- **未検証**: claude.ai実機でのインライン表示（要デプロイ＆コネクタ再接続）。深夜帯はOTPが経路なしを返す点に注意

**今後**: 複数ルート切替、運賃・番線表示（GTFS運賃精度に不安があり保留）、地図タイル表示（Transit APIは地理院タイルも併用している）。
