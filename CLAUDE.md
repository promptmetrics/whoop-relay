# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Multi-user orchestration layer: WHOOP webhooks → Cloudflare Queue → consumer → D1 read model, served to Claude clients through a remote MCP server (spec **2026-07-28**) at `https://whoop.promptmetrics.dev/mcp`, plus an MCP Apps dashboard and an authenticated live dashboard at `/dashboard`. Deployed and live. The full decision record and architecture handover is `docs/ARCHITECTURE.md`; the original planning rationale lives outside the repo at `../whoop-relay-plan.md`.

## Commands

```bash
npm run typecheck          # the only verification gate — run after every change (no test suite exists)
npm run dev                # local dev; needs .dev.vars and a migrated local D1
npm run db:migrate:local   # apply src/db/schema.sql locally (run first on a fresh checkout)
npm run db:migrate:remote  # apply schema to production D1
npm run deploy             # wrangler deploy (if the npm wrapper is permission-blocked, `npx wrangler deploy` works)
npx wrangler tail          # production logs
```

`src/db/schema.sql` is idempotent (`CREATE ... IF NOT EXISTS`) — additive schema changes just re-run the migrate scripts. Column changes need explicit `ALTER TABLE` statements added there.

## Architecture — the parts that span files

**One `OAuthProvider` wraps the entire Worker** (`src/index.ts`). Requests to `/mcp` go to the apiHandler after bearer-token verification, with `SessionProps` (`whoopUserId`) decrypted onto `ctx.props` — sealed in at consent time in `src/mcp/auth.ts` via `completeAuthorization({... props})`. Every other route (webhooks, `/authorize`, `/callback`, landing) goes to the defaultHandler in `src/mcp/auth.ts`. WHOOP is the upstream IdP: one consent screen authenticates the MCP client and connects the WHOOP account.

**Event pipeline:** `src/ingest.ts` verifies the HMAC against the raw body (read exactly once), dedupes on `trace_id`, enqueues, returns 204 — it must never call the WHOOP API. `src/consumer.ts` coalesces each batch by `(user, entity, id)` keeping the newest, draws from RateBudget, fetches from WHOOP v2, and upserts. `src/reconcile.ts` runs on two crons distinguished by the `event.cron` string in `src/index.ts` (`0 */6 * * *` reconciliation, `30 3 * * *` token health).

**MCP layer is stateless (spec 2026-07-28):** `createMcpHandler(() => buildServer(env, props))` builds a fresh `McpServer` per request. This repo uses **`@modelcontextprotocol/server` v2** — not the legacy v1 `@modelcontextprotocol/sdk`; their APIs differ substantially. `cacheHints` sets `ttlMs`/`cacheScope` on `tools/list`. `sync_now` implements MRTR: on budget exhaustion it returns `inputRequired(...)` and reads the retry's answer with `acceptedContent(ctx.mcpReq.inputResponses, ...)`.

**Two Durable Objects carry hard invariants:**
- `TokenManager` (one per user) is the **only** code allowed to touch WHOOP's token endpoint. WHOOP refresh tokens rotate — a second independent refresher invalidates the pair and logs users out. Never fetch or refresh tokens anywhere else.
- `RateBudget` (single global instance) enforces WHOOP's per-app limits. Every WHOOP API call must `draw()` first: `bulk` lane for queue/cron/backfill, `interactive` for MCP-triggered fetches.

## WHOOP v2 domain rules (not derivable from the code alone)

- Webhooks carry no data — they're dirty flags. Creates fire as `.updated`; delivery is unordered and unguaranteed. Hence: all writes are idempotent upserts keyed by resource id, and `.deleted` events tombstone (`deleted=1`) with **no** API call.
- `recovery.*` events carry the **sleep UUID**, not a recovery id — resolved by scanning the recent recovery collection for a matching `sleep_id`.
- Cycles (day strain) have **no webhooks**. Strain freshness = cycle fetch piggybacked on recovery events + the 6h cron + `sync_now`. Keep the staleness caveats in the `get_strain`/`daily_report` tool descriptions.
- ID types differ on purpose: cycles are INTEGER, sleeps/workouts are UUID. Never unify the columns.
- Rate limits are per **app** (100/min, 10k/day), and the app has a 10-user cap until WHOOP approves it.

## Gotchas

- DO method names can collide with the `DurableObject` base class (`connect` is its socket method) — that's why TokenManager uses `storeTokens`.
- `.dev.vars` and `.env*` are read-denied via `.claude/settings.json`. Don't bypass this; production secrets (`WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET`) are set by the user with `wrangler secret put`.
- CIMD support in workers-oauth-provider requires the `global_fetch_strictly_public` compatibility flag (already set in `wrangler.jsonc`).
