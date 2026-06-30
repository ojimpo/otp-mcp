// 経路をYahoo乗換案内の「ルート詳細」のような縦タイムライン図のPNGに描画する。
// 地理的な地図ではなく、駅・発着時刻・路線カラー・乗換を縦に並べたダイヤグラム。
// 描画は @napi-rs/canvas（prebuiltバイナリ。nativeビルド不要）で行う。
import { createCanvas, GlobalFonts, type SKRSContext2D } from "@napi-rs/canvas";
import { existsSync } from "node:fs";
import type { Itinerary, Leg, Place } from "./otp.js";

// 描画に使う日本語フォントを1度だけ登録する。napi-rs/canvasはシステムのfontconfigを
// 見ないため、フォントファイルを明示的に登録する必要がある。エイリアス "JP" で参照する。
const FONT = "JP";
let fontReady: boolean | undefined;
function ensureFont(): boolean {
  if (fontReady !== undefined) return fontReady;
  const candidates = [
    process.env.OTP_FONT_PATH, // 任意の上書き
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", // Debian/Ubuntu fonts-noto-cjk
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJKjp-Regular.otf",
    "/usr/share/fonts/truetype/fonts-japanese-gothic.ttf",
    "/usr/share/fonts/truetype/vlgothic/VL-Gothic-Regular.ttf",
    "/System/Library/Fonts/ヒラギノ角ゴシック W4.ttc", // macOS（ローカル動作確認用）
  ].filter((p): p is string => Boolean(p));
  for (const path of candidates) {
    if (existsSync(path) && GlobalFonts.registerFromPath(path, FONT)) {
      fontReady = true;
      return true;
    }
  }
  console.error(
    "[timeline] 日本語フォントが見つかりません。OTP_FONT_PATH を設定するか fonts-noto-cjk を入れてください（日本語が豆腐□になります）。",
  );
  fontReady = false;
  return false;
}

// ---- レイアウト定数 ----
const W = 820;
const PAD_X = 40;
const TIME_RIGHT = 132; // 時刻テキストの右端x（右寄せ）
const TRACK_X = 176; // 縦の軌道線の中心x
const NODE_R = 11; // 駅ノードの半径
const LABEL_X = 212; // 駅名・路線ラベルの左端x
const SEG_H = 132; // 1区間（駅と駅の間）の高さ
const HEADER_H = 116; // ヘッダー領域の高さ
const FOOT_H = 28;

const C_BG = "#ffffff";
const C_INK = "#1f2937";
const C_SUB = "#6b7280";
const C_WALK = "#9ca3af";
const C_START = "#16a34a";
const C_END = "#dc2626";
const C_TRANSIT_DEFAULT = "#2563eb";

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function legMinutes(l: Leg): number {
  return Math.max(1, Math.round(l.durationSec / 60));
}

// leg.color（#なしHEX）を #付きに。無ければモード別のデフォルト色。
function legColor(l: Leg): string {
  if (l.mode === "WALK") return C_WALK;
  if (l.color && /^[0-9a-fA-F]{6}$/.test(l.color)) return `#${l.color}`;
  return C_TRANSIT_DEFAULT;
}

function legTextColor(l: Leg, bg: string): string {
  if (l.textColor && /^[0-9a-fA-F]{6}$/.test(l.textColor)) return `#${l.textColor}`;
  // 背景の明度から白/黒を選ぶ。
  const r = parseInt(bg.slice(1, 3), 16);
  const g = parseInt(bg.slice(3, 5), 16);
  const b = parseInt(bg.slice(5, 7), 16);
  const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luma > 0.6 ? "#1f2937" : "#ffffff";
}

interface Stop {
  name: string;
  arrISO?: string; // この駅への到着（始発駅は無し）
  depISO?: string; // この駅からの出発（終着駅は無し）
}

// legs から駅ノード列を作る。連続するlegは駅を共有する（leg[i].to == leg[i+1].from）。
function buildStops(legs: Leg[]): Stop[] {
  const stops: Stop[] = [];
  legs.forEach((l, i) => {
    if (i === 0) stops.push({ name: l.fromName, depISO: l.startISO });
    const last = stops[stops.length - 1];
    last.depISO = l.startISO; // 直前の駅＝この区間の出発駅
    stops.push({ name: l.toName, arrISO: l.endISO });
  });
  return stops;
}

function roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 1経路を縦タイムライン図のPNGに描画してBufferで返す。 */
export function renderRouteTimeline(from: Place, to: Place, it: Itinerary): Buffer {
  ensureFont();
  const stops = buildStops(it.legs);
  const n = stops.length;
  // 座標入力だとOTPは端点を "Origin"/"Destination" と返すので、解決した地点名に置き換える。
  if (n > 0) {
    if (/^Origin$/i.test(stops[0].name)) stops[0].name = from.name;
    if (/^Destination$/i.test(stops[n - 1].name)) stops[n - 1].name = to.name;
  }
  const node0Y = HEADER_H + 36;
  const height = node0Y + (n - 1) * SEG_H + FOOT_H + 36;
  const nodeY = (i: number) => node0Y + i * SEG_H;

  const canvas = createCanvas(W, height);
  const ctx = canvas.getContext("2d");

  // 背景
  ctx.fillStyle = C_BG;
  ctx.fillRect(0, 0, W, height);

  // ---- ヘッダー ----
  ctx.fillStyle = C_INK;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.font = `bold 32px ${FONT}`;
  ctx.fillText(`${from.name} → ${to.name}`, PAD_X, 52);

  ctx.fillStyle = C_SUB;
  ctx.font = `21px ${FONT}`;
  const summary = `${hhmm(it.startISO)} 発 → ${hhmm(it.endISO)} 着　・　所要 ${it.durationMin}分　・　乗換 ${it.transfers}回`;
  ctx.fillText(summary, PAD_X, 86);

  // ヘッダー下の区切り線
  ctx.strokeStyle = "#e5e7eb";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD_X, HEADER_H);
  ctx.lineTo(W - PAD_X, HEADER_H);
  ctx.stroke();

  // ---- 区間（駅と駅の間の路線バー＋ラベル）----
  it.legs.forEach((leg, i) => {
    const y1 = nodeY(i);
    const y2 = nodeY(i + 1);
    const color = legColor(leg);
    const mins = legMinutes(leg);

    // 縦の路線バー
    ctx.lineCap = "round";
    if (leg.mode === "WALK") {
      ctx.strokeStyle = C_WALK;
      ctx.lineWidth = 6;
      ctx.setLineDash([2, 12]);
      ctx.beginPath();
      ctx.moveTo(TRACK_X, y1 + NODE_R);
      ctx.lineTo(TRACK_X, y2 - NODE_R);
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      ctx.strokeStyle = color;
      ctx.lineWidth = 14;
      ctx.beginPath();
      ctx.moveTo(TRACK_X, y1 + NODE_R);
      ctx.lineTo(TRACK_X, y2 - NODE_R);
      ctx.stroke();
    }

    // 区間ラベル（路線名チップ＋所要分）
    const midY = (y1 + y2) / 2;
    if (leg.mode === "WALK") {
      ctx.fillStyle = C_SUB;
      ctx.font = `22px ${FONT}`;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(`徒歩 ${mins}分`, LABEL_X, midY);
    } else {
      const label = leg.route || leg.routeShortName || leg.mode;
      ctx.font = `bold 22px ${FONT}`;
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      const tw = ctx.measureText(label).width;
      const chipPadX = 14;
      const chipH = 36;
      const chipW = tw + chipPadX * 2;
      const chipX = LABEL_X;
      const chipY = midY - chipH / 2 - 16;
      // チップ
      ctx.fillStyle = color;
      roundRect(ctx, chipX, chipY, chipW, chipH, 8);
      ctx.fill();
      ctx.fillStyle = legTextColor(leg, color);
      ctx.fillText(label, chipX + chipPadX, chipY + chipH / 2 + 1);
      // 所要分
      ctx.fillStyle = C_SUB;
      ctx.font = `20px ${FONT}`;
      ctx.fillText(`${mins}分`, LABEL_X + 2, midY + 18);
    }
  });

  // ---- 駅ノード＋時刻＋駅名 ----
  stops.forEach((s, i) => {
    const y = nodeY(i);
    const isFirst = i === 0;
    const isLast = i === n - 1;
    // 乗換駅: 到着と出発の両方があり、かつ前後で路線が変わる箇所
    const isTransfer = !isFirst && !isLast;

    // ノード
    ctx.lineWidth = 4;
    if (isFirst) {
      ctx.fillStyle = C_START;
      ctx.beginPath();
      ctx.arc(TRACK_X, y, NODE_R, 0, Math.PI * 2);
      ctx.fill();
    } else if (isLast) {
      ctx.fillStyle = C_END;
      ctx.beginPath();
      ctx.arc(TRACK_X, y, NODE_R, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // 中間（乗換）駅: 白抜き＋濃い縁
      const ring = isTransfer ? C_INK : C_SUB;
      ctx.fillStyle = C_BG;
      ctx.strokeStyle = ring;
      ctx.beginPath();
      ctx.arc(TRACK_X, y, NODE_R, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // 時刻（右寄せ）。到着→出発の順に。差があれば2行。
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    const arr = s.arrISO ? hhmm(s.arrISO) : undefined;
    const dep = s.depISO ? hhmm(s.depISO) : undefined;
    if (arr && dep && arr !== dep) {
      ctx.font = `20px ${FONT}`;
      ctx.fillStyle = C_SUB;
      ctx.fillText(`${arr}着`, TIME_RIGHT, y - 13);
      ctx.fillStyle = C_INK;
      ctx.font = `bold 22px ${FONT}`;
      ctx.fillText(`${dep}発`, TIME_RIGHT, y + 13);
    } else {
      const t = dep ?? arr ?? "";
      ctx.font = `bold 24px ${FONT}`;
      ctx.fillStyle = C_INK;
      ctx.fillText(t, TIME_RIGHT, y);
    }

    // 駅名（左寄せ）
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = C_INK;
    ctx.font = `bold ${isFirst || isLast ? 28 : 26}px ${FONT}`;
    ctx.fillText(s.name, LABEL_X, y);
  });

  // ---- フッター ----
  ctx.textAlign = "right";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#b0b6c0";
  ctx.font = `16px ${FONT}`;
  ctx.fillText("self-hosted OpenTripPlanner", W - PAD_X, height - 14);

  return canvas.toBuffer("image/png");
}
