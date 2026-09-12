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
  mintDecisionToken,
  mintLoginState,
  mintMcpState,
  mintSessionCookie,
  sessionSetCookie,
  verifyDecisionToken,
  verifyLoginState,
  verifyMcpState,
  verifySessionCookie,
  type Decision
} from "../session";
import { whoop } from "../whoop/client";
import { upsertUser, upsertBodyMeasurement } from "../db/upserts";
import { drawBudget } from "../consumer";
import { offboardUser, revokeUpstream } from "../offboard";
import {
  landingPage,
  privacyPage,
  supportPage,
  requestReceivedPage,
  adminPage,
  decisionConfirmPage,
  decisionResultPage,
  type RequestRow
} from "../pages";
import {
  sendEmail,
  adminRequestMail,
  applicantReceivedMail,
  applicantApprovedMail,
  applicantDeniedMail
} from "../email";

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
// WHOOP approved this app for 100 members (2026-09-11). Whether revoked
// members free their slot is unconfirmed, so stop admitting well short of it.
const MAX_USERS = 90;

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
    if (url.pathname === "/dashboard/disconnect" && request.method === "POST") {
      return handleDashboardDisconnect(request, env);
    }
    if (url.pathname === "/authorize") return handleAuthorize(request, env);
    if (url.pathname === "/callback") return handleCallback(request, env);
    if (url.pathname === "/") {
      return landingPage(url.origin, { disconnected: url.searchParams.get("disconnected") === "1" });
    }
    if (url.pathname === "/privacy") return privacyPage();
    if (url.pathname === "/support") return supportPage();
    if (url.pathname === "/admin" && request.method === "GET") return handleAdminPage(request, env);
    if (url.pathname === "/admin/requests" && request.method === "POST") return handleAdminAction(request, env);
    if (url.pathname === "/admin/decide") return handleDecisionLink(request, env);
    return new Response("not found", { status: 404 });
  }
};

async function handleAuthorize(request: Request, env: EnvWithOAuth): Promise<Response> {
  const authReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  const client = await env.OAUTH_PROVIDER.lookupClient(authReq.clientId);
  if (!client) return new Response("unknown client", { status: 400 });

  // The downstream (MCP client) auth request rides through the WHOOP flow in
  // the state parameter, HMAC-signed with a 10-minute expiry so nobody can
  // hand-craft one; completeAuthorization still validates it against the
  // registered client + redirect URI on the way back.
  const state = await mintMcpState(authReq, env.SESSION_SECRET);
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

  const authReq = await verifyMcpState<AuthRequest>(state, env.SESSION_SECRET);
  if (!authReq) return new Response("bad state — start the connection again", { status: 400 });

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

  const existing = await env.DB
    .prepare(`SELECT 1 AS x FROM users WHERE whoop_user_id = ?`)
    .bind(whoopUserId)
    .first();

  // Invite gate for first-time users. An uninvited login becomes an access
  // request: the freshly minted grant goes straight back to WHOOP, nothing
  // but name/email/id is kept, and the admin is notified.
  if (!existing) {
    const verdict = await admitNewUser(env, profile.email);
    if (verdict !== "ok") {
      await revokeUpstream(env, tokens.access_token, whoopUserId);
      const response = await recordAccessRequest(env, url.origin, profile, verdict === "full");
      return { ok: false, response };
    }
  }

  const stub = env.TOKEN_MANAGER.get(env.TOKEN_MANAGER.idFromName(String(whoopUserId)));
  await stub.storeTokens(tokens);
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

async function admitNewUser(env: Env, email: string | undefined): Promise<"ok" | "not_invited" | "full"> {
  if (!email) return "not_invited";
  // allowlist.email is COLLATE NOCASE; trimming covers copy-paste whitespace.
  const invited = await env.DB.prepare(`SELECT 1 AS x FROM allowlist WHERE email = ?`).bind(email.trim()).first();
  if (!invited) return "not_invited";
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users`).first<{ n: number }>();
  if ((row?.n ?? 0) >= MAX_USERS) {
    console.warn(JSON.stringify({ event: "user_cap_reached", max_users: MAX_USERS }));
    return "full";
  }
  return "ok";
}

// ---------------------------------------------------------------------------
// Access requests

type Profile = { user_id: number; first_name?: string; last_name?: string; email?: string };

const RENOTIFY_AFTER_DENIAL_MS = 7 * 86_400_000;

async function seatCount(env: Env): Promise<{ used: number; max: number }> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users`).first<{ n: number }>();
  return { used: row?.n ?? 0, max: MAX_USERS };
}

async function recordAccessRequest(env: Env, origin: string, profile: Profile, full: boolean): Promise<Response> {
  const email = profile.email ?? "";
  const name = [profile.first_name, profile.last_name].filter(Boolean).join(" ") || null;
  const prev = await env.DB
    .prepare(`SELECT status, decided_at FROM access_requests WHERE whoop_user_id = ?`)
    .bind(profile.user_id)
    .first<{ status: string; decided_at: string | null }>();
  const requestedAt = new Date().toISOString();

  await env.DB
    .prepare(
      `INSERT INTO access_requests (whoop_user_id, name, email, status, requested_at, decided_at, decided_via)
       VALUES (?, ?, ?, 'pending', ?, NULL, NULL)
       ON CONFLICT(whoop_user_id) DO UPDATE SET
         name=excluded.name, email=excluded.email, status='pending',
         requested_at=excluded.requested_at, decided_at=NULL, decided_via=NULL`
    )
    .bind(profile.user_id, name, email, requestedAt)
    .run();

  // A denial that is less than a week old re-pages nobody — the row is back
  // to pending and visible on /admin, that is enough.
  const recentlyDenied =
    prev?.status === "denied" && prev.decided_at != null && Date.now() - Date.parse(prev.decided_at) < RENOTIFY_AFTER_DENIAL_MS;
  if (!recentlyDenied) {
    const [approve, deny] = await Promise.all([
      mintDecisionToken(profile.user_id, "approve", env.SESSION_SECRET),
      mintDecisionToken(profile.user_id, "deny", env.SESSION_SECRET)
    ]);
    const adminMail = adminRequestMail(
      env,
      { whoopUserId: profile.user_id, name, email, requestedAt, isRepeat: !!prev },
      {
        approve: `${origin}/admin/decide?token=${approve}`,
        deny: `${origin}/admin/decide?token=${deny}`,
        admin: `${origin}/admin`
      },
      await seatCount(env)
    );
    // Applicant receipt goes out alongside the admin ping: a Claude client may
    // not show the "Request received" page, so the email is their record.
    await Promise.all([
      sendEmail(env, adminMail),
      email ? sendEmail(env, applicantReceivedMail(email, origin, { full })) : Promise.resolve(false)
    ]);
  }
  console.log(JSON.stringify({ event: "access_requested", user_id: profile.user_id, full, repeat: !!prev }));
  return requestReceivedPage(email || null, { full, repeat: !!prev });
}

type DecisionOutcome = { outcome: "applied" | "already" | "not_found"; email: string | null; status: string | null };

async function decideRequest(
  env: Env,
  origin: string,
  whoopUserId: number,
  action: Decision,
  via: "email-link" | "admin-page"
): Promise<DecisionOutcome> {
  const row = await env.DB
    .prepare(`SELECT email, status FROM access_requests WHERE whoop_user_id = ?`)
    .bind(whoopUserId)
    .first<{ email: string; status: string }>();
  if (!row) return { outcome: "not_found", email: null, status: null };
  if (row.status !== "pending") return { outcome: "already", email: row.email, status: row.status };

  const now = new Date().toISOString();
  const status = action === "approve" ? "approved" : "denied";
  const statements = [
    env.DB
      .prepare(`UPDATE access_requests SET status=?, decided_at=?, decided_via=? WHERE whoop_user_id=? AND status='pending'`)
      .bind(status, now, via, whoopUserId)
  ];
  if (action === "approve" && row.email) {
    statements.unshift(
      env.DB
        .prepare(`INSERT INTO allowlist (email, added_at, note) VALUES (?, ?, 'access-request') ON CONFLICT(email) DO NOTHING`)
        .bind(row.email, now)
    );
  }
  await env.DB.batch(statements);

  if (row.email) {
    await sendEmail(env, action === "approve" ? applicantApprovedMail(row.email, origin) : applicantDeniedMail(row.email));
  }
  console.log(JSON.stringify({ event: "access_decided", user_id: whoopUserId, status, via }));
  return { outcome: "applied", email: row.email || null, status };
}

// /admin is for one WHOOP account: the id in ADMIN_WHOOP_USER_ID. Anyone else
// with a valid session sees a 404 rather than a hint that the page exists.
async function requireAdmin(request: Request, env: Env): Promise<"ok" | "login" | "forbidden"> {
  const uid = await verifySessionCookie(getCookie(request, SESSION_COOKIE), env.SESSION_SECRET);
  if (uid == null) return "login";
  return env.ADMIN_WHOOP_USER_ID && String(uid) === env.ADMIN_WHOOP_USER_ID ? "ok" : "forbidden";
}

async function handleAdminPage(request: Request, env: Env): Promise<Response> {
  const auth = await requireAdmin(request, env);
  if (auth === "login") return Response.redirect(new URL("/dashboard/login", request.url).toString(), 302);
  if (auth === "forbidden") return new Response("not found", { status: 404 });

  const rows = await env.DB
    .prepare(
      `SELECT r.whoop_user_id, r.name, r.email, r.status, r.requested_at, r.decided_at, r.decided_via,
              CASE WHEN u.whoop_user_id IS NULL THEN 0 ELSE 1 END AS connected
       FROM access_requests r LEFT JOIN users u ON u.whoop_user_id = r.whoop_user_id
       ORDER BY (r.status = 'pending') DESC, r.requested_at DESC`
    )
    .all<RequestRow>();
  const flash = new URL(request.url).searchParams.get("done") ?? undefined;
  return adminPage({ seats: await seatCount(env), rows: rows.results }, flash);
}

async function handleAdminAction(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.headers.get("Origin") !== url.origin) return new Response("forbidden", { status: 403 });
  const auth = await requireAdmin(request, env);
  if (auth === "login") return Response.redirect(new URL("/dashboard/login", request.url).toString(), 302);
  if (auth === "forbidden") return new Response("not found", { status: 404 });

  const form = await request.formData();
  const whoopUserId = Number(form.get("whoop_user_id"));
  const action = form.get("action");
  if (!Number.isInteger(whoopUserId) || (action !== "approve" && action !== "deny")) {
    return new Response("bad request", { status: 400 });
  }
  const result = await decideRequest(env, url.origin, whoopUserId, action, "admin-page");
  const msg =
    result.outcome === "applied"
      ? `${result.email ?? whoopUserId}: ${result.status}`
      : result.outcome === "already"
        ? `${result.email ?? whoopUserId} was already ${result.status}`
        : `request ${whoopUserId} not found`;
  return Response.redirect(new URL(`/admin?done=${encodeURIComponent(msg)}`, request.url).toString(), 303);
}

// GET (the email link) only renders a confirm page; the decision is applied
// on POST. Mail scanners prefetch GET links, so a GET must never decide.
async function handleDecisionLink(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token =
    request.method === "POST" ? String((await request.formData()).get("token") ?? "") : url.searchParams.get("token");
  const decision = await verifyDecisionToken(token, env.SESSION_SECRET);
  if (!decision) return new Response("link invalid or expired, open /admin instead", { status: 400 });

  if (request.method === "GET") {
    const row = await env.DB
      .prepare(`SELECT name, email, status FROM access_requests WHERE whoop_user_id = ?`)
      .bind(decision.whoopUserId)
      .first<{ name: string | null; email: string; status: string }>();
    if (!row) return decisionResultPage(decision.action, "not_found", null, null);
    if (row.status !== "pending") return decisionResultPage(decision.action, "already", row.email, row.status);
    return decisionConfirmPage(decision.action, row.email || null, row.name, token as string);
  }

  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (request.headers.get("Origin") !== url.origin) return new Response("forbidden", { status: 403 });
  const result = await decideRequest(env, url.origin, decision.whoopUserId, decision.action, "email-link");
  return decisionResultPage(decision.action, result.outcome, result.email, result.status);
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

// The dashboard's "disconnect and delete" button. Identity comes from the
// session cookie only; the cookie is SameSite=Lax so a cross-site form post
// never carries it, and the Origin check makes that explicit.
async function handleDashboardDisconnect(request: Request, env: EnvWithOAuth): Promise<Response> {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  if (origin !== url.origin) return new Response("forbidden", { status: 403 });

  const uid = await verifySessionCookie(getCookie(request, SESSION_COOKIE), env.SESSION_SECRET);
  if (uid == null) return Response.redirect(new URL("/dashboard/login", request.url).toString(), 302);

  await offboardUser(env, uid, { revokeUpstream: true, oauth: env.OAUTH_PROVIDER });

  return new Response(null, {
    status: 302,
    headers: {
      Location: new URL("/?disconnected=1", request.url).toString(),
      "Set-Cookie": clearCookie(SESSION_COOKIE)
    }
  });
}
