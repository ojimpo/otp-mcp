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

## 次の作業: グラフィカル経路表示 `plan_route_map`（未実装・実現可能性は確認済み）

claude.aiはツールが返す**画像をインライン表示できる**ので、経路を描いた地図PNGを返すツールを足せばグラフィカル表示できる（Transit API MCPの `plan_route_map` 相当）。

**確認済みの事実**: OTPの planConnection は leg ごとに線形と路線カラーを返す。
- `legGeometry { points }` … Google encoded polyline（precision 5）。例 `'yvyxEsgtsY...'`
- `route { color textColor }` … 6桁HEX（#なし）。例 埼京線 `color=2DBC8F`
- WALK legは route=null なので灰色で描く

**実装プラン**:
1. 依存追加: `staticmaps`（OSMタイル上にライン/マーカーを描いてPNG出力。内部で sharp を使う）、`@mapbox/polyline`（polylineデコード）
2. `src/otp.ts`: `planJourney` のGraphQLに `legGeometry { points }` と `route { color }` を追加し、`Leg` 型に `points?: string` / `color?: string` を持たせる（この拡張は途中まで着手して戻した。再度入れるところから）
3. `src/map.ts` 新規: `renderRouteMap(itinerary) -> Promise<Buffer>`
   - 各legを `polyline.decode(points)`（[lat,lon]→staticmapsは[lon,lat]順なので入れ替え）して `map.addLine`
   - WALK=灰色破線、transit=`#${leg.color || 'デフォルト'}`、太さで区別
   - 始点（緑）・終点（赤）・乗換点は `map.addCircle` で（staticmapsのaddMarkerはアイコン画像が要るのでcircleが楽）
   - `await map.render(); return await map.image.buffer('image/png')`
4. `src/index.ts`: ツール `plan_route_map`（入力は plan_journey と同じ from/to）を登録。返り値は
   `{ content: [{ type: "image", data: <base64>, mimeType: "image/png" }, { type: "text", text: <整形済み経路> }] }`
5. ビルド→`docker compose up -d --build`→公開URL経由で claude.ai に地図が出ることを確認

**注意点**:
- staticmapsはOSMタイルを外部取得する。コンテナはdocker NAT経由で外に出られるので可。OSMのタイル利用ポリシーに沿って User-Agent を設定すること
- sharp は node:22-slim でprebuiltが入る（ビルド時間・イメージサイズ増に注意）
- まず1ルート（best=itineraries[0]）だけ描けば十分。複数表示は後回しでよい
