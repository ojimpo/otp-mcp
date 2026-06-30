// セルフホストOpenTripPlanner (OTP) のGraphQL APIを叩く薄いクライアント。
// arigatai-score で実証済みのクエリ（planConnection / stops）を流用している。

const OTP_BASE_URL = process.env.OTP_BASE_URL || "http://localhost:8080";
const GRAPHQL_URL = `${OTP_BASE_URL}/otp/routers/default/index/graphql`;

export interface Station {
  name: string;
  lat: number;
  lon: number;
}

export interface Place {
  lat: number;
  lon: number;
  name: string;
}

export interface Leg {
  mode: string;
  durationSec: number;
  startISO: string;
  endISO: string;
  fromName: string;
  toName: string;
  route?: string;
  /** 路線記号などの短い名前（例 "JK"）。長い名前が無いときの代替表示に使う。 */
  routeShortName?: string;
  /** GTFS由来の路線カラー。#なし6桁HEX（例 "2DBC8F"）。地図/タイムラインの線色に使う。 */
  color?: string;
  /** 路線カラー上に置く文字色。#なし6桁HEX。 */
  textColor?: string;
}

export interface Itinerary {
  startISO: string;
  endISO: string;
  durationMin: number;
  transfers: number;
  legs: Leg[];
}

// 一部のGTFSは "新宿 Shinjuku" のように英語併記を含むため日本語部分だけ取り出す。
function normalizeName(name: string): string {
  const stripped = name.replace(/\s+[A-Za-z].*$/, "").trim();
  return stripped || name;
}

async function gql(query: string): Promise<any> {
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    throw new Error(`OTP GraphQL HTTP ${res.status} (${GRAPHQL_URL})`);
  }
  const json = (await res.json()) as { data?: any; errors?: unknown };
  if (json.errors) {
    throw new Error(`OTP GraphQL error: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

/** 駅名サジェスト（同名の重複プラットフォームは1件に集約）。 */
export async function suggestStations(query: string, limit = 10): Promise<Station[]> {
  const data = await gql(`query { stops(name: ${JSON.stringify(query)}) { name lat lon } }`);
  const seen = new Set<string>();
  const out: Station[] = [];
  for (const s of data.stops ?? []) {
    const name = normalizeName(s.name);
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, lat: s.lat, lon: s.lon });
    if (out.length >= limit) break;
  }
  return out;
}

const GEO_RE = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

/** "lat,lon" ならそのまま座標に、駅名なら先頭一致の駅座標に解決する。 */
export async function resolvePlace(input: string): Promise<Place> {
  const m = input.match(GEO_RE);
  if (m) {
    return { lat: parseFloat(m[1]), lon: parseFloat(m[2]), name: `(${m[1]}, ${m[2]})` };
  }
  const stations = await suggestStations(input, 1);
  if (!stations.length) {
    throw new Error(`駅が見つかりません: ${input}`);
  }
  return { lat: stations[0].lat, lon: stations[0].lon, name: stations[0].name };
}

/** 2地点間の経路（鉄道・地下鉄）を検索する。 */
export async function planJourney(from: Place, to: Place, numItineraries = 3): Promise<Itinerary[]> {
  const q = `{
    planConnection(
      origin: { location: { coordinate: { latitude: ${from.lat}, longitude: ${from.lon} } } }
      destination: { location: { coordinate: { latitude: ${to.lat}, longitude: ${to.lon} } } }
      modes: { transit: { transit: [{ mode: RAIL }, { mode: SUBWAY }] } }
      first: ${Math.max(1, Math.min(6, numItineraries))}
    ) {
      edges { node {
        start end
        legs {
          mode duration
          start { scheduledTime }
          end { scheduledTime }
          from { name } to { name }
          route { shortName longName color textColor }
        }
      } }
    }
  }`;
  const data = await gql(q);
  const edges = data.planConnection?.edges ?? [];
  const itins: Itinerary[] = [];
  for (const e of edges) {
    const node = e.node;
    const start = new Date(node.start);
    const end = new Date(node.end);
    const durationMin = Math.max(1, Math.round((end.getTime() - start.getTime()) / 60000));
    const legs: Leg[] = (node.legs ?? []).map((l: any) => ({
      mode: l.mode,
      durationSec: l.duration,
      startISO: l.start?.scheduledTime ?? node.start,
      endISO: l.end?.scheduledTime ?? node.end,
      fromName: normalizeName(l.from?.name ?? ""),
      toName: normalizeName(l.to?.name ?? ""),
      route: l.route ? normalizeName(l.route.longName ?? l.route.shortName ?? "") : undefined,
      routeShortName: l.route?.shortName ? normalizeName(l.route.shortName) : undefined,
      color: l.route?.color || undefined,
      textColor: l.route?.textColor || undefined,
    }));
    const transfers = Math.max(0, legs.filter((l) => l.mode !== "WALK").length - 1);
    itins.push({ startISO: node.start, endISO: node.end, durationMin, transfers, legs });
  }
  return itins;
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function modeIcon(mode: string): string {
  switch (mode) {
    case "WALK": return "🚶";
    case "RAIL": return "🚃";
    case "SUBWAY": return "🚇";
    case "BUS": return "🚌";
    case "TRAM": return "🚊";
    default: return "•";
  }
}

/** 経路を人間に読みやすいテキストに整形する（Transit API MCPの見せ方を参考）。 */
export function formatJourney(from: Place, to: Place, itins: Itinerary[]): string {
  if (!itins.length) {
    return `${from.name} → ${to.name}: 経路が見つかりませんでした（このエリアは鉄道データのカバレッジ外の可能性があります）。`;
  }
  const blocks = itins.map((it, i) => {
    const head = `【ルート${i + 1}】${hhmm(it.startISO)} → ${hhmm(it.endISO)}  所要${it.durationMin}分  乗換${it.transfers}回`;
    const lines = it.legs.map((l) => {
      const mins = Math.max(1, Math.round(l.durationSec / 60));
      if (l.mode === "WALK") {
        return `  ${modeIcon(l.mode)} 徒歩 ${mins}分 → ${l.toName}`;
      }
      return `  ${modeIcon(l.mode)} ${l.route ?? l.mode}  ${l.fromName} → ${l.toName}  ${mins}分`;
    });
    return [head, ...lines].join("\n");
  });
  return `${from.name} → ${to.name}\n\n${blocks.join("\n\n")}`;
}

/** 駅サジェスト結果を整形する。 */
export function formatStations(stations: Station[]): string {
  if (!stations.length) return "該当する駅が見つかりませんでした。";
  return stations.map((s) => `- ${s.name} (${s.lat.toFixed(5)}, ${s.lon.toFixed(5)})`).join("\n");
}
