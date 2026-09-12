import type { Env, BackfillResource } from "./types";
import { whoop, RateLimitedError, UnauthorizedError, type CollectionPage, type CollectionParams } from "./whoop/client";
import {
  upsertSleep,
  upsertWorkout,
  upsertRecovery,
  upsertCycle,
  getWatermark,
  setWatermark
} from "./db/upserts";
import { drawBudget, getToken } from "./consumer";
import { offboardUser } from "./offboard";

const RESOURCES: BackfillResource[] = ["cycle", "sleep", "recovery", "workout"];
const MAX_PAGES_PER_RUN = 10;
// WHOOP collections filter on activity start time, not updated_at, so a
// backdated edit can predate the watermark. The overlap re-reads two days of
// history each run; upserts make the re-reads free of side effects.
const WATERMARK_OVERLAP_MS = 2 * 86_400_000;

// Every 6h. Catches missed webhooks (delivery is not guaranteed) — and for
// cycles it is the primary polling path for strain between recovery-event
// piggybacks.
// A real 429 means WHOOP's counter and our RateBudget disagree. One user's
// burst should not cost everyone else their run, so a 429 skips that user;
// three users in a row hitting it means the app-wide limit is genuinely
// exhausted and the run stops — the next one resumes from the watermarks.
const MAX_CONSECUTIVE_RATE_LIMITED_USERS = 3;

export async function runReconciliation(env: Env): Promise<void> {
  const users = await env.DB.prepare(
    `SELECT whoop_user_id FROM users WHERE status='connected'`
  ).all<{ whoop_user_id: number }>();

  let consecutiveRateLimited = 0;
  for (const { whoop_user_id: userId } of users.results) {
    const tokenRes = await getToken(env, userId);
    if (!tokenRes.ok) {
      if (tokenRes.reason === "revoked") await offboardUser(env, userId, { revokeUpstream: false });
      continue;
    }
    let rateLimited = false;
    for (const resource of RESOURCES) {
      try {
        await reconcileResource(env, userId, resource, tokenRes.token);
      } catch (err) {
        if (err instanceof RateLimitedError) {
          console.warn(JSON.stringify({ event: "reconcile_rate_limited", user_id: userId, resource, reset_s: err.resetSeconds }));
          rateLimited = true;
          break;
        }
        if (err instanceof UnauthorizedError) {
          await offboardUser(env, userId, { revokeUpstream: false });
          break;
        }
        console.error(`reconcile ${resource} failed for user ${userId}`, err);
      }
    }
    consecutiveRateLimited = rateLimited ? consecutiveRateLimited + 1 : 0;
    if (consecutiveRateLimited >= MAX_CONSECUTIVE_RATE_LIMITED_USERS) {
      console.warn("reconcile: app-wide rate limit exhausted, ending run early");
      return;
    }
  }
}

// Daily prune. webhook_events exists for trace_id dedupe (WHOOP retries for
// about an hour) and a short audit trail; denied access requests hold a
// stranger's name and email with no reason to keep them. 30 days covers both
// and is what the privacy page promises.
const PRUNE_AFTER_MS = 30 * 86_400_000;

export async function runDailyPrune(env: Env): Promise<void> {
  const cutoff = new Date(Date.now() - PRUNE_AFTER_MS).toISOString();
  const [events, denied] = await env.DB.batch([
    env.DB.prepare(`DELETE FROM webhook_events WHERE received_at < ?`).bind(cutoff),
    env.DB.prepare(`DELETE FROM access_requests WHERE status = 'denied' AND decided_at < ?`).bind(cutoff)
  ]);
  console.log(
    JSON.stringify({
      event: "daily_prune",
      webhook_events_deleted: events?.meta.changes ?? 0,
      denied_requests_deleted: denied?.meta.changes ?? 0,
      cutoff
    })
  );
}

async function reconcileResource(
  env: Env,
  userId: number,
  resource: BackfillResource,
  token: string
): Promise<void> {
  const watermark = await getWatermark(env.DB, userId, resource);
  const start = watermark
    ? new Date(Date.parse(watermark) - WATERMARK_OVERLAP_MS).toISOString()
    : new Date(Date.now() - 7 * 86_400_000).toISOString();

  let nextToken: string | undefined;
  for (let pageNo = 0; pageNo < MAX_PAGES_PER_RUN; pageNo++) {
    const budget = await drawBudget(env, 1);
    if (!budget.ok) return; // out of budget: next run resumes from the watermark

    const params: CollectionParams = { start, nextToken, limit: 25 };
    const page: CollectionPage | null =
      resource === "cycle"
        ? await whoop.cycles(token, params)
        : resource === "sleep"
          ? await whoop.sleeps(token, params)
          : resource === "recovery"
            ? await whoop.recoveries(token, params)
            : await whoop.workouts(token, params);
    if (!page) return;

    for (const rec of page.records) {
      if (resource === "cycle") await upsertCycle(env.DB, userId, rec);
      else if (resource === "sleep") await upsertSleep(env.DB, userId, rec);
      else if (resource === "recovery") await upsertRecovery(env.DB, userId, rec);
      else await upsertWorkout(env.DB, userId, rec);
    }

    nextToken = page.next_token;
    if (!nextToken) break;
  }

  await setWatermark(env.DB, userId, resource, new Date().toISOString());
}

// Nightly: refresh every connected user's token so silent revocations surface
// here instead of as a failed webhook fetch days later.
export async function runTokenHealthCheck(env: Env): Promise<void> {
  const users = await env.DB.prepare(
    `SELECT whoop_user_id FROM users WHERE status='connected'`
  ).all<{ whoop_user_id: number }>();

  for (const { whoop_user_id: userId } of users.results) {
    try {
      const res = await getToken(env, userId);
      if (!res.ok && res.reason === "revoked") {
        await offboardUser(env, userId, { revokeUpstream: false });
      }
    } catch (err) {
      console.error(`token health check failed for user ${userId}`, err);
    }
  }
}
