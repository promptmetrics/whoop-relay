import { WHOOP_WORDMARK_SVG, dataByWhoop } from "./whoop-brand";

// Static, script-free HTML pages: landing, privacy, support, and the two
// end-of-flow notices. WHOOP's app-approval checklist requires an accurate
// privacy policy URL and an easily reachable support contact; the API Terms
// (§2.3, §5.1) require both plus WHOOP attribution wherever WHOOP data shows.

export const SUPPORT_EMAIL = "hello@promptmetrics.dev";
export const PRIVACY_EMAIL = "privacy@promptmetrics.dev";
const OPERATOR = "PromptMetrics, Berlin, Germany";
const POLICY_UPDATED = "2026-09-11";

// Same reasoning as dashboard-page.ts: CSP lives in a <meta> tag because the
// zone rewrites CSP *headers*. These pages run no script at all.
const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; base-uri 'none'";

const CSS = `
  :root { color-scheme: dark; }
  body { margin: 0; background: linear-gradient(180deg, #283339 0%, #101518 100%); min-height: 100vh;
         color: #fff; font: 16px/1.55 "Helvetica Neue", Helvetica, Arial, system-ui, sans-serif; }
  main { max-width: 720px; margin: 0 auto; padding: 40px 20px 32px; }
  h1 { font-size: 22px; letter-spacing: .08em; text-transform: uppercase; margin: 0 0 6px; }
  h2 { font-size: 17px; margin: 32px 0 8px; }
  p, li { color: #d7dde0; }
  a { color: #00f19f; }
  code, pre { font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; background: rgba(255,255,255,.08);
              border-radius: 6px; }
  code { padding: 1px 6px; } pre { padding: 12px 14px; overflow-x: auto; }
  .lede { font-size: 18px; color: #fff; }
  .notice { border: 1px solid #00f19f; border-radius: 10px; padding: 12px 16px; margin: 0 0 24px; color: #fff; }
  .notice.warn { border-color: #ffde00; }
  .card { background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.12); border-radius: 12px; padding: 16px 18px; margin: 12px 0; }
  footer { max-width: 720px; margin: 0 auto; padding: 24px 20px 40px; border-top: 1px solid rgba(255,255,255,.12);
           display: flex; flex-wrap: wrap; gap: 14px 28px; align-items: center; justify-content: space-between;
           font-size: 13px; color: #9aa4aa; }
  footer nav a { color: #d7dde0; margin-right: 18px; }
  .whoop-attr { color: #fff; }
  .muted { color: #9aa4aa; font-size: 14px; }
  .btn { display: inline-block; padding: 10px 18px; border-radius: 8px; background: #00f19f; color: #101518;
         font-weight: 700; text-decoration: none; }
  .btn.ghost { background: transparent; border: 1px solid #ff0026; color: #ff0026; font-weight: 400; padding: 6px 12px; font-size: 13px; }
  .btn.small { padding: 6px 12px; font-size: 13px; }
  form.inline { display: inline; }
  .pill { display: inline-block; font-size: 12px; padding: 1px 8px; border-radius: 999px; border: 1px solid rgba(255,255,255,.2); color: #d7dde0; }
  .pill.approved { border-color: #16ec06; color: #16ec06; } .pill.denied { border-color: #ff0026; color: #ff0026; } .pill.pending { border-color: #ffde00; color: #ffde00; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { text-align: left; padding: 6px 10px 6px 0; border-bottom: 1px solid rgba(255,255,255,.12); vertical-align: top; color: #d7dde0; }
  th { color: #fff; }
`;

function shell(title: string, body: string, opts: { noindex?: boolean } = {}): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    (opts.noindex ? `<meta name="robots" content="noindex">` : "") +
    `<title>${title}</title><style>${CSS}</style></head><body>` +
    `<main>${body}</main>` +
    `<footer>` +
    `<nav><a href="/">WHOOP Relay</a><a href="/dashboard">Dashboard</a><a href="/privacy">Privacy</a><a href="/support">Support</a></nav>` +
    dataByWhoop(110) +
    `<div style="flex-basis:100%">WHOOP Relay is built and operated by ${OPERATOR}. It is not affiliated with, endorsed or sponsored by WHOOP. WHOOP is a trademark of WHOOP, Inc.</div>` +
    `</footer></body></html>`
  );
}

function htmlResponse(html: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html;charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "Referrer-Policy": "no-referrer",
      ...extra
    }
  });
}

export function landingPage(origin: string, flags: { disconnected?: boolean } = {}): Response {
  const notice = flags.disconnected
    ? `<div class="notice">Your WHOOP account is disconnected. We deleted every record we held for it. Reconnect any time; that starts a fresh six-month history import.</div>`
    : "";
  const body =
    notice +
    `<h1>WHOOP Relay</h1>` +
    `<p class="lede">Your WHOOP data, available to Claude. Connect once. Then ask about recovery, sleep, strain and workouts in plain language, or open the live dashboard.</p>` +
    `<div class="card"><strong>Invite-only.</strong> <span class="muted">WHOOP caps this app at a fixed member limit, so I approve seats by hand. Operator Stack members come first.</span>` +
    `<p style="margin:12px 0 6px"><a class="btn" href="/dashboard/login">Request access</a></p>` +
    `<p class="muted" style="margin:0">You approve WHOOP Relay on WHOOP's own screen so I know which account to invite. We revoke that access straight away. Until I approve a seat, we hold your name and email. Nothing else. You'll get the connect steps by email.</p></div>` +
    `<h2>Connect from Claude</h2>` +
    `<p><strong>Claude Code:</strong></p><pre>claude mcp add --transport http whoop ${origin}/mcp</pre>` +
    `<p><strong>Claude Desktop / claude.ai:</strong> Settings → Connectors → Add custom connector → <code>${origin}/mcp</code>. The WHOOP consent screen links your account.</p>` +
    `<h2>Live dashboard</h2>` +
    `<p><a href="/dashboard">${origin}/dashboard</a>. WHOOP login, your data only. Recovery, HRV and resting heart rate, sleep, strain vs recovery, and workouts.</p>` +
    `<h2>Your data</h2>` +
    `<p>We store it only while you stay connected and delete all of it the moment you disconnect: the dashboard button, the <code>disconnect_whoop</code> tool, or revoking access inside the WHOOP app. Details in the <a href="/privacy">privacy policy</a>.</p>`;
  return htmlResponse(shell("WHOOP Relay", body), 200, flags.disconnected ? { "Cache-Control": "no-store" } : {});
}

// Shown to an uninvited WHOOP login, from the landing button or from a Claude
// client. The request is recorded, the grant revoked, the admin notified.
export function requestReceivedPage(email: string | null, opts: { full: boolean; repeat: boolean }): Response {
  const who = email ? ` A confirmation is on its way to <code>${escapeHtml(email)}</code>; the decision goes there too.` : "";
  const headline = opts.full ? "You're on the waiting list" : opts.repeat ? "Request received again" : "Request received";
  const lede = opts.full
    ? "WHOOP Relay has reached the member limit WHOOP granted it. Your request is recorded and you will hear from us when a seat opens."
    : "Seats are approved by hand, usually within a day or two. Approval arrives by email with the steps to connect from Claude.";
  const body =
    `<div class="notice">Not connected yet. We hold your name and email. Nothing else.</div>` +
    `<h1>${headline}</h1>` +
    `<p class="lede">${lede}${who}</p>` +
    `<p>The access you just granted on WHOOP's screen has been revoked again. No health data was fetched. ` +
    `Questions: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>`;
  return htmlResponse(shell(`${headline} · WHOOP Relay`, body, { noindex: true }), 200, { "Cache-Control": "no-store" });
}

export interface RequestRow {
  whoop_user_id: number;
  name: string | null;
  email: string;
  status: "pending" | "approved" | "denied";
  requested_at: string;
  decided_at: string | null;
  decided_via: string | null;
  connected: 0 | 1;
}

export function adminPage(
  data: { seats: { used: number; max: number }; rows: RequestRow[] },
  flash?: string
): Response {
  const pending = data.rows.filter((r) => r.status === "pending");
  const decided = data.rows.filter((r) => r.status !== "pending");
  const row = (r: RequestRow, actions: boolean) =>
    `<tr><td>${escapeHtml(r.name ?? "(no name)")}<br><span class="muted">${escapeHtml(r.email)}</span></td>` +
    `<td>${r.requested_at.slice(0, 16).replace("T", " ")}</td>` +
    `<td><span class="pill ${r.status}">${r.status}</span>${r.connected ? ' <span class="pill">connected</span>' : ""}` +
    (r.decided_at ? `<br><span class="muted">${r.decided_at.slice(0, 16).replace("T", " ")} · ${escapeHtml(r.decided_via ?? "")}</span>` : "") +
    `</td>` +
    `<td>${
      actions
        ? `<form class="inline" method="post" action="/admin/requests"><input type="hidden" name="whoop_user_id" value="${r.whoop_user_id}"><input type="hidden" name="action" value="approve"><button class="btn small" type="submit">Approve</button></form> ` +
          `<form class="inline" method="post" action="/admin/requests"><input type="hidden" name="whoop_user_id" value="${r.whoop_user_id}"><input type="hidden" name="action" value="deny"><button class="btn ghost" type="submit">Deny</button></form>`
        : ""
    }</td></tr>`;
  const table = (rows: RequestRow[], actions: boolean) =>
    rows.length
      ? `<table><tr><th>Who</th><th>Requested</th><th>Status</th><th></th></tr>${rows.map((r) => row(r, actions)).join("")}</table>`
      : `<p class="muted">None.</p>`;
  const body =
    (flash ? `<div class="notice">${escapeHtml(flash)}</div>` : "") +
    `<h1>Access requests</h1>` +
    `<p class="lede">Seats used: <strong>${data.seats.used} / ${data.seats.max}</strong> <span class="muted">(WHOOP granted 100; the app stops admitting at ${data.seats.max})</span></p>` +
    `<h2>Pending (${pending.length})</h2>${table(pending, true)}` +
    `<h2>Decided (${decided.length})</h2>${table(decided, false)}` +
    `<p class="muted">Approving adds the email to the allowlist and emails connect steps. Denying emails a short notice. Denied requests are deleted after 30 days. Terminal alternative: <code>scripts/allowlist.sh</code>.</p>`;
  return htmlResponse(shell("Admin · WHOOP Relay", body, { noindex: true }), 200, {
    "Cache-Control": "private, no-store",
    "X-Robots-Tag": "noindex"
  });
}

// The email link only shows this page. Mail security scanners prefetch links,
// so the state change happens on the POST below, never on the GET.
export function decisionConfirmPage(action: "approve" | "deny", email: string | null, name: string | null, token: string): Response {
  const who = email ? `<code>${escapeHtml(email)}</code>${name ? ` (${escapeHtml(name)})` : ""}` : "this request";
  const verb = action === "approve" ? "Approve" : "Deny";
  const effect =
    action === "approve"
      ? "adds the email to the allowlist and sends the connect steps."
      : "sends a short notice and keeps nothing else.";
  const body =
    `<h1>${verb} access?</h1>` +
    `<p class="lede">${verb} ${who}. This ${effect}</p>` +
    `<form method="post" action="/admin/decide"><input type="hidden" name="token" value="${escapeHtml(token)}">` +
    `<button class="btn${action === "deny" ? " ghost" : ""}" type="submit">${verb}</button></form>` +
    `<p class="muted" style="margin-top:16px"><a href="/admin">Open the queue instead</a></p>`;
  return htmlResponse(shell(`${verb} · WHOOP Relay`, body, { noindex: true }), 200, { "Cache-Control": "no-store" });
}

export function decisionResultPage(
  action: "approve" | "deny",
  outcome: "applied" | "already" | "not_found",
  email: string | null,
  currentStatus: string | null
): Response {
  const who = email ? `<code>${escapeHtml(email)}</code>` : "this request";
  let headline: string;
  let text: string;
  if (outcome === "not_found") {
    headline = "Request not found";
    text = "It may have been deleted (denied requests are pruned after 30 days) or the link is stale.";
  } else if (outcome === "already") {
    headline = `Already ${currentStatus}`;
    text = `${who} was already ${currentStatus}; nothing changed. One-click links are idempotent on purpose.`;
  } else {
    headline = action === "approve" ? "Approved" : "Denied";
    text =
      action === "approve"
        ? `${who} is on the allowlist and has been emailed the connect steps. They count toward the seat limit once they actually connect from Claude.`
        : `${who} has been emailed a short notice. Nothing of theirs was stored.`;
  }
  const body =
    `<h1>${headline}</h1><p class="lede">${text}</p><p><a class="btn small" href="/admin">Open the queue</a></p>`;
  return htmlResponse(shell(`${headline} · WHOOP Relay`, body, { noindex: true }), 200, { "Cache-Control": "no-store" });
}

export function supportPage(): Response {
  const body =
    `<h1>Support</h1>` +
    `<p class="lede">WHOOP Relay is operated by ${OPERATOR}. We provide all support for it; WHOOP does not.</p>` +
    `<div class="card"><strong>Email:</strong> <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a><br>` +
    `<span class="muted">Write from the email address on your WHOOP account so we can find your connection. Typical reply within two business days (Berlin time).</span></div>` +
    `<h2>Common requests</h2>` +
    `<ul>` +
    `<li><strong>Disconnect and delete my data.</strong> Self-service: the button at the bottom of the <a href="/dashboard">dashboard</a>, the <code>disconnect_whoop</code> tool in Claude, or revoke "WHOOP Relay" under connected apps in the WHOOP app. All three delete everything we hold within minutes.</li>` +
    `<li><strong>Data looks stale.</strong> Recovery and sleep arrive within seconds of WHOOP finishing its own processing. Day strain has no webhook at WHOOP and refreshes with each recovery, every six hours, or when you ask Claude to <code>sync_now</code>.</li>` +
    `<li><strong>Connector shows no new tools.</strong> Claude clients cache the tool list for up to an hour after a deploy; disconnect and reconnect the connector to refresh.</li>` +
    `<li><strong>Security issue.</strong> Email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> with "security" in the subject. We acknowledge within one business day.</li>` +
    `</ul>` +
    `<h2>Privacy requests</h2>` +
    `<p>Access, correction, deletion or a copy of your data: <a href="mailto:${PRIVACY_EMAIL}">${PRIVACY_EMAIL}</a>, or see the <a href="/privacy">privacy policy</a>.</p>`;
  return htmlResponse(shell("Support · WHOOP Relay", body));
}

export function privacyPage(): Response {
  const body =
    `<h1>Privacy policy</h1>` +
    `<p class="muted">WHOOP Relay · last updated ${POLICY_UPDATED}</p>` +
    `<p class="lede">WHOOP Relay lets you use your own WHOOP data inside Claude. This page says exactly what we store, why, for how long, and how to make it go away.</p>` +

    `<h2>Who is responsible</h2>` +
    `<p>${OPERATOR} operates WHOOP Relay and is the data controller for the processing described here. Contact: <a href="mailto:${PRIVACY_EMAIL}">${PRIVACY_EMAIL}</a>. ` +
    `WHOOP, Inc. is the source of the data and a separate controller for what happens inside the WHOOP app and the WHOOP developer platform; WHOOP's own policy governs that.</p>` +

    `<h2>What we collect</h2>` +
    `<p>Only what you authorise on the WHOOP consent screen, fetched through the official WHOOP Developer API (v2):</p>` +
    `<table><tr><th>Category</th><th>Fields</th><th>Why</th></tr>` +
    `<tr><td>Profile</td><td>WHOOP user id, first and last name, email</td><td>Identify your connection; the invite check; support</td></tr>` +
    `<tr><td>Body measurements</td><td>Height, weight, max heart rate</td><td>Shown on request in your profile</td></tr>` +
    `<tr><td>Recovery</td><td>Recovery score, HRV, resting heart rate, SpO₂, skin temperature</td><td>Answer questions, draw the dashboard</td></tr>` +
    `<tr><td>Sleep</td><td>Sleep and nap times, stage durations, performance, respiratory rate</td><td>Same</td></tr>` +
    `<tr><td>Physiological cycles</td><td>Day strain, energy, average and max heart rate</td><td>Same</td></tr>` +
    `<tr><td>Workouts</td><td>Sport, times, strain, energy, heart-rate zones</td><td>Same</td></tr>` +
    `<tr><td>Technical</td><td>Webhook delivery ids, sync timestamps, OAuth tokens</td><td>Keep the copy current; de-duplicate; authenticate</td></tr>` +
    `</table>` +
    `<p>We store the WHOOP API records as received so that a future change in what we display never requires re-downloading your history. We do not collect location, raw heart-rate streams, or anything WHOOP does not expose through the fields above.</p>` +
    `<p><strong>Access requests.</strong> Connecting without an invite creates an access request holding your name, email and WHOOP user id only. The WHOOP access you granted is revoked in the same moment and no health data is fetched. Denied requests are deleted after 30 days; approved ones are kept as the record of your invitation.</p>` +

    `<h2>Why, and on what legal basis</h2>` +
    `<p>Health and biometric data is special-category data under GDPR Article 9. We process it only on your <strong>explicit consent</strong> (Art. 6(1)(a) and 9(2)(a)), given when you approve WHOOP Relay on WHOOP's consent screen. ` +
    `The sole purpose is to show <em>you</em> your data: through the Claude client you connected and through the authenticated dashboard. There is no profiling, no advertising, no analytics on your health data, and no automated decision-making.</p>` +

    `<h2>Who can see it</h2>` +
    `<ul>` +
    `<li><strong>You</strong>, in your Claude client and in the dashboard after WHOOP login.</li>` +
    `<li><strong>Anthropic</strong> receives whatever tool results you ask Claude to fetch, under your own Anthropic account terms. WHOOP Relay never pushes data to Anthropic on its own.</li>` +
    `<li><strong>Cloudflare</strong> hosts the service (Workers, D1 database, Durable Objects, Queues) as our processor under Cloudflare's data processing addendum. Data is encrypted in transit (TLS) and at rest by Cloudflare; OAuth tokens are additionally encrypted by us before storage.</li>` +
    `<li><strong>WHOOP</strong> sees the API requests we make on your behalf, as any connected app would.</li>` +
    `</ul>` +
    `<p>No other user of WHOOP Relay can see your data: every request is tied to the account that authenticated it, and there are no share links. We never sell, license, rent or otherwise trade WHOOP data, and we do not use it to train any model.</p>` +

    `<h2>Where</h2>` +
    `<p>Cloudflare's network is global; the database and per-user storage may be processed outside the European Union. Transfers rely on Cloudflare's Standard Contractual Clauses and its EU–US Data Privacy Framework certification.</p>` +

    `<h2>How long</h2>` +
    `<p>For as long as your connection is active. Disconnecting deletes <em>all</em> of it in a single operation: every stored record, the OAuth tokens, and the connector authorisation. Disconnect from the dashboard button, with the <code>disconnect_whoop</code> tool in Claude, or by revoking "WHOOP Relay" in the WHOOP app (we detect that within 24 hours and delete just the same). ` +
    `Webhook delivery ids without personal content are pruned after 30 days. Server logs are kept by Cloudflare for at most 7 days. If WHOOP Relay shuts down, all data is deleted.</p>` +

    `<h2>Your rights</h2>` +
    `<p>Under GDPR you can access, correct, export, restrict or delete your data and withdraw consent at any time; withdrawing consent is exactly what disconnecting does. ` +
    `For anything you cannot do yourself, email <a href="mailto:${PRIVACY_EMAIL}">${PRIVACY_EMAIL}</a>; we answer within 30 days. You may also complain to the Berlin Commissioner for Data Protection and Freedom of Information (Berliner Beauftragte für Datenschutz und Informationsfreiheit).</p>` +

    `<h2>Security incidents</h2>` +
    `<p>If your data is affected by a breach we notify you and WHOOP without undue delay and, where required, the supervisory authority within 72 hours.</p>` +

    `<h2>Changes</h2>` +
    `<p>Changes are posted here with a new date. Material changes are announced on the landing page before they take effect.</p>`;
  return htmlResponse(shell("Privacy · WHOOP Relay", body));
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}
