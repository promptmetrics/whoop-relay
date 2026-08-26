import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Env } from "../types";
import type { DashboardPayload, PanelId } from "./dashboard-types";
import { PANEL_IDS } from "./dashboard-types";
import { dashboardPayloadSchema, loadDashboardData, summarize } from "./dashboard-data";
import dashboardHtml from "../../ui/dist/index.html";

export const DASHBOARD_UI_URI = "ui://whoop/dashboard.html";
// MCP Apps (SEP-1865) resource mime type — mirrors RESOURCE_MIME_TYPE in
// @modelcontextprotocol/ext-apps@1.7.5 (dist/src/app.d.ts).
const UI_MIME = "text/html;profile=mcp-app";

export function registerDashboard(server: McpServer, env: Env, uid: number, origin: string): void {
  server.registerResource(
    "whoop-dashboard-ui",
    DASHBOARD_UI_URI,
    {
      title: "WHOOP dashboard app",
      description:
        "Interactive dashboard UI template (MCP Apps). Static template — contains no user data; data arrives via tool results.",
      mimeType: UI_MIME,
      cacheHint: { ttlMs: 3_600_000, cacheScope: "public" },
      _meta: { ui: { prefersBorder: true } }
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: UI_MIME, text: dashboardHtml }]
    })
  );

  server.registerTool(
    "show_dashboard",
    {
      title: "Show WHOOP dashboard",
      description:
        "Read-only: render an interactive dashboard (charts, trends, filters) of recovery, HRV, resting heart rate, sleep, day strain and workouts for a date range. " +
        "Omit `panels` for the full dashboard; pass a subset to compose a focused view (e.g. just sleep and recovery). " +
        "On hosts without MCP Apps rendering, the text result includes the live browser dashboard URL (WHOOP login, per-user) and structuredContent carries chart-ready daily series.",
      inputSchema: z.object({
        start: z.string().optional().describe("Start date, YYYY-MM-DD (inclusive). Default: 30 days ago."),
        end: z.string().optional().describe("End date, YYYY-MM-DD (inclusive). Default: today."),
        granularity: z.enum(["day", "week"]).default("day").describe("Aggregation bucket for the series."),
        panels: z
          .array(z.enum(PANEL_IDS))
          .optional()
          .describe("Subset of panels to show. Omit for the full dashboard.")
      }),
      outputSchema: dashboardPayloadSchema,
      annotations: { readOnlyHint: true },
      _meta: {
        ui: { resourceUri: DASHBOARD_UI_URI },
        // Legacy key for hosts predating _meta.ui (mirrors ext-apps normalization)
        "ui/resourceUri": DASHBOARD_UI_URI
      }
    },
    async (args) => {
      const panels: PanelId[] = args.panels?.length ? args.panels : [...PANEL_IDS];
      const data = await loadDashboardData(env.DB, uid, args);
      const payload: DashboardPayload = { ...data, panels };

      return {
        content: [{ type: "text" as const, text: summarize(payload, origin) }],
        structuredContent: payload
      };
    }
  );
}
