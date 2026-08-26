import type { DashboardPayload, PanelId } from "../../src/mcp/dashboard-types";
import { PANEL_IDS } from "../../src/mcp/dashboard-types";

// Deterministic synthetic data so ui/dist/index.html is previewable in a plain
// browser (no MCP host, no snapshot). Never shown when real data is available.

const DAYS = 30;
const END = new Date("2026-08-26T00:00:00Z");
const SPORTS = ["Running", "Cycling", "Strength", "Padel"];

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function wave(i: number, base: number, amp: number, period: number, phase = 0): number {
  return base + amp * Math.sin((2 * Math.PI * (i + phase)) / period) + amp * 0.3 * Math.sin(i * 1.7);
}

export function mockPayload(): DashboardPayload {
  const days = Array.from({ length: DAYS }, (_, i) => {
    const d = new Date(END.getTime() - (DAYS - 1 - i) * 86_400_000);
    return iso(d);
  });

  const recovery = days.map((day, i) => ({
    day,
    recovery: Math.max(5, Math.min(99, Math.round(wave(i, 62, 22, 9)))),
    hrv: Math.round(wave(i, 68, 14, 9, 2) * 10) / 10,
    rhr: Math.round(wave(i, 54, 4, 11, 5))
  }));

  const sleep = days.map((day, i) => ({
    day,
    performance: Math.max(40, Math.min(100, Math.round(wave(i, 82, 12, 7, 1)))),
    light_ms: Math.round(wave(i, 3.9, 0.7, 6) * 3_600_000),
    sws_ms: Math.round(wave(i, 1.5, 0.4, 8, 3) * 3_600_000),
    rem_ms: Math.round(wave(i, 1.7, 0.5, 7, 5) * 3_600_000),
    awake_ms: Math.round(wave(i, 0.5, 0.2, 5) * 3_600_000)
  }));

  const strain = days.map((day, i) => ({
    day,
    strain: Math.max(2, Math.min(20.5, Math.round(wave(i, 11, 5, 9, 4) * 10) / 10)),
    kilojoule: Math.round(wave(i, 8500, 2500, 9, 4))
  }));

  const workouts = days
    .filter((_, i) => i % 2 === 0)
    .map((day, i) => {
      const startH = 7 + (i % 3) * 5;
      const durMin = 35 + (i * 13) % 50;
      const start = `${day}T${String(startH).padStart(2, "0")}:00:00.000Z`;
      const end = new Date(new Date(start).getTime() + durMin * 60_000).toISOString();
      return {
        start,
        end,
        sport: SPORTS[i % SPORTS.length]!,
        strain: Math.round(wave(i, 10, 4, 5) * 10) / 10,
        kilojoule: Math.round(wave(i, 2200, 800, 5)),
        avg_hr: Math.round(wave(i, 138, 15, 4))
      };
    });

  const avg = (xs: (number | null)[]) => {
    const v = xs.filter((x): x is number => x != null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };

  return {
    range: { start: days[0]!, end: days[DAYS - 1]!, granularity: "day" },
    panels: [...PANEL_IDS] as PanelId[],
    recovery,
    sleep,
    strain,
    workouts,
    stats: {
      current: {
        recovery: avg(recovery.map((r) => r.recovery)),
        hrv: avg(recovery.map((r) => r.hrv)),
        rhr: avg(recovery.map((r) => r.rhr)),
        sleep_performance: avg(sleep.map((s) => s.performance)),
        strain: avg(strain.map((s) => s.strain))
      },
      previous: { recovery: 58, hrv: 63.5, rhr: 55.2, sleep_performance: 78, strain: 12.1 }
    },
    freshness: [
      { resource: "recovery", synced_at: new Date(END.getTime() - 4 * 60_000).toISOString() },
      { resource: "sleep", synced_at: new Date(END.getTime() - 9 * 60_000).toISOString() },
      { resource: "cycle", synced_at: new Date(END.getTime() - 3 * 3_600_000).toISOString() },
      { resource: "workout", synced_at: new Date(END.getTime() - 40 * 60_000).toISOString() }
    ]
  };
}
