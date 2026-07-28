// Propane — two machines, each with L and R tanks, each tank its own swap
// history.
//
// Ruled 07-28: propane is TIME-SINCE ONLY. There is no interval and no
// deadline, so a tank never goes red for being old. The question a crew member
// actually asks is "when did we last swap that side", and the answer is a
// backwards ticker plus who did it.

import { db, json, bad, audit, replayed, remember } from "../db";

export type PropaneSlot = {
  machine_id: number;
  machine_code: string;
  machine_name: string;
  rink_code: string;
  side: "L" | "R";
  swapped_at: number | null;
  swapped_by: string | null;
  notes: string | null;
  swap_count: number;
};

const qMachines = db.query<{ id: number; code: string; name: string; rink_code: string }, []>(
  "SELECT id, code, name, rink_code FROM machines ORDER BY sort, id"
);

const qLast = db.query<{ swapped_at: number; swapped_by: string; notes: string | null }, [number, string]>(`
  SELECT swapped_at, swapped_by, notes FROM propane_swaps
   WHERE machine_id = ? AND side = ?
   ORDER BY swapped_at DESC, id DESC LIMIT 1
`);

const qCount = db.query<{ c: number }, [number, string]>(
  "SELECT COUNT(*) c FROM propane_swaps WHERE machine_id = ? AND side = ?"
);

const qHistory = db.query(`
  SELECT p.*, m.name AS machine_name, m.code AS machine_code
    FROM propane_swaps p JOIN machines m ON m.id = p.machine_id
   WHERE ($machine IS NULL OR p.machine_id = $machine)
   ORDER BY p.swapped_at DESC, p.id DESC LIMIT $limit
`);

const qInsert = db.query<{ id: number }, unknown[]>(`
  INSERT INTO propane_swaps (machine_id, side, swapped_by, swapped_at, notes)
  VALUES ($machine, $side, $by, $at, $notes) RETURNING id
`);

/** Four slots — both machines × both sides — always present, even at zero. */
export function propaneStatus(): PropaneSlot[] {
  const out: PropaneSlot[] = [];
  for (const m of qMachines.all()) {
    for (const side of ["L", "R"] as const) {
      const last = qLast.get(m.id, side);
      out.push({
        machine_id: m.id,
        machine_code: m.code,
        machine_name: m.name,
        rink_code: m.rink_code,
        side,
        swapped_at: last?.swapped_at ?? null,
        swapped_by: last?.swapped_by ?? null,
        notes: last?.notes ?? null,
        swap_count: qCount.get(m.id, side)!.c,
      });
    }
  }
  return out;
}

export function handleStatus(): Response {
  return json(propaneStatus());
}

export function handleHistory(url: URL): Response {
  const m = url.searchParams.get("machine_id");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 500);
  return json(qHistory.all({ $machine: m ? Number(m) : null, $limit: limit }));
}

/**
 * The NFC target. A tag on the machine deep-links to
 * /log/propane?rink=U&side=L, so this has to accept a machine by CODE or by
 * RINK as well as by id — the sticker cannot know a database id.
 */
export async function handleSwap(req: Request, actor: string | null): Promise<Response> {
  const replay = replayed(req);
  if (replay) return replay;
  if (!actor) return bad("pick your name first", 401);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return bad("invalid JSON");
  }

  const side = body.side === "L" || body.side === "R" ? body.side : null;
  if (!side) return bad("side must be L or R");

  const machines = qMachines.all();
  let machine = null;
  if (body.machine_id != null) machine = machines.find((m) => m.id === Number(body.machine_id)) ?? null;
  else if (typeof body.machine_code === "string")
    machine = machines.find((m) => m.code === body.machine_code) ?? null;
  else if (body.rink === "U" || body.rink === "L")
    machine = machines.find((m) => m.rink_code === body.rink) ?? null;

  if (!machine) return bad("unknown machine — pass machine_id, machine_code or rink");

  const at = Number.isFinite(Number(body.swapped_at)) ? Number(body.swapped_at) : Date.now();
  const notes = typeof body.notes === "string" ? body.notes.trim().slice(0, 500) : null;

  const { id } = qInsert.get({ $machine: machine.id, $side: side, $by: actor, $at: at, $notes: notes })!;
  audit(actor, "propane.swap", `${machine.code}/${side}`, { id });

  return remember(req, { ok: true, id, propane: propaneStatus() });
}
