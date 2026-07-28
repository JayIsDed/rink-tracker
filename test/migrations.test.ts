import { expect, test, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate, MIGRATIONS, TARGET_VERSION } from "../server/migrations";

function fresh(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  return db;
}

const version = (db: Database) =>
  (db.query<{ user_version: number }, []>("PRAGMA user_version").get()!).user_version;

describe("migration runner", () => {
  test("brings a blank database to the target version", () => {
    const db = fresh();
    expect(version(db)).toBe(0);
    expect(migrate(db)).toBe(TARGET_VERSION);
    expect(version(db)).toBe(TARGET_VERSION);
  });

  test("is a no-op the second time", () => {
    const db = fresh();
    migrate(db);
    const before = db.query("SELECT name FROM sqlite_master ORDER BY name").all();
    expect(migrate(db)).toBe(TARGET_VERSION);
    expect(db.query("SELECT name FROM sqlite_master ORDER BY name").all()).toEqual(before);
  });

  test("versions are unique and ascending", () => {
    const vs = MIGRATIONS.map((m) => m.version);
    expect(new Set(vs).size).toBe(vs.length);
    expect([...vs].sort((a, b) => a - b)).toEqual(vs);
  });

  test("creates every table the app needs", () => {
    const db = fresh();
    migrate(db);
    const names = new Set(
      db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
    );
    for (const t of [
      "rinks", "points", "measurements", "weather",
      "members", "machines", "tickers", "maintenance_log", "propane_swaps",
      "cards", "card_photos", "edger_runs", "schedule",
      "settings", "job_runs", "audit_log", "idempotency_keys",
    ]) {
      expect(names).toContain(t);
    }
  });

  test("the feed is a view, not a table — no dual write", () => {
    const db = fresh();
    migrate(db);
    const t = db.query<{ type: string }, [string]>("SELECT type FROM sqlite_master WHERE name = ?").get("feed");
    expect(t!.type).toBe("view");
    expect(
      db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='events'").all()
    ).toEqual([]);
  });
});

describe("schema v1 constraints", () => {
  let db: Database;
  beforeEach(() => {
    db = fresh();
    migrate(db);
    db.run(`INSERT INTO machines (code,name,rink_code,sort) VALUES ('546','Zamboni 546','U',0)`);
  });

  test("carried tables match the shape prod actually has", () => {
    // The carry does INSERT…SELECT by column name; a rename here breaks V1.
    const cols = (t: string) =>
      db.query<{ name: string }, []>(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    expect(cols("measurements")).toEqual(["rink_code", "point_nbr", "measure_date", "depth_in", "temp_f"]);
    expect(cols("points")).toEqual(["rink_code", "point_nbr", "grid_col", "grid_row"]);
    expect(cols("rinks")).toEqual(["code", "description", "floor"]);
    expect(cols("weather")).toContain("cloud_cover_pct");
  });

  test("card status and due_kind are constrained", () => {
    const ins = (status: string, due = "none") =>
      db.run(
        `INSERT INTO cards (title,status,due_kind,created_by,created_at) VALUES ('t',?,?,'jay',1)`,
        [status, due]
      );
    ins("noticed");
    ins("doing");
    ins("done");
    expect(() => ins("wontfix")).toThrow();
    expect(() => ins("noticed", "someday")).toThrow();
  });

  test("severity is limited to the three tiers", () => {
    const ins = (sev: number) =>
      db.run(`INSERT INTO cards (title,severity,created_by,created_at) VALUES ('t',?,'jay',1)`, [sev]);
    ins(1); ins(2); ins(3);
    expect(() => ins(0)).toThrow();
    expect(() => ins(4)).toThrow();
  });

  test("propane sides are only L and R", () => {
    const ins = (side: string) =>
      db.run(`INSERT INTO propane_swaps (machine_id,side,swapped_by,swapped_at) VALUES (1,?,'jay',1)`, [side]);
    ins("L"); ins("R");
    expect(() => ins("C")).toThrow();
  });

  test("maintenance outcome is the three ruled options", () => {
    db.run(`INSERT INTO tickers (machine_id,kind,label,interval_days) VALUES (1,'oil','Oil change',90)`);
    const ins = (o: string) =>
      db.run(`INSERT INTO maintenance_log (ticker_id,done_by,done_at,outcome) VALUES (1,'jay',1,?)`, [o]);
    ins("went_well"); ins("had_issues"); ins("something_wrong");
    expect(() => ins("ok")).toThrow();
  });

  test("a machine cannot hold two tickers of the same kind", () => {
    db.run(`INSERT INTO tickers (machine_id,kind,label,interval_days) VALUES (1,'blade','Blade change',30)`);
    expect(() =>
      db.run(`INSERT INTO tickers (machine_id,kind,label,interval_days) VALUES (1,'blade','Blade again',30)`)
    ).toThrow();
  });

  test("machine-less tickers still collide on kind", () => {
    // IFNULL(machine_id,-1) in the unique index is what makes this hold.
    db.run(`INSERT INTO tickers (machine_id,kind,label,interval_days) VALUES (NULL,'nets','Net check',7)`);
    expect(() =>
      db.run(`INSERT INTO tickers (machine_id,kind,label,interval_days) VALUES (NULL,'nets','Nets',7)`)
    ).toThrow();
  });

  test("members are unique by name and default to non-admin with no PIN", () => {
    db.run(`INSERT INTO members (name, created_at) VALUES ('Art', 1)`);
    const m = db.query<{ role: string; pin_hash: string | null }, []>("SELECT role, pin_hash FROM members").get()!;
    expect(m.role).toBe("member");
    expect(m.pin_hash).toBeNull();
    expect(() => db.run(`INSERT INTO members (name, created_at) VALUES ('Art', 2)`)).toThrow();
  });

  test("deleting a card releases the maintenance link instead of cascading", () => {
    // A maintenance entry is a historical fact; deleting the card it spawned
    // must not delete the record that the job was done.
    db.run(`INSERT INTO tickers (machine_id,kind,label,interval_days) VALUES (1,'oil','Oil',90)`);
    db.run(`INSERT INTO cards (title,created_by,created_at) VALUES ('leak','jay',1)`);
    db.run(
      `INSERT INTO maintenance_log (ticker_id,done_by,done_at,outcome,spawned_card_id) VALUES (1,'jay',1,'something_wrong',1)`
    );
    db.run(`DELETE FROM cards WHERE id = 1`);
    const row = db.query<{ n: number; spawned_card_id: number | null }, []>(
      "SELECT COUNT(*) n, spawned_card_id FROM maintenance_log"
    ).get()!;
    expect(row.n).toBe(1);
    expect(row.spawned_card_id).toBeNull();
  });

  test("deleting a machine takes its tickers and swaps with it", () => {
    db.run(`INSERT INTO tickers (machine_id,kind,label,interval_days) VALUES (1,'oil','Oil',90)`);
    db.run(`INSERT INTO propane_swaps (machine_id,side,swapped_by,swapped_at) VALUES (1,'L','jay',1)`);
    db.run(`DELETE FROM machines WHERE id = 1`);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM tickers").get()!.n).toBe(0);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM propane_swaps").get()!.n).toBe(0);
  });
});

describe("feed view", () => {
  test("unions the event-shaped tables and orders by time", () => {
    const db = fresh();
    migrate(db);
    db.run(`INSERT INTO machines (code,name,rink_code) VALUES ('546','Zamboni 546','U')`);
    db.run(`INSERT INTO tickers (machine_id,kind,label,interval_days) VALUES (1,'oil','Oil change',90)`);
    db.run(`INSERT INTO cards (title,created_by,created_at,claimed_by,claimed_at) VALUES ('door sticks','jay',100,'art',200)`);
    db.run(`INSERT INTO maintenance_log (ticker_id,done_by,done_at,outcome) VALUES (1,'jay',300,'went_well')`);
    db.run(`INSERT INTO propane_swaps (machine_id,side,swapped_by,swapped_at) VALUES (1,'L','art',400)`);
    db.run(`INSERT INTO edger_runs (rink_code,run_by,run_at,laps) VALUES ('U','jay',500,3)`);

    const rows = db.query<{ kind: string; at: number; actor: string }, []>(
      "SELECT kind, at, actor FROM feed ORDER BY at"
    ).all();
    expect(rows.map((r) => r.kind)).toEqual([
      "card_created", "card_claimed", "maintenance", "propane", "edger",
    ]);
    expect(rows.at(-1)!.actor).toBe("jay");
  });

  test("archived cards drop out of the feed", () => {
    const db = fresh();
    migrate(db);
    db.run(`INSERT INTO cards (title,created_by,created_at,archived_at) VALUES ('old','jay',1,999)`);
    expect(db.query("SELECT * FROM feed").all()).toEqual([]);
  });

  test("ice_sessions summarises a measurement day", () => {
    const db = fresh();
    migrate(db);
    db.run(`INSERT INTO measurements VALUES ('U',1,'2026-07-14',3.0,20.0)`);
    db.run(`INSERT INTO measurements VALUES ('U',2,'2026-07-14',1.2,21.0)`);
    db.run(`INSERT INTO measurements VALUES ('U',3,'2026-07-14',NULL,NULL)`);
    const s = db.query<{ depth_count: number; min_depth: number }, []>(
      "SELECT depth_count, min_depth FROM ice_sessions WHERE measure_date='2026-07-14'"
    ).get()!;
    expect(s.depth_count).toBe(2);
    expect(s.min_depth).toBeCloseTo(1.2, 6);
  });
});
