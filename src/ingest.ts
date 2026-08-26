import type { Env, WebhookEventType } from "./types";

// Webhook ingest: verify, dedupe, enqueue, 204. WHOOP wants a 2XX within one
// second — no WHOOP API calls happen here, ever.

const EVENT_TYPES: ReadonlySet<string> = new Set([
  "workout.updated",
  "workout.deleted",
  "sleep.updated",
  "sleep.deleted",
  "recovery.updated",
  "recovery.deleted"
]);

const REPLAY_WINDOW_MS = 5 * 60_000;

async function verifySignature(secret: string, payload: string, signatureB64: string): Promise<boolean> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  let sigBytes: Uint8Array;
  try {
    sigBytes = Uint8Array.from(atob(signatureB64), (c) => c.charCodeAt(0));
  } catch {
    return false;
  }
  // crypto.subtle.verify is constant-time; never compare signature strings.
  return crypto.subtle.verify("HMAC", key, sigBytes, enc.encode(payload));
}

export async function handleWebhook(request: Request, env: Env): Promise<Response> {
  // Read the body text exactly once, before any parsing: the HMAC covers the
  // raw bytes.
  const raw = await request.text();
  const signature = request.headers.get("X-WHOOP-Signature");
  const timestamp = request.headers.get("X-WHOOP-Signature-Timestamp");
  if (!signature || !timestamp) return new Response("missing signature", { status: 401 });

  const tsMs = Number(timestamp);
  if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > REPLAY_WINDOW_MS) {
    return new Response("stale timestamp", { status: 401 });
  }

  if (!(await verifySignature(env.WHOOP_CLIENT_SECRET, timestamp + raw, signature))) {
    return new Response("bad signature", { status: 401 });
  }

  let event: { user_id?: unknown; id?: unknown; type?: unknown; trace_id?: unknown };
  try {
    event = JSON.parse(raw);
  } catch {
    return new Response("bad payload", { status: 400 });
  }

  const userId = Number(event.user_id);
  const type = String(event.type ?? "");
  const traceId = String(event.trace_id ?? "");
  const entityId = event.id as string | number;
  if (!Number.isFinite(userId) || !traceId || entityId === undefined) {
    return new Response("bad payload", { status: 400 });
  }
  // Unknown/new event types: acknowledge so WHOOP stops retrying, do nothing.
  if (!EVENT_TYPES.has(type)) return new Response(null, { status: 204 });

  const receivedAt = new Date().toISOString();
  // trace_id dedupe is mandatory: WHOOP retries 5x/hour and our 2XX can get
  // lost in transit. changes=0 means we already accepted this delivery.
  const result = await env.DB.prepare(
    `INSERT INTO webhook_events (trace_id, user_id, entity_id, type, received_at)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT(trace_id) DO NOTHING`
  )
    .bind(traceId, userId, String(entityId), type, receivedAt)
    .run();
  if ((result.meta.changes ?? 0) === 0) return new Response(null, { status: 204 });

  await env.EVENT_QUEUE.send({
    kind: "webhook",
    user_id: userId,
    id: entityId,
    type: type as WebhookEventType,
    trace_id: traceId,
    received_at: receivedAt
  });

  return new Response(null, { status: 204 });
}
