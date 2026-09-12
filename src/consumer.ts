import type { Env, QueueMsg } from "./types";
import { whoop, RateLimitedError, UnauthorizedError } from "./whoop/client";
import {
  upsertSleep,
  upsertWorkout,
  upsertRecovery,
  upsertCycle,
  tombstone
} from "./db/upserts";
import { offboardUser } from "./offboard";
import type { TokenResult } from "./do/token-manager";
import type { DrawResult, Lane } from "./do/rate-budget";

export function drawBudget(env: Env, n: number, lane: Lane = "bulk"): Promise<DrawResult> {
  const stub = env.RATE_BUDGET.get(env.RATE_BUDGET.idFromName("global"));
  return stub.draw(n, lane);
}

export function getToken(env: Env, userId: number): Promise<TokenResult> {
  const stub = env.TOKEN_MANAGER.get(env.TOKEN_MANAGER.idFromName(String(userId)));
  return stub.getAccessToken();
}

function entityOf(type: string): string {
  return type.split(".")[0] ?? type;
}

const MAX_DELAY_SECONDS = 86_400; // Queues cap

export async function handleQueueBatch(batch: MessageBatch<QueueMsg>, env: Env): Promise<void> {
  // Coalesce webhook events by (user, entity-kind, id), keeping only the
  // newest: WHOOP fires multiple .updated events as a sleep processes
  // overnight, and every coalesced duplicate is an API call saved.
  const survivors = new Map<string, Message<QueueMsg>>();
  const backfills: Message<QueueMsg>[] = [];

  for (const msg of batch.messages) {
    const body = msg.body;
    if (body.kind !== "webhook") {
      backfills.push(msg);
      continue;
    }
    const key = `${body.user_id}:${entityOf(body.type)}:${body.id}`;
    const prev = survivors.get(key);
    if (!prev) {
      survivors.set(key, msg);
    } else if ((prev.body as { received_at: string }).received_at <= body.received_at) {
      prev.ack();
      survivors.set(key, msg);
    } else {
      msg.ack();
    }
  }

  for (const msg of survivors.values()) await processWebhook(msg, env);
  for (const msg of backfills) await processBackfill(msg, env);
}

async function processWebhook(msg: Message<QueueMsg>, env: Env): Promise<void> {
  const body = msg.body;
  if (body.kind !== "webhook") return;
  const { user_id, id, type } = body;

  try {
    // Deletes cost no API call: tombstone and move on.
    if (type === "sleep.deleted") {
      await tombstone(env.DB, "sleeps", String(id));
      msg.ack();
      return;
    }
    if (type === "workout.deleted") {
      await tombstone(env.DB, "workouts", String(id));
      msg.ack();
      return;
    }
    if (type === "recovery.deleted") {
      // v2: recovery events carry the sleep UUID.
      await tombstone(env.DB, "recoveries", String(id));
      msg.ack();
      return;
    }

    const budget = await drawBudget(env, 1);
    if (!budget.ok) {
      msg.retry({ delaySeconds: Math.min(budget.retryAfterSeconds, MAX_DELAY_SECONDS) });
      return;
    }

    const tokenRes = await getToken(env, user_id);
    if (!tokenRes.ok) {
      if (tokenRes.reason === "revoked") await offboardUser(env, user_id, { revokeUpstream: false });
      msg.ack(); // retrying cannot fix a revoked user
      return;
    }
    const token = tokenRes.token;

    if (type === "sleep.updated") {
      const rec = await whoop.sleep(token, String(id));
      if (rec) await upsertSleep(env.DB, user_id, rec);
    } else if (type === "workout.updated") {
      const rec = await whoop.workout(token, String(id));
      if (rec) await upsertWorkout(env.DB, user_id, rec);
    } else if (type === "recovery.updated") {
      // v2 quirk: the event id is the *sleep* UUID, not a recovery id.
      // Resolve via the recovery collection (newest first) matching sleep_id.
      const page = await whoop.recoveries(token, { limit: 25 });
      const rec = page?.records.find((r) => r.sleep_id === String(id));
      if (rec) {
        await upsertRecovery(env.DB, user_id, rec);
        // Cycles have no webhooks of their own — piggybacking the cycle fetch
        // on recovery events is what keeps strain data current.
        const cycleId = rec.cycle_id as number | undefined;
        if (typeof cycleId === "number") {
          const cycleBudget = await drawBudget(env, 1);
          if (cycleBudget.ok) {
            const cycle = await whoop.cycle(token, cycleId);
            if (cycle) await upsertCycle(env.DB, user_id, cycle);
          }
        }
      } else {
        // Not in the 25 most recent: the 6h reconciliation closes this gap.
        console.warn(`recovery for sleep ${id} not found in recent collection (user ${user_id})`);
      }
    }

    msg.ack();
  } catch (err) {
    await handleProcessingError(err, msg, env, user_id);
  }
}

async function processBackfill(msg: Message<QueueMsg>, env: Env): Promise<void> {
  const body = msg.body;
  if (body.kind !== "backfill") return;
  const { user_id, resource, start, nextToken } = body;

  try {
    const budget = await drawBudget(env, 1);
    if (!budget.ok) {
      msg.retry({ delaySeconds: Math.min(budget.retryAfterSeconds, MAX_DELAY_SECONDS) });
      return;
    }

    const tokenRes = await getToken(env, user_id);
    if (!tokenRes.ok) {
      if (tokenRes.reason === "revoked") await offboardUser(env, user_id, { revokeUpstream: false });
      msg.ack();
      return;
    }
    const token = tokenRes.token;

    const params = { start, nextToken, limit: 25 };
    const page =
      resource === "cycle"
        ? await whoop.cycles(token, params)
        : resource === "sleep"
          ? await whoop.sleeps(token, params)
          : resource === "recovery"
            ? await whoop.recoveries(token, params)
            : await whoop.workouts(token, params);

    for (const rec of page?.records ?? []) {
      if (resource === "cycle") await upsertCycle(env.DB, user_id, rec);
      else if (resource === "sleep") await upsertSleep(env.DB, user_id, rec);
      else if (resource === "recovery") await upsertRecovery(env.DB, user_id, rec);
      else await upsertWorkout(env.DB, user_id, rec);
    }

    if (page?.next_token) {
      // Low priority: space pages out so backfill never bursts the budget.
      await env.EVENT_QUEUE.send(
        { kind: "backfill", user_id, resource, start, nextToken: page.next_token },
        { delaySeconds: 5 }
      );
    }
    msg.ack();
  } catch (err) {
    await handleProcessingError(err, msg, env, user_id);
  }
}

async function handleProcessingError(err: unknown, msg: Message<QueueMsg>, env: Env, userId: number): Promise<void> {
  if (err instanceof RateLimitedError) {
    msg.retry({ delaySeconds: Math.min(err.resetSeconds + 1, MAX_DELAY_SECONDS) });
    return;
  }
  if (err instanceof UnauthorizedError) {
    // Token was valid moments ago but WHOOP rejected it: user revoked.
    await offboardUser(env, userId, { revokeUpstream: false });
    msg.ack();
    return;
  }
  console.error("queue processing error", err);
  msg.retry(); // exponential backoff via max_retries, then the DLQ
}
