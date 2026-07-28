// The board. ONE card type — a problem is a card nobody has picked up, a
// project is one somebody did. Same object, same create flow, same detail
// sheet; `status` walks noticed → doing → done.
//
// The old app had a separate mental model per tab, and the crew logged three
// issues in fourteen months. "Simple" here mostly falls out of there being only
// one of everything.

import { db, json, bad, audit, getSettingNum, replayed, remember } from "../db";
import { listFor, thumbsForCards } from "./photos";

export type Card = {
  id: number;
  title: string;
  body: string | null;
  severity: number;
  status: string;
  rink_code: string | null;
  created_by: string;
  created_at: number;
  claimed_by: string | null;
  claimed_at: number | null;
  due_kind: string;
  due_at: number | null;
  due_text: string | null;
  done_at: number | null;
  done_by: string | null;
  archived_at: number | null;
};

const SELECT = `
  SELECT c.*, (SELECT COUNT(*) FROM card_photos p WHERE p.card_id = c.id) AS photo_count
    FROM cards c
`;

const qOpen = db.query<Card, []>(`${SELECT} WHERE c.archived_at IS NULL
  ORDER BY (c.status = 'done'), c.severity DESC,
           CASE WHEN c.due_kind = 'at' THEN c.due_at ELSE NULL END IS NULL,
           c.due_at, c.created_at DESC`);
const qArchived = db.query<Card, []>(`${SELECT} WHERE c.archived_at IS NOT NULL ORDER BY c.archived_at DESC LIMIT 200`);
const qCard = db.query<Card, [number]>(`${SELECT} WHERE c.id = ?`);

const qInsert = db.query<{ id: number }, unknown[]>(`
  INSERT INTO cards (title, body, severity, status, rink_code, created_by, created_at,
                     claimed_by, claimed_at, due_kind, due_at, due_text)
  VALUES ($title, $body, $severity, $status, $rink, $by, $at, $claimed_by, $claimed_at,
          $due_kind, $due_at, $due_text)
  RETURNING id
`);

const qClaim = db.query(`UPDATE cards SET claimed_by=$by, claimed_at=$at, status='doing' WHERE id=$id`);
const qUnclaim = db.query(`UPDATE cards SET claimed_by=NULL, claimed_at=NULL, status='noticed' WHERE id=$id`);
const qDone = db.query(`UPDATE cards SET status='done', done_by=$by, done_at=$at,
                          claimed_by=COALESCE(claimed_by,$by), claimed_at=COALESCE(claimed_at,$at) WHERE id=$id`);
const qReopen = db.query(`UPDATE cards SET status=CASE WHEN claimed_by IS NULL THEN 'noticed' ELSE 'doing' END,
                            done_by=NULL, done_at=NULL, archived_at=NULL WHERE id=$id`);
const qArchive = db.query(`UPDATE cards SET archived_at=$at WHERE id=$id`);
const qDelete = db.query(`DELETE FROM cards WHERE id=$id`);

/** Done cards fade off the board after the configured window. */
export function autoArchive(now = Date.now()): number {
  const days = getSettingNum("archive_days");
  if (!Number.isFinite(days) || days <= 0) return 0;
  const cutoff = now - days * 86400000;
  const res = db.run(
    `UPDATE cards SET archived_at = ? WHERE status='done' AND archived_at IS NULL AND done_at < ?`,
    [now, cutoff]
  );
  return res.changes ?? 0;
}

function parseDue(body: Record<string, unknown>): { kind: string; at: number | null; text: string | null } | null {
  const kind = body.due_kind ?? "none";
  if (kind === "none" || kind == null) return { kind: "none", at: null, text: null };
  if (kind === "before") {
    const text = typeof body.due_text === "string" ? body.due_text.trim().slice(0, 120) : "";
    if (!text) return null;
    return { kind: "before", at: null, text };
  }
  if (kind === "at") {
    const at = Number(body.due_at);
    if (!Number.isFinite(at)) return null;
    return { kind: "at", at, text: null };
  }
  return null;
}

export function handleList(url: URL): Response {
  autoArchive();
  const archived = url.searchParams.get("archived") === "1";
  const rows = archived ? qArchived.all() : qOpen.all();
  // One query for every card's photos rather than one per card — the board
  // renders thumbnails inline and the list is unbounded in principle.
  const byCard = thumbsForCards(rows.map((r) => r.id));
  return json(rows.map((r) => ({ ...r, photos: byCard.get(r.id) ?? [] })));
}

export function handleGet(id: number): Response {
  const c = qCard.get(id);
  return c ? json({ ...c, photos: listFor(id) }) : bad("no such card", 404);
}

export async function handleCreate(req: Request, actor: string | null, isAdmin: boolean): Promise<Response> {
  const replay = replayed(req);
  if (replay) return replay;
  if (!actor) return bad("pick your name first", 401);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return bad("invalid JSON");
  }

  const title = typeof body.title === "string" ? body.title.trim().slice(0, 160) : "";
  if (!title) return bad("title required");

  // Severity is an admin lever — it changes what glows for everyone. Anyone can
  // raise a card; only an admin says it is the top tier.
  let severity = 1;
  if (body.severity != null) {
    const s = Number(body.severity);
    if (![1, 2, 3].includes(s)) return bad("severity must be 1, 2 or 3");
    severity = isAdmin ? s : Math.min(s, 2);
  }

  const due = parseDue(body);
  if (!due) return bad("due_kind needs a matching due_at or due_text");

  const rink = body.rink_code === "U" || body.rink_code === "L" ? body.rink_code : null;
  const now = Date.now();

  // Claim-on-create: if you already know you're taking it, one gesture does
  // both. The claim primitive is the same verb everywhere.
  const claiming = body.claim === true;

  const { id } = qInsert.get({
    $title: title,
    $body: typeof body.body === "string" ? body.body.trim().slice(0, 4000) : null,
    $severity: severity,
    $status: claiming ? "doing" : "noticed",
    $rink: rink,
    $by: actor,
    $at: now,
    $claimed_by: claiming ? actor : null,
    $claimed_at: claiming ? now : null,
    $due_kind: due.kind,
    $due_at: due.at,
    $due_text: due.text,
  })!;

  audit(actor, "card.create", String(id), { title, severity });
  return remember(req, qCard.get(id));
}

export async function handleAction(
  req: Request,
  id: number,
  action: string,
  actor: string | null,
  isAdmin: boolean
): Promise<Response> {
  const card = qCard.get(id);
  if (!card) return bad("no such card", 404);
  if (!actor) return bad("pick your name first", 401);
  const now = Date.now();

  switch (action) {
    case "claim":
      // One tap. Claiming something already claimed is not an error — it is
      // usually two people at the same board, and last-writer-wins is fine.
      qClaim.run({ $by: actor, $at: now, $id: id });
      audit(actor, "card.claim", String(id));
      break;
    case "unclaim":
      if (card.claimed_by !== actor && !isAdmin) return bad("only the person on it can drop it", 403);
      qUnclaim.run({ $id: id });
      audit(actor, "card.unclaim", String(id));
      break;
    case "done":
      qDone.run({ $by: actor, $at: now, $id: id });
      audit(actor, "card.done", String(id));
      break;
    case "reopen":
      qReopen.run({ $id: id });
      audit(actor, "card.reopen", String(id));
      break;
    case "archive":
      if (!isAdmin) return bad("admin required", 403);
      qArchive.run({ $at: now, $id: id });
      audit(actor, "card.archive", String(id));
      break;
    default:
      return bad("unknown action", 404);
  }
  return json(qCard.get(id));
}

export async function handlePatch(req: Request, id: number, actor: string | null, isAdmin: boolean): Promise<Response> {
  const card = qCard.get(id);
  if (!card) return bad("no such card", 404);
  if (!actor) return bad("pick your name first", 401);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return bad("invalid JSON");
  }

  const sets: string[] = [];
  const params: Record<string, unknown> = { $id: id };

  if (typeof body.title === "string" && body.title.trim()) {
    sets.push("title = $title");
    params.$title = body.title.trim().slice(0, 160);
  }
  if ("body" in body) {
    sets.push("body = $body");
    params.$body = typeof body.body === "string" ? body.body.trim().slice(0, 4000) : null;
  }
  if (body.severity != null) {
    if (!isAdmin) return bad("severity is admin-only", 403);
    const s = Number(body.severity);
    if (![1, 2, 3].includes(s)) return bad("severity must be 1, 2 or 3");
    sets.push("severity = $severity");
    params.$severity = s;
  }
  if ("due_kind" in body) {
    const due = parseDue(body);
    if (!due) return bad("due_kind needs a matching due_at or due_text");
    sets.push("due_kind = $dk", "due_at = $da", "due_text = $dt");
    params.$dk = due.kind;
    params.$da = due.at;
    params.$dt = due.text;
  }

  if (!sets.length) return json(card);
  db.query(`UPDATE cards SET ${sets.join(", ")} WHERE id = $id`).run(params);
  audit(actor, "card.edit", String(id), Object.keys(body));
  return json(qCard.get(id));
}

export async function handleDelete(id: number, actor: string | null, isAdmin: boolean): Promise<Response> {
  if (!isAdmin) return bad("admin required", 403);
  if (!qCard.get(id)) return bad("no such card", 404);
  qDelete.run({ $id: id });
  audit(actor, "card.delete", String(id));
  return json({ ok: true });
}

/** Used by the maintenance route when an outcome spawns a card. */
export function spawnCard(opts: {
  title: string;
  body: string | null;
  actor: string;
  severity?: number;
  rink_code?: string | null;
}): number {
  const now = Date.now();
  const { id } = qInsert.get({
    $title: opts.title.slice(0, 160),
    $body: opts.body,
    $severity: opts.severity ?? 2,
    $status: "noticed",
    $rink: opts.rink_code ?? null,
    $by: opts.actor,
    $at: now,
    $claimed_by: null,
    $claimed_at: null,
    $due_kind: "none",
    $due_at: null,
    $due_text: null,
  })!;
  // Audited like any other creation. Without this the one card type nobody
  // typed by hand is also the one whose history starts blank — and "where did
  // this come from" is exactly the question asked about a card that appeared
  // on the board on its own.
  audit(opts.actor, "card.create", String(id), { title: opts.title, spawned: true });
  return id;
}

const qHistory = db.query<
  { actor: string | null; action: string; detail: string | null; at: number },
  [string]
>(`
  SELECT actor, action, detail, at FROM audit_log
   WHERE target = ? AND action LIKE 'card.%'
   ORDER BY at
`);

/**
 * A card's history, read out of the audit log.
 *
 * "Every write is attributed + timestamped" is a law on n-72 and it was being
 * kept in a table nothing could read. Round one showed a timeline on every
 * issue; the rebuild wrote better records and then showed none of them.
 *
 * The log is the source, not a second events table — same reasoning as the
 * feed being a VIEW. Nothing here is dual-written, so nothing can drift.
 */
export function handleHistory(id: number): Response {
  if (!qCard.get(id)) return bad("no such card", 404);
  return json(
    qHistory.all(String(id)).map((r) => ({
      actor: r.actor,
      action: r.action.slice("card.".length),
      at: r.at,
      detail: r.detail ? safeParse(r.detail) : null,
    }))
  );
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export function getCard(id: number): Card | null {
  return qCard.get(id) ?? null;
}
