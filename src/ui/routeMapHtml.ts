// plan_route_map のMCP Apps（MCP-UI）ビュー。claude.aiがこのHTMLをiframeでインライン
// 表示し、ツール結果の structuredContent（src/routemap.ts の RouteMapData）を
// postMessage で渡してくる。それを受けてYahoo乗換案内風の縦タイムラインをSVGで描画する。
//
// トランスポート（ui/initialize → initialized、tool-result 受信、host-context 適用、
// size 通知、ping/teardown 応答）は Transit乗換案内 の route-map アプリの実装に倣った。
// フォントはホスト（claude.ai）が注入するCSS変数/フォントを使うので同梱不要。
export const ROUTE_MAP_HTML = String.raw`<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>経路</title>
<style>
:root {
  color-scheme: light dark;
  --bg: var(--color-background-primary, light-dark(#ffffff, #1b1c1e));
  --fg: var(--color-text-primary, light-dark(#15171c, #f3f5f8));
  --fg2: var(--color-text-secondary, light-dark(#5a636f, #aab2bd));
  --line: var(--color-border-primary, light-dark(#e4e7ec, #383b40));
  --node-hollow: var(--color-background-primary, light-dark(#ffffff, #1b1c1e));
  --font: var(--font-sans, system-ui, -apple-system, "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif);
  --start: #16a34a;
  --end: #dc2626;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); font-family: var(--font); }
#app { padding: 18px 20px 14px; }
.title { font-size: 20px; font-weight: 700; letter-spacing: .01em; }
.subtitle { margin-top: 4px; font-size: 13px; color: var(--fg2); }
.divider { height: 1px; background: var(--line); margin: 12px 0 4px; }
svg { display: block; width: 100%; height: auto; }
.empty { color: var(--fg2); font-size: 14px; padding: 8px 0; }
text { font-family: var(--font); }
</style>
</head>
<body>
<div id="app">
  <div class="title" id="title"></div>
  <div class="subtitle" id="subtitle"></div>
  <div class="divider"></div>
  <div id="view"><div class="empty" id="empty">経路を読み込み中…</div></div>
</div>
<script>
(function () {
  "use strict";

  // ---- MCP Apps postMessage transport --------------------------------------
  var rpcId = 0, pending = {}, initializedSent = false;
  function post(msg) { parent.postMessage(msg, "*"); }
  function request(method, params) {
    rpcId += 1; var id = rpcId;
    post({ jsonrpc: "2.0", id: id, method: method, params: params || {} });
    return new Promise(function (resolve, reject) { pending[id] = { resolve: resolve, reject: reject }; });
  }
  function notify(method, params) { post({ jsonrpc: "2.0", method: method, params: params || {} }); }
  function respond(id, result) { post({ jsonrpc: "2.0", id: id, result: result }); }
  function respondError(id, code, message) { post({ jsonrpc: "2.0", id: id, error: { code: code, message: message } }); }

  window.addEventListener("message", function (ev) {
    var d = ev.data;
    if (!d || typeof d !== "object" || d.jsonrpc !== "2.0") return;
    if (d.id !== undefined && (("result" in d) || ("error" in d))) {
      var p = pending[d.id];
      if (p) { delete pending[d.id]; d.error ? p.reject(d.error) : p.resolve(d.result); }
      return;
    }
    if (typeof d.method === "string") {
      d.id !== undefined ? handleRequest(d.id, d.method, d.params || {}) : handleNotification(d.method, d.params || {});
    }
  });

  function handleRequest(id, method) {
    if (method === "ui/resource-teardown" || method === "ping") { respond(id, {}); return; }
    respondError(id, -32601, "method not handled by this view: " + method);
  }
  function handleNotification(method, params) {
    if (method === "ui/notifications/tool-result") { onToolResult(params); return; }
    if (method === "ui/notifications/host-context-changed") { applyHostContext(params); scheduleSize(); return; }
  }

  function withTimeout(promise, ms) {
    return Promise.race([promise, new Promise(function (r) { setTimeout(function () { r(undefined); }, ms); })]);
  }
  function init() {
    var req = request("ui/initialize", {
      protocolVersion: "2025-06-18",
      appInfo: { name: "otp-route-map", version: "1.0.0" },
      appCapabilities: { availableDisplayModes: ["inline"] }
    });
    withTimeout(req, 1500).then(function (result) {
      if (result && result.hostContext) applyHostContext(result.hostContext);
    }).catch(function () {}).then(function () {
      if (!initializedSent) { initializedSent = true; notify("ui/notifications/initialized", {}); }
    });
  }
  function applyHostContext(ctx) {
    if (!ctx) return;
    if (ctx.theme === "light" || ctx.theme === "dark") document.documentElement.style.colorScheme = ctx.theme;
    if (ctx.styles && ctx.styles.variables) {
      var vars = ctx.styles.variables;
      for (var k in vars) if (Object.prototype.hasOwnProperty.call(vars, k) && typeof vars[k] === "string")
        document.documentElement.style.setProperty(k, vars[k]);
    }
    if (ctx.styles && ctx.styles.css && typeof ctx.styles.css.fonts === "string") {
      var fs = document.getElementById("host-fonts") || document.createElement("style");
      fs.id = "host-fonts"; fs.textContent = ctx.styles.css.fonts; document.head.appendChild(fs);
    }
  }

  // ---- size reporting -------------------------------------------------------
  var sizeTimer = null;
  function scheduleSize() {
    if (sizeTimer) clearTimeout(sizeTimer);
    sizeTimer = setTimeout(function () {
      sizeTimer = null;
      notify("ui/notifications/size-changed", { width: document.body.scrollWidth, height: document.body.scrollHeight });
    }, 60);
  }

  // ---- rendering ------------------------------------------------------------
  var SVGNS = "http://www.w3.org/2000/svg";
  function svgEl(name, attrs) {
    var n = document.createElementNS(SVGNS, name);
    if (attrs) for (var k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }
  function textEl(x, y, s, attrs) {
    var t = svgEl("text", attrs || {});
    t.setAttribute("x", x); t.setAttribute("y", y);
    t.textContent = s == null ? "" : String(s);
    return t;
  }

  var W = 720, TIME_R = 92, TRACK = 132, LABEL = 166, NODE = 8, SEG = 104, TOP = 26, BOT = 22;

  function render(data) {
    document.getElementById("title").textContent = data.title || "";
    document.getElementById("subtitle").textContent = data.subtitle || "";
    var view = document.getElementById("view");
    view.textContent = "";

    var stops = (data && data.stops) || [], segs = (data && data.segments) || [];
    if (!stops.length) {
      var e = document.createElement("div"); e.className = "empty";
      e.textContent = "経路が見つかりませんでした。"; view.appendChild(e); scheduleSize(); return;
    }

    var n = stops.length;
    var H = TOP + (n - 1) * SEG + BOT;
    var svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H, width: W, height: H, role: "img" });
    // getBBox（チップ幅の計測）は要素がドキュメントに入っていないと0を返すため、
    // 描画より先にSVGをDOMへ追加しておく。
    view.appendChild(svg);
    var nodeY = function (i) { return TOP + i * SEG; };
    var cssFg = "var(--fg)", cssFg2 = "var(--fg2)", cssBg = "var(--node-hollow)";

    // 区間（駅と駅の間）: 路線バー＋チップ＋所要分
    segs.forEach(function (seg, i) {
      var y1 = nodeY(i), y2 = nodeY(i + 1), mid = (y1 + y2) / 2;
      if (seg.walk) {
        svg.appendChild(svgEl("line", { x1: TRACK, y1: y1 + NODE, x2: TRACK, y2: y2 - NODE,
          stroke: "#9ca3af", "stroke-width": 5, "stroke-linecap": "round", "stroke-dasharray": "1 11" }));
        svg.appendChild(textEl(LABEL, mid + 5, "徒歩 " + seg.minutes + "分", { fill: cssFg2, "font-size": 15 }));
        return;
      }
      svg.appendChild(svgEl("line", { x1: TRACK, y1: y1 + NODE, x2: TRACK, y2: y2 - NODE,
        stroke: seg.color, "stroke-width": 13, "stroke-linecap": "round" }));
      // 路線名チップ: テキストを先に置いてgetBBoxで実寸を測り、背景の角丸rectを後ろに敷く
      var chipTextY = mid - 7;
      var label = textEl(LABEL + 12, chipTextY, seg.label, { fill: seg.textColor, "font-size": 15, "font-weight": 700 });
      svg.appendChild(label);
      var bb = label.getBBox();
      var padx = 11, chipH = 25;
      var rect = svgEl("rect", { x: bb.x - padx, y: bb.y - (chipH - bb.height) / 2,
        width: bb.width + padx * 2, height: chipH, rx: 7, fill: seg.color });
      svg.insertBefore(rect, label); // rectをテキストの背後へ
      // 所要分
      svg.appendChild(textEl(LABEL + 2, mid + 16, seg.minutes + "分", { fill: cssFg2, "font-size": 13 }));
    });

    // 駅ノード＋時刻＋駅名
    stops.forEach(function (s, i) {
      var y = nodeY(i);
      if (s.kind === "start") {
        svg.appendChild(svgEl("circle", { cx: TRACK, cy: y, r: NODE, fill: "var(--start)" }));
      } else if (s.kind === "end") {
        svg.appendChild(svgEl("circle", { cx: TRACK, cy: y, r: NODE, fill: "var(--end)" }));
      } else {
        svg.appendChild(svgEl("circle", { cx: TRACK, cy: y, r: NODE, fill: cssBg, stroke: cssFg, "stroke-width": 3 }));
      }
      // 時刻（右寄せ）。乗換駅で着≠発なら2段。
      if (s.arr && s.dep && s.arr !== s.dep) {
        svg.appendChild(textEl(TIME_R, y - 6, s.arr + "着", { fill: cssFg2, "font-size": 13, "text-anchor": "end" }));
        svg.appendChild(textEl(TIME_R, y + 13, s.dep + "発", { fill: cssFg, "font-size": 15, "font-weight": 700, "text-anchor": "end" }));
      } else {
        var t = s.dep || s.arr || "";
        svg.appendChild(textEl(TIME_R, y + 6, t, { fill: cssFg, "font-size": 17, "font-weight": 700, "text-anchor": "end" }));
      }
      // 駅名
      var big = (s.kind === "start" || s.kind === "end");
      svg.appendChild(textEl(LABEL, y + 6, s.name, { fill: cssFg, "font-size": big ? 19 : 17, "font-weight": 700 }));
    });

    scheduleSize();
  }

  function onToolResult(params) {
    var data = params && params.structuredContent;
    if (data && Array.isArray(data.stops)) { render(data); return; }
    var view = document.getElementById("view");
    view.textContent = "";
    var e = document.createElement("div"); e.className = "empty";
    e.textContent = "経路データを取得できませんでした。"; view.appendChild(e); scheduleSize();
  }

  // 単体プレビュー用: ブラウザで直接開いたとき window.__ROUTE__ があれば描画する
  if (window.__ROUTE__) render(window.__ROUTE__);
  init();
  scheduleSize();
})();
</script>
</body>
</html>`;
