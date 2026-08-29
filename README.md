# WHOOP Relay

WHOOP Relay is a multi-user orchestration layer that connects WHOOP accounts to Claude — claude.ai, Desktop, Code, Cowork, and mobile — through a remote MCP server on Cloudflare Workers, including an interactive dashboard rendered inside the chat and an authenticated live dashboard on the web.

WHOOP pushes webhook events; a queue buffers them; the consumer resolves the actual data within rate limits and lands it in D1. The MCP server answers questions from that datastore instantly — "how did I sleep, should I push today, what's my strain trend" — without burning API quota per question.

For every architectural decision, its rationale, and detailed request flows, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Get started

The server URL is `https://whoop.promptmetrics.dev/mcp`. Every client goes through the same one-time WHOOP consent screen, which links your WHOOP account and starts a six-month history backfill.

> **Note:** The app is capped at 10 users until WHOOP approves it.

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

All tools read D1 except `sync_now` (live fetch, budget-permitting). Cycles/strain have no webhooks upstream — strain freshness comes from recovery-event piggybacks, the 6h cron, and `sync_now`. `show_dashboard` is read-only (`readOnlyHint`) and takes an optional `panels` subset, date range, and granularity.

## Live dashboard

`https://whoop.promptmetrics.dev/dashboard` — one URL for every user. First visit redirects to the WHOOP login; after that a signed session cookie (30 days) loads *your* data only: recovery bands with a 7-day average, HRV/RHR trends, sleep stages, strain vs next-day recovery, and workouts, with date/sport/panel filters. Log out from the link in the header.

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
openssl rand -hex 32 | npx wrangler secret put SESSION_SECRET   # dashboard session signing key

# Schema
npm run db:migrate:remote

npm run deploy   # predeploy hook builds ui/dist/index.html and embeds it in the Worker
```

WHOOP app config: redirect URL `https://whoop.promptmetrics.dev/callback`, webhook URL `https://whoop.promptmetrics.dev/webhooks/whoop` (model version v2).

### Local development

`.dev.vars` holds dev credentials including a `SESSION_SECRET` line (gitignored). Then:

```bash
npm run db:migrate:local
npm run dev
```

To preview the dashboard with synthetic data, open `ui/dist/index.html` directly in a browser after `npm run build:ui`.

### Testing the pipeline (WHOOP's own recipe)

Edit a past sleep's end time by one minute in the WHOOP app — the updated sleep **and** its recomputed recovery should land in D1 with no manual API calls. A backdated 5-minute workout tests the workout path.

## License

[MIT](LICENSE)
