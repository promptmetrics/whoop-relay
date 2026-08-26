import { z } from "zod";
import type {
  DashboardPayload,
  FreshnessRow,
  RecoveryDay,
  SleepDay,
  StrainDay,
  WindowStats,
  WorkoutRow
} from "./dashboard-types";
import { PANEL_IDS } from "./dashboard-types";

// All dashboard reads come from D1 (zero WHOOP API quota), one db.batch()
// round trip. Same conventions as the other tools: user_id + deleted = 0 on
// every statement, "end" stays double-quoted, recoveries are dated via
// date(COALESCE(s."end", r.updated_at)).

const MAX_RANGE_DAYS = 366;
const DEFAULT_RANGE_DAYS = 30;

export interface DashboardArgs {
  start?: string;
  end?: string;
  granularity?: "day" | "week";
}

const day = (d: Date) => d.toISOString().slice(0, 10);

export function resolveRange(args: DashboardArgs): { start: string; end: string } {
  const end = args.end ?? day(new Date());
  const start = args.start ?? day(new Date(new Date(`${end}T00:00:00Z`).getTime() - (DEFAULT_RANGE_DAYS - 1) * 86_400_000));
  const clampedStart =
    new Date(`${end}T00:00:00Z`).getTime() - new Date(`${start}T00:00:00Z`).getTime() >
    MAX_RANGE_DAYS * 86_400_000
      ? day(new Date(new Date(`${end}T00:00:00Z`).getTime() - MAX_RANGE_DAYS * 86_400_000))
      : start;
  return { start: clampedStart, end };
}

function prevWindow(start: string, end: string): { start: string; end: string } {
  const s = new Date(`${start}T00:00:00Z`).getTime();
  const e = new Date(`${end}T00:00:00Z`).getTime();
  const len = e - s + 86_400_000;
  return { start: day(new Date(s - len)), end: day(new Date(s - 86_400_000)) };
}

export async function loadDashboardData(
  db: D1Database,
  uid: number,
  args: DashboardArgs
): Promise<Omit<DashboardPayload, "panels">> {
  const { start, end } = resolveRange(args);
  const granularity = args.granularity ?? "day";
  // Weekly granularity groups server-side so the UI never aggregates.
  const dayExprRecovery =
    granularity === "week"
      ? `strftime('%Y-W%W', COALESCE(s."end", r.updated_at))`
      : `date(COALESCE(s."end", r.updated_at))`;
  const dayExprSleep = granularity === "week" ? `strftime('%Y-W%W', "end")` : `date("end")`;
  const dayExprCycle = granularity === "week" ? `strftime('%Y-W%W', start)` : `date(start)`;
  const prev = prevWindow(start, end);

  const stmts = [
    db
      .prepare(
        `SELECT ${dayExprRecovery} AS day, avg(r.score) AS recovery,
                avg(r.hrv_rmssd_ms) AS hrv, avg(r.resting_heart_rate) AS rhr
         FROM recoveries r LEFT JOIN sleeps s ON s.id = r.sleep_id
         WHERE r.user_id = ?1 AND r.deleted = 0
           AND date(COALESCE(s."end", r.updated_at)) BETWEEN date(?2) AND date(?3)
         GROUP BY day ORDER BY day`
      )
      .bind(uid, start, end),
    db
      .prepare(
        `SELECT ${dayExprSleep} AS day, avg(performance_pct) AS performance,
                sum(stage_light_ms) AS light_ms, sum(stage_sws_ms) AS sws_ms,
                sum(stage_rem_ms) AS rem_ms, sum(stage_awake_ms) AS awake_ms
         FROM sleeps
         WHERE user_id = ?1 AND deleted = 0 AND nap = 0
           AND date("end") BETWEEN date(?2) AND date(?3)
         GROUP BY day ORDER BY day`
      )
      .bind(uid, start, end),
    db
      .prepare(
        `SELECT ${dayExprCycle} AS day, avg(strain) AS strain, sum(kilojoule) AS kilojoule
         FROM cycles
         WHERE user_id = ?1 AND deleted = 0 AND date(start) BETWEEN date(?2) AND date(?3)
         GROUP BY day ORDER BY day`
      )
      .bind(uid, start, end),
    db
      .prepare(
        `SELECT start, "end", sport_name AS sport, strain, kilojoule, avg_heart_rate AS avg_hr
         FROM workouts
         WHERE user_id = ?1 AND deleted = 0 AND date(start) BETWEEN date(?2) AND date(?3)
         ORDER BY start`
      )
      .bind(uid, start, end),
    db.prepare(`SELECT resource, synced_at FROM sync_state WHERE user_id = ?1`).bind(uid),
    db
      .prepare(
        `SELECT avg(r.score) AS recovery, avg(r.hrv_rmssd_ms) AS hrv, avg(r.resting_heart_rate) AS rhr
         FROM recoveries r LEFT JOIN sleeps s ON s.id = r.sleep_id
         WHERE r.user_id = ?1 AND r.deleted = 0
           AND date(COALESCE(s."end", r.updated_at)) BETWEEN date(?2) AND date(?3)`
      )
      .bind(uid, prev.start, prev.end),
    db
      .prepare(
        `SELECT avg(performance_pct) AS sleep_performance FROM sleeps
         WHERE user_id = ?1 AND deleted = 0 AND nap = 0 AND date("end") BETWEEN date(?2) AND date(?3)`
      )
      .bind(uid, prev.start, prev.end),
    db
      .prepare(
        `SELECT avg(strain) AS strain FROM cycles
         WHERE user_id = ?1 AND deleted = 0 AND date(start) BETWEEN date(?2) AND date(?3)`
      )
      .bind(uid, prev.start, prev.end)
  ];

  const [recoveryRes, sleepRes, strainRes, workoutRes, freshRes, prevRecRes, prevSleepRes, prevStrainRes] =
    await db.batch(stmts);

  const recovery = (recoveryRes!.results ?? []) as unknown as RecoveryDay[];
  const sleep = (sleepRes!.results ?? []) as unknown as SleepDay[];
  const strain = (strainRes!.results ?? []) as unknown as StrainDay[];
  const workouts = (workoutRes!.results ?? []) as unknown as WorkoutRow[];
  const freshness = (freshRes!.results ?? []) as unknown as FreshnessRow[];

  const avg = (xs: (number | null | undefined)[]): number | null => {
    const v = xs.filter((x): x is number => x != null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };

  const current: WindowStats = {
    recovery: avg(recovery.map((r) => r.recovery)),
    hrv: avg(recovery.map((r) => r.hrv)),
    rhr: avg(recovery.map((r) => r.rhr)),
    sleep_performance: avg(sleep.map((s) => s.performance)),
    strain: avg(strain.map((s) => s.strain))
  };
  const prevRec = (prevRecRes!.results?.[0] ?? {}) as Partial<WindowStats>;
  const prevSleep = (prevSleepRes!.results?.[0] ?? {}) as Partial<WindowStats>;
  const prevStrain = (prevStrainRes!.results?.[0] ?? {}) as Partial<WindowStats>;
  const previous: WindowStats = {
    recovery: prevRec.recovery ?? null,
    hrv: prevRec.hrv ?? null,
    rhr: prevRec.rhr ?? null,
    sleep_performance: prevSleep.sleep_performance ?? null,
    strain: prevStrain.strain ?? null
  };

  return {
    range: { start, end, granularity },
    recovery,
    sleep,
    strain,
    workouts,
    stats: { current, previous },
    freshness
  };
}

// The v2 SDK validates structuredContent against outputSchema — every metric
// that can be absent in D1 must be nullable here or tool calls fail.
const num = z.number().nullable();

export const dashboardPayloadSchema = z.object({
  range: z.object({ start: z.string(), end: z.string(), granularity: z.enum(["day", "week"]) }),
  panels: z.array(z.enum(PANEL_IDS)),
  recovery: z.array(z.object({ day: z.string(), recovery: num, hrv: num, rhr: num })),
  sleep: z.array(
    z.object({
      day: z.string(),
      performance: num,
      light_ms: num,
      sws_ms: num,
      rem_ms: num,
      awake_ms: num
    })
  ),
  strain: z.array(z.object({ day: z.string(), strain: num, kilojoule: num })),
  workouts: z.array(
    z.object({
      start: z.string(),
      end: z.string().nullable(),
      sport: z.string().nullable(),
      strain: num,
      kilojoule: num,
      avg_hr: num
    })
  ),
  stats: z.object({
    current: z.object({ recovery: num, hrv: num, rhr: num, sleep_performance: num, strain: num }),
    previous: z.object({ recovery: num, hrv: num, rhr: num, sleep_performance: num, strain: num })
  }),
  freshness: z.array(z.object({ resource: z.string(), synced_at: z.string().nullable() }))
});

const round = (n: number | null, d = 0): string =>
  n == null ? "n/a" : n.toFixed(d);

// Fallback for hosts that don't render MCP Apps (e.g. terminal clients):
// the text content must stand on its own.
export function summarize(p: DashboardPayload, origin?: string): string {
  const { current, previous } = p.stats;
  const delta = (c: number | null, pv: number | null, d = 0) =>
    c != null && pv != null ? ` (${c - pv >= 0 ? "+" : ""}${(c - pv).toFixed(d)} vs previous window)` : "";
  const lines = [
    `WHOOP dashboard ${p.range.start} → ${p.range.end} (${p.range.granularity} granularity), panels: ${p.panels.join(", ")}.`,
    `Avg recovery ${round(current.recovery)}%${delta(current.recovery, previous.recovery)}; ` +
      `HRV ${round(current.hrv, 1)} ms${delta(current.hrv, previous.hrv, 1)}; ` +
      `RHR ${round(current.rhr)} bpm${delta(current.rhr, previous.rhr)}; ` +
      `sleep performance ${round(current.sleep_performance)}%${delta(current.sleep_performance, previous.sleep_performance)}; ` +
      `day strain ${round(current.strain, 1)}${delta(current.strain, previous.strain, 1)}.`,
    `${p.recovery.length} recovery days, ${p.sleep.length} sleep days, ${p.workouts.length} workouts in range.`
  ];
  if (origin) {
    lines.push(
      `Live dashboard in a browser: ${origin}/dashboard — per-user, behind WHOOP login; nothing is published.`
    );
  }
  lines.push(
    "Hosts that support MCP Apps render this as an interactive dashboard; elsewhere, structuredContent carries chart-ready daily series."
  );
  return lines.join("\n");
}
