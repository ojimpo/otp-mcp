#!/usr/bin/env node

// 引数があればCLIモード、なければMCPサーバーモード（scrapbox-cosense-mcpの構成を踏襲）。
const _firstArg = process.argv[2];
if (_firstArg) {
  const { runCli } = await import("./cli.js");
  await runCli(process.argv.slice(2));
  process.exit(0);
}

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { resolvePlace, suggestStations, planJourney, formatJourney, formatStations } from "./otp.js";
import { buildRouteMapData } from "./routemap.js";
import { ROUTE_MAP_HTML } from "./ui/routeMapHtml.js";

// MCP Apps（MCP-UI）: plan_route_map の結果をclaude.aiがインライン描画するHTMLアプリ。
const ROUTE_MAP_URI = "ui://otp/route-map";
const UI_MIME = "text/html;profile=mcp-app";

const SERVICE_LABEL = process.env.SERVICE_LABEL || "self-hosted OTP (Kanto rail/subway)";
// 複数インスタンスを区別したい場合にツール名へ付けるサフィックス。
const TOOL_SUFFIX = process.env.OTP_TOOL_SUFFIX;
const toolName = (b: string) => (TOOL_SUFFIX ? `${b}_${TOOL_SUFFIX}` : b);
const baseName = (n: string) =>
  TOOL_SUFFIX && n.endsWith(`_${TOOL_SUFFIX}`) ? n.slice(0, -(`_${TOOL_SUFFIX}`.length)) : n;

function createServer(): Server {
  const server = new Server(
    { name: "otp-mcp", version: "0.1.0" },
    {
      capabilities: {
        tools: {},
        resources: {},
        // MCP Apps拡張の宣言（Transit乗換案内と同じ）。claude.aiがこれを見て
        // _meta.ui.resourceUri のHTMLアプリをインライン表示する。
        extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [UI_MIME] } },
      } as Record<string, unknown>,
    },
  );

  // UIリソース（plan_route_map の描画アプリ）を公開する。
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      { uri: ROUTE_MAP_URI, name: "route_map", mimeType: UI_MIME, description: "Route timeline view (MCP App)." },
    ],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri === ROUTE_MAP_URI) {
      return { contents: [{ uri: ROUTE_MAP_URI, mimeType: UI_MIME, text: ROUTE_MAP_HTML }] };
    }
    throw new Error(`Unknown resource: ${request.params.uri}`);
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: toolName("plan_journey"),
        description:
          `Plan a public-transit (rail/subway) journey using a self-hosted OpenTripPlanner instance (${SERVICE_LABEL}). ` +
          `'from' and 'to' are each a station name (e.g. "新宿") or a "lat,lon" coordinate. ` +
          `Returns ranked itineraries with per-leg lines (line name, stations, minutes), departure/arrival times, and transfer count. ` +
          `Accurate within the covered area (Kanto); returns no route for places outside coverage.`,
        inputSchema: {
          type: "object",
          properties: {
            from: { type: "string", description: 'Origin: a station name or a "lat,lon" coordinate.' },
            to: { type: "string", description: 'Destination: a station name or a "lat,lon" coordinate.' },
            numItineraries: {
              type: "number",
              minimum: 1,
              maximum: 6,
              description: "Number of itineraries to return (default 3).",
            },
          },
          required: ["from", "to"],
        },
      },
      {
        name: toolName("plan_route_map"),
        description:
          `Plan a rail/subway journey and render it as a Yahoo!乗換案内-style vertical timeline (an inline interactive view on claude.ai). ` +
          `The view shows stations, departure/arrival times, line names in their official colors, and transfer points stacked vertically; ` +
          `the same itinerary is also returned as text. ` +
          `'from' and 'to' are each a station name (e.g. "新宿") or a "lat,lon" coordinate. ` +
          `By default shows the best (fastest) itinerary; use 'routeIndex' to pick another. ` +
          `Prefer this over plan_journey when a visual route is helpful.`,
        inputSchema: {
          type: "object",
          properties: {
            from: { type: "string", description: 'Origin: a station name or a "lat,lon" coordinate.' },
            to: { type: "string", description: 'Destination: a station name or a "lat,lon" coordinate.' },
            routeIndex: {
              type: "number",
              minimum: 0,
              maximum: 5,
              description: "Which itinerary to show, 0 = best/fastest (default 0).",
            },
          },
          required: ["from", "to"],
        },
        // MCP Apps: この結果を ui://otp/route-map のHTMLアプリで描画する。
        _meta: { ui: { resourceUri: ROUTE_MAP_URI } },
      },
      {
        name: toolName("suggest_stations"),
        description:
          `Autocomplete station names against the self-hosted OpenTripPlanner instance (${SERVICE_LABEL}). ` +
          `Returns matching stations with coordinates. Use to resolve or disambiguate a name before plan_journey.`,
        inputSchema: {
          type: "object",
          properties: {
            q: { type: "string", description: "Station name prefix or substring." },
            limit: { type: "number", minimum: 1, maximum: 30, description: "Max results (default 10)." },
          },
          required: ["q"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      switch (baseName(name)) {
        case "plan_journey": {
          const from = await resolvePlace(String(args?.from ?? ""));
          const to = await resolvePlace(String(args?.to ?? ""));
          const n = args?.numItineraries ? Number(args.numItineraries) : 3;
          const itins = await planJourney(from, to, n);
          return { content: [{ type: "text", text: formatJourney(from, to, itins) }] };
        }
        case "plan_route_map": {
          const from = await resolvePlace(String(args?.from ?? ""));
          const to = await resolvePlace(String(args?.to ?? ""));
          const idx = args?.routeIndex ? Math.max(0, Number(args.routeIndex)) : 0;
          const itins = await planJourney(from, to, idx + 1);
          if (!itins.length) {
            return { content: [{ type: "text", text: formatJourney(from, to, itins) }] };
          }
          const it = itins[Math.min(idx, itins.length - 1)];
          const data = buildRouteMapData(from, to, it);
          // structuredContent をUIアプリ（ui://otp/route-map）が受け取って描画する。
          // text は非UIクライアント（Claude Code等）とモデル用のフォールバック。
          return {
            content: [{ type: "text", text: formatJourney(from, to, [it]) }],
            structuredContent: data,
            _meta: { ui: { resourceUri: ROUTE_MAP_URI } },
          };
        }
        case "suggest_stations": {
          const stations = await suggestStations(String(args?.q ?? ""), args?.limit ? Number(args.limit) : 10);
          return { content: [{ type: "text", text: formatStations(stations) }] };
        }
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (e) {
      return { content: [{ type: "text", text: `エラー: ${(e as Error).message}` }], isError: true };
    }
  });

  return server;
}

// Transport選択: http（claude.ai / リモート）or stdio（Claude Code / Desktop、デフォルト）
const transport = process.env.TRANSPORT;
if (transport === "http") {
  const { startHttpServer } = await import("./http-server.js");
  const port = parseInt(process.env.PORT || "3000", 10);
  const authToken = process.env.MCP_AUTH_TOKEN;
  startHttpServer(createServer, { port, ...(authToken ? { authToken } : {}) });
} else {
  const server = createServer();
  const stdioTransport = new StdioServerTransport();
  await server.connect(stdioTransport);
}
