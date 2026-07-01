// CLIモード: MCPを介さず直接OTPに問い合わせる。動作確認・デバッグ用。
//   node build/index.js plan 新宿 渋谷
//   node build/index.js suggest 新宿
//   node build/index.js map 新宿 渋谷 route.html   （MCP Appを単体プレビューできるHTMLを出力）
import { writeFileSync } from "node:fs";
import { resolvePlace, suggestStations, planJourney, formatJourney, formatStations } from "./otp.js";
import { buildRouteMapData } from "./routemap.js";
import { ROUTE_MAP_HTML } from "./ui/routeMapHtml.js";

export async function runCli(args: string[]): Promise<void> {
  const [cmd, ...rest] = args;
  if (cmd === "map") {
    // node build/index.js map 新宿 渋谷 [out.html] [routeIndex]
    // MCP Appのビュー（ui://otp/route-map）に structuredContent を流し込んだ、
    // ブラウザで直接開けるHTMLを書き出す（見た目の確認用）。
    const [from, to, out, idxStr] = rest;
    if (!from || !to) {
      console.error("usage: otp-mcp map <from> <to> [out.html] [routeIndex]");
      process.exit(1);
    }
    const f = await resolvePlace(from);
    const t = await resolvePlace(to);
    const idx = idxStr ? parseInt(idxStr, 10) : 0;
    const itins = await planJourney(f, t, idx + 1);
    if (!itins.length) {
      console.error("経路が見つかりませんでした。");
      process.exit(1);
    }
    const it = itins[Math.min(idx, itins.length - 1)];
    const data = buildRouteMapData(f, t, it);
    // window.__ROUTE__ に注入 → アプリ側が起動時に描画する。
    const html = ROUTE_MAP_HTML.replace(
      "<script>",
      `<script>window.__ROUTE__ = ${JSON.stringify(data)};</script>\n<script>`,
    );
    const path = out || "route.html";
    writeFileSync(path, html);
    console.log(formatJourney(f, t, [it]));
    console.log(`\n→ プレビューHTMLを書き出しました: ${path}`);
  } else if (cmd === "plan") {
    const [from, to, n] = rest;
    if (!from || !to) {
      console.error("usage: otp-mcp plan <from> <to> [numItineraries]");
      process.exit(1);
    }
    const f = await resolvePlace(from);
    const t = await resolvePlace(to);
    const itins = await planJourney(f, t, n ? parseInt(n, 10) : 3);
    console.log(formatJourney(f, t, itins));
  } else if (cmd === "suggest") {
    const [q, limit] = rest;
    if (!q) {
      console.error("usage: otp-mcp suggest <query> [limit]");
      process.exit(1);
    }
    console.log(formatStations(await suggestStations(q, limit ? parseInt(limit, 10) : 10)));
  } else {
    console.error(`unknown command: ${cmd ?? "(none)"}\ncommands:\n  plan <from> <to> [n]\n  map <from> <to> [out.png] [routeIndex]\n  suggest <query> [limit]`);
    process.exit(1);
  }
}
