// Schema migrations, driven by PRAGMA user_version.
//
// The old app used CREATE TABLE IF NOT EXISTS, which silently does nothing when
// a table exists but has the wrong columns — so the schema could drift from the
// code and nothing would say so. Here each step runs exactly once, in order,
// inside a transaction, and the version is the receipt.
//
// Rules: never edit a shipped step; append a new one. Steps must be idempotent
// only in the sense that they run once — they may assume the previous step ran.

import type { Database } from "bun:sqlite";

export type Migration = { version: number; name: string; up: (db: Database) => void };

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "rebuild-baseline",
    up(db) {
      // ── Carried tables (shape must match prod exactly; the carry script does
      //    ATTACH + INSERT…SELECT into these) ──────────────────────────────
      db.run(`
        CREATE TABLE rinks (
          code        TEXT PRIMARY KEY,
          description TEXT,
          floor       TEXT
        )
      `);
      db.run(`
        CREATE TABLE points (
          rink_code TEXT NOT NULL,
          point_nbr INTEGER NOT NULL,
          grid_col  INTEGER NOT NULL,
          grid_row  INTEGER NOT NULL,
          PRIMARY KEY (rink_code, point_nbr)
        )
      `);
      db.run(`
        CREATE TABLE measurements (
          rink_code    TEXT NOT NULL,
          point_nbr    INTEGER NOT NULL,
          measure_date DATE NOT NULL,
          depth_in     REAL,
          temp_f       REAL,
          PRIMARY KEY (rink_code, point_nbr, measure_date)
        )
      `);
      db.run(`CREATE INDEX idx_measurements_date ON measurements(rink_code, measure_date)`);
      db.run(`
        CREATE TABLE weather (
          measure_date    DATE PRIMARY KEY,
          temp_high_f     REAL,
          temp_low_f      REAL,
          temp_mean_f     REAL,
          precip_in       REAL,
          snow_in         REAL,
          wind_mph_max    REAL,
          cloud_cover_pct REAL,
          weather_code    INTEGER,
          source          TEXT
        )
      `);

      // ── Identity ──────────────────────────────────────────────────────
      // Everyone types. PIN guards admin only, and is NULL for ordinary crew —
      // claiming a card must be one tap, never a login.
      db.run(`
        CREATE TABLE members (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          name       TEXT NOT NULL UNIQUE,
          role       TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin')),
          pin_hash   TEXT,
          active     INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL
        )
      `);

      // ── The board ─────────────────────────────────────────────────────
      // One card type. A problem is an unclaimed card; a project is a claimed
      // one. status walks noticed → doing → done. Declared before
      // maintenance_log because that table's spawned_card_id points here.
      db.run(`
        CREATE TABLE cards (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          title       TEXT NOT NULL,
          body        TEXT,
          severity    INTEGER NOT NULL DEFAULT 1 CHECK (severity BETWEEN 1 AND 3),
          status      TEXT NOT NULL DEFAULT 'noticed' CHECK (status IN ('noticed','doing','done')),
          rink_code   TEXT,
          created_by  TEXT NOT NULL,
          created_at  INTEGER NOT NULL,
          claimed_by  TEXT,
          claimed_at  INTEGER,
          due_kind    TEXT NOT NULL DEFAULT 'none' CHECK (due_kind IN ('none','at','before')),
          due_at      INTEGER,
          due_text    TEXT,
          done_at     INTEGER,
          done_by     TEXT,
          archived_at INTEGER
        )
      `);
      db.run(`CREATE INDEX idx_cards_status ON cards(status, archived_at)`);

      db.run(`
        CREATE TABLE card_photos (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          card_id    INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
          path       TEXT NOT NULL,
          thumb_path TEXT NOT NULL,
          width      INTEGER,
          height     INTEGER,
          added_by   TEXT NOT NULL,
          added_at   INTEGER NOT NULL
        )
      `);
      db.run(`CREATE INDEX idx_card_photos_card ON card_photos(card_id)`);

      // ── Machines + maintenance ────────────────────────────────────────
      db.run(`
        CREATE TABLE machines (
          id        INTEGER PRIMARY KEY AUTOINCREMENT,
          code      TEXT NOT NULL UNIQUE,
          name      TEXT NOT NULL,
          rink_code TEXT NOT NULL,
          sort      INTEGER NOT NULL DEFAULT 0
        )
      `);

      // Ticker state is DERIVED from the latest maintenance_log row plus the
      // nudge columns. No last_done_at column here on purpose — a stored copy
      // is a dual write, and dual writes drift.
      db.run(`
        CREATE TABLE tickers (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          machine_id    INTEGER REFERENCES machines(id) ON DELETE CASCADE,
          kind          TEXT NOT NULL,
          label         TEXT NOT NULL,
          interval_days INTEGER,
          nudged_at     INTEGER,
          nudged_by     TEXT,
          sort          INTEGER NOT NULL DEFAULT 0,
          active        INTEGER NOT NULL DEFAULT 1
        )
      `);
      db.run(`CREATE UNIQUE INDEX idx_tickers_machine_kind ON tickers(IFNULL(machine_id,-1), kind)`);

      db.run(`
        CREATE TABLE maintenance_log (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          ticker_id       INTEGER NOT NULL REFERENCES tickers(id) ON DELETE CASCADE,
          done_by         TEXT NOT NULL,
          done_at         INTEGER NOT NULL,
          outcome         TEXT NOT NULL CHECK (outcome IN ('went_well','had_issues','something_wrong')),
          notes           TEXT,
          spawned_card_id INTEGER REFERENCES cards(id) ON DELETE SET NULL
        )
      `);
      db.run(`CREATE INDEX idx_maint_ticker ON maintenance_log(ticker_id, done_at DESC)`);

      // Propane is time-since only — two machines, each with L/R tanks, each
      // with its own swap history. No deadline, ever.
      db.run(`
        CREATE TABLE propane_swaps (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          machine_id INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
          side       TEXT NOT NULL CHECK (side IN ('L','R')),
          swapped_by TEXT NOT NULL,
          swapped_at INTEGER NOT NULL,
          notes      TEXT
        )
      `);
      db.run(`CREATE INDEX idx_propane_machine ON propane_swaps(machine_id, side, swapped_at DESC)`);

      // ── Edger ─────────────────────────────────────────────────────────
      // coverage is JSON: {"mode":"dots","dots":[n,…]} or
      // {"mode":"path","path":[[x,y],…]} in rink feet. Two input modes, one row
      // shape, so history reads the same either way.
      db.run(`
        CREATE TABLE edger_runs (
          id        INTEGER PRIMARY KEY AUTOINCREMENT,
          rink_code TEXT NOT NULL,
          run_by    TEXT NOT NULL,
          run_at    INTEGER NOT NULL,
          laps      INTEGER,
          coverage  TEXT,
          notes     TEXT
        )
      `);
      db.run(`CREATE INDEX idx_edger_at ON edger_runs(run_at DESC)`);

      // ── Pulled ice-cut schedule ───────────────────────────────────────
      db.run(`
        CREATE TABLE schedule (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          source     TEXT NOT NULL,
          rink_code  TEXT,
          starts_at  INTEGER NOT NULL,
          ends_at    INTEGER,
          title      TEXT,
          kind       TEXT,
          ext_id     TEXT,
          pulled_at  INTEGER NOT NULL,
          UNIQUE (source, ext_id)
        )
      `);
      db.run(`CREATE INDEX idx_schedule_start ON schedule(starts_at)`);

      // ── Infrastructure ────────────────────────────────────────────────
      db.run(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER)`);

      // Cron health. The weather backfill died 2026-05-05 and nothing noticed
      // for ten sessions; a job that cannot report its last run is a job that
      // dies quietly.
      db.run(`
        CREATE TABLE job_runs (
          id        INTEGER PRIMARY KEY AUTOINCREMENT,
          job       TEXT NOT NULL,
          ran_at    INTEGER NOT NULL,
          ok        INTEGER NOT NULL,
          detail    TEXT,
          duration_ms INTEGER
        )
      `);
      db.run(`CREATE INDEX idx_job_runs ON job_runs(job, ran_at DESC)`);

      db.run(`
        CREATE TABLE audit_log (
          id        INTEGER PRIMARY KEY AUTOINCREMENT,
          actor     TEXT,
          action    TEXT NOT NULL,
          target    TEXT,
          detail    TEXT,
          at        INTEGER NOT NULL
        )
      `);
      db.run(`CREATE INDEX idx_audit_at ON audit_log(at DESC)`);

      db.run(`
        CREATE TABLE idempotency_keys (
          key      TEXT PRIMARY KEY,
          response TEXT NOT NULL,
          at       INTEGER NOT NULL
        )
      `);

      // ── The feed is a VIEW ────────────────────────────────────────────
      // No events table, no dual write. "Since you were here" is a per-device
      // last-seen timestamp compared against this query.
      db.run(`
        CREATE VIEW feed AS
          SELECT 'card_created' AS kind, c.id AS ref_id, c.created_at AS at,
                 c.created_by AS actor, c.title AS summary, c.severity AS severity,
                 c.rink_code AS rink_code
            FROM cards c WHERE c.archived_at IS NULL
          UNION ALL
          SELECT 'card_claimed', c.id, c.claimed_at, c.claimed_by, c.title, c.severity, c.rink_code
            FROM cards c WHERE c.claimed_at IS NOT NULL AND c.archived_at IS NULL
          UNION ALL
          SELECT 'card_done', c.id, c.done_at, c.done_by, c.title, c.severity, c.rink_code
            FROM cards c WHERE c.done_at IS NOT NULL AND c.archived_at IS NULL
          UNION ALL
          SELECT 'maintenance', m.id, m.done_at, m.done_by,
                 t.label || ' — ' || REPLACE(m.outcome,'_',' '), 1, NULL
            FROM maintenance_log m JOIN tickers t ON t.id = m.ticker_id
          UNION ALL
          SELECT 'propane', p.id, p.swapped_at, p.swapped_by,
                 mc.name || ' ' || p.side || ' tank swapped', 1, mc.rink_code
            FROM propane_swaps p JOIN machines mc ON mc.id = p.machine_id
          UNION ALL
          SELECT 'edger', e.id, e.run_at, e.run_by,
                 'edger run' || IIF(e.laps IS NULL,'',' — ' || e.laps || ' laps'), 1, e.rink_code
            FROM edger_runs e
          UNION ALL
          SELECT 'nudge', t.id, t.nudged_at, t.nudged_by, t.label || ' nudged', 2, NULL
            FROM tickers t WHERE t.nudged_at IS NOT NULL
      `);

      // Ice sessions are feed-worthy too, but measurements are keyed by date
      // with no timestamp, so they enter the feed as a separate day-grained
      // view rather than being forced into the ms-grained UNION above.
      db.run(`
        CREATE VIEW ice_sessions AS
          SELECT rink_code, measure_date,
                 COUNT(*) FILTER (WHERE depth_in IS NOT NULL) AS depth_count,
                 COUNT(*) FILTER (WHERE temp_f   IS NOT NULL) AS temp_count,
                 MIN(depth_in) AS min_depth,
                 AVG(depth_in) AS mean_depth
            FROM measurements
           GROUP BY rink_code, measure_date
      `);
    },
  },
];

export const TARGET_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

/** Applies every migration above the database's current user_version. */
export function migrate(db: Database, log: (m: string) => void = () => {}): number {
  const current = (db.query<{ user_version: number }, []>("PRAGMA user_version").get()!).user_version;
  const pending = MIGRATIONS.filter((m) => m.version > current).sort((a, b) => a.version - b.version);
  if (pending.length === 0) return current;

  for (const m of pending) {
    // PRAGMA user_version cannot be parameterised, hence the interpolation —
    // m.version is a literal from this file, never user input.
    db.transaction(() => {
      m.up(db);
      db.run(`PRAGMA user_version = ${m.version}`);
    })();
    log(`migrated to v${m.version} (${m.name})`);
  }
  return TARGET_VERSION;
}
