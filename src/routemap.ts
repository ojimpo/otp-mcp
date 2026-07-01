// plan_route_map のMCP Apps（MCP-UI）向けの構造化データを組み立てる。
// claude.aiは _meta.ui.resourceUri で指定したHTMLアプリ（ui://otp/route-map）を
// インライン表示し、ツール結果の structuredContent をそのアプリに渡す。アプリ側は
// これを受け取ってYahoo乗換案内風の縦タイムラインをSVGで描く（src/ui/routeMapHtml.ts）。
import type { Itinerary, Leg, Place } from "./otp.js";

export interface RouteStop {
  name: string;
  /** 到着時刻 "HH:MM"（始発駅は無し）。 */
  arr?: string;
  /** 出発時刻 "HH:MM"（終着駅は無し）。 */
  dep?: string;
  kind: "start" | "end" | "transfer";
}

export interface RouteSegment {
  mode: string;
  /** 路線名（RAIL/SUBWAY）または "" （WALK）。 */
  label: string;
  minutes: number;
  walk: boolean;
  /** "#rrggbb"。バー・チップ背景色。 */
  color: string;
  /** "#rrggbb"。チップ上の文字色。 */
  textColor: string;
}

export interface RouteMapData {
  title: string;
  subtitle: string;
  stops: RouteStop[];
  segments: RouteSegment[];
}

const WALK_COLOR = "#9ca3af";
const TRANSIT_DEFAULT = "#2563eb";

// OTPのISO（例 "2026-06-30T22:07:00+09:00"）から壁掛け時刻 "HH:MM" を取り出す。
// 文字列内の時刻はフィード地域のローカル時刻なので、実行環境のTZに依存せず安全。
function hhmm(iso: string): string {
  const m = iso.match(/T(\d{2}):(\d{2})/);
  if (m) return `${m[1]}:${m[2]}`;
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function legMinutes(l: Leg): number {
  return Math.max(1, Math.round(l.durationSec / 60));
}

function legColor(l: Leg): string {
  if (l.mode === "WALK") return WALK_COLOR;
  if (l.color && /^[0-9a-fA-F]{6}$/.test(l.color)) return `#${l.color.toLowerCase()}`;
  return TRANSIT_DEFAULT;
}

function legTextColor(l: Leg, bg: string): string {
  if (l.textColor && /^[0-9a-fA-F]{6}$/.test(l.textColor)) return `#${l.textColor.toLowerCase()}`;
  const r = parseInt(bg.slice(1, 3), 16);
  const g = parseInt(bg.slice(3, 5), 16);
  const b = parseInt(bg.slice(5, 7), 16);
  const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luma > 0.6 ? "#1f2937" : "#ffffff";
}

/** 1経路をタイムライン描画用のデータに変換する。 */
export function buildRouteMapData(from: Place, to: Place, it: Itinerary): RouteMapData {
  // 駅ノード列（連続legは駅を共有: leg[i].to == leg[i+1].from）。
  const stops: RouteStop[] = [];
  it.legs.forEach((l, i) => {
    if (i === 0) stops.push({ name: l.fromName, dep: hhmm(l.startISO), kind: "start" });
    const last = stops[stops.length - 1];
    last.dep = hhmm(l.startISO);
    stops.push({ name: l.toName, arr: hhmm(l.endISO), kind: "end" });
  });
  // 中間駅は乗換扱い。
  for (let i = 1; i < stops.length - 1; i++) stops[i].kind = "transfer";
  // 座標入力時のOTPプレースホルダ名を解決済み地点名に置換。
  if (stops.length > 0) {
    if (/^Origin$/i.test(stops[0].name)) stops[0].name = from.name;
    const li = stops.length - 1;
    if (/^Destination$/i.test(stops[li].name)) stops[li].name = to.name;
  }

  const segments: RouteSegment[] = it.legs.map((l) => {
    const color = legColor(l);
    return {
      mode: l.mode,
      label: l.mode === "WALK" ? "" : l.route || l.routeShortName || l.mode,
      minutes: legMinutes(l),
      walk: l.mode === "WALK",
      color,
      textColor: legTextColor(l, color),
    };
  });

  const subtitle = `${hhmm(it.startISO)} 発 → ${hhmm(it.endISO)} 着　・　所要 ${it.durationMin}分　・　乗換 ${it.transfers}回`;
  return { title: `${from.name} → ${to.name}`, subtitle, stops, segments };
}
