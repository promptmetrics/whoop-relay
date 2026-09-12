import type { TokenManager } from "./do/token-manager";
import type { RateBudget } from "./do/rate-budget";

export interface Env {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  EVENT_QUEUE: Queue<QueueMsg>;
  TOKEN_MANAGER: DurableObjectNamespace<TokenManager>;
  RATE_BUDGET: DurableObjectNamespace<RateBudget>;
  WHOOP_CLIENT_ID: string;
  WHOOP_CLIENT_SECRET: string;
  // HMAC key for /dashboard session cookies and both OAuth state params (wrangler secret)
  SESSION_SECRET: string;
  // AES-256-GCM key (base64, 32 bytes) sealing WHOOP tokens in the TokenManager DO (wrangler secret)
  TOKEN_ENCRYPTION_KEY: string;
  // Access-request notifications (wrangler.jsonc vars + secrets). Email is
  // best-effort: a missing key logs and skips, it never fails a request.
  RESEND_API_KEY?: string;
  EMAIL_FROM: string; // e.g. "WHOOP Relay <no-reply@mail.promptmetrics.dev>"
  ADMIN_EMAIL: string; // where access requests are announced
  // WHOOP user id allowed to open /admin (wrangler secret, optional until set)
  ADMIN_WHOOP_USER_ID?: string;
}

// WHOOP v2 webhook event types. Creates fire as .updated; there are no
// cycle/strain/body-measurement webhooks — those are polling-only.
export type WebhookEventType =
  | "workout.updated"
  | "workout.deleted"
  | "sleep.updated"
  | "sleep.deleted"
  | "recovery.updated"
  | "recovery.deleted";

export type BackfillResource = "cycle" | "sleep" | "recovery" | "workout";

export type QueueMsg =
  | {
      kind: "webhook";
      user_id: number;
      // cycles use integer ids; sleeps/workouts use UUIDs. recovery.* events
      // carry the *sleep* UUID, not a recovery id (v2 quirk).
      id: string | number;
      type: WebhookEventType;
      trace_id: string;
      received_at: string;
    }
  | {
      kind: "backfill";
      user_id: number;
      resource: BackfillResource;
      start: string;
      nextToken?: string;
    };

// Application props sealed into the MCP access token by workers-oauth-provider
// at consent time and surfaced as ctx.props on every /mcp request.
export interface SessionProps extends Record<string, unknown> {
  whoopUserId: number;
  name?: string;
}
