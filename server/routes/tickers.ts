// Tickers — the trust surface. State is DERIVED here, never stored: the latest
// maintenance_log row supplies last_done_at, the nudge columns supply the
// human override, and dates.js turns the pair into green/amber/red.
//
// A stored state column would be a dual write, and dual writes drift.

import { db, json, bad } from "../db";
import { tickerState } from "../../public/shared/lib/dates.js";

export type TickerRow = {
  id: number;
  machine_id: number | null;
  machine_code: string | null;
  machine_name: string | null;
  rink_code: string | null;
  kind: string;
  label: string;
  interval_days: number | null;
  nudged_at: number | null;
  nudged_by: string | null;
  last_done_at: number | null;
  last_done_by: string | null;
  last_outcome: string | null;
  sort: number;
};

const qTickers = db.query<TickerRow, []>(`
  SELECT t.id, t.machine_id, m.code AS machine_code, m.name AS machine_name,
         m.rink_code, t.kind, t.label, t.interval_days,
         t.nudged_at, t.nudged_by, t.sort,
         l.done_at AS last_done_at, l.done_by AS last_done_by, l.outcome AS last_outcome
    FROM tickers t
    LEFT JOIN machines m ON m.id = t.machine_id
    LEFT JOIN maintenance_log l
      ON l.id = (SELECT id FROM maintenance_log
                  WHERE ticker_id = t.id
                  ORDER BY done_at DESC, id DESC LIMIT 1)
   WHERE t.active = 1
   ORDER BY t.sort, t.id
`);

const qTicker = db.query<TickerRow, [number]>(`
  SELECT t.id, t.machine_id, m.code AS machine_code, m.name AS machine_name,
         m.rink_code, t.kind, t.label, t.interval_days,
         t.nudged_at, t.nudged_by, t.sort,
         l.done_at AS last_done_at, l.done_by AS last_done_by, l.outcome AS last_outcome
    FROM tickers t
    LEFT JOIN machines m ON m.id = t.machine_id
    LEFT JOIN maintenance_log l
      ON l.id = (SELECT id FROM maintenance_log
                  WHERE ticker_id = t.id
                  ORDER BY done_at DESC, id DESC LIMIT 1)
   WHERE t.id = ?
`);

const qUpdate = db.query(
  `UPDATE tickers SET interval_days = $interval, label = $label WHERE id = $id`
);
const qNudge = db.query(`UPDATE tickers SET nudged_at = $at, nudged_by = $by WHERE id = $id`);

/** Row plus its derived state, which is what every client actually wants. */
export function withState(t: TickerRow, now = Date.now()) {
  return { ...t, ...tickerState(t, now) };
}

export function listTickers(now = Date.now()) {
  return qTickers.all().map((t) => withState(t, now));
}

export function getTicker(id: number, now = Date.now()) {
  const row = qTicker.get(id);
  return row ? withState(row, now) : null;
}

export function handleList(): Response {
  return json(listTickers());
}

export async function handlePatch(req: Request, id: number, isAdmin: boolean): Promise<Response> {
  if (!isAdmin) return bad("admin required", 403);
  const existing = qTicker.get(id);
  if (!existing) return bad("no such ticker", 404);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return bad("invalid JSON");
  }

  let interval: number | null = existing.interval_days;
  if ("interval_days" in body) {
    const v = body.interval_days;
    if (v === null || v === "") interval = null;
    else {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 1 || n > 3650) return bad("interval must be 1..3650 days");
      interval = Math.round(n);
    }
  }

  const label =
    typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 80) : existing.label;

  qUpdate.run({ $interval: interval, $label: label, $id: id });
  return json(getTicker(id));
}

/**
 * Anyone can nudge — "blade's dull" is a real observation and it outranks the
 * calendar. The nudge is attributed and shows up in the feed.
 */
export async function handleNudge(req: Request, id: number, actor: string | null): Promise<Response> {
  if (!actor) return bad("pick your name first", 401);
  if (!qTicker.get(id)) return bad("no such ticker", 404);
  qNudge.run({ $at: Date.now(), $by: actor, $id: id });
  return json(getTicker(id));
}
