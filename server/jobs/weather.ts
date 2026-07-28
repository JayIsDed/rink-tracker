// Weather, from open-meteo. No key required.
//
// This is the job that died. It stopped on 2026-05-05 and ten consecutive
// measurement sessions (05-12 → 07-14) were logged with no weather row before
// anyone noticed — because nothing anywhere said "the last successful run was
// in May". Two things follow from that, and both are requirements, not polish:
//
//   1. every run writes to job_runs, pass or fail (see ./runs)
//   2. the job BACKFILLS — it looks for measurement dates that have no weather
//      row and fetches those, rather than only ever fetching today. A pull that
//      only fetches today can never repair a gap it created.

import { db } from "../db";
import { recordRun } from "./runs";

// Torrington, CT — the rink's location, rounded to the grid open-meteo serves.
export const LAT = Number(process.env.RINK_LAT ?? 41.8);
export const LON = Number(process.env.RINK_LON ?? -73.12);
const TZ = "America/New_York";

const ARCHIVE = "https://archive-api.open-meteo.com/v1/archive";
const FORECAST = "https://api.open-meteo.com/v1/forecast";

const DAILY = [
  "temperature_2m_max",
  "temperature_2m_min",
  "temperature_2m_mean",
  "precipitation_sum",
  "snowfall_sum",
  "windspeed_10m_max",
  "weathercode",
].join(",");

const qMissing = db.query<{ measure_date: string }, []>(`
  SELECT DISTINCT m.measure_date
    FROM measurements m
    LEFT JOIN weather w ON w.measure_date = m.measure_date
   WHERE w.measure_date IS NULL
   ORDER BY m.measure_date
`);

const qUpsert = db.query(`
  INSERT INTO weather (measure_date, temp_high_f, temp_low_f, temp_mean_f,
                       precip_in, snow_in, wind_mph_max, cloud_cover_pct,
                       weather_code, source)
  VALUES ($d, $hi, $lo, $mean, $precip, $snow, $wind, NULL, $code, 'open-meteo')
  ON CONFLICT(measure_date) DO UPDATE SET
    temp_high_f = excluded.temp_high_f,
    temp_low_f  = excluded.temp_low_f,
    temp_mean_f = excluded.temp_mean_f,
    precip_in   = excluded.precip_in,
    snow_in     = excluded.snow_in,
    wind_mph_max= excluded.wind_mph_max,
    weather_code= excluded.weather_code,
    source      = 'open-meteo'
`);

/** Measurement dates with no weather row. This is the gap, measured. */
export function missingDates(): string[] {
  return qMissing.all().map((r) => r.measure_date);
}

const cToF = (c: number | null) => (c == null ? null : c * 9 / 5 + 32);
const mmToIn = (mm: number | null) => (mm == null ? null : mm / 25.4);
const cmToIn = (cm: number | null) => (cm == null ? null : cm / 2.54);
const kmhToMph = (k: number | null) => (k == null ? null : k / 1.609344);

type DailyPayload = {
  daily?: {
    time: string[];
    temperature_2m_max: (number | null)[];
    temperature_2m_min: (number | null)[];
    temperature_2m_mean: (number | null)[];
    precipitation_sum: (number | null)[];
    snowfall_sum: (number | null)[];
    windspeed_10m_max: (number | null)[];
    weathercode: (number | null)[];
  };
};

export function storeDaily(p: DailyPayload): number {
  const d = p.daily;
  if (!d || !Array.isArray(d.time)) return 0;
  let n = 0;
  db.transaction(() => {
    d.time.forEach((day, i) => {
      qUpsert.run({
        $d: day,
        $hi: cToF(d.temperature_2m_max?.[i] ?? null),
        $lo: cToF(d.temperature_2m_min?.[i] ?? null),
        $mean: cToF(d.temperature_2m_mean?.[i] ?? null),
        $precip: mmToIn(d.precipitation_sum?.[i] ?? null),
        $snow: cmToIn(d.snowfall_sum?.[i] ?? null),
        $wind: kmhToMph(d.windspeed_10m_max?.[i] ?? null),
        $code: d.weathercode?.[i] ?? null,
      });
      n++;
    });
  })();
  return n;
}

/**
 * Fill every measurement date that has no weather row. Ranges are batched by
 * contiguous span so a 10-day gap is one request, not ten.
 */
export async function backfillWeather(fetchImpl: typeof fetch = fetch): Promise<{
  ok: boolean;
  missingBefore: number;
  filled: number;
  missingAfter: number;
  detail: string;
}> {
  const started = Date.now();
  const missing = missingDates();
  if (missing.length === 0) {
    recordRun("weather", true, "no gaps", Date.now() - started);
    return { ok: true, missingBefore: 0, filled: 0, missingAfter: 0, detail: "no gaps" };
  }

  try {
    // The archive API lags ~5 days; anything newer comes from the forecast
    // endpoint with past_days. Splitting on that boundary is what makes a
    // same-week session fillable at all.
    const cutoff = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
    const old = missing.filter((d) => d < cutoff);
    const recent = missing.filter((d) => d >= cutoff);

    let filled = 0;

    if (old.length) {
      const url = `${ARCHIVE}?latitude=${LAT}&longitude=${LON}&start_date=${old[0]}&end_date=${old[old.length - 1]}&daily=${DAILY}&temperature_unit=celsius&timezone=${encodeURIComponent(TZ)}`;
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(45000) });
      if (!res.ok) throw new Error(`archive ${res.status}`);
      filled += storeDaily((await res.json()) as DailyPayload);
    }

    if (recent.length) {
      const url = `${FORECAST}?latitude=${LAT}&longitude=${LON}&past_days=14&forecast_days=1&daily=${DAILY}&temperature_unit=celsius&timezone=${encodeURIComponent(TZ)}`;
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(45000) });
      if (!res.ok) throw new Error(`forecast ${res.status}`);
      filled += storeDaily((await res.json()) as DailyPayload);
    }

    const after = missingDates();
    const detail = `gap ${missing.length} → ${after.length} (wrote ${filled} day rows)`;
    // Filling nothing when a gap exists is a failure, not a quiet success —
    // that is precisely the state this job sat in for two months.
    const ok = after.length < missing.length || missing.length === 0;
    recordRun("weather", ok, detail, Date.now() - started);
    return { ok, missingBefore: missing.length, filled, missingAfter: after.length, detail };
  } catch (err) {
    const detail = String((err as Error)?.message ?? err);
    recordRun("weather", false, detail, Date.now() - started);
    return { ok: false, missingBefore: missing.length, filled: 0, missingAfter: missing.length, detail };
  }
}
