// Rink Tracker — shared database instance + schema bootstrap.
//
// Single SQLite file (WAL mode) shared across all routes. Schema is bootstrapped
// idempotently on boot via CREATE TABLE IF NOT EXISTS — no separate migration
// runner. Existing tables from the legacy ice-tracker DB (rinks, points,
// measurements, weather, idempotency_keys) are picked up as-is.

import { Database } from "bun:sqlite";
import { join } from "node:path";

export const ROOT = join(import.meta.dir, "..");
export const DB_PATH = join(ROOT, "data", "rink.db");
export const PUBLIC = join(ROOT, "public");

export const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

// ──────────────────────────────────────────────────────────────────────
// Legacy schema (ported from ice-tracker; idempotent on existing DB)
// ──────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS rinks (
    code        TEXT PRIMARY KEY,
    description TEXT,
    floor       TEXT
  );
  CREATE TABLE IF NOT EXISTS points (
    rink_code  TEXT NOT NULL,
    point_nbr  INTEGER NOT NULL,
    grid_col   INTEGER NOT NULL,
    grid_row   INTEGER NOT NULL,
    PRIMARY KEY (rink_code, point_nbr)
  );
  CREATE TABLE IF NOT EXISTS measurements (
    rink_code     TEXT NOT NULL,
    point_nbr     INTEGER NOT NULL,
    measure_date  DATE NOT NULL,
    depth_in      REAL,
    temp_f        REAL,
    PRIMARY KEY (rink_code, point_nbr, measure_date)
  );
  CREATE INDEX IF NOT EXISTS idx_measurements_date  ON measurements(measure_date);
  CREATE INDEX IF NOT EXISTS idx_measurements_point ON measurements(rink_code, point_nbr);
  CREATE TABLE IF NOT EXISTS weather (
    measure_date     DATE PRIMARY KEY,
    temp_high_f      REAL,
    temp_low_f       REAL,
    temp_mean_f      REAL,
    precip_in        REAL,
    snow_in          REAL,
    wind_mph_max     REAL,
    cloud_cover_pct  REAL,
    weather_code     INTEGER,
    source           TEXT
  );
  CREATE TABLE IF NOT EXISTS idempotency_keys (
    key         TEXT PRIMARY KEY,
    response    TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
`);

// ──────────────────────────────────────────────────────────────────────
// AIO schema — auth + audit (used by all routes)
// ──────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    role        TEXT NOT NULL CHECK(role IN ('member','admin')) DEFAULT 'member',
    pin_hash    TEXT,
    created_at  INTEGER NOT NULL,
    active      INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
  CREATE TABLE IF NOT EXISTS audit_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER,
    action       TEXT NOT NULL,
    target_table TEXT,
    target_id    TEXT,
    payload      TEXT,
    at           INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_audit_at   ON audit_log(at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, at DESC);
`);

// Idempotency dedupe — used by any POST that wants offline-retry safety.
// See public/shared/outbox.js for the client side.
export const qIdemGet = db.query<{ response: string }, [string]>(
  `SELECT response FROM idempotency_keys WHERE key = $1`
);
export const qIdemPut = db.query(
  `INSERT OR IGNORE INTO idempotency_keys (key, response, created_at) VALUES ($key, $response, $now)`
);

// SW cache version — git short-sha if available, boot timestamp otherwise.
export const SW_VERSION = (() => {
  try {
    const p = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: ROOT });
    const sha = new TextDecoder().decode(p.stdout).trim();
    if (sha) return sha;
  } catch { /* fall through */ }
  return `t${Date.now().toString(36)}`;
})();

export const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
