# whoop-relay

Multi-user orchestration layer that connects WHOOP accounts to Claude (Code, Cowork, mobile) through a remote MCP server on Cloudflare Workers.

WHOOP pushes webhook events; a queue buffers them; the consumer resolves the actual data within rate limits and lands it in D1. The MCP server answers questions from that datastore instantly — "how did I sleep, should I push today, what's my strain trend" — without burning API quota per question.

## Architecture

```
WHOOP ──webhook──▶ Ingest (HMAC, dedupe) ──▶ Queue ──▶ Consumer (coalesce, budget) ──▶ D1
Cron (6h) ── reconciliation ────────────────────────────────────────────────────────▶ D1
Claude ──streamable HTTP──▶ /mcp (stateless, spec 2026-07-28) ──reads──────────────▶ D1

Durable Objects: TokenManager (1/user, single-writer token refresh)
                 RateBudget   (global 100/min + daily token bucket)
```

- **MCP spec `2026-07-28`**: stateless handler (no sessions, no initialize), `server/discover`, required `ttlMs`/`cacheScope` on lists, MRTR (`input_required`) on `sync_now` when the API budget is exhausted.
- **Auth**: `workers-oauth-provider` with CIMD (DCR kept as deprecated fallback), RFC 9207 `iss`, PKCE. WHOOP is the upstream IdP — one consent screen authenticates the MCP client *and* connects the WHOOP account.
- **Rate limits are per app** (100/min, 10k/day): every WHOOP call draws from the RateBudget DO; backfill and reconciliation use the bulk lane, `sync_now` the interactive lane.
- **Refresh tokens rotate**: only the TokenManager DO ever touches the token endpoint.

## Tools

`get_recovery` · `get_sleep` · `get_workouts` · `get_strain` · `get_profile` · `daily_report` · `trend` · `sync_now`

All read D1 except `sync_now` (live fetch, budget-permitting). Cycles/strain have no webhooks upstream — strain freshness comes from recovery-event piggybacks, the 6h cron, and `sync_now`.

## Setup

```bash
npm install
npm run typecheck

# Provision (once)
npx wrangler d1 create whoop-relay            # paste id into wrangler.jsonc
npx wrangler kv namespace create OAUTH_KV     # paste id into wrangler.jsonc
npx wrangler queues create whoop-events
npx wrangler queues create whoop-events-dlq

# Secrets (from the WHOOP Developer Dashboard app)
npx wrangler secret put WHOOP_CLIENT_ID
npx wrangler secret put WHOOP_CLIENT_SECRET

# Schema
npm run db:migrate:remote

npm run deploy
```

WHOOP app config: redirect URL `https://whoop.promptmetrics.dev/callback`, webhook URL `https://whoop.promptmetrics.dev/webhooks/whoop` (model version v2).

Local dev: `.dev.vars` holds dev credentials (gitignored), `npm run db:migrate:local`, `npm run dev`.

## Testing the pipeline (WHOOP's own recipe)

Edit a past sleep's end time by one minute in the WHOOP app — the updated sleep **and** its recomputed recovery should land in D1 with no manual API calls. A backdated 5-minute workout tests the workout path.
