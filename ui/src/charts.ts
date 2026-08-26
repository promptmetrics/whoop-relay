import {
  Chart,
  BarController,
  LineController,
  ScatterController,
  CategoryScale,
  LinearScale,
  BarElement,
  LineElement,
  PointElement,
  Tooltip,
  Legend
} from "chart.js";
import type { RecoveryDay, SleepDay, StrainDay, WorkoutRow } from "../../src/mcp/dashboard-types";

Chart.register(
  BarController,
  LineController,
  ScatterController,
  CategoryScale,
  LinearScale,
  BarElement,
  LineElement,
  PointElement,
  Tooltip,
  Legend
);

// Chart.js reads concrete colors, not CSS vars — resolve tokens at render time
// and re-render on theme change (main.ts listens to prefers-color-scheme).
function token(name: string): string {
  const root = document.querySelector(".viz-root");
  return getComputedStyle(root as Element).getPropertyValue(name).trim();
}

const live: Chart[] = [];

export function destroyCharts(): void {
  for (const c of live.splice(0)) c.destroy();
}

function canvas(id: string): HTMLCanvasElement | null {
  return document.getElementById(id) as HTMLCanvasElement | null;
}

function baseOptions() {
  const muted = token("--text-muted");
  const grid = token("--grid");
  Chart.defaults.font.family = 'system-ui, -apple-system, "Segoe UI", sans-serif';
  Chart.defaults.font.size = 11;
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false as const,
    interaction: { mode: "index" as const, intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: token("--surface-1"),
        titleColor: token("--text-primary"),
        bodyColor: token("--text-secondary"),
        borderColor: token("--border"),
        borderWidth: 1
      }
    },
    scales: {
      x: {
        grid: { display: false },
        border: { color: token("--baseline") },
        ticks: { color: muted, maxTicksLimit: 10, maxRotation: 0 }
      },
      y: {
        grid: { color: grid },
        border: { display: false },
        ticks: { color: muted, maxTicksLimit: 5 }
      }
    }
  };
}

function rolling(values: (number | null)[], window: number): (number | null)[] {
  return values.map((_, i) => {
    const slice = values.slice(Math.max(0, i - window + 1), i + 1).filter((v): v is number => v != null);
    return slice.length ? slice.reduce((a, b) => a + b, 0) / slice.length : null;
  });
}

function shortDay(day: string): string {
  return day.length === 10 ? day.slice(5) : day; // 2026-08-01 -> 08-01
}

const BAND = {
  good: { min: 67, label: "Green (≥67)" },
  warning: { min: 34, label: "Yellow (34–66)" },
  critical: { min: 0, label: "Red (<34)" }
} as const;

export function bandColor(score: number | null): string {
  if (score == null) return token("--grid");
  if (score >= BAND.good.min) return token("--status-good");
  if (score >= BAND.warning.min) return token("--status-warning");
  return token("--status-critical");
}

export function renderRecoveryChart(rows: RecoveryDay[]): void {
  const el = canvas("chart-recovery");
  if (!el) return;
  const scores = rows.map((r) => r.recovery);
  const opts = baseOptions();
  live.push(
    new Chart(el, {
      data: {
        labels: rows.map((r) => shortDay(r.day)),
        datasets: [
          {
            type: "line",
            label: "7-day average",
            data: rolling(scores, 7),
            borderColor: token("--text-primary"),
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 4,
            spanGaps: true,
            tension: 0.3
          },
          {
            type: "bar",
            label: "Recovery",
            data: scores,
            backgroundColor: scores.map(bandColor),
            borderRadius: 4,
            borderSkipped: "bottom" as const,
            maxBarThickness: 18
          }
        ]
      },
      options: {
        ...opts,
        scales: { ...opts.scales, y: { ...opts.scales.y, min: 0, max: 100 } },
        plugins: {
          ...opts.plugins,
          legend: {
            display: true,
            position: "bottom",
            labels: {
              color: token("--text-secondary"),
              boxWidth: 10,
              boxHeight: 10,
              generateLabels: () => [
                { text: BAND.good.label, fillStyle: token("--status-good"), strokeStyle: "transparent" },
                { text: BAND.warning.label, fillStyle: token("--status-warning"), strokeStyle: "transparent" },
                { text: BAND.critical.label, fillStyle: token("--status-critical"), strokeStyle: "transparent" },
                { text: "7-day average", fillStyle: token("--text-primary"), strokeStyle: "transparent" }
              ]
            }
          }
        }
      }
    })
  );
}

export function renderMetricLine(
  canvasId: string,
  rows: { day: string; value: number | null }[],
  label: string,
  colorToken: string
): void {
  const el = canvas(canvasId);
  if (!el) return;
  const color = token(colorToken);
  const opts = baseOptions();
  live.push(
    new Chart(el, {
      type: "line",
      data: {
        labels: rows.map((r) => shortDay(r.day)),
        datasets: [
          {
            label,
            data: rows.map((r) => r.value),
            borderColor: color,
            backgroundColor: color,
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 4,
            spanGaps: true,
            tension: 0.3
          }
        ]
      },
      options: {
        ...opts,
        scales: {
          ...opts.scales,
          y: { ...opts.scales.y, title: { display: true, text: label, color: token("--text-muted") } }
        }
      }
    })
  );
}

const STAGES = [
  { key: "sws_ms", label: "Deep (SWS)", token: "--series-1" },
  { key: "rem_ms", label: "REM", token: "--series-2" },
  { key: "light_ms", label: "Light", token: "--series-3" },
  { key: "awake_ms", label: "Awake", token: "--series-4" }
] as const;

export function renderSleepCharts(rows: SleepDay[]): void {
  const stagesEl = canvas("chart-sleep-stages");
  if (stagesEl) {
    const opts = baseOptions();
    live.push(
      new Chart(stagesEl, {
        type: "bar",
        data: {
          labels: rows.map((r) => shortDay(r.day)),
          datasets: STAGES.map((s) => ({
            label: s.label,
            data: rows.map((r) => (r[s.key] == null ? null : (r[s.key] as number) / 3_600_000)),
            backgroundColor: token(s.token),
            stack: "sleep",
            // 1px surface-colored border keeps stacked segments visually separated
            borderColor: token("--surface-1"),
            borderWidth: 1,
            maxBarThickness: 18
          }))
        },
        options: {
          ...opts,
          scales: {
            x: { ...opts.scales.x, stacked: true },
            y: {
              ...opts.scales.y,
              stacked: true,
              title: { display: true, text: "hours", color: token("--text-muted") }
            }
          },
          plugins: {
            ...opts.plugins,
            legend: {
              display: true,
              position: "bottom",
              labels: { color: token("--text-secondary"), boxWidth: 10, boxHeight: 10 }
            }
          }
        }
      })
    );
  }
  renderMetricLine(
    "chart-sleep-perf",
    rows.map((r) => ({ day: r.day, value: r.performance })),
    "Sleep performance %",
    "--series-1"
  );
}

export function renderStrainCharts(strain: StrainDay[], recovery: RecoveryDay[]): void {
  const byDay = new Map(recovery.map((r) => [r.day, r.recovery]));
  const days = strain.map((s) => s.day);
  // Recovery is scored the morning AFTER the strain day — shift by one slot.
  const nextRecovery = days.map((d, i) => {
    const next = days[i + 1];
    return next ? (byDay.get(next) ?? null) : null;
  });

  const strainEl = canvas("chart-strain");
  if (strainEl) {
    const opts = baseOptions();
    live.push(
      new Chart(strainEl, {
        type: "bar",
        data: {
          labels: days.map(shortDay),
          datasets: [
            {
              label: "Day strain",
              data: strain.map((s) => s.strain),
              backgroundColor: token("--series-1"),
              borderRadius: 4,
              borderSkipped: "bottom" as const,
              maxBarThickness: 18
            }
          ]
        },
        options: {
          ...opts,
          scales: {
            ...opts.scales,
            y: {
              ...opts.scales.y,
              min: 0,
              max: 21,
              title: { display: true, text: "Strain (0–21)", color: token("--text-muted") }
            }
          }
        }
      })
    );
  }

  renderMetricLine(
    "chart-next-recovery",
    days.map((d, i) => ({ day: d, value: nextRecovery[i] ?? null })),
    "Next-day recovery %",
    "--series-3"
  );

  const scatterEl = canvas("chart-strain-scatter");
  if (scatterEl) {
    const pts = strain
      .map((s, i) => ({ x: s.strain, y: nextRecovery[i], day: s.day }))
      .filter((p): p is { x: number; y: number; day: string } => p.x != null && p.y != null);
    const opts = baseOptions();
    live.push(
      new Chart(scatterEl, {
        type: "scatter",
        data: {
          datasets: [
            {
              label: "Strain vs next-day recovery",
              data: pts,
              backgroundColor: token("--series-1"),
              pointRadius: 4,
              pointHoverRadius: 6
            }
          ]
        },
        options: {
          ...opts,
          interaction: { mode: "nearest" as const, intersect: true },
          plugins: {
            ...opts.plugins,
            tooltip: {
              ...opts.plugins.tooltip,
              callbacks: {
                label: (ctx: { raw: unknown }) => {
                  const p = ctx.raw as { x: number; y: number; day: string };
                  return `${p.day}: strain ${p.x.toFixed(1)} → recovery ${Math.round(p.y)}%`;
                }
              }
            }
          },
          scales: {
            x: {
              ...opts.scales.x,
              type: "linear" as const,
              min: 0,
              max: 21,
              grid: { color: token("--grid") },
              title: { display: true, text: "Day strain", color: token("--text-muted") }
            },
            y: {
              ...opts.scales.y,
              min: 0,
              max: 100,
              title: { display: true, text: "Next-day recovery %", color: token("--text-muted") }
            }
          }
        }
      })
    );
  }
}

export function renderSportBars(workouts: WorkoutRow[]): void {
  const el = canvas("chart-sport-strain");
  if (!el) return;
  const bySport = new Map<string, number>();
  for (const w of workouts) {
    const sport = w.sport ?? "Unknown";
    bySport.set(sport, (bySport.get(sport) ?? 0) + (w.strain ?? 0));
  }
  const entries = [...bySport.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  const opts = baseOptions();
  live.push(
    new Chart(el, {
      type: "bar",
      data: {
        labels: entries.map(([sport]) => sport),
        datasets: [
          {
            label: "Total strain",
            data: entries.map(([, v]) => v),
            backgroundColor: token("--series-1"),
            borderRadius: 4,
            borderSkipped: "start" as const,
            maxBarThickness: 16
          }
        ]
      },
      options: {
        ...opts,
        indexAxis: "y" as const,
        interaction: { mode: "nearest" as const, intersect: true },
        scales: {
          x: {
            ...opts.scales.x,
            grid: { color: token("--grid") },
            title: { display: true, text: "Total strain in range", color: token("--text-muted") }
          },
          y: { ...opts.scales.y, grid: { display: false }, ticks: { color: token("--text-secondary") } }
        }
      }
    })
  );
}
