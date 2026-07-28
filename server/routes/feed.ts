// The feed is a QUERY, not a table.
//
// Everything that happens already lives in an event-shaped row somewhere —
// cards get created and claimed and finished, tickers get completed and nudged,
// tanks get swapped, the edger goes round. Writing those facts a second time
// into an events table would be a dual write, and dual writes drift. The `feed`
// VIEW unions them; "since you were here" is a per-device timestamp compared
// against it, held client-side.

import { db, json } from "../db";

const qFeed = db.query(`
  SELECT kind, ref_id, at, actor, summary, severity, rink_code
    FROM feed
   WHERE at IS NOT NULL AND at > $since
   ORDER BY at DESC
   LIMIT $limit
`);

const qCount = db.query<{ c: number }, [number]>(
  "SELECT COUNT(*) c FROM feed WHERE at IS NOT NULL AND at > ?"
);

/** Ice sessions are day-grained (measurements have no timestamp), so they ride
 *  alongside the feed rather than being forced into its millisecond union. */
const qSessions = db.query(`
  SELECT rink_code, measure_date, depth_count, min_depth, mean_depth
    FROM ice_sessions
   ORDER BY measure_date DESC
   LIMIT $limit
`);

export function handleFeed(url: URL): Response {
  const since = Number(url.searchParams.get("since") ?? 0) || 0;
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200);
  return json({
    since,
    unseen: qCount.get(since)!.c,
    events: qFeed.all({ $since: since, $limit: limit }),
  });
}

export function handleSessions(url: URL): Response {
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 10) || 10, 100);
  return json(qSessions.all({ $limit: limit }));
}
