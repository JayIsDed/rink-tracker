// Edger runs.
//
// Ruled 07-28: anchor dots on the rink map are the DEFAULT, freehand draw is
// the escape hatch. Both ship. One row shape holds either, so history reads the
// same regardless of how it was entered — the input mode is a UI choice, not a
// data model fork.

import { db, json, bad, audit, replayed, remember } from "../db";
import { POINT_COUNT } from "../../public/shared/lib/rink-geom.js";

const qList = db.query(`
  SELECT id, rink_code, run_by, run_at, laps, coverage, notes
    FROM edger_runs
   WHERE ($rink IS NULL OR rink_code = $rink)
   ORDER BY run_at DESC, id DESC
   LIMIT $limit
`);

const qInsert = db.query<{ id: number }, unknown[]>(`
  INSERT INTO edger_runs (rink_code, run_by, run_at, laps, coverage, notes)
  VALUES ($rink, $by, $at, $laps, $coverage, $notes) RETURNING id
`);

/**
 * Coverage is stored as JSON in one of two shapes. Validated here so a
 * malformed blob can never reach the renderer:
 *   {"mode":"dots","dots":[1,4,17]}                  — point numbers
 *   {"mode":"path","path":[[x,y],[x,y],…]}           — rink feet
 */
function parseCoverage(raw: unknown): string | null {
  if (raw == null) return null;
  const c = raw as Record<string, unknown>;

  if (c.mode === "dots") {
    if (!Array.isArray(c.dots)) return null;
    const dots = c.dots
      .map(Number)
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= POINT_COUNT);
    return JSON.stringify({ mode: "dots", dots: [...new Set(dots)] });
  }

  if (c.mode === "path") {
    if (!Array.isArray(c.path)) return null;
    const path = c.path
      .filter((p): p is [number, number] => Array.isArray(p) && p.length === 2)
      .map(([x, y]) => [Number(x), Number(y)])
      .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
      // Cap the stroke so a long scribble cannot write an unbounded row.
      .slice(0, 2000);
    if (!path.length) return null;
    return JSON.stringify({ mode: "path", path: path.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]) });
  }

  return null;
}

export function handleList(url: URL): Response {
  const rink = url.searchParams.get("rink");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200);
  const rows = qList.all({ $rink: rink === "U" || rink === "L" ? rink : null, $limit: limit });
  return json(
    rows.map((r: Record<string, unknown>) => ({
      ...r,
      coverage: r.coverage ? JSON.parse(String(r.coverage)) : null,
    }))
  );
}

export async function handleCreate(req: Request, actor: string | null): Promise<Response> {
  const replay = replayed(req);
  if (replay) return replay;
  if (!actor) return bad("pick your name first", 401);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return bad("invalid JSON");
  }

  // The NFC tag sends ?rink=U — the deep link is the whole contract.
  const rink = body.rink_code === "L" || body.rink === "L" ? "L" : "U";

  // Everything except the rink is optional. Forcing a lap count on someone
  // taking their gloves off in a cold building is exactly the friction that
  // loses to a pen.
  let laps: number | null = null;
  if (body.laps != null && body.laps !== "") {
    const n = Number(body.laps);
    if (!Number.isInteger(n) || n < 0 || n > 99) return bad("laps must be 0..99");
    laps = n;
  }

  const at = Number.isFinite(Number(body.run_at)) ? Number(body.run_at) : Date.now();
  const notes = typeof body.notes === "string" ? body.notes.trim().slice(0, 1000) : null;
  const coverage = parseCoverage(body.coverage);

  const { id } = qInsert.get({
    $rink: rink,
    $by: actor,
    $at: at,
    $laps: laps,
    $coverage: coverage,
    $notes: notes,
  })!;
  audit(actor, "edger.run", String(id), { rink, laps });

  return remember(req, { ok: true, id });
}
