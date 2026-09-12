import "./style.css";
import { App } from "@modelcontextprotocol/ext-apps";
import type { DashboardPayload, PanelId, WorkoutRow } from "../../src/mcp/dashboard-types";
import { PANEL_IDS } from "../../src/mcp/dashboard-types";
import { dataByWhoop } from "../../src/whoop-brand";
import {
  destroyCharts,
  renderRecoveryChart,
  renderMetricLine,
  renderSleepCharts,
  renderStrainCharts,
  renderSportBars
} from "./charts";

// live = MCP App iframe; web = authenticated /dashboard page (range changes
// navigate via URL); static = saved/injected snapshot; demo = plain browser.
type Mode = "live" | "web" | "static" | "demo";

interface View {
  sport: string; // "" = all
  visible: Set<PanelId>;
  workoutSort: { key: keyof WorkoutRow; dir: 1 | -1 };
}

let payload: DashboardPayload | null = null;
let mode: Mode = "demo";
let app: App | null = null;
const view: View = { sport: "", visible: new Set(PANEL_IDS), workoutSort: { key: "start", dir: -1 } };

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

// ---------- formatting ----------

function fmt(n: number | null | undefined, digits = 0): string {
  return n == null ? "–" : n.toFixed(digits);
}

function relTime(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function duration(start: string, end: string | null): string {
  if (!end) return "–";
  const min = Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60_000);
  return min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min}m`;
}

// ---------- rendering ----------

const TILE_SPEC = [
  { key: "recovery", label: "Avg recovery", unit: "%", digits: 0, higherIsBetter: true },
  { key: "hrv", label: "Avg HRV", unit: "ms", digits: 1, higherIsBetter: true },
  { key: "rhr", label: "Avg resting HR", unit: "bpm", digits: 0, higherIsBetter: false },
  { key: "sleep_performance", label: "Avg sleep perf", unit: "%", digits: 0, higherIsBetter: true },
  { key: "strain", label: "Avg day strain", unit: "", digits: 1, higherIsBetter: null }
] as const;

function renderTiles(p: DashboardPayload): void {
  const box = $("tiles");
  box.innerHTML = "";
  for (const spec of TILE_SPEC) {
    const cur = p.stats.current[spec.key];
    const prev = p.stats.previous[spec.key];
    const tile = document.createElement("div");
    tile.className = "tile";
    let deltaHtml = "";
    if (cur != null && prev != null) {
      const d = cur - prev;
      const good = spec.higherIsBetter == null ? null : spec.higherIsBetter ? d >= 0 : d <= 0;
      const cls = good == null ? "" : good ? "up" : "down";
      const arrow = d >= 0 ? "▲" : "▼";
      deltaHtml = `<div class="delta ${cls}">${arrow} ${Math.abs(d).toFixed(spec.digits)} vs previous window</div>`;
    }
    tile.innerHTML =
      `<div class="label">${spec.label}</div>` +
      `<div class="value">${fmt(cur, spec.digits)}<span class="unit"> ${spec.unit}</span></div>` +
      deltaHtml;
    box.appendChild(tile);
  }
}

function buildTable(target: HTMLElement, headers: string[], rows: (string | number | null)[][]): void {
  const cells = (r: (string | number | null)[]) => r.map((c) => `<td>${c ?? "–"}</td>`).join("");
  target.innerHTML =
    `<table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead>` +
    `<tbody>${rows.map((r) => `<tr>${cells(r)}</tr>`).join("")}</tbody></table>`;
}

function filteredWorkouts(p: DashboardPayload): WorkoutRow[] {
  const rows = view.sport ? p.workouts.filter((w) => (w.sport ?? "") === view.sport) : [...p.workouts];
  const { key, dir } = view.workoutSort;
  return rows.sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (av == null) return 1;
    if (bv == null) return -1;
    return av < bv ? -dir : av > bv ? dir : 0;
  });
}

function renderWorkoutTable(p: DashboardPayload): void {
  const tbody = document.querySelector<HTMLTableSectionElement>("#workout-table tbody")!;
  tbody.innerHTML = filteredWorkouts(p)
    .map(
      (w) =>
        `<tr><td>${w.start.slice(0, 10)}</td><td>${w.sport ?? "–"}</td>` +
        `<td>${duration(w.start, w.end)}</td><td>${fmt(w.strain, 1)}</td>` +
        `<td>${fmt(w.kilojoule)}</td><td>${fmt(w.avg_hr)}</td></tr>`
    )
    .join("");
}

function renderFreshness(p: DashboardPayload): void {
  const el = $("freshness");
  const items = p.freshness.map((f) => {
    const stale = !f.synced_at || Date.now() - new Date(f.synced_at).getTime() > 24 * 3_600_000;
    return `<span class="${stale ? "stale" : ""}">${f.resource} synced ${relTime(f.synced_at)}</span>`;
  });
  items.push(`<span>strain lags real time — refreshed on recovery events and 6h reconciliation</span>`);
  el.innerHTML = items.join("");
}

function renderDataTables(p: DashboardPayload): void {
  buildTable(
    $("table-recovery"),
    ["Day", "Recovery %"],
    p.recovery.map((r) => [r.day, fmt(r.recovery)])
  );
  buildTable(
    $("table-hrv-rhr"),
    ["Day", "HRV ms", "RHR bpm"],
    p.recovery.map((r) => [r.day, fmt(r.hrv, 1), fmt(r.rhr)])
  );
  buildTable(
    $("table-sleep"),
    ["Day", "Perf %", "Deep h", "REM h", "Light h", "Awake h"],
    p.sleep.map((s) => [
      s.day,
      fmt(s.performance),
      fmt(s.sws_ms == null ? null : s.sws_ms / 3_600_000, 1),
      fmt(s.rem_ms == null ? null : s.rem_ms / 3_600_000, 1),
      fmt(s.light_ms == null ? null : s.light_ms / 3_600_000, 1),
      fmt(s.awake_ms == null ? null : s.awake_ms / 3_600_000, 1)
    ])
  );
  buildTable(
    $("table-strain"),
    ["Day", "Strain", "kJ"],
    p.strain.map((s) => [s.day, fmt(s.strain, 1), fmt(s.kilojoule)])
  );
}

function renderAll(): void {
  if (!payload) return;
  const p = payload;
  destroyCharts();

  $("range-label").textContent = `${p.range.start} → ${p.range.end}`;
  const badge = $("mode-badge");
  if (mode === "demo" || mode === "static") {
    badge.hidden = false;
    badge.textContent = mode === "demo" ? "demo data" : "snapshot";
  }
  $("logout-link").hidden = mode !== "web";
  // Privacy/support links and the disconnect button need the Worker origin,
  // which only the authenticated web page has (the in-chat iframe is sandboxed).
  $("footer-links").hidden = mode !== "web";
  $("disconnect-form").hidden = mode !== "web";

  for (const section of document.querySelectorAll<HTMLElement>("section[data-panel]")) {
    const id = section.dataset.panel as PanelId;
    section.hidden = !(p.panels.includes(id) && view.visible.has(id));
  }

  if (show("stats")) renderTiles(p);
  if (show("recovery")) renderRecoveryChart(p.recovery);
  if (show("hrv_rhr")) {
    // Recovery Blue: WHOOP's colour for recovery-related data without a valuation.
    renderMetricLine("chart-hrv", p.recovery.map((r) => ({ day: r.day, value: r.hrv })), "HRV rMSSD (ms)", "--whoop-recovery-blue");
    renderMetricLine("chart-rhr", p.recovery.map((r) => ({ day: r.day, value: r.rhr })), "Resting HR (bpm)", "--series-2");
  }
  if (show("sleep")) renderSleepCharts(p.sleep);
  if (show("strain_vs_recovery")) renderStrainCharts(p.strain, p.recovery);
  if (show("workouts")) {
    renderSportBars(filteredWorkouts(p));
    renderWorkoutTable(p);
  }
  renderDataTables(p);
  renderFreshness(p);

  function show(id: PanelId): boolean {
    return p.panels.includes(id) && view.visible.has(id);
  }
}

// ---------- filters ----------

const PANEL_LABELS: Record<PanelId, string> = {
  stats: "Stats",
  recovery: "Recovery",
  hrv_rhr: "HRV & RHR",
  sleep: "Sleep",
  strain_vs_recovery: "Strain vs recovery",
  workouts: "Workouts"
};

function setupFilterBar(): void {
  if (!payload) return;
  const p = payload;

  // Panel toggles — only for panels the payload includes
  const toggles = $("panel-toggles");
  toggles.innerHTML = "";
  for (const id of p.panels) {
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = view.visible.has(id);
    cb.addEventListener("change", () => {
      cb.checked ? view.visible.add(id) : view.visible.delete(id);
      renderAll();
    });
    label.append(cb, PANEL_LABELS[id]);
    toggles.appendChild(label);
  }

  // Sport filter — populated from the data
  const sportSel = $<HTMLSelectElement>("sport-filter");
  const sports = [...new Set(p.workouts.map((w) => w.sport).filter((s): s is string => !!s))].sort();
  sportSel.length = 1;
  for (const s of sports) sportSel.add(new Option(s, s));
  sportSel.value = view.sport;
  sportSel.onchange = () => {
    view.sport = sportSel.value;
    renderAll();
  };

  // Date range — live (callServerTool) and web (URL navigation) modes only;
  // a snapshot is frozen and demo has nothing to fetch.
  const presets = $("presets");
  const custom = $("customrange");
  if (mode !== "live" && mode !== "web") {
    presets.hidden = true;
    custom.hidden = true;
    return;
  }
  $<HTMLInputElement>("range-start").value = p.range.start;
  $<HTMLInputElement>("range-end").value = p.range.end;

  const applyRange = (start: string, end: string) => {
    if (mode === "web") {
      const params = new URLSearchParams({ start, end, granularity: p.range.granularity });
      location.search = params.toString();
    } else {
      void changeRange(start, end);
    }
  };

  for (const btn of presets.querySelectorAll("button")) {
    btn.onclick = () => {
      const days = Number(btn.dataset.days);
      const end = new Date();
      const start = new Date(end.getTime() - (days - 1) * 86_400_000);
      applyRange(start.toISOString().slice(0, 10), end.toISOString().slice(0, 10));
    };
  }
  $("range-apply").onclick = () => {
    const start = $<HTMLInputElement>("range-start").value;
    const end = $<HTMLInputElement>("range-end").value;
    if (start && end && start <= end) applyRange(start, end);
  };
}

function status(msg: string | null): void {
  const el = $("status-line");
  el.hidden = !msg;
  el.textContent = msg ?? "";
}

async function changeRange(start: string, end: string): Promise<void> {
  if (!app || !payload) return;
  status("Loading…");
  try {
    const result = await app.callServerTool({
      name: "show_dashboard",
      arguments: { start, end, panels: payload.panels }
    });
    if (result.isError) {
      status("Could not load that range — try again.");
      return;
    }
    payload = result.structuredContent as unknown as DashboardPayload;
    status(null);
    renderAll();
    setupFilterBar();
  } catch {
    status("Could not reach the server — showing the previous range.");
  }
}

// ---------- boot ----------

import { mockPayload } from "./mock";

function adopt(p: DashboardPayload, m: Mode): void {
  payload = p;
  mode = m;
  view.visible = new Set(p.panels);
  renderAll();
  setupFilterBar();
}

async function boot(): Promise<void> {
  // 1) Shared-snapshot mode: the share route injected the payload
  const snapEl = document.getElementById("snapshot");
  let snapshot: DashboardPayload | null = null;
  try {
    snapshot = snapEl?.textContent ? (JSON.parse(snapEl.textContent) as DashboardPayload | null) : null;
  } catch {
    snapshot = null;
  }
  if (snapshot && typeof snapshot === "object" && Array.isArray(snapshot.panels)) {
    adopt(snapshot, snapshot.web === true ? "web" : "static");
    return;
  }

  // 2) MCP App mode: rendered by a host in a sandboxed iframe
  try {
    app = new App({ name: "whoop-dashboard", version: "0.1.0" });
    app.ontoolresult = (result) => {
      const p = (result as { structuredContent?: unknown }).structuredContent as DashboardPayload | undefined;
      if (p && Array.isArray(p.panels)) adopt(p, "live");
    };
    await app.connect();
  } catch {
    // 3) Plain-browser preview: demo data
    app = null;
    adopt(mockPayload(), "demo");
  }
}

// Re-render charts when the theme flips (token values change)
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => renderAll());

// WHOOP brand guidelines: every surface showing WHOOP data says so. Rendered
// once, in every mode, including the in-chat iframe.
$("whoop-attr").innerHTML = dataByWhoop(100);

$<HTMLFormElement>("disconnect-form").addEventListener("submit", (e) => {
  const ok = confirm(
    "Disconnect WHOOP Relay from your WHOOP account and permanently delete every stored record?\n\n" +
      "This cannot be undone. You can reconnect later; that starts a new six-month import."
  );
  if (!ok) e.preventDefault();
});

void boot();
