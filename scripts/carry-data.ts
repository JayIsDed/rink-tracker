// Carry the four keepable tables out of the old database into a fresh v1 one.
//
//   bun scripts/carry-data.ts --from <old.db> --to data/rink.db
//
// This is V1 in the runbook. The receipt is a parity table: 2,566 measurements
// / 35 points / 2 rinks / 64 weather rows, plus a checksum over measurements.
// It exits non-zero if anything is short, because a migration that quietly
// carries less than everything is worse than one that fails.
//
// THE TRAP THIS SCRIPT EXISTS TO AVOID: prod's rink.db file was 270 KB and
// dated May 2, while its -wal was 2 MB and dated Jul 14. Copying the .db alone
// carries a May-2 database. Always hand this script a file produced by
// `VACUUM INTO` on the live database, or a directory copy that includes -wal
// and -shm. It refuses to run against a source with an unmerged WAL beside it.

import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";

const CARRIED = ["rinks", "points", "measurements", "weather"] as const;

// n-71's verified prod counts. Parity is measured against these, not against
// whatever the source happens to hold, so a truncated source fails loudly.
const EXPECTED: Record<string, number> = {
  rinks: 2,
  points: 35,
  measurements: 2566,
  weather: 64,
};

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  console.error(`missing --${name}`);
  process.exit(2);
}

const from = arg("from");
const to = arg("to", "data/rink.db");
const strict = !process.argv.includes("--no-strict");

if (!existsSync(from)) {
  console.error(`source not found: ${from}`);
  process.exit(2);
}

// Refuse a source whose WAL still holds data.
const wal = `${from}-wal`;
if (existsSync(wal) && statSync(wal).size > 0) {
  console.error(
    `\n  REFUSING: ${wal} is ${statSync(wal).size} bytes.\n` +
      `  The source has un-checkpointed pages, so ${from} alone is stale.\n` +
      `  On the live host run:  sqlite3 rink.db "VACUUM INTO '/tmp/carry.db'"\n` +
      `  (or via bun: new Database(path).run("VACUUM INTO '/tmp/carry.db'"))\n` +
      `  then carry /tmp/carry.db.\n`
  );
  process.exit(2);
}

console.log(`carry: ${from}  →  ${to}`);

// Opening the destination runs migrations to v1.
process.env.RINK_DB = to;
const { db } = await import("../server/db");

const src = new Database(from, { readonly: true });
const srcCounts: Record<string, number> = {};
for (const t of CARRIED) {
  try {
    srcCounts[t] = (src.query(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c;
  } catch {
    console.error(`source is missing table ${t}`);
    process.exit(2);
  }
}
// Checksum the measurement payload itself, not just its cardinality — a carry
// that moves the right number of rows with the wrong values still fails here.
const srcSum = src.query(
  `SELECT ROUND(SUM(IFNULL(depth_in,0)), 4) d, ROUND(SUM(IFNULL(temp_f,0)), 4) t FROM measurements`
).get() as { d: number; t: number };
src.close();

for (const t of [...CARRIED].reverse()) db.run(`DELETE FROM ${t}`);

db.run(`ATTACH DATABASE ? AS old`, [from]);
db.transaction(() => {
  db.run(`INSERT INTO rinks (code, description, floor) SELECT code, description, floor FROM old.rinks`);
  db.run(
    `INSERT INTO points (rink_code, point_nbr, grid_col, grid_row)
     SELECT rink_code, point_nbr, grid_col, grid_row FROM old.points`
  );
  db.run(
    `INSERT INTO measurements (rink_code, point_nbr, measure_date, depth_in, temp_f)
     SELECT rink_code, point_nbr, measure_date, depth_in, temp_f FROM old.measurements`
  );
  db.run(
    `INSERT INTO weather (measure_date, temp_high_f, temp_low_f, temp_mean_f, precip_in,
                          snow_in, wind_mph_max, cloud_cover_pct, weather_code, source)
     SELECT measure_date, temp_high_f, temp_low_f, temp_mean_f, precip_in,
            snow_in, wind_mph_max, cloud_cover_pct, weather_code, source FROM old.weather`
  );
})();
db.run(`DETACH DATABASE old`);

// ── Receipt ───────────────────────────────────────────────────────────
const dstSum = db
  .query(`SELECT ROUND(SUM(IFNULL(depth_in,0)), 4) d, ROUND(SUM(IFNULL(temp_f,0)), 4) t FROM measurements`)
  .get() as { d: number; t: number };

let failed = false;
const rows: string[] = [];
rows.push("  table          source   carried   expected   verdict");
rows.push("  ─────────────  ──────   ───────   ────────   ───────");
for (const t of CARRIED) {
  const got = (db.query(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c;
  const exp = EXPECTED[t];
  const ok = got === srcCounts[t] && (!strict || got === exp);
  if (!ok) failed = true;
  rows.push(
    `  ${t.padEnd(13)}  ${String(srcCounts[t]).padStart(6)}   ${String(got).padStart(7)}   ` +
      `${String(exp).padStart(8)}   ${ok ? "ok" : "MISMATCH"}`
  );
}
const sumOk = srcSum.d === dstSum.d && srcSum.t === dstSum.t;
if (!sumOk) failed = true;

console.log("\nV1 — migration parity\n");
console.log(rows.join("\n"));
console.log(
  `\n  checksum  depth Σ ${dstSum.d} (src ${srcSum.d})   temp Σ ${dstSum.t} (src ${srcSum.t})   ` +
    `${sumOk ? "ok" : "MISMATCH"}`
);

const span = db
  .query(`SELECT MIN(measure_date) a, MAX(measure_date) b, COUNT(DISTINCT measure_date) n FROM measurements`)
  .get() as { a: string; b: string; n: number };
console.log(`  span      ${span.a} → ${span.b}   ${span.n} sessions\n`);

if (failed) {
  console.error("V1 FAILED — do not proceed to cutover.\n");
  process.exit(1);
}
console.log("V1 PASSED\n");
