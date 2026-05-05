// Rink Tracker — heatmap routes (ported from ice-tracker/server/server.ts).
//
// All measurements/points/weather/anomaly endpoints. Rink-aware: every query
// takes a rink_code; the legacy default of 'U' (Upper) is preserved when not
// supplied so existing clients don't break.
//
// POST /api/measurements supports the Idempotency-Key header for offline retries.

import { db, json, qIdemGet, qIdemPut } from "../db";

type Point = { rink_code: string; point_nbr: number; grid_col: number; grid_row: number };
type Measurement = { point_nbr: number; depth_in: number | null; temp_f: number | null };
type DateRow = { measure_date: string; depth_count: number; temp_count: number };
type Weather = {
  measure_date: string;
  temp_high_f: number | null;
  temp_low_f: number | null;
  temp_mean_f: number | null;
  precip_in: number | null;
  snow_in: number | null;
  wind_mph_max: number | null;
  cloud_cover_pct: number | null;
  weather_code: number | null;
};

// ──────────────────────────────────────────────────────────────────────
// Prepared queries (rink-parameterized)
// ──────────────────────────────────────────────────────────────────────
const qPoints = db.query<Point, [string]>(
  `SELECT rink_code, point_nbr, grid_col, grid_row FROM points WHERE rink_code = $1 ORDER BY point_nbr`
);
const qDates = db.query<DateRow, [string]>(`
  SELECT measure_date,
         COUNT(*) FILTER (WHERE depth_in IS NOT NULL) AS depth_count,
         COUNT(*) FILTER (WHERE temp_f   IS NOT NULL) AS temp_count
  FROM measurements WHERE rink_code = $1
  GROUP BY measure_date ORDER BY measure_date
`);
const qByDate = db.query<Measurement, [string, string]>(`
  SELECT point_nbr, depth_in, temp_f FROM measurements
  WHERE rink_code = $1 AND measure_date = $2
  ORDER BY point_nbr
`);
const qTimeseries = db.query<{ measure_date: string; depth_in: number | null; temp_f: number | null }, [string, number]>(`
  SELECT measure_date, depth_in, temp_f FROM measurements
  WHERE rink_code = $1 AND point_nbr = $2
  ORDER BY measure_date
`);
const qConcrete = db.query<{ point_nbr: number; min_depth: number; samples: number; min_date: string }, [string]>(`
  SELECT point_nbr,
         ROUND(MIN(depth_in), 2) AS min_depth,
         COUNT(*) AS samples,
         (SELECT measure_date FROM measurements m2
            WHERE m2.rink_code = $1 AND m2.point_nbr = m1.point_nbr
              AND m2.depth_in = (SELECT MIN(depth_in) FROM measurements m3 WHERE m3.rink_code = $1 AND m3.point_nbr = m1.point_nbr)
            LIMIT 1) AS min_date
  FROM measurements m1 WHERE rink_code = $1 AND depth_in IS NOT NULL
  GROUP BY point_nbr ORDER BY point_nbr
`);
const qStats = db.query<{ point_nbr: number; mean_depth: number; std_depth: number; mean_temp: number | null; n: number }, [string]>(`
  SELECT point_nbr,
         ROUND(AVG(depth_in), 3) AS mean_depth,
         ROUND(
           CASE WHEN COUNT(depth_in) > 1
             THEN SQRT(AVG(depth_in*depth_in) - AVG(depth_in)*AVG(depth_in))
             ELSE 0 END,
         3) AS std_depth,
         ROUND(AVG(temp_f), 2) AS mean_temp,
         COUNT(depth_in) AS n
  FROM measurements WHERE rink_code = $1
  GROUP BY point_nbr ORDER BY point_nbr
`);
const qWeatherAll = db.query<Weather, []>(
  `SELECT measure_date, temp_high_f, temp_low_f, temp_mean_f, precip_in, snow_in, wind_mph_max, cloud_cover_pct, weather_code FROM weather ORDER BY measure_date`
);
const qWeatherByDate = db.query<Weather, [string]>(
  `SELECT measure_date, temp_high_f, temp_low_f, temp_mean_f, precip_in, snow_in, wind_mph_max, cloud_cover_pct, weather_code FROM weather WHERE measure_date = $1`
);
const qUpsertMeasurement = db.query(`
  INSERT INTO measurements (rink_code, point_nbr, measure_date, depth_in, temp_f)
  VALUES ($rink, $pt, $date, $depth, $temp)
  ON CONFLICT(rink_code, point_nbr, measure_date) DO UPDATE SET
    depth_in = COALESCE($depth, depth_in),
    temp_f   = COALESCE($temp,  temp_f)
`);
const qDeleteMeasurement = db.query(
  `DELETE FROM measurements WHERE rink_code=$rink AND point_nbr=$pt AND measure_date=$date`
);

// Per-point trailing baseline before a date — drives entry-mode anomaly flags.
// Same trailing math as anomalies but without a "current" value (entry hasn't been
// saved yet) and date-exclusive (so re-editing today doesn't poison its own baseline).
const qBaseline = db.query<
  { point_nbr: number; mean: number; std: number; n: number; last: number | null; last_date: string | null },
  [string, string, string]
>(`
  WITH trailing AS (
    SELECT point_nbr,
           AVG(depth_in) AS mean,
           CASE WHEN COUNT(depth_in) > 1 THEN
             SQRT(MAX(0.0, AVG(depth_in*depth_in) - AVG(depth_in)*AVG(depth_in)))
           ELSE 0 END AS std,
           COUNT(depth_in) AS n
    FROM measurements
    WHERE rink_code = $1
      AND depth_in IS NOT NULL
      AND measure_date < $2
      AND measure_date >= date($2, '-' || $3 || ' days')
    GROUP BY point_nbr
  ),
  most_recent AS (
    SELECT m.point_nbr, m.depth_in AS last, m.measure_date AS last_date
    FROM measurements m
    JOIN (
      SELECT point_nbr, MAX(measure_date) AS d
      FROM measurements
      WHERE rink_code = $1 AND depth_in IS NOT NULL AND measure_date < $2
      GROUP BY point_nbr
    ) x ON x.point_nbr = m.point_nbr AND x.d = m.measure_date
    WHERE m.rink_code = $1
  )
  SELECT t.point_nbr, t.mean, t.std, t.n, r.last, r.last_date
  FROM trailing t LEFT JOIN most_recent r ON r.point_nbr = t.point_nbr
  ORDER BY t.point_nbr
`);

const qAnomalies = db.query<
  { point_nbr: number; current: number | null; mean: number; std: number; n: number },
  [string, string, string]
>(`
  WITH latest AS (
    SELECT point_nbr, depth_in AS current
    FROM measurements
    WHERE rink_code = $1 AND measure_date = $2
  ),
  trailing AS (
    SELECT point_nbr,
           AVG(depth_in) AS mean,
           CASE WHEN COUNT(depth_in) > 1 THEN
             SQRT(MAX(0.0, AVG(depth_in*depth_in) - AVG(depth_in)*AVG(depth_in)))
           ELSE 0 END AS std,
           COUNT(depth_in) AS n
    FROM measurements
    WHERE rink_code = $1
      AND depth_in IS NOT NULL
      AND measure_date < $2
      AND measure_date >= date($2, '-' || $3 || ' days')
    GROUP BY point_nbr
  )
  SELECT t.point_nbr, l.current, t.mean, t.std, t.n
  FROM trailing t LEFT JOIN latest l ON l.point_nbr = t.point_nbr
  ORDER BY t.point_nbr
`);

// ──────────────────────────────────────────────────────────────────────
// Handlers
// ──────────────────────────────────────────────────────────────────────
function getRink(url: URL): string {
  const r = url.searchParams.get("rink");
  return r === "U" || r === "L" ? r : "U";
}

export function handleGetPoints(url: URL): Response {
  return json(qPoints.all(getRink(url)));
}

export function handleGetDates(url: URL): Response {
  return json(qDates.all(getRink(url)));
}

export function handleGetMeasurements(url: URL): Response {
  const date = url.searchParams.get("date");
  if (!date) return json({ error: "missing ?date=YYYY-MM-DD" }, 400);
  return json(qByDate.all(getRink(url), date));
}

export function handleGetTimeseries(url: URL, ptStr: string): Response {
  const pt = Number(ptStr);
  if (!Number.isFinite(pt)) return json({ error: "bad point" }, 400);
  return json(qTimeseries.all(getRink(url), pt));
}

export function handleGetConcrete(url: URL): Response {
  return json(qConcrete.all(getRink(url)));
}

export function handleGetStats(url: URL): Response {
  return json(qStats.all(getRink(url)));
}

export function handleGetAnomalies(url: URL): Response {
  const date = url.searchParams.get("date");
  const windowDays = Number(url.searchParams.get("window") ?? "30");
  if (!date) return json({ error: "missing ?date=YYYY-MM-DD" }, 400);
  const rows = qAnomalies.all(getRink(url), date, String(windowDays));
  return json(rows.map((r) => ({
    ...r,
    z: r.std > 0 && r.current != null ? (r.current - r.mean) / r.std : 0,
  })));
}

export function handleGetBaseline(url: URL): Response {
  const before = url.searchParams.get("before");
  const windowDays = Number(url.searchParams.get("window") ?? "30");
  if (!before || !/^\d{4}-\d{2}-\d{2}$/.test(before)) {
    return json({ error: "missing or invalid ?before=YYYY-MM-DD" }, 400);
  }
  return json(qBaseline.all(getRink(url), before, String(windowDays)));
}

export function handleGetWeatherAll(): Response {
  return json(qWeatherAll.all());
}

export function handleGetWeatherByDate(d: string): Response {
  return json(qWeatherByDate.get(d) ?? null);
}

export async function handlePostMeasurements(req: Request): Promise<Response> {
  // Idempotency: dedupe retries when client supplies Idempotency-Key.
  const idemKey = req.headers.get("idempotency-key");
  if (idemKey) {
    const cached = qIdemGet.get(idemKey);
    if (cached) {
      return new Response(cached.response, {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store", "idempotent-replayed": "1" },
      });
    }
  }

  let body: any;
  try { body = await req.json(); }
  catch { return json({ error: "invalid JSON" }, 400); }

  const rink = body.rink_code === "L" ? "L" : "U";
  const date = body.date;
  const entries = body.entries;

  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return json({ error: "missing or invalid date (expected YYYY-MM-DD)" }, 400);
  }
  if (!Array.isArray(entries)) {
    return json({ error: "entries must be an array" }, 400);
  }

  let written = 0;
  let cleared = 0;
  const tx = db.transaction(() => {
    for (const e of entries) {
      const pt = Number(e.point_nbr);
      if (!Number.isInteger(pt) || pt < 1 || pt > 35) continue;
      const depth = e.depth_in == null || e.depth_in === "" ? null : Number(e.depth_in);
      const temp  = e.temp_f   == null || e.temp_f   === "" ? null : Number(e.temp_f);
      if (depth != null && (!Number.isFinite(depth) || depth < 0 || depth > 24)) continue;
      if (temp  != null && (!Number.isFinite(temp)  || temp < -40 || temp > 100)) continue;

      if (depth == null && temp == null) {
        if (e.clear === true) {
          qDeleteMeasurement.run({ $rink: rink, $pt: pt, $date: date });
          cleared++;
        }
        continue;
      }
      qUpsertMeasurement.run({ $rink: rink, $pt: pt, $date: date, $depth: depth, $temp: temp });
      written++;
    }
  });
  tx();
  const responseBody = JSON.stringify({ ok: true, written, cleared });
  if (idemKey) qIdemPut.run({ $key: idemKey, $response: responseBody, $now: Date.now() });
  return new Response(responseBody, {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
