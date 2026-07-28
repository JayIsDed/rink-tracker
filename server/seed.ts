// First-boot fixtures. Every seed is guarded on emptiness, so this never fights
// carried data — if the carry ran, rinks already has two rows and we skip.

import { db } from "./db";

const count = (t: string) => (db.query(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c;

export function seedFixtures(): void {
  if (count("rinks") === 0) {
    db.run(`INSERT INTO rinks (code, description, floor) VALUES ('U','Upper','Concrete'), ('L','Lower','Sand')`);
  }

  // Two machines, ruled 07-28: Zamboni 546 upstairs, Olympia downstairs. Each
  // carries L/R propane tanks with independent swap histories.
  if (count("machines") === 0) {
    db.run(`
      INSERT INTO machines (code, name, rink_code, sort) VALUES
        ('546','Zamboni 546','U',0),
        ('olympia','Olympia','L',1)
    `);
  }

  // Maintenance tickers. THE INTERVALS BELOW ARE PLACEHOLDERS — the runbook's
  // needs-Jay list has "first values are yours". They are settings-editable and
  // the settings screen labels any untouched value as a default, so nothing
  // here pretends to be a measured number.
  if (count("tickers") === 0) {
    const machines = db.query<{ id: number; code: string }, []>("SELECT id, code FROM machines").all();
    const ins = db.query(
      `INSERT INTO tickers (machine_id, kind, label, interval_days, sort) VALUES ($m, $k, $l, $i, $s)`
    );
    let sort = 0;
    for (const m of machines) {
      const pretty = m.code === "546" ? "546" : "Olympia";
      ins.run({ $m: m.id, $k: "blade", $l: `${pretty} blade change`, $i: 30, $s: sort++ });
      ins.run({ $m: m.id, $k: "oil", $l: `${pretty} oil change`, $i: 90, $s: sort++ });
      ins.run({ $m: m.id, $k: "grease", $l: `${pretty} greasing`, $i: 14, $s: sort++ });
    }
    db.run(`INSERT INTO settings (key, value, updated_at) VALUES ('ticker_intervals_are_defaults','1',$at)`, {
      $at: Date.now(),
    });
  }
}
