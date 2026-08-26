-- WHOOP Relay D1 read model.
-- v2 ID semantics: cycles use INTEGER ids; sleeps/workouts use UUIDs. Never unify.
-- Every table carries user_id. raw JSON is stored alongside typed columns so
-- schema evolution never requires re-fetching from WHOOP.

CREATE TABLE IF NOT EXISTS users (
  whoop_user_id INTEGER PRIMARY KEY,
  name          TEXT,
  email         TEXT,
  status        TEXT NOT NULL DEFAULT 'connected', -- connected | disconnected
  connected_at  TEXT NOT NULL,                     -- ISO-8601
  disconnected_at TEXT
);

CREATE TABLE IF NOT EXISTS cycles (
  id         INTEGER PRIMARY KEY,                  -- WHOOP v2: integer cycle id
  user_id    INTEGER NOT NULL,
  start      TEXT,
  "end"      TEXT,                                 -- NULL while cycle is open
  strain     REAL,
  kilojoule  REAL,
  avg_heart_rate INTEGER,
  max_heart_rate INTEGER,
  score_state TEXT,
  deleted    INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  raw        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cycles_user_start ON cycles (user_id, start);

CREATE TABLE IF NOT EXISTS sleeps (
  id         TEXT PRIMARY KEY,                     -- WHOOP v2: UUID
  user_id    INTEGER NOT NULL,
  start      TEXT,
  "end"      TEXT,
  nap        INTEGER,
  performance_pct REAL,
  respiratory_rate REAL,
  stage_light_ms INTEGER,
  stage_sws_ms   INTEGER,
  stage_rem_ms   INTEGER,
  stage_awake_ms INTEGER,
  score_state TEXT,
  deleted    INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  raw        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sleeps_user_start ON sleeps (user_id, start);

CREATE TABLE IF NOT EXISTS recoveries (
  sleep_id   TEXT PRIMARY KEY,                     -- v2: recovery is keyed by its sleep UUID
  user_id    INTEGER NOT NULL,
  cycle_id   INTEGER,
  score      REAL,
  hrv_rmssd_ms REAL,
  resting_heart_rate REAL,
  spo2_pct   REAL,
  skin_temp_c REAL,
  score_state TEXT,
  deleted    INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  raw        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recoveries_user ON recoveries (user_id, updated_at);

CREATE TABLE IF NOT EXISTS workouts (
  id         TEXT PRIMARY KEY,                     -- WHOOP v2: UUID
  user_id    INTEGER NOT NULL,
  start      TEXT,
  "end"      TEXT,
  sport_name TEXT,
  strain     REAL,
  kilojoule  REAL,
  avg_heart_rate INTEGER,
  max_heart_rate INTEGER,
  zone_zero_ms INTEGER,
  zone_one_ms  INTEGER,
  zone_two_ms  INTEGER,
  zone_three_ms INTEGER,
  zone_four_ms INTEGER,
  zone_five_ms INTEGER,
  score_state TEXT,
  deleted    INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  raw        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workouts_user_start ON workouts (user_id, start);

CREATE TABLE IF NOT EXISTS body_measurements (
  user_id    INTEGER PRIMARY KEY,
  height_m   REAL,
  weight_kg  REAL,
  max_heart_rate INTEGER,
  updated_at TEXT NOT NULL,
  raw        TEXT NOT NULL
);

-- Webhook dedupe + audit. WHOOP retries 5x/hour; trace_id makes redelivery a no-op.
CREATE TABLE IF NOT EXISTS webhook_events (
  trace_id    TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  entity_id   TEXT NOT NULL,
  type        TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webhook_events_received ON webhook_events (received_at);

-- Per-user, per-resource reconciliation watermarks.
CREATE TABLE IF NOT EXISTS sync_state (
  user_id   INTEGER NOT NULL,
  resource  TEXT NOT NULL,                         -- cycle | sleep | recovery | workout
  watermark TEXT,                                  -- ISO-8601 updated_at high-water mark
  synced_at TEXT,
  PRIMARY KEY (user_id, resource)
);
