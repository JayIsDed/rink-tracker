// Pull the ice-cut schedule from the facility's public page.
//
// Path and parsing rationale: docs/schedule-source.md (R0 probe). Short
// version: the page server-renders the whole schedule into the RSC flight
// payload, so one unauthenticated GET returns everything. No key, no secret.
//
// This job MUST log every run. The old weather pull died silently on
// 2026-05-05 and ten consecutive sessions went bare before anyone noticed —
// a job that cannot report its last run is a job that dies quietly.

import { db } from "../db";
import { recordRun } from "./runs";
import { parseSlots, toEpoch, slotKind, SPACE_TO_RINK } from "./schedule-parse";

export const SCHEDULE_URL =
  process.env.RINK_SCHEDULE_URL ??
  "https://schedule.bondsports.co/schedule/Champions-Skating-Center-Schedule";

const qUpsert = db.query(`
  INSERT INTO schedule (source, rink_code, starts_at, ends_at, title, kind, ext_id, pulled_at)
  VALUES ('bondsports', $rink, $starts, $ends, $title, $kind, $ext, $pulled)
  ON CONFLICT(source, ext_id) DO UPDATE SET
    rink_code = excluded.rink_code,
    starts_at = excluded.starts_at,
    ends_at   = excluded.ends_at,
    title     = excluded.title,
    kind      = excluded.kind,
    pulled_at = excluded.pulled_at
`);

export async function pullSchedule(fetchImpl: typeof fetch = fetch): Promise<{
  ok: boolean;
  parsed: number;
  stored: number;
  ice: number;
  headerCount: number | null;
  detail: string;
}> {
  const started = Date.now();
  try {
    const res = await fetchImpl(SCHEDULE_URL, {
      headers: { "user-agent": "rink-tracker/1.0 (+internal rink ops tool)" },
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    const html = await res.text();

    // The page prints its own count. Carrying both means a widening gap between
    // what the source claims and what we extract becomes visible, instead of
    // being assumed benign — on 2026-07-28 it was 1,308 claimed vs 1,213 parsed.
    const header = /([0-9,]+)\s+events/.exec(html.replace(/<[^>]+>/g, " "));
    const headerCount = header ? Number(header[1].replace(/,/g, "")) : null;

    const slots = parseSlots(html);
    // Zero slots means the markup changed, not that the rink is empty.
    if (slots.length === 0) throw new Error("parsed zero slots — page shape probably changed");

    let ice = 0;
    let stored = 0;
    db.transaction(() => {
      for (const s of slots) {
        const rink = SPACE_TO_RINK[s.spaceId];
        if (!rink) continue; // pool, fitness room, party room…
        const starts = toEpoch(s.startDate, s.startTime);
        if (starts == null) continue;
        const kind = slotKind(s);
        if (kind === "ice_cut") ice++;
        qUpsert.run({
          $rink: rink,
          $starts: starts,
          $ends: s.endTime ? toEpoch(s.startDate, s.endTime) : null,
          $title: s.title ?? null,
          $kind: kind,
          $ext: String(s.id),
          $pulled: Date.now(),
        });
        stored++;
      }
    })();

    const detail = `parsed ${slots.length}, header ${headerCount ?? "?"}, stored ${stored}, ice cuts ${ice}`;
    recordRun("schedule_pull", true, detail, Date.now() - started);
    return { ok: true, parsed: slots.length, stored, ice, headerCount, detail };
  } catch (err) {
    const detail = String((err as Error)?.message ?? err);
    recordRun("schedule_pull", false, detail, Date.now() - started);
    return { ok: false, parsed: 0, stored: 0, ice: 0, headerCount: null, detail };
  }
}
