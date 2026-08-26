// Shared between the Worker (tool/payload) and the dashboard UI bundle
// (ui/src). Keep this file dependency-free — it is compiled into both.

export const PANEL_IDS = [
  "stats",
  "recovery",
  "hrv_rhr",
  "sleep",
  "strain_vs_recovery",
  "workouts"
] as const;

export type PanelId = (typeof PANEL_IDS)[number];

export interface RecoveryDay {
  day: string; // YYYY-MM-DD (or YYYY-Www at week granularity)
  recovery: number | null; // 0-100
  hrv: number | null; // rMSSD ms
  rhr: number | null; // bpm
}

export interface SleepDay {
  day: string;
  performance: number | null; // 0-100
  light_ms: number | null;
  sws_ms: number | null;
  rem_ms: number | null;
  awake_ms: number | null;
}

export interface StrainDay {
  day: string;
  strain: number | null; // 0-21
  kilojoule: number | null;
}

export interface WorkoutRow {
  start: string; // ISO-8601
  end: string | null;
  sport: string | null;
  strain: number | null;
  kilojoule: number | null;
  avg_hr: number | null;
}

export interface WindowStats {
  recovery: number | null;
  hrv: number | null;
  rhr: number | null;
  sleep_performance: number | null;
  strain: number | null;
}

export interface FreshnessRow {
  resource: string;
  synced_at: string | null; // ISO-8601
}

export interface DashboardPayload {
  range: { start: string; end: string; granularity: "day" | "week" };
  panels: PanelId[];
  recovery: RecoveryDay[];
  sleep: SleepDay[];
  strain: StrainDay[];
  workouts: WorkoutRow[];
  stats: { current: WindowStats; previous: WindowStats };
  freshness: FreshnessRow[];
  // Set only by the authenticated /dashboard page injection — switches the UI
  // into web mode (range controls navigate via URL query params).
  web?: boolean;
}
