// Idempotent upserts keyed by resource ID. Webhooks are dirty flags, not
// data: events arrive unordered and duplicated, so every write here must be
// safe to apply in any order, any number of times.

type Rec = Record<string, unknown>;

const s = (v: unknown): string | null => (typeof v === "string" ? v : null);
const n = (v: unknown): number | null => (typeof v === "number" ? v : null);
const score = (r: Rec): Rec => (r.score as Rec) ?? {};

export async function upsertSleep(db: D1Database, userId: number, r: Rec): Promise<void> {
  const sc = score(r);
  const stages = (sc.stage_summary as Rec) ?? {};
  await db
    .prepare(
      `INSERT INTO sleeps (id, user_id, start, "end", nap, performance_pct, respiratory_rate,
         stage_light_ms, stage_sws_ms, stage_rem_ms, stage_awake_ms, score_state, deleted, updated_at, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         start=excluded.start, "end"=excluded."end", nap=excluded.nap,
         performance_pct=excluded.performance_pct, respiratory_rate=excluded.respiratory_rate,
         stage_light_ms=excluded.stage_light_ms, stage_sws_ms=excluded.stage_sws_ms,
         stage_rem_ms=excluded.stage_rem_ms, stage_awake_ms=excluded.stage_awake_ms,
         score_state=excluded.score_state, deleted=0, updated_at=excluded.updated_at, raw=excluded.raw`
    )
    .bind(
      s(r.id),
      userId,
      s(r.start),
      s(r.end),
      r.nap ? 1 : 0,
      n(sc.sleep_performance_percentage),
      n(sc.respiratory_rate),
      n(stages.total_light_sleep_time_milli),
      n(stages.total_slow_wave_sleep_time_milli),
      n(stages.total_rem_sleep_time_milli),
      n(stages.total_awake_time_milli),
      s(r.score_state),
      s(r.updated_at) ?? new Date().toISOString(),
      JSON.stringify(r)
    )
    .run();
}

export async function upsertWorkout(db: D1Database, userId: number, r: Rec): Promise<void> {
  const sc = score(r);
  const zones = (sc.zone_durations as Rec) ?? {};
  await db
    .prepare(
      `INSERT INTO workouts (id, user_id, start, "end", sport_name, strain, kilojoule,
         avg_heart_rate, max_heart_rate, zone_zero_ms, zone_one_ms, zone_two_ms, zone_three_ms,
         zone_four_ms, zone_five_ms, score_state, deleted, updated_at, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         start=excluded.start, "end"=excluded."end", sport_name=excluded.sport_name,
         strain=excluded.strain, kilojoule=excluded.kilojoule,
         avg_heart_rate=excluded.avg_heart_rate, max_heart_rate=excluded.max_heart_rate,
         zone_zero_ms=excluded.zone_zero_ms, zone_one_ms=excluded.zone_one_ms,
         zone_two_ms=excluded.zone_two_ms, zone_three_ms=excluded.zone_three_ms,
         zone_four_ms=excluded.zone_four_ms, zone_five_ms=excluded.zone_five_ms,
         score_state=excluded.score_state, deleted=0, updated_at=excluded.updated_at, raw=excluded.raw`
    )
    .bind(
      s(r.id),
      userId,
      s(r.start),
      s(r.end),
      s(r.sport_name),
      n(sc.strain),
      n(sc.kilojoule),
      n(sc.average_heart_rate),
      n(sc.max_heart_rate),
      n(zones.zone_zero_milli),
      n(zones.zone_one_milli),
      n(zones.zone_two_milli),
      n(zones.zone_three_milli),
      n(zones.zone_four_milli),
      n(zones.zone_five_milli),
      s(r.score_state),
      s(r.updated_at) ?? new Date().toISOString(),
      JSON.stringify(r)
    )
    .run();
}

export async function upsertRecovery(db: D1Database, userId: number, r: Rec): Promise<void> {
  const sc = score(r);
  await db
    .prepare(
      `INSERT INTO recoveries (sleep_id, user_id, cycle_id, score, hrv_rmssd_ms,
         resting_heart_rate, spo2_pct, skin_temp_c, score_state, deleted, updated_at, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(sleep_id) DO UPDATE SET
         cycle_id=excluded.cycle_id, score=excluded.score, hrv_rmssd_ms=excluded.hrv_rmssd_ms,
         resting_heart_rate=excluded.resting_heart_rate, spo2_pct=excluded.spo2_pct,
         skin_temp_c=excluded.skin_temp_c, score_state=excluded.score_state,
         deleted=0, updated_at=excluded.updated_at, raw=excluded.raw`
    )
    .bind(
      s(r.sleep_id),
      userId,
      n(r.cycle_id),
      n(sc.recovery_score),
      n(sc.hrv_rmssd_milli),
      n(sc.resting_heart_rate),
      n(sc.spo2_percentage),
      n(sc.skin_temp_celsius),
      s(r.score_state),
      s(r.updated_at) ?? new Date().toISOString(),
      JSON.stringify(r)
    )
    .run();
}

export async function upsertCycle(db: D1Database, userId: number, r: Rec): Promise<void> {
  const sc = score(r);
  await db
    .prepare(
      `INSERT INTO cycles (id, user_id, start, "end", strain, kilojoule,
         avg_heart_rate, max_heart_rate, score_state, deleted, updated_at, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         start=excluded.start, "end"=excluded."end", strain=excluded.strain,
         kilojoule=excluded.kilojoule, avg_heart_rate=excluded.avg_heart_rate,
         max_heart_rate=excluded.max_heart_rate, score_state=excluded.score_state,
         deleted=0, updated_at=excluded.updated_at, raw=excluded.raw`
    )
    .bind(
      n(r.id),
      userId,
      s(r.start),
      s(r.end),
      n(sc.strain),
      n(sc.kilojoule),
      n(sc.average_heart_rate),
      n(sc.max_heart_rate),
      s(r.score_state),
      s(r.updated_at) ?? new Date().toISOString(),
      JSON.stringify(r)
    )
    .run();
}

// .deleted events tombstone rather than remove: the row stays for audit and
// the tools filter on deleted=0. A sleep deletion cascades to its recovery
// upstream — WHOOP sends the matching recovery.deleted separately.
export async function tombstone(
  db: D1Database,
  table: "sleeps" | "workouts" | "recoveries" | "cycles",
  id: string | number
): Promise<void> {
  const idCol = table === "recoveries" ? "sleep_id" : "id";
  await db
    .prepare(`UPDATE ${table} SET deleted=1, updated_at=? WHERE ${idCol}=?`)
    .bind(new Date().toISOString(), id)
    .run();
}

export async function upsertUser(
  db: D1Database,
  profile: { user_id: number; first_name?: string; last_name?: string; email?: string }
): Promise<void> {
  const name = [profile.first_name, profile.last_name].filter(Boolean).join(" ") || null;
  await db
    .prepare(
      `INSERT INTO users (whoop_user_id, name, email, status, connected_at)
       VALUES (?, ?, ?, 'connected', ?)
       ON CONFLICT(whoop_user_id) DO UPDATE SET
         name=excluded.name, email=excluded.email, status='connected',
         connected_at=excluded.connected_at, disconnected_at=NULL`
    )
    .bind(profile.user_id, name, profile.email ?? null, new Date().toISOString())
    .run();
}

export async function upsertBodyMeasurement(db: D1Database, userId: number, r: Rec): Promise<void> {
  await db
    .prepare(
      `INSERT INTO body_measurements (user_id, height_m, weight_kg, max_heart_rate, updated_at, raw)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         height_m=excluded.height_m, weight_kg=excluded.weight_kg,
         max_heart_rate=excluded.max_heart_rate, updated_at=excluded.updated_at, raw=excluded.raw`
    )
    .bind(userId, n(r.height_meter), n(r.weight_kilogram), n(r.max_heart_rate), new Date().toISOString(), JSON.stringify(r))
    .run();
}

// A 401 from WHOOP means the user disconnected: stop processing and surface
// it in the tools instead of silently serving stale data.
export async function markUserDisconnected(db: D1Database, userId: number): Promise<void> {
  await db
    .prepare(`UPDATE users SET status='disconnected', disconnected_at=? WHERE whoop_user_id=?`)
    .bind(new Date().toISOString(), userId)
    .run();
}

export async function getWatermark(
  db: D1Database,
  userId: number,
  resource: string
): Promise<string | null> {
  const row = await db
    .prepare(`SELECT watermark FROM sync_state WHERE user_id=? AND resource=?`)
    .bind(userId, resource)
    .first<{ watermark: string | null }>();
  return row?.watermark ?? null;
}

export async function setWatermark(
  db: D1Database,
  userId: number,
  resource: string,
  watermark: string
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sync_state (user_id, resource, watermark, synced_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, resource) DO UPDATE SET watermark=excluded.watermark, synced_at=excluded.synced_at`
    )
    .bind(userId, resource, watermark, new Date().toISOString())
    .run();
}
