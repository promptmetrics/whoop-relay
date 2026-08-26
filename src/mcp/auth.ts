import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Env, SessionProps, BackfillResource } from "../types";
import { handleWebhook } from "../ingest";
import { handleDashboardPage } from "../dashboard-page";
import {
  BROWSER_STATE_PREFIX,
  LOGIN_COOKIE,
  SESSION_COOKIE,
  clearCookie,
  getCookie,
  loginSetCookie,
  mintLoginState,
  mintSessionCookie,
  sessionSetCookie,
  verifyLoginState
} from "../session";
import { whoop } from "../whoop/client";
import { upsertUser, upsertBodyMeasurement } from "../db/upserts";
import { drawBudget } from "../consumer";

// WHOOP is the upstream identity provider: one consent screen both
// authenticates the MCP client and connects the WHOOP account. Onboarding a
// community member is a single link.

type EnvWithOAuth = Env & { OAUTH_PROVIDER: OAuthHelpers };

const WHOOP_AUTHORIZE_URL = "https://api.prod.whoop.com/oauth/oauth2/auth";
const WHOOP_TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";
const WHOOP_SCOPES =
  "offline read:recovery read:cycles read:sleep read:workout read:profile read:body_measurement";
const BACKFILL_MONTHS = 6;
const BACKFILL_RESOURCES: BackfillResource[] = ["cycle", "sleep", "recovery", "workout"];

export const defaultHandler = {
  // The provider injects OAUTH_PROVIDER into env at runtime; the exported
  // fetch signature must stay ExportedHandler<Env>, so widen inside.
  async fetch(request: Request, baseEnv: Env, _ctx: ExecutionContext): Promise<Response> {
    const env = baseEnv as EnvWithOAuth;
    const url = new URL(request.url);
    if (url.pathname === "/webhooks/whoop" && request.method === "POST") {
      return handleWebhook(request, env);
    }
    if (url.pathname === "/dashboard" && (request.method === "GET" || request.method === "HEAD")) {
      return handleDashboardPage(request, env);
    }
    if (url.pathname === "/dashboard/login") return handleDashboardLogin(request, env);
    if (url.pathname === "/dashboard/logout") return handleDashboardLogout(request);
    if (url.pathname === "/authorize") return handleAuthorize(request, env);
    if (url.pathname === "/callback") return handleCallback(request, env);
    if (url.pathname === "/") {
      return new Response(
        "whoop-relay: WHOOP data for Claude over MCP.\n\nMCP endpoint: /mcp (streamable HTTP, OAuth).\nConnect from Claude by adding this server's URL — the consent screen links your WHOOP account.\nLive dashboard: /dashboard (WHOOP login, per-user).\n",
        { headers: { "Content-Type": "text/plain" } }
      );
    }
    return new Response("not found", { status: 404 });
  }
};

async function handleAuthorize(request: Request, env: EnvWithOAuth): Promise<Response> {
  const authReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  const client = await env.OAUTH_PROVIDER.lookupClient(authReq.clientId);
  if (!client) return new Response("unknown client", { status: 400 });

  // The downstream (MCP client) auth request rides through the WHOOP flow in
  // the state parameter; completeAuthorization validates it against the
  // registered client + redirect URI on the way back.
  const state = btoa(JSON.stringify(authReq));
  const url = new URL(request.url);

  const upstream = new URL(WHOOP_AUTHORIZE_URL);
  upstream.searchParams.set("response_type", "code");
  upstream.searchParams.set("client_id", env.WHOOP_CLIENT_ID);
  upstream.searchParams.set("redirect_uri", `${url.origin}/callback`);
  upstream.searchParams.set("scope", WHOOP_SCOPES);
  upstream.searchParams.set("state", state);
  return Response.redirect(upstream.toString(), 302);
}

async function handleCallback(request: Request, env: EnvWithOAuth): Promise<Response> {
  const code = new URL(request.url).searchParams.get("code");
  const state = new URL(request.url).searchParams.get("state");
  if (!code || !state) return new Response("missing code/state", { status: 400 });

  // One registered redirect URI serves two flows: browser logins mark their
  // state with a prefix; everything else is an MCP AuthRequest riding through.
  if (state.startsWith(BROWSER_STATE_PREFIX)) {
    return handleBrowserCallback(request, env, code, state);
  }

  let authReq: AuthRequest;
  try {
    authReq = JSON.parse(atob(state)) as AuthRequest;
  } catch {
    return new Response("bad state", { status: 400 });
  }

  const login = await completeWhoopLogin(request, env, code);
  if (!login.ok) return login.response;

  const props: SessionProps = { whoopUserId: login.whoopUserId, name: login.name };
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: authReq,
    userId: String(login.whoopUserId),
    metadata: { connected_at: new Date().toISOString() },
    scope: authReq.scope,
    props
  });
  return Response.redirect(redirectTo, 302);
}

type LoginResult =
  | { ok: true; whoopUserId: number; name?: string }
  | { ok: false; response: Response };

// Shared by the MCP consent flow and the browser /dashboard login: exchange
// the WHOOP code, resolve the profile, hand tokens to the TokenManager DO
// (the only component allowed to hold or refresh them), upsert the user.
async function completeWhoopLogin(request: Request, env: EnvWithOAuth, code: string): Promise<LoginResult> {
  const url = new URL(request.url);
  const tokenRes = await fetch(WHOOP_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: env.WHOOP_CLIENT_ID,
      client_secret: env.WHOOP_CLIENT_SECRET,
      redirect_uri: `${url.origin}/callback`
    })
  });
  if (!tokenRes.ok) {
    return { ok: false, response: new Response(`WHOOP token exchange failed (${tokenRes.status})`, { status: 502 }) };
  }
  const tokens = (await tokenRes.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const budget = await drawBudget(env, 2, "interactive");
  if (!budget.ok) {
    return { ok: false, response: new Response("WHOOP API budget exhausted, try connecting again shortly", { status: 503 }) };
  }

  const profile = (await whoop.profile(tokens.access_token)) as {
    user_id: number;
    first_name?: string;
    last_name?: string;
    email?: string;
  } | null;
  if (!profile || typeof profile.user_id !== "number") {
    return { ok: false, response: new Response("could not resolve WHOOP profile", { status: 502 }) };
  }
  const whoopUserId = profile.user_id;

  const stub = env.TOKEN_MANAGER.get(env.TOKEN_MANAGER.idFromName(String(whoopUserId)));
  await stub.storeTokens(tokens);

  const existing = await env.DB
    .prepare(`SELECT 1 AS x FROM users WHERE whoop_user_id = ?`)
    .bind(whoopUserId)
    .first();
  await upsertUser(env.DB, profile);
  const body = await whoop.bodyMeasurement(tokens.access_token);
  if (body) await upsertBodyMeasurement(env.DB, whoopUserId, body);

  // Backfill history for first-time users only — repeat logins (browser
  // sessions, reconsents) rely on webhooks + reconciliation instead of
  // re-drawing six months of budget.
  if (!existing) {
    const start = new Date(Date.now() - BACKFILL_MONTHS * 30 * 86_400_000).toISOString();
    for (const [i, resource] of BACKFILL_RESOURCES.entries()) {
      await env.EVENT_QUEUE.send(
        { kind: "backfill", user_id: whoopUserId, resource, start },
        { delaySeconds: 10 + i * 5 }
      );
    }
  }

  return {
    ok: true,
    whoopUserId,
    name: [profile.first_name, profile.last_name].filter(Boolean).join(" ") || undefined
  };
}

async function handleBrowserCallback(
  request: Request,
  env: EnvWithOAuth,
  code: string,
  state: string
): Promise<Response> {
  const nonce = getCookie(request, LOGIN_COOKIE);
  if (!(await verifyLoginState(state, nonce, env.SESSION_SECRET))) {
    return new Response("login expired or invalid — start again at /dashboard", { status: 400 });
  }

  const login = await completeWhoopLogin(request, env, code);
  if (!login.ok) return login.response;

  const headers = new Headers({ Location: new URL("/dashboard", request.url).toString() });
  headers.append("Set-Cookie", sessionSetCookie(await mintSessionCookie(login.whoopUserId, env.SESSION_SECRET)));
  headers.append("Set-Cookie", clearCookie(LOGIN_COOKIE));
  return new Response(null, { status: 302, headers });
}

async function handleDashboardLogin(request: Request, env: EnvWithOAuth): Promise<Response> {
  const { state, nonce } = await mintLoginState(env.SESSION_SECRET);
  const url = new URL(request.url);
  const upstream = new URL(WHOOP_AUTHORIZE_URL);
  upstream.searchParams.set("response_type", "code");
  upstream.searchParams.set("client_id", env.WHOOP_CLIENT_ID);
  upstream.searchParams.set("redirect_uri", `${url.origin}/callback`);
  upstream.searchParams.set("scope", WHOOP_SCOPES);
  upstream.searchParams.set("state", state);
  return new Response(null, {
    status: 302,
    headers: { Location: upstream.toString(), "Set-Cookie": loginSetCookie(nonce) }
  });
}

function handleDashboardLogout(request: Request): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: new URL("/", request.url).toString(), "Set-Cookie": clearCookie(SESSION_COOKIE) }
  });
}
