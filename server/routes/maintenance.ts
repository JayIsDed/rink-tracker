// Completing a ticker, and the outcome selector that makes the board self-feed.
//
// Ruled 07-28: on completion you pick went well / had issues / something else
// is wrong. The third SPAWNS A CARD, attributed, pre-linked to the maintenance
// entry — zero extra typing. That is the whole point: the moment a crew member
// notices something is the moment the tool is already in their hand, and asking
// them to navigate to a different screen to write it down is how the old
// issues board got three entries in fourteen months.

import { db, json, bad, audit, replayed, remember } from "../db";
import { spawnCard, getCard } from "./cards";
import { getTicker, listTickers } from "./tickers";
import { propaneStatus } from "./propane";

export const OUTCOMES = ["went_well", "had_issues", "something_wrong"] as const;

const qInsertLog = db.query<{ id: number }, unknown[]>(`
  INSERT INTO maintenance_log (ticker_id, done_by, done_at, outcome, notes, spawned_card_id)
  VALUES ($ticker, $by, $at, $outcome, $notes, $card)
  RETURNING id
`);

const qLog = db.query(`
  SELECT m.*, t.label, t.kind, mc.name AS machine_name, mc.code AS machine_code
    FROM maintenance_log m
    JOIN tickers t ON t.id = m.ticker_id
    LEFT JOIN machines mc ON mc.id = t.machine_id
   WHERE ($ticker IS NULL OR m.ticker_id = $ticker)
   ORDER BY m.done_at DESC, m.id DESC
   LIMIT $limit
`);

export function handleLog(url: URL): Response {
  const t = url.searchParams.get("ticker_id");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 500);
  return json(qLog.all({ $ticker: t ? Number(t) : null, $limit: limit }));
}

export async function handleComplete(req: Request, tickerId: number, actor: string | null): Promise<Response> {
  const replay = replayed(req);
  if (replay) return replay;
  if (!actor) return bad("pick your name first", 401);

  const ticker = getTicker(tickerId);
  if (!ticker) return bad("no such ticker", 404);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return bad("invalid JSON");
  }

  const outcome = String(body.outcome ?? "went_well");
  if (!OUTCOMES.includes(outcome as (typeof OUTCOMES)[number])) {
    return bad(`outcome must be one of ${OUTCOMES.join(", ")}`);
  }
  const notes = typeof body.notes === "string" ? body.notes.trim().slice(0, 2000) : null;
  const doneAt = Number.isFinite(Number(body.done_at)) ? Number(body.done_at) : Date.now();

  let cardId: number | null = null;
  const result = db.transaction(() => {
    if (outcome === "something_wrong") {
      // The card carries the machine and the note without asking again.
      cardId = spawnCard({
        title: `${ticker.label} — something else is wrong`,
        body: notes,
        actor,
        severity: 2,
        rink_code: ticker.rink_code,
      });
    }
    const { id } = qInsertLog.get({
      $ticker: tickerId,
      $by: actor,
      $at: doneAt,
      $outcome: outcome,
      $notes: notes,
      $card: cardId,
    })!;
    return id;
  })();

  audit(actor, "maintenance.complete", String(tickerId), { outcome, spawned_card_id: cardId });

  return remember(req, {
    ok: true,
    log_id: result,
    ticker: getTicker(tickerId),
    spawned_card: cardId ? getCard(cardId) : null,
  });
}

/** Everything the home surface needs in one call. */
export function handleOverview(): Response {
  return json({ tickers: listTickers(), propane: propaneStatus() });
}
