import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";

// WHOOP limits are per APP, not per user: 100 req/min, 10,000 req/day.
// Caps below keep headroom under both. The bulk lane (queue consumer,
// reconciliation, backfill) stops at 8,500/day so the interactive lane
// (MCP sync_now) always has quota left; interactive stops at 9,500 total,
// leaving 500/day as a final buffer against clock skew and retries.
const MINUTE_CAP = 95;
const DAY_CAP_BULK = 8_500;
const DAY_CAP_TOTAL = 9_500;

export type Lane = "bulk" | "interactive";

export type DrawResult = { ok: true } | { ok: false; retryAfterSeconds: number };

interface BudgetState {
  minuteKey: number;
  minuteCount: number;
  dayKey: string;
  dayCount: number;
}

// Single global instance (idFromName("global")). Serializes all draws so one
// user's backfill can never starve everyone's webhook processing.
export class RateBudget extends DurableObject<Env> {
  async draw(n = 1, lane: Lane = "bulk"): Promise<DrawResult> {
    const now = Date.now();
    const minuteKey = Math.floor(now / 60_000);
    const dayKey = new Date(now).toISOString().slice(0, 10); // UTC day

    let state = (await this.ctx.storage.get<BudgetState>("state")) ?? {
      minuteKey,
      minuteCount: 0,
      dayKey,
      dayCount: 0
    };
    if (state.minuteKey !== minuteKey) {
      state = { ...state, minuteKey, minuteCount: 0 };
    }
    if (state.dayKey !== dayKey) {
      state = { ...state, dayKey, dayCount: 0 };
    }

    if (state.minuteCount + n > MINUTE_CAP) {
      const nextMinuteMs = (minuteKey + 1) * 60_000;
      return { ok: false, retryAfterSeconds: Math.ceil((nextMinuteMs - now) / 1000) + 1 };
    }

    const dayCap = lane === "interactive" ? DAY_CAP_TOTAL : DAY_CAP_BULK;
    if (state.dayCount + n > dayCap) {
      const nextUtcMidnight = Date.parse(dayKey + "T00:00:00.000Z") + 86_400_000;
      return { ok: false, retryAfterSeconds: Math.ceil((nextUtcMidnight - now) / 1000) + 1 };
    }

    state.minuteCount += n;
    state.dayCount += n;
    await this.ctx.storage.put("state", state);
    return { ok: true };
  }

  async stats(): Promise<BudgetState | undefined> {
    return this.ctx.storage.get<BudgetState>("state");
  }
}
