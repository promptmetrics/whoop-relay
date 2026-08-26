import { McpServer, inputRequired, acceptedContent } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Env, SessionProps } from "../types";
import { whoop } from "../whoop/client";
import { upsertRecovery, upsertCycle, upsertSleep, upsertWorkout } from "../db/upserts";
import { drawBudget, getToken } from "../consumer";
import { registerDashboard } from "./dashboard";

// D1-first is the payoff of the whole pipeline: trend questions become SQL
// instead of N paginated WHOOP calls, and answers cost zero API quota.
// Only sync_now touches the live API, through the interactive budget lane.

type Row = Record<string, unknown>;

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function defaultRange(): { start: string; end: string } {
  const end = new Date();
  const start = new Date(end.getTime() - 7 * 86_400_000);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

const rangeSchema = z.object({
  start: z.string().optional().describe("Start date, YYYY-MM-DD (inclusive). Default: 7 days ago."),
  end: z.string().optional().describe("End date, YYYY-MM-DD (inclusive). Default: today.")
});

export function buildServer(env: Env, props: SessionProps, origin: string): McpServer {
  const server = new McpServer(
    { name: "whoop-relay", version: "0.1.0" },
    {
      // 2026-07-28 list caching: the tool list is static and identical for
      // every user — cache it aggressively, publicly, in deterministic order.
      // Resources too: the only resource is the dashboard UI template, which
      // carries zero user data (per-user data arrives via tool results).
      cacheHints: {
        "tools/list": { ttlMs: 3_600_000, cacheScope: "public" },
        "resources/list": { ttlMs: 3_600_000, cacheScope: "public" },
        "resources/read": { ttlMs: 3_600_000, cacheScope: "public" }
      }
    }
  );

  const uid = props.whoopUserId;
  const db = env.DB;

  // show_dashboard tool + ui:// resource (MCP Apps, SEP-1865)
  registerDashboard(server, env, uid, origin);

  server.registerTool(
    "get_recovery",
    {
      title: "Get recovery scores",
      description:
        "Daily recovery scores (0-100), HRV, resting heart rate, SpO2 and skin temperature for a date range. Served from the local datastore, updated within seconds of WHOOP processing each night's sleep.",
      inputSchema: rangeSchema
    },
    async (args) => {
      const { start, end } = { ...defaultRange(), ...args };
      const rows = await db
        .prepare(
          `SELECT r.score, r.hrv_rmssd_ms, r.resting_heart_rate, r.spo2_pct, r.skin_temp_c,
                  r.score_state, r.cycle_id, s.start AS sleep_start, s."end" AS sleep_end
           FROM recoveries r LEFT JOIN sleeps s ON s.id = r.sleep_id
           WHERE r.user_id = ? AND r.deleted = 0
             AND date(COALESCE(s."end", r.updated_at)) BETWEEN date(?) AND date(?)
           ORDER BY COALESCE(s."end", r.updated_at) DESC`
        )
        .bind(uid, start, end)
        .all<Row>();
      return json({ start, end, recoveries: rows.results });
    }
  );

  server.registerTool(
    "get_sleep",
    {
      title: "Get sleep data",
      description:
        "Sleep sessions with stage breakdown (light/SWS/REM/awake, milliseconds), performance percentage and respiratory rate for a date range.",
      inputSchema: rangeSchema
    },
    async (args) => {
      const { start, end } = { ...defaultRange(), ...args };
      const rows = await db
        .prepare(
          `SELECT id, start, "end", nap, performance_pct, respiratory_rate,
                  stage_light_ms, stage_sws_ms, stage_rem_ms, stage_awake_ms, score_state
           FROM sleeps
           WHERE user_id = ? AND deleted = 0 AND date("end") BETWEEN date(?) AND date(?)
           ORDER BY start DESC`
        )
        .bind(uid, start, end)
        .all<Row>();
      return json({ start, end, sleeps: rows.results });
    }
  );

  server.registerTool(
    "get_workouts",
    {
      title: "Get workouts",
      description:
        "Workouts with sport, strain, energy (kJ) and heart-rate zone durations for a date range. Optionally filter by sport name.",
      inputSchema: rangeSchema.extend({
        sport: z.string().optional().describe("Filter by sport name (e.g. 'running').")
      })
    },
    async (args) => {
      const { start, end } = { ...defaultRange(), ...args };
      const sport = args.sport ?? null;
      const rows = await db
        .prepare(
          `SELECT id, start, "end", sport_name, strain, kilojoule, avg_heart_rate, max_heart_rate,
                  zone_zero_ms, zone_one_ms, zone_two_ms, zone_three_ms, zone_four_ms, zone_five_ms
           FROM workouts
           WHERE user_id = ? AND deleted = 0 AND date(start) BETWEEN date(?) AND date(?)
             AND (? IS NULL OR lower(sport_name) = lower(?))
           ORDER BY start DESC`
        )
        .bind(uid, start, end, sport, sport)
        .all<Row>();
      return json({ start, end, workouts: rows.results });
    }
  );

  server.registerTool(
    "get_strain",
    {
      title: "Get day strain",
      description:
        "Daily cycle strain (0-21) and energy expenditure for a date range. Note: WHOOP sends no webhooks for cycles, so strain lags real time — it refreshes when a recovery arrives, on the 6-hour reconciliation, or via sync_now. Treat intraday strain as approximate.",
      inputSchema: rangeSchema
    },
    async (args) => {
      const { start, end } = { ...defaultRange(), ...args };
      const rows = await db
        .prepare(
          `SELECT id, start, "end", strain, kilojoule, avg_heart_rate, max_heart_rate, score_state, updated_at
           FROM cycles
           WHERE user_id = ? AND deleted = 0 AND date(start) BETWEEN date(?) AND date(?)
           ORDER BY start DESC`
        )
        .bind(uid, start, end)
        .all<Row>();
      return json({ start, end, cycles: rows.results });
    }
  );

  server.registerTool(
    "get_profile",
    {
      title: "Get user profile",
      description: "The connected WHOOP user's name, email and body measurements.",
      inputSchema: z.object({})
    },
    async () => {
      const user = await db
        .prepare(`SELECT whoop_user_id, name, email, status, connected_at FROM users WHERE whoop_user_id = ?`)
        .bind(uid)
        .first<Row>();
      const body = await db
        .prepare(`SELECT height_m, weight_kg, max_heart_rate FROM body_measurements WHERE user_id = ?`)
        .bind(uid)
        .first<Row>();
      return json({ user, body_measurements: body });
    }
  );

  server.registerTool(
    "daily_report",
    {
      title: "Daily report",
      description:
        "Composed report for one day: recovery, sleep, day strain and workouts. Recovery and sleep are near-real-time; strain refreshes on recovery events, 6-hour reconciliation or sync_now, so intraday strain may lag.",
      inputSchema: z.object({
        date: z.string().optional().describe("The day, YYYY-MM-DD. Default: today (UTC).")
      })
    },
    async (args) => {
      const date = args.date ?? new Date().toISOString().slice(0, 10);
      const recovery = await db
        .prepare(
          `SELECT r.score, r.hrv_rmssd_ms, r.resting_heart_rate, r.spo2_pct, r.skin_temp_c, r.score_state
           FROM recoveries r LEFT JOIN sleeps s ON s.id = r.sleep_id
           WHERE r.user_id = ? AND r.deleted = 0 AND date(COALESCE(s."end", r.updated_at)) = date(?)
           ORDER BY r.updated_at DESC LIMIT 1`
        )
        .bind(uid, date)
        .first<Row>();
      const sleep = await db
        .prepare(
          `SELECT start, "end", performance_pct, respiratory_rate,
                  stage_light_ms, stage_sws_ms, stage_rem_ms, stage_awake_ms
           FROM sleeps
           WHERE user_id = ? AND deleted = 0 AND nap = 0 AND date("end") = date(?)
           ORDER BY "end" DESC LIMIT 1`
        )
        .bind(uid, date)
        .first<Row>();
      const cycle = await db
        .prepare(
          `SELECT strain, kilojoule, avg_heart_rate, max_heart_rate, updated_at
           FROM cycles WHERE user_id = ? AND deleted = 0 AND date(start) = date(?)
           ORDER BY start DESC LIMIT 1`
        )
        .bind(uid, date)
        .first<Row>();
      const workouts = await db
        .prepare(
          `SELECT sport_name, start, "end", strain, kilojoule FROM workouts
           WHERE user_id = ? AND deleted = 0 AND date(start) = date(?) ORDER BY start`
        )
        .bind(uid, date)
        .all<Row>();
      return json({
        date,
        recovery,
        sleep,
        strain: cycle,
        workouts: workouts.results,
        note: "Strain data may lag real time; call sync_now for the freshest cycle data."
      });
    }
  );

  server.registerTool(
    "trend",
    {
      title: "Metric trend",
      description:
        "Rolling trend for one metric over a window of days: daily values, window average, and delta between the two window halves. Computed in SQL from the local datastore — costs zero WHOOP API quota.",
      inputSchema: z.object({
        metric: z
          .enum(["hrv", "rhr", "recovery_score", "sleep_performance", "strain"])
          .describe("hrv = HRV rMSSD ms; rhr = resting heart rate; strain = day strain."),
        window_days: z.number().int().min(3).max(180).default(30)
      })
    },
    async (args) => {
      const since = new Date(Date.now() - args.window_days * 86_400_000).toISOString();
      const queries: Record<string, string> = {
        hrv: `SELECT date(COALESCE(s."end", r.updated_at)) AS day, avg(r.hrv_rmssd_ms) AS value
              FROM recoveries r LEFT JOIN sleeps s ON s.id = r.sleep_id
              WHERE r.user_id = ?1 AND r.deleted = 0 AND r.updated_at >= ?2 GROUP BY day ORDER BY day`,
        rhr: `SELECT date(COALESCE(s."end", r.updated_at)) AS day, avg(r.resting_heart_rate) AS value
              FROM recoveries r LEFT JOIN sleeps s ON s.id = r.sleep_id
              WHERE r.user_id = ?1 AND r.deleted = 0 AND r.updated_at >= ?2 GROUP BY day ORDER BY day`,
        recovery_score: `SELECT date(COALESCE(s."end", r.updated_at)) AS day, avg(r.score) AS value
              FROM recoveries r LEFT JOIN sleeps s ON s.id = r.sleep_id
              WHERE r.user_id = ?1 AND r.deleted = 0 AND r.updated_at >= ?2 GROUP BY day ORDER BY day`,
        sleep_performance: `SELECT date("end") AS day, avg(performance_pct) AS value
              FROM sleeps WHERE user_id = ?1 AND deleted = 0 AND nap = 0 AND "end" >= ?2
              GROUP BY day ORDER BY day`,
        strain: `SELECT date(start) AS day, avg(strain) AS value
              FROM cycles WHERE user_id = ?1 AND deleted = 0 AND start >= ?2 GROUP BY day ORDER BY day`
      };
      const rows = await db.prepare(queries[args.metric]!).bind(uid, since).all<{ day: string; value: number }>();
      const series = rows.results.filter((r) => r.value != null);
      const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
      const values = series.map((r) => r.value);
      const half = Math.floor(values.length / 2);
      const firstHalf = avg(values.slice(0, half));
      const secondHalf = avg(values.slice(half));
      return json({
        metric: args.metric,
        window_days: args.window_days,
        days_with_data: series.length,
        average: avg(values),
        first_half_avg: firstHalf,
        second_half_avg: secondHalf,
        delta: firstHalf != null && secondHalf != null ? secondHalf - firstHalf : null,
        series
      });
    }
  );

  server.registerTool(
    "sync_now",
    {
      title: "Sync now",
      description:
        "Force a live fetch from the WHOOP API (recovery, cycles, sleep or workouts) and refresh the local datastore. Budget-limited: WHOOP quota is shared across all users of this app. Use only when freshness genuinely matters — the other tools are near-real-time already.",
      inputSchema: z.object({
        resource: z.enum(["recovery", "cycle", "sleep", "workout", "all"]).default("all")
      })
    },
    async (args, ctx) => {
      const user = await db
        .prepare(`SELECT status FROM users WHERE whoop_user_id = ?`)
        .bind(uid)
        .first<{ status: string }>();
      if (user?.status !== "connected") {
        return json({
          error: "whoop_disconnected",
          message: "This WHOOP account is disconnected. Re-connect via the OAuth flow to resume syncing."
        });
      }

      const wanted = args.resource === "all" ? ["recovery", "cycle", "sleep", "workout"] : [args.resource];
      const calls = wanted.length;

      const budget = await drawBudget(env, calls, "interactive");
      if (!budget.ok) {
        // MRTR (spec 2026-07-28): instead of failing, ask the client whether
        // cached data is acceptable; it retries this call with the answer.
        const proceed = acceptedContent<{ proceed: boolean }>(
          (ctx as { mcpReq?: { inputResponses?: Record<string, unknown> } }).mcpReq?.inputResponses,
          "budget"
        );
        if (proceed?.proceed) {
          return json({
            stale: true,
            message: `WHOOP API budget exhausted (resets in ~${budget.retryAfterSeconds}s). Serving the latest cached data instead — use the read tools (get_recovery, get_strain, ...) as usual.`
          });
        }
        return inputRequired({
          inputRequests: {
            budget: inputRequired.elicit({
              message: `The shared WHOOP API budget is exhausted; it resets in ~${Math.ceil(
                budget.retryAfterSeconds / 60
              )} minutes. Proceed with the latest cached data instead?`,
              requestedSchema: {
                type: "object",
                properties: { proceed: { type: "boolean", description: "true = use cached data now" } },
                required: ["proceed"]
              }
            })
          }
        });
      }

      const tokenRes = await getToken(env, uid);
      if (!tokenRes.ok) {
        return json({
          error: "whoop_token_revoked",
          message: "WHOOP rejected this account's token — the user likely revoked access. Re-connect to resume."
        });
      }
      const token = tokenRes.token;
      const synced: Record<string, number> = {};

      for (const resource of wanted) {
        const params = { limit: 5 };
        if (resource === "recovery") {
          const page = await whoop.recoveries(token, params);
          for (const r of page?.records ?? []) await upsertRecovery(db, uid, r);
          synced.recovery = page?.records.length ?? 0;
        } else if (resource === "cycle") {
          const page = await whoop.cycles(token, params);
          for (const r of page?.records ?? []) await upsertCycle(db, uid, r);
          synced.cycle = page?.records.length ?? 0;
        } else if (resource === "sleep") {
          const page = await whoop.sleeps(token, params);
          for (const r of page?.records ?? []) await upsertSleep(db, uid, r);
          synced.sleep = page?.records.length ?? 0;
        } else {
          const page = await whoop.workouts(token, params);
          for (const r of page?.records ?? []) await upsertWorkout(db, uid, r);
          synced.workout = page?.records.length ?? 0;
        }
      }

      return json({ synced, message: "Datastore refreshed from the live WHOOP API." });
    }
  );

  return server;
}
