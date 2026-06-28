# otp-mcp

セルフホストした **OpenTripPlanner (OTP)** を MCP（Model Context Protocol）サーバー越しに使えるようにするツール。Claude Code や claude.ai から「AからBは電車で何分？」を、**自分の手元のOTPが持つ正確な経路データ**で聞けるようにする。

## 作った背景

きっかけは、ある公開の経路検索API（MCP付き）を触ったこと。MCP越しに `plan_journey` を叩いて経路が返ってくる体験はとても便利だった一方、そのAPIは「力技で集めた時刻表のパッチワーク」で、JRの直通・乗継系統（上野東京ライン・京浜東北快速など）を取りこぼし、関東の所要時間を実態の約2倍に誤ることがあった（[飲み会場所最適化アプリ arigatai-score](https://github.com/ojimpo/arigatai-score) の経路エンジン選定の中で実測）。

一方で、自分は arigatai-score 用に **関東全域のOTP**（TokyoGTFS + OSM からビルドしたグラフ）を既にセルフホストしている。これは Yahoo!乗換案内とほぼ一致する精度（平均誤差 約3分）を持つ。

> だったら「**便利なMCPの体験**」を「**自前OTPの正確なデータ**」で実現すればいい——というのがこのツール。

トレードオフはこうなる:

| | 公開API（パッチワーク） | otp-mcp（自前OTP） |
|---|---|---|
| カバレッジ | 全国だが穴が多い | 関東のみ |
| 精度 | 平均誤差 約17分 | 平均誤差 約3分 |

「狭いが正確な経路MCP」を狙ったツール。

## 設計思想

- **薄いラッパーに徹する**: 経路検索のロジックはOTPに任せ、このサーバーはOTPのGraphQL（`planConnection` / `stops`）を叩いて結果を読みやすく整形するだけ。
- **stdio / HTTP 両対応**: ローカルの Claude Code は stdio、claude.ai のリモートコネクタは HTTP（Streamable HTTP + 任意のBearer認証）。1つの実装で両方をカバーする。足場は自分がフォークして使っている [scrapbox-cosense-mcp](https://github.com/worldnine/scrapbox-cosense-mcp) の構成を下敷きにした。
- **経路の見せ方**: leg（区間）ごとに「路線名・駅・所要分」を並べ、出発/到着時刻と乗換回数を添える。

## 提供ツール

- **`plan_journey(from, to, numItineraries?)`** — 経路検索。`from`/`to` は駅名（例: `新宿`）か `"緯度,経度"`。ランク付けされたルートを返す。
- **`suggest_stations(q, limit?)`** — 駅名サジェスト。座標付きで返す。

出力例（`plan_journey 新宿 渋谷`）:

```
新宿 → 渋谷

【ルート1】15:26 → 15:34  所要8分  乗換0回
  🚶 徒歩 4分 → 新宿
  🚃 JR湘南新宿ライン  新宿 → 渋谷  4分
  🚶 徒歩 1分 → 渋谷
```

## 前提

経路検索の本体である **OTP が動いていて、このサーバーから到達できること**。本リポジトリ自体はOTPを含まない。

- 既定では arigatai-score の docker compose で動くOTP（サービス名 `otp`、`http://otp:8080`）を想定
- 別構成のOTPに繋ぐ場合は `OTP_BASE_URL` を設定

## 使い方

### Claude Code（ローカル / stdio）

ビルドして、`.mcp.json` に登録する:

```bash
npm install
npm run build
```

```json
{
  "mcpServers": {
    "otp": {
      "command": "node",
      "args": ["/home/kouki/dev/otp-mcp/build/index.js"],
      "env": { "OTP_BASE_URL": "http://localhost:8080" }
    }
  }
}
```

`OTP_BASE_URL` はOTPに到達できるURLにする（OTPのポートをホスト公開している場合は `http://localhost:8080` など）。

### claude.ai / リモート（HTTP）

Docker Compose で HTTP サーバーとして起動し、Cloudflare Tunnel 等で公開して claude.ai のカスタムコネクタに登録する:

```bash
cp .env.example .env   # MCP_AUTH_TOKEN を設定推奨
docker compose up -d --build
```

- エンドポイント: `https://<公開ホスト>/mcp`
- `MCP_AUTH_TOKEN` を設定した場合は `Authorization: Bearer <token>` が必要
- 既定の compose は arigatai-score の Docker ネットワーク（`arigatai-score_internal`）に相乗りして `http://otp:8080` に到達する

### CLI（動作確認用）

```bash
node build/index.js plan 新宿 渋谷
node build/index.js suggest 新宿
```

## 今後の展望

- `station_departures`（発車標）の追加（OTPの `stoptimes` クエリ）
- 出発/到着時刻の指定
- 運賃・乗換回数のメタ情報付与
- OTPのカバレッジを関東以外へ広げたら、そのまま全国対応に

## 関連

- [arigatai-score](https://github.com/ojimpo/arigatai-score) — このOTPを使う、飲み会場所最適化アプリ
- 足場: [scrapbox-cosense-mcp](https://github.com/worldnine/scrapbox-cosense-mcp)
