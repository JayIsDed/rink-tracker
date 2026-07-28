// Job run bookkeeping. Every scheduled job writes here, pass or fail.
//
// This table exists because of a specific failure: the weather backfill stopped
// on 2026-05-05 and ten consecutive sessions were logged with no weather row
// before anybody noticed. Nothing was broken loudly enough to see. Settings
// surfaces the newest row per job, so a job that stops running becomes visible
// as a stale timestamp rather than as absent data months later.

import { db } from "../db";

const qInsert = db.query(
  `INSERT INTO job_runs (job, ran_at, ok, detail, duration_ms) VALUES ($job, $at, $ok, $detail, $ms)`
);

export function recordRun(job: string, ok: boolean, detail: string, durationMs: number): void {
  qInsert.run({ $job: job, $at: Date.now(), $ok: ok ? 1 : 0, $detail: detail.slice(0, 500), $ms: durationMs });
  console.log(`[job] ${job} ${ok ? "ok" : "FAILED"} (${durationMs}ms) — ${detail}`);
}

export function lastRun(job: string): { ran_at: number; ok: number; detail: string } | null {
  return (
    db
      .query<{ ran_at: number; ok: number; detail: string }, [string]>(
        "SELECT ran_at, ok, detail FROM job_runs WHERE job = ? ORDER BY ran_at DESC LIMIT 1"
      )
      .get(job) ?? null
  );
}
