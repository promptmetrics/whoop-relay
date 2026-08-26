import type { Env } from "./types";
import { PANEL_IDS } from "./mcp/dashboard-types";
import { loadDashboardData } from "./mcp/dashboard-data";
import { SESSION_COOKIE, getCookie, verifySessionCookie } from "./session";
import dashboardHtml from "../ui/dist/index.html";

// Authenticated live dashboard: one URL for every user, identity comes ONLY
// from the verified session cookie. Nothing here is shareable — a request
// without a valid cookie is bounced to the WHOOP login.

const SNAPSHOT_SENTINEL = '<script id="snapshot" type="application/json">null</script>';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function handleDashboardPage(request: Request, env: Env): Promise<Response> {
  const uid = await verifySessionCookie(getCookie(request, SESSION_COOKIE), env.SESSION_SECRET);
  if (uid == null) {
    return Response.redirect(new URL("/dashboard/login", request.url).toString(), 302);
  }

  const url = new URL(request.url);
  const start = url.searchParams.get("start") ?? undefined;
  const end = url.searchParams.get("end") ?? undefined;
  const gran = url.searchParams.get("granularity");
  const args = {
    start: start && DATE_RE.test(start) ? start : undefined,
    end: end && DATE_RE.test(end) ? end : undefined,
    granularity: (gran === "week" ? "week" : "day") as "day" | "week"
  };

  const data = await loadDashboardData(env.DB, uid, args);
  const payload = { ...data, panels: [...PANEL_IDS], web: true };

  // \u003c-escape keeps a "</script>" inside the JSON from breaking out.
  const injected = `<script id="snapshot" type="application/json">${JSON.stringify(payload).replace(/</g, "\\u003c")}</script>`;
  // CSP goes in a <meta> tag, NOT a header: Cloudflare's Web Analytics
  // auto-injection rewrites CSP *headers* to add a nonce for its beacon, and a
  // nonce in script-src makes browsers ignore 'unsafe-inline' — which blocked
  // the entire inlined app (blank dashboard). Meta CSP is left untouched; it
  // still keeps external scripts (the beacon included) off this page.
  const cspMeta =
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; ` +
    `script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'">`;
  const html = dashboardHtml.replace(SNAPSHOT_SENTINEL, injected).replace("<head>", `<head>${cspMeta}`);

  return new Response(html, {
    headers: {
      "Content-Type": "text/html;charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex",
      "Referrer-Policy": "no-referrer"
    }
  });
}
