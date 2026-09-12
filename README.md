# WHOOP Relay

WHOOP Relay is a multi-user orchestration layer that connects WHOOP accounts to Claude — claude.ai, Desktop, Code, Cowork, and mobile — through a remote MCP server on Cloudflare Workers, including an interactive dashboard rendered inside the chat and an authenticated live dashboard on the web.

WHOOP pushes webhook events; a queue buffers them; the consumer resolves the actual data within rate limits and lands it in D1. The MCP server answers questions from that datastore instantly — "how did I sleep, should I push today, what's my strain trend" — without burning API quota per question.

For every architectural decision, its rationale, and detailed request flows, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Get started

The server URL is `https://whoop.promptmetrics.dev/mcp`. Every client goes through the same one-time WHOOP consent screen, which links your WHOOP account and starts a six-month history backfill.

> **Invite-only.** WHOOP approved the app on 2026-09-11 for up to 100 members. A first-time login is admitted only if the WHOOP account's email is on the allowlist. Anyone else becomes an **access request**: the WHOOP grant is revoked on the spot, only name and email are kept, and the admin approves or denies from an email link or [`/admin`](https://whoop.promptmetrics.dev/admin) (see [Approving users](#approving-users)). What is stored, and how to delete it, is on the [privacy page](https://whoop.promptmetrics.dev/privacy).

### Claude Code (terminal)

```bash
claude mcp add --transport http whoop https://whoop.promptmetrics.dev/mcp
```

Then run `/mcp` inside a session and authenticate — the browser opens the WHOOP consent screen. Claude Code doesn't render MCP App iframes; `show_dashboard` returns a text summary, structured data, and the live dashboard URL instead.

### Claude Desktop and claude.ai

Profile → **Settings** → **Connectors** → **Add custom connector** → paste `https://whoop.promptmetrics.dev/mcp` (custom connectors require a paid plan). Complete the WHOOP login when prompted. These hosts render MCP Apps — ask for "my WHOOP dashboard" and the interactive dashboard appears in the chat; "just sleep vs recovery for June" renders only those panels.

### Claude Cowork

Cowork shares the claude.ai connector settings: add the custom connector once at claude.ai (**Settings → Connectors**, as above), then enable it from the connector picker inside your Cowork session. Tool calls work identically; dashboard rendering follows the host surface you're on.

After a new deploy, already-connected clients can take up to an hour to see new tools (`tools/list` is publicly cached with a 1-hour TTL) — disconnect/reconnect the connector to force a refresh.

## Tools

| Tool | Description |
| --- | --- |
| `get_recovery` | Recovery scores from the D1 datastore |
| `get_sleep` | Sleep data |
| `get_workouts` | Workouts |
| `get_strain` | Day strain (see freshness note below) |
| `get_profile` | User profile |
| `daily_report` | Combined daily summary |
| `trend` | Metric trend over a date range |
| `sync_now` | Live fetch from the WHOOP API, budget-permitting |
| `show_dashboard` | Interactive dashboard rendered in the chat (MCP Apps) |
| `disconnect_whoop` | Destructive: revokes WHOOP access, deletes every stored record, revokes the connector grant. Requires `confirm="DELETE MY WHOOP DATA"` |

All tools read D1 except `sync_now` (live fetch, budget-permitting). Cycles/strain have no webhooks upstream — strain freshness comes from recovery-event piggybacks, the 6h cron, and `sync_now`. `show_dashboard` is read-only (`readOnlyHint`) and takes an optional `panels` subset, date range, and granularity.

## Live dashboard

`https://whoop.promptmetrics.dev/dashboard` — one URL for every user. First visit redirects to the WHOOP login; after that a signed session cookie (30 days) loads *your* data only: recovery bands with a 7-day average, HRV/RHR trends, sleep stages, strain vs next-day recovery, and workouts, with date/sport/panel filters. Log out from the link in the header.

The footer carries the WHOOP attribution, links to [`/privacy`](https://whoop.promptmetrics.dev/privacy) and [`/support`](https://whoop.promptmetrics.dev/support), and a **Disconnect WHOOP & delete my data** button. Disconnecting — from that button, the `disconnect_whoop` tool, or by revoking the app inside WHOOP — deletes everything the service holds for that user in one step. There is no soft-delete and no retention period.

## Architecture

```
WHOOP ──webhook──▶ Ingest (HMAC, dedupe) ──▶ Queue ──▶ Consumer (coalesce, budget) ──▶ D1
Cron (6h) ── reconciliation ────────────────────────────────────────────────────────▶ D1
Claude ──streamable HTTP──▶ /mcp (stateless, spec 2026-07-28) ──reads──────────────▶ D1
Browser ──WHOOP login + session cookie──▶ /dashboard (live, per-user) ──reads──────▶ D1

Durable Objects: TokenManager (1/user, single-writer token refresh)
                 RateBudget   (global 100/min + daily token bucket)
```

- **MCP spec `2026-07-28`**: stateless handler (no sessions, no initialize), `server/discover`, required `ttlMs`/`cacheScope` on lists, MRTR (`input_required`) on `sync_now` when the API budget is exhausted.
- **MCP Apps (SEP-1865)**: `show_dashboard` ships a single-file HTML app as a `ui://` resource; hosts that support MCP Apps (claude.ai, Claude Desktop) render it as an interactive dashboard inside the conversation. Terminal hosts get a text summary plus chart-ready structured data.
- **Auth**: `workers-oauth-provider` with CIMD (DCR kept as deprecated fallback), RFC 9207 `iss`, PKCE. WHOOP is the upstream IdP — one consent screen authenticates the MCP client *and* connects the WHOOP account. The browser dashboard uses the same WHOOP login plus a signed 30-day session cookie; identity comes only from the verified cookie, never from the URL.
- **Rate limits are per app** (100/min, 10k/day): every WHOOP call draws from the RateBudget DO; backfill and reconciliation use the bulk lane, `sync_now` the interactive lane.
- **Refresh tokens rotate**: only the TokenManager DO ever touches the token endpoint.
- **Nothing is published**: there are no share links; every route that serves health data requires authentication.

The full decision record — every architectural choice, its rationale, one same-day reversal, and detailed request flows — is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Development

### Requirements

- Node.js and npm
- A Cloudflare account with Workers, D1, KV, Queues, and Durable Objects
- A WHOOP app from the [WHOOP Developer Dashboard](https://developer.whoop.com/) (API model version v2)

### Setup

```bash
npm install
npm --prefix ui install     # dashboard app dependencies
npm run typecheck

# Provision (once)
npx wrangler d1 create whoop-relay            # paste id into wrangler.jsonc
npx wrangler kv namespace create OAUTH_KV     # paste id into wrangler.jsonc
npx wrangler queues create whoop-events
npx wrangler queues create whoop-events-dlq

# Secrets
npx wrangler secret put WHOOP_CLIENT_ID       # from the WHOOP Developer Dashboard app
npx wrangler secret put WHOOP_CLIENT_SECRET   # from the WHOOP Developer Dashboard app
openssl rand -hex 32 | npx wrangler secret put SESSION_SECRET   # session cookies + OAuth state signing
openssl rand -base64 32 | npx wrangler secret put TOKEN_ENCRYPTION_KEY   # AES-GCM key for stored WHOOP tokens (must exist before the first deploy that uses it)
npx wrangler secret put RESEND_API_KEY        # Resend key (sending access, mail.promptmetrics.dev) for access-request emails; optional — skipped if unset
npx wrangler secret put ADMIN_WHOOP_USER_ID   # your WHOOP user id (get_profile tool) — the only account that can open /admin

# Schema
npm run db:migrate:remote

npm run deploy   # predeploy hook builds ui/dist/index.html and embeds it in the Worker
```

WHOOP app config: redirect URL `https://whoop.promptmetrics.dev/callback`, webhook URL `https://whoop.promptmetrics.dev/webhooks/whoop` (model version v2), privacy policy URL `https://whoop.promptmetrics.dev/privacy`.

### Approving users

Anyone can start from the landing page (**Request access**) or straight from a Claude client. If their WHOOP email is not on the allowlist:

1. The worker records name, email and WHOOP id in `access_requests`, revokes the grant WHOOP just issued (no seat used, no tokens held), shows a "Request received" page, and emails the applicant a receipt ("pending approval", or "waiting list" when the seat ceiling is reached).
2. You get an email (via Resend, from `EMAIL_FROM` to `ADMIN_EMAIL` in `wrangler.jsonc`) with **Approve** / **Deny** links, valid 7 days, plus the current seat count. Each link opens a one-button confirm page; the decision applies on that click, so link-prefetching mail scanners cannot decide for you.
3. Approve adds the email to the allowlist and emails them the connect steps; they then connect from Claude as a normal login. Deny emails a one-line notice. Both are idempotent.
4. `/admin` (WHOOP login; only `ADMIN_WHOOP_USER_ID` gets in, everyone else sees 404) shows pending and decided requests, who has actually connected, and seats used out of 90.

A hard ceiling of 90 connected users (`MAX_USERS` in `src/mcp/auth.ts`) sits under WHOOP's 100-member grant; logins past it are recorded as waiting-list requests. Denied requests are deleted after 30 days. The terminal path still works for pre-seeding:

```bash
scripts/allowlist.sh add pilot@example.com "operator-stack pilot"   # invite without a request (idempotent)
scripts/allowlist.sh list                                            # invited vs connected
scripts/allowlist.sh remove pilot@example.com                        # un-invite (an already-connected user keeps access until they disconnect)
```

Append `--local` to target the local dev database.

### Local development

`.dev.vars` holds dev credentials: `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET`, `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY`, and optionally `RESEND_API_KEY` / `ADMIN_WHOOP_USER_ID` (gitignored). Then:

```bash
npm run db:migrate:local
npm run dev
```

To preview the dashboard with synthetic data, open `ui/dist/index.html` directly in a browser after `npm run build:ui`.

### Testing the pipeline (WHOOP's own recipe)

Edit a past sleep's end time by one minute in the WHOOP app — the updated sleep **and** its recomputed recovery should land in D1 with no manual API calls. A backdated 5-minute workout tests the workout path.

## License

[MIT](LICENSE)

---

Built by [Izzy Aly](https://github.com/iiizzzyyy) at [PromptMetrics](https://github.com/promptmetrics).
