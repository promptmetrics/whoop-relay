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
scripts/allowlist.sh add|remove|list [email] [note]   # invite gate (D1 allowlist); --local for dev
```

`src/db/schema.sql` is idempotent (`CREATE ... IF NOT EXISTS`) — additive schema changes just re-run the migrate scripts. Column changes need explicit `ALTER TABLE` statements added there.

## Architecture — the parts that span files

**One `OAuthProvider` wraps the entire Worker** (`src/index.ts`). Requests to `/mcp` go to the apiHandler after bearer-token verification, with `SessionProps` (`whoopUserId`) decrypted onto `ctx.props` — sealed in at consent time in `src/mcp/auth.ts` via `completeAuthorization({... props})`. Every other route (webhooks, `/authorize`, `/callback`, landing) goes to the defaultHandler in `src/mcp/auth.ts`. WHOOP is the upstream IdP: one consent screen authenticates the MCP client and connects the WHOOP account.

**Event pipeline:** `src/ingest.ts` verifies the HMAC against the raw body (read exactly once), dedupes on `trace_id`, enqueues, returns 204 — it must never call the WHOOP API. `src/consumer.ts` coalesces each batch by `(user, entity, id)` keeping the newest, draws from RateBudget, fetches from WHOOP v2, and upserts. `src/reconcile.ts` runs on two crons distinguished by the `event.cron` string in `src/index.ts` (`0 */6 * * *` reconciliation, `30 3 * * *` token health).

**MCP layer is stateless (spec 2026-07-28):** `createMcpHandler(() => buildServer(env, props))` builds a fresh `McpServer` per request. This repo uses **`@modelcontextprotocol/server` v2** — not the legacy v1 `@modelcontextprotocol/sdk`; their APIs differ substantially. `cacheHints` sets `ttlMs`/`cacheScope` on `tools/list`. `sync_now` implements MRTR: on budget exhaustion it returns `inputRequired(...)` and reads the retry's answer with `acceptedContent(ctx.mcpReq.inputResponses, ...)`.

**Two Durable Objects carry hard invariants:**
- `TokenManager` (one per user) is the **only** code allowed to touch WHOOP's token endpoint. WHOOP refresh tokens rotate — a second independent refresher invalidates the pair and logs users out. Never fetch or refresh tokens anywhere else. Tokens are AES-GCM sealed with `TOKEN_ENCRYPTION_KEY` before they hit DO storage; the secret must exist before deploy.
- `RateBudget` (single global instance) enforces WHOOP's per-app limits. Every WHOOP API call must `draw()` first: `bulk` lane for queue/cron/backfill, `interactive` for MCP-triggered fetches.

**One exit path:** `offboardUser()` in `src/offboard.ts` is the only way a user leaves — dashboard button, `disconnect_whoop` tool, allowlist refusal, or WHOOP rejecting the token all call it. It revokes upstream (when the token still works), wipes the token DO, deletes every D1 row for the user in one batch, and revokes their MCP grants. There is no soft-delete of users and no retention window (WHOOP API Terms §4.2(b), §7.1); `users.status`/`disconnected_at` are legacy columns that never change.

**Onboarding gate:** `completeWhoopLogin()` admits a first-time user only if their WHOOP profile email is in the `allowlist` table and `COUNT(users) < MAX_USERS` (90). Anyone else becomes a row in `access_requests` (`recordAccessRequest`): the just-issued WHOOP grant is revoked, only name/email/id are kept, and the admin is emailed one-click approve/deny links (`mintDecisionToken`, 7-day TTL) via `src/email.ts` (Resend REST; best-effort, skipped without `RESEND_API_KEY`). `decideRequest` is the single decision path for both the email link (`GET /admin/decide`) and the admin page (`POST /admin/requests`); approving inserts into `allowlist` and emails connect steps. `/admin` is visible only to `ADMIN_WHOOP_USER_ID`; other sessions get 404.

**Static pages** (`src/pages.ts`): `/`, `/privacy`, `/support` — script-free HTML with a meta CSP, WHOOP attribution from `src/whoop-brand.ts` (official SVGs, black/white only). The privacy text makes concrete promises (immediate deletion, 30-day webhook-event retention, token encryption); code changes that touch those must update the page.

## WHOOP v2 domain rules (not derivable from the code alone)

- Webhooks carry no data — they're dirty flags. Creates fire as `.updated`; delivery is unordered and unguaranteed. Hence: all writes are idempotent upserts keyed by resource id, and `.deleted` events tombstone (`deleted=1`) with **no** API call.
- `recovery.*` events carry the **sleep UUID**, not a recovery id — resolved by scanning the recent recovery collection for a matching `sleep_id`.
- Cycles (day strain) have **no webhooks**. Strain freshness = cycle fetch piggybacked on recovery events + the 6h cron + `sync_now`. Keep the staleness caveats in the `get_strain`/`daily_report` tool descriptions.
- ID types differ on purpose: cycles are INTEGER, sleeps/workouts are UUID. Never unify the columns.
- Rate limits are per **app** (100/min, 10k/day). WHOOP approved the app on 2026-09-11 for 100 members; the local `MAX_USERS` guard stops at 90 because it is unconfirmed whether revoked members free their slot.
- Brand rules (WHOOP Design Guidelines PDF): never rename Recovery/Strain/Sleep Performance/HRV; recovery bands are #16EC06 / #FFDE00 / #FF0026 at 67 / 34; strain #0093E7; sleep #7BA1BB; show "DATA BY WHOOP" wherever WHOOP data renders; logo black or white only, never next to our own logo.

## Gotchas

- DO method names can collide with the `DurableObject` base class (`connect` is its socket method) — that's why TokenManager uses `storeTokens`.
- `.dev.vars` and `.env*` are read-denied via `.claude/settings.json`. Don't bypass this; production secrets (`WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET`) are set by the user with `wrangler secret put`.
- CIMD support in workers-oauth-provider requires the `global_fetch_strictly_public` compatibility flag (already set in `wrangler.jsonc`).
