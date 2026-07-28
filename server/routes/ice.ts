// Ice measurements: sessions, one session's readings, the thin-spot strip, and
// the write path.
//
// THE THING THIS SURFACE EXISTS FOR (n-71): the 2026-07-14 session has point 27
// at 1.19" and round one showed nothing. Worth being precise about why, because
// it decides the shape of the whole strip — point 27 has read 0.83"-1.19" every
// session since May. It is not eroding. A per-point z-score, the obvious
// "anomaly detection" reflex, scores it as PERFECTLY NORMAL, because for that
// point it is normal. What makes it alarming is that it is thin in absolute
// terms while the sheet around it is not.
//
// So the strip leads with the absolute threshold and the neighbour comparison,
// and reports trend and z-score as a SEPARATE, secondary column answering a
// different question ("is this getting worse", not "is this thin"). A strip
// built on z-score alone would have missed the exact finding it was built for.

import { db, json, bad, audit, replayed, remember, getSettingNum } from "../db";
import { POINT_COUNT, nearestNeighbours, gridOf } from "../../public/shared/lib/rink-geom.js";
import { mean, stdev, zScore, trendPerWeek } from "../../public/shared/lib/scales.js";

// Only the Upper sheet is measured. Lower is a sand base and has never held a
// measurement row — it has no surveyed points either, so a write there would
// reference a grid that does not exist for it.
const MEASURED_RINK = "U";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Erosion rate at which a point is worth calling out. n-71 measured ordinary
// per-point scatter across real sessions at roughly ±0.1"/week (pt 11 at
// -0.039, pt 9 at +0.108), so a threshold inside that band would flag a large
// slice of the sheet every single session. An alarm that fires constantly is
// the "five coming soon tabs" failure in a different costume: the crew stops
// reading it, and then it may as well not exist. -0.15"/wk sits clearly outside
// the noise and still catches a point losing ~0.6" a month.
const DROPPING_PER_WEEK = -0.15;

/** Sessions of history required before a trend is claimed at all. */
const MIN_TREND_SESSIONS = 4;

// How far OUTSIDE the local min-max a point must sit to be called out of line
// with its neighbours.
//
// The first cut compared against the neighbour MEAN, and on the real carry it
// flagged 14 of 35 points — including five that were merely thicker than
// average. The reason is that a mean is a bad summary here: point 27's four
// neighbours span 1.97"-4.37", so "1.25 off the mean" mostly measures the
// gradient across the sheet, not an outlier. Being outside the range its own
// neighbours occupy is the claim actually worth making, and on the same data it
// leaves the nine genuinely thin points and drops the noise.
const OUT_OF_LINE_IN = 0.75;

// A z-score needs a companion guard, because on this data it is computed from
// about four weekly sessions and a tiny standard deviation makes any movement
// look enormous — the first run produced z of -5.5 and +7.79 on points that had
// barely moved, and lit up eight of thirty-five. Statistical significance is not
// operational significance: a point is only "unusual" if it has ALSO moved half
// an inch off its own recent normal. Below that it is measurement noise wearing
// a big number.
const MIN_UNUSUAL_MOVE_IN = 0.5;
const MIN_BASELINE_SESSIONS = 4;

type Row = Record<string, unknown>;

const qSessions = db.query(`
  SELECT s.rink_code, s.measure_date, s.depth_count, s.temp_count,
         s.min_depth, s.mean_depth,
         w.temp_mean_f, w.temp_high_f, w.temp_low_f, w.precip_in, w.weather_code
    FROM ice_sessions s
    LEFT JOIN weather w ON w.measure_date = s.measure_date
   WHERE s.rink_code = $rink
   ORDER BY s.measure_date DESC
   LIMIT $limit
`);

const qReadings = db.query(`
  SELECT point_nbr, depth_in, temp_f FROM measurements
   WHERE rink_code = $rink AND measure_date = $date
   ORDER BY point_nbr
`);

const qPrevDate = db.query<{ measure_date: string }, Row>(`
  SELECT MAX(measure_date) AS measure_date FROM measurements
   WHERE rink_code = $rink AND measure_date < $date
`);

const qLatestDate = db.query<{ measure_date: string | null }, Row>(`
  SELECT MAX(measure_date) AS measure_date FROM measurements WHERE rink_code = $rink
`);

const qWeather = db.query(`SELECT * FROM weather WHERE measure_date = ?`);

const qHistory = db.query(`
  SELECT point_nbr, measure_date, depth_in FROM measurements
   WHERE rink_code = $rink AND measure_date >= $from AND depth_in IS NOT NULL
   ORDER BY point_nbr, measure_date
`);

// One point's readings up to and including a date. Everything the detail sheet
// reports — the sparkline, the all-time stats, the headroom — is derived from
// this one pull, so they cannot disagree with each other.
const qPointHistory = db.query(`
  SELECT measure_date, depth_in, temp_f FROM measurements
   WHERE rink_code = $rink AND point_nbr = $point AND measure_date <= $date
   ORDER BY measure_date
`);

const qUpsert = db.query(`
  INSERT INTO measurements (rink_code, point_nbr, measure_date, depth_in, temp_f)
  VALUES ($rink, $point, $date, $depth, $temp)
  ON CONFLICT (rink_code, point_nbr, measure_date)
  DO UPDATE SET depth_in = excluded.depth_in, temp_f = excluded.temp_f
`);

// Clearing both readings removes the row. A row holding two NULLs is not a
// measurement, and leaving it behind makes "35 points recorded" a lie.
const qDelete = db.query(`
  DELETE FROM measurements WHERE rink_code = $rink AND point_nbr = $point AND measure_date = $date
`);

function rinkParam(url: URL): string {
  const r = url.searchParams.get("rink");
  return r === "L" ? "L" : MEASURED_RINK;
}

function toISO(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

/** YYYY-MM-DD, n days before today in the rink's local zone. */
function daysAgoISO(days: number): string {
  return toISO(Date.now() - days * 86400000);
}

/**
 * YYYY-MM-DD, n days before a given date.
 *
 * The windows must be anchored to the SESSION being examined, not to today. The
 * first cut used "today minus 30", which meant every point in the most recent
 * carried session came back with z = 0 — its baseline window held two rows, one
 * short of the minimum, purely because that session was a fortnight old. Open a
 * session from last winter and the window would be empty and the whole anomaly
 * column would read zero without ever saying it had nothing to work with.
 */
function daysBeforeISO(date: string, days: number): string {
  return toISO(Date.parse(`${date}T12:00:00Z`) - days * 86400000);
}

export function handleSessions(url: URL): Response {
  const rink = rinkParam(url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 40) || 40, 200);
  if (rink !== MEASURED_RINK) return json([]);
  return json(qSessions.all({ $rink: rink, $limit: limit }));
}

/** One session: every point, its previous reading, and the day's weather. */
export function handleSession(url: URL): Response {
  const rink = rinkParam(url);
  if (rink !== MEASURED_RINK) {
    return json({ rink_code: rink, measured: false, date: null, points: [], prev_date: null, weather: null });
  }

  const asked = url.searchParams.get("date");
  const date =
    asked && DATE_RE.test(asked) ? asked : (qLatestDate.get({ $rink: rink })?.measure_date ?? null);

  if (!date) {
    return json({ rink_code: rink, measured: true, date: null, points: [], prev_date: null, weather: null, stats: null });
  }

  const prev_date = qPrevDate.get({ $rink: rink, $date: date })?.measure_date ?? null;
  const now = new Map((qReadings.all({ $rink: rink, $date: date }) as Row[]).map((r) => [Number(r.point_nbr), r]));
  const before = prev_date
    ? new Map((qReadings.all({ $rink: rink, $date: prev_date }) as Row[]).map((r) => [Number(r.point_nbr), r]))
    : new Map();

  // All 35 points always, measured or not. A hole in the walk is information —
  // dropping unmeasured points would render it as if the sheet were complete.
  const points = [];
  for (let n = 1; n <= POINT_COUNT; n++) {
    const cur = now.get(n) as Row | undefined;
    const old = before.get(n) as Row | undefined;
    const depth = (cur?.depth_in as number | null) ?? null;
    const prevDepth = (old?.depth_in as number | null) ?? null;
    points.push({
      point_nbr: n,
      depth_in: depth,
      temp_f: (cur?.temp_f as number | null) ?? null,
      prev_depth_in: prevDepth,
      delta_in: depth != null && prevDepth != null ? Math.round((depth - prevDepth) * 1000) / 1000 : null,
    });
  }

  const depths = points.map((p) => p.depth_in).filter((v): v is number => v != null);
  return json({
    rink_code: rink,
    measured: true,
    date,
    prev_date,
    points,
    stats: depths.length
      ? {
          n: depths.length,
          min: Math.min(...depths),
          max: Math.max(...depths),
          mean: mean(depths),
          stdev: stdev(depths),
        }
      : null,
    weather: qWeather.get(date) ?? null,
  });
}

/**
 * The GM-credibility surface. Two independent questions per point, kept apart
 * on purpose (see the file header):
 *   IS IT THIN   — absolute depth vs the threshold, and vs its own neighbours
 *   IS IT MOVING — trend per week, and z-score against that point's own history
 */
export function handleThinSpots(url: URL): Response {
  const rink = rinkParam(url);
  if (rink !== MEASURED_RINK) {
    return json({ rink_code: rink, measured: false, date: null, threshold_in: null, spots: [], counts: null });
  }

  const asked = url.searchParams.get("date");
  const date =
    asked && DATE_RE.test(asked) ? asked : (qLatestDate.get({ $rink: rink })?.measure_date ?? null);
  const threshold = getSettingNum("thin_spot_in");
  if (!date) {
    return json({ rink_code: rink, measured: true, date: null, threshold_in: threshold, spots: [], counts: null });
  }

  const readings = new Map(
    (qReadings.all({ $rink: rink, $date: date }) as Row[]).map((r) => [Number(r.point_nbr), r.depth_in as number | null])
  );

  // One history pull over the wider of the two windows, sliced per question.
  const trendDays = getSettingNum("trend_window_days");
  const anomalyDays = getSettingNum("anomaly_window_days");
  const from = daysBeforeISO(date, Math.max(trendDays, anomalyDays));
  const anomalyFrom = daysBeforeISO(date, anomalyDays);

  const history = new Map<number, { date: string; value: number }[]>();
  // Only history up to and including the session under examination — a trend
  // shown against an old session must not be computed from its future.
  for (const h of (qHistory.all({ $rink: rink, $from: from }) as Row[]).filter(
    (h) => String(h.measure_date) <= date
  )) {
    const n = Number(h.point_nbr);
    if (!history.has(n)) history.set(n, []);
    history.get(n)!.push({ date: String(h.measure_date), value: Number(h.depth_in) });
  }

  const spots = [];
  for (let n = 1; n <= POINT_COUNT; n++) {
    const depth = readings.get(n) ?? null;
    if (depth == null) continue;

    const near = nearestNeighbours(n, 4).map((nb: { point_nbr: number }) => readings.get(nb.point_nbr) ?? null);
    const nearVals = near.filter((v): v is number => v != null);
    const nMean = nearVals.length ? mean(nearVals) : null;
    const nMin = nearVals.length ? Math.min(...nearVals) : null;
    const nMax = nearVals.length ? Math.max(...nearVals) : null;
    const off = nMean == null ? null : depth - nMean;
    // Distance outside the range the neighbours actually occupy — negative when
    // the point sits within it.
    const outside = nMin == null ? null : Math.max(nMin - depth, depth - nMax!);

    // Baseline EXCLUDES today: the question is whether this reading is unusual
    // for this point, and folding today into its own baseline drags the mean
    // toward the value being tested.
    const series = history.get(n) ?? [];
    const baseline = series.filter((p) => p.date >= anomalyFrom && p.date !== date).map((p) => p.value);
    const baseMean = baseline.length ? mean(baseline) : null;
    const z = baseline.length >= MIN_BASELINE_SESSIONS ? zScore(depth, baseMean, stdev(baseline)) : 0;
    const moved = baseMean == null ? null : Math.round((depth - baseMean) * 100) / 100;
    // Two sessions make a perfect line and a meaningless slope. Four is the
    // point at which a claimed trend is worth putting in front of the GM.
    const trend = series.length >= MIN_TREND_SESSIONS ? trendPerWeek(series) : null;

    const thin = depth <= threshold;
    const odd = outside != null && outside >= OUT_OF_LINE_IN;
    const dropping = trend != null && trend <= DROPPING_PER_WEEK;
    const unusual = Math.abs(z) >= 2 && moved != null && Math.abs(moved) >= MIN_UNUSUAL_MOVE_IN;
    if (!thin && !odd && !unusual && !dropping) continue;

    spots.push({
      point_nbr: n,
      depth_in: depth,
      neighbour_mean: nMean == null ? null : Math.round(nMean * 100) / 100,
      neighbour_min: nMin,
      neighbour_max: nMax,
      off_by: off == null ? null : Math.round(off * 100) / 100,
      outside_by: outside == null ? null : Math.round(outside * 100) / 100,
      moved_by: moved,
      trend_per_week: trend == null ? null : Math.round(trend * 1000) / 1000,
      z: Math.round(z * 100) / 100,
      history_n: series.length,
      thin,
      odd,
      dropping,
      unusual,
    });
  }

  spots.sort((a, b) => a.depth_in - b.depth_in);

  return json({
    rink_code: rink,
    measured: true,
    date,
    threshold_in: threshold,
    trend_window_days: trendDays,
    anomaly_window_days: anomalyDays,
    counts: {
      thin: spots.filter((s) => s.thin).length,
      odd: spots.filter((s) => s.odd).length,
      dropping: spots.filter((s) => s.dropping).length,
      measured: readings.size,
    },
    spots,
  });
}

/**
 * One point, everything known about it. Round one had this and the rebuild did
 * not: tapping a dot gave a single line of text instead of the point's history,
 * which is what the composition check (AMENDMENT 1 on n-72) was called to fix.
 *
 * On the date window — every number here is computed from readings up to and
 * including the session being viewed, never past it. Open a January session and
 * "thinnest ever" means thinnest as of January. The alternative reads tidier
 * and is a quiet lie: it would show a reading from the session's future and
 * label it history. Viewing the latest session, which is the ordinary case,
 * this IS all-time.
 */
export function handlePoint(url: URL): Response {
  const rink = rinkParam(url);
  const n = Number(url.searchParams.get("point"));
  if (!Number.isInteger(n) || n < 1 || n > POINT_COUNT) return bad(`point must be 1..${POINT_COUNT}`);
  if (rink !== MEASURED_RINK) {
    return json({ rink_code: rink, measured: false, point_nbr: n, history: [], stats: null });
  }

  const asked = url.searchParams.get("date");
  const date =
    asked && DATE_RE.test(asked) ? asked : (qLatestDate.get({ $rink: rink })?.measure_date ?? null);
  if (!date) {
    return json({ rink_code: rink, measured: true, point_nbr: n, date: null, history: [], stats: null });
  }

  const rows = (qPointHistory.all({ $rink: rink, $point: n, $date: date }) as Row[]).map((r) => ({
    measure_date: String(r.measure_date),
    depth_in: (r.depth_in as number | null) ?? null,
    temp_f: (r.temp_f as number | null) ?? null,
  }));

  const here = rows.find((r) => r.measure_date === date) ?? null;
  // The reading before this session — the delta the operator actually asks for
  // is "since last time", not "since some fixed point".
  const earlier = rows.filter((r) => r.measure_date < date && r.depth_in != null);
  const prev = earlier.length ? earlier[earlier.length - 1] : null;

  const depths = rows.filter((r) => r.depth_in != null) as { measure_date: string; depth_in: number }[];
  let stats = null;
  if (depths.length) {
    let minRow = depths[0];
    let maxRow = depths[0];
    for (const r of depths) {
      if (r.depth_in < minRow.depth_in) minRow = r;
      if (r.depth_in > maxRow.depth_in) maxRow = r;
    }
    stats = {
      n: depths.length,
      mean: mean(depths.map((r) => r.depth_in)),
      min: minRow.depth_in,
      min_date: minRow.measure_date,
      max: maxRow.depth_in,
      max_date: maxRow.measure_date,
      trend_per_week:
        depths.length >= MIN_TREND_SESSIONS
          ? trendPerWeek(depths.map((r) => ({ date: r.measure_date, value: r.depth_in })))
          : null,
    };
  }

  // Headroom is the round-one idea, kept because it answers a real question
  // before a cut: how much is there between today's surface and the thinnest
  // this point has ever read, which is the best estimate anyone has of where
  // the concrete starts. It is an ESTIMATE from measurement history, not a
  // survey, and the sheet says so in words rather than implying precision.
  const headroom =
    here?.depth_in != null && stats != null ? Math.round((here.depth_in - stats.min) * 100) / 100 : null;

  const near = nearestNeighbours(n, 4).map((nb: { point_nbr: number }) => nb.point_nbr);
  const neighbourRows = (qReadings.all({ $rink: rink, $date: date }) as Row[])
    .filter((r) => near.includes(Number(r.point_nbr)) && r.depth_in != null)
    .map((r) => ({ point_nbr: Number(r.point_nbr), depth_in: Number(r.depth_in) }));

  return json({
    rink_code: rink,
    measured: true,
    point_nbr: n,
    date,
    grid: gridOf(n),
    depth_in: here?.depth_in ?? null,
    temp_f: here?.temp_f ?? null,
    prev_date: prev?.measure_date ?? null,
    prev_depth_in: prev?.depth_in ?? null,
    delta_in:
      here?.depth_in != null && prev?.depth_in != null
        ? Math.round((here.depth_in - prev.depth_in) * 1000) / 1000
        : null,
    headroom_in: headroom,
    threshold_in: getSettingNum("thin_spot_in"),
    neighbours: neighbourRows,
    stats,
    weather: qWeather.get(date) ?? null,
    history: rows,
  });
}

/**
 * The write. Accepts one point or all thirty-five — entry mode sends a single
 * point the moment it is typed, so an interrupted session loses nothing, and
 * the outbox replays the same shape after an outage.
 *
 * Idempotent twice over: the idempotency key short-circuits a replay, and the
 * upsert on (rink, point, date) means even an unkeyed retry converges.
 */
export async function handleWrite(req: Request, actor: string | null): Promise<Response> {
  const replay = replayed(req);
  if (replay) return replay;
  if (!actor) return bad("pick your name first", 401);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return bad("invalid JSON");
  }

  const rink = body.rink_code === "L" || body.rink === "L" ? "L" : "U";
  if (rink !== MEASURED_RINK) {
    return bad("the Lower rink is a sand base and has no surveyed measurement points");
  }

  const date = String(body.date ?? body.measure_date ?? "");
  if (!DATE_RE.test(date)) return bad("date must be YYYY-MM-DD");
  // A future date is a typo, not a measurement. One day of slack covers a
  // device whose clock or timezone runs ahead of the rink's.
  if (date > daysAgoISO(-1)) return bad("that date is in the future");

  const raw = Array.isArray(body.points) ? body.points : null;
  if (!raw || raw.length === 0) return bad("points required");
  if (raw.length > POINT_COUNT) return bad(`at most ${POINT_COUNT} points`);

  const writes: { point: number; depth: number | null; temp: number | null }[] = [];
  const seen = new Set<number>();
  for (const p of raw as Record<string, unknown>[]) {
    const point = Number(p?.point_nbr);
    if (!Number.isInteger(point) || point < 1 || point > POINT_COUNT) {
      return bad(`point_nbr must be 1..${POINT_COUNT}`);
    }
    if (seen.has(point)) return bad(`point ${point} listed twice`);
    seen.add(point);

    const num = (v: unknown, lo: number, hi: number, label: string) => {
      if (v == null || v === "") return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${label} for point ${point} must be ${lo}..${hi}`);
      return Math.round(n * 100) / 100;
    };

    try {
      writes.push({
        point,
        depth: num(p.depth_in, 0, 24, "depth"),
        temp: num(p.temp_f, -20, 60, "temp"),
      });
    } catch (err) {
      return bad((err as Error).message);
    }
  }

  db.transaction(() => {
    for (const w of writes) {
      if (w.depth == null && w.temp == null) {
        qDelete.run({ $rink: rink, $point: w.point, $date: date });
      } else {
        qUpsert.run({ $rink: rink, $point: w.point, $date: date, $depth: w.depth, $temp: w.temp });
      }
    }
  })();

  audit(actor, "ice.write", `${rink}/${date}`, { points: writes.map((w) => w.point) });

  return remember(req, {
    ok: true,
    date,
    rink_code: rink,
    written: writes.map((w) => w.point),
  });
}
