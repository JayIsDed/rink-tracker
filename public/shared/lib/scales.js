// Value → colour ramps, and the statistics behind the anomaly / thin-spot
// language. Pure; colours are returned as strings, nothing touches the DOM.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Piecewise linear ramp over [{t, rgb}] stops with t in 0..1.
 * @returns {string} rgb() string
 */
export function ramp(t, stops) {
  const x = clamp(t, 0, 1);
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (x >= a.t && x <= b.t) {
      const f = b.t === a.t ? 0 : (x - a.t) / (b.t - a.t);
      const c = a.rgb.map((v, j) => Math.round(v + (b.rgb[j] - v) * f));
      return `rgb(${c[0]},${c[1]},${c[2]})`;
    }
  }
  const last = stops[stops.length - 1].rgb;
  return `rgb(${last[0]},${last[1]},${last[2]})`;
}

export const NO_DATA = "rgba(60,80,100,0.2)";

// Depth in inches. Thin ice is the dangerous end, so thin = hot.
const DEPTH_STOPS = [
  { t: 0.0, rgb: [190, 30, 45] },
  { t: 0.25, rgb: [240, 140, 40] },
  { t: 0.5, rgb: [235, 220, 90] },
  { t: 0.75, rgb: [90, 190, 140] },
  { t: 1.0, rgb: [40, 120, 200] },
];

export const DEPTH_MIN = 0.5;
export const DEPTH_MAX = 5.0;

export function colorDepth(v) {
  if (v == null) return NO_DATA;
  return ramp((v - DEPTH_MIN) / (DEPTH_MAX - DEPTH_MIN), DEPTH_STOPS);
}

const TEMP_STOPS = [
  { t: 0.0, rgb: [40, 90, 200] },
  { t: 0.5, rgb: [120, 200, 210] },
  { t: 1.0, rgb: [220, 90, 60] },
];

export function colorTemp(v) {
  if (v == null) return NO_DATA;
  return ramp((v - 10) / 30, TEMP_STOPS);
}

const DELTA_STOPS = [
  { t: 0.0, rgb: [200, 60, 50] },
  { t: 0.5, rgb: [70, 80, 95] },
  { t: 1.0, rgb: [60, 170, 120] },
];

/** Signed change; ±1" saturates. */
export function colorDelta(v) {
  if (v == null) return NO_DATA;
  return ramp((v + 1) / 2, DELTA_STOPS);
}

/**
 * Population standard deviation, guarded against the floating-point negative
 * that AVG(x²)−AVG(x)² produces when every sample is identical.
 */
export function stdev(values) {
  const vals = values.filter((v) => v != null && Number.isFinite(v));
  if (vals.length < 2) return 0;
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  const varc = vals.reduce((s, v) => s + (v - mean) * (v - mean), 0) / vals.length;
  return Math.sqrt(Math.max(0, varc));
}

export function mean(values) {
  const vals = values.filter((v) => v != null && Number.isFinite(v));
  if (vals.length === 0) return null;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

/**
 * How many standard deviations `current` sits from a baseline. Returns 0 when
 * the baseline has no spread — a flat history makes every deviation infinite,
 * which is noise, not signal.
 */
export function zScore(current, baselineMean, baselineStd) {
  if (current == null || baselineMean == null) return 0;
  if (!baselineStd || baselineStd <= 0) return 0;
  return (current - baselineMean) / baselineStd;
}

/**
 * Least-squares slope of value against day-offset, in units per WEEK.
 * This is the erosion-trend number the thin-spot strip reports; n-71 measured
 * pt 11 at −0.039"/wk and pt 9 at +0.108"/wk with this shape.
 *
 * @param {Array<{date:string, value:number}>} series
 * @returns {number|null} null when fewer than 2 usable points
 */
export function trendPerWeek(series) {
  const pts = series
    .filter((p) => p && p.value != null && Number.isFinite(p.value))
    .map((p) => ({ t: Date.parse(p.date + "T00:00:00Z") / 86400000, v: p.value }))
    .filter((p) => Number.isFinite(p.t));
  if (pts.length < 2) return null;

  const n = pts.length;
  const mt = pts.reduce((s, p) => s + p.t, 0) / n;
  const mv = pts.reduce((s, p) => s + p.v, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of pts) {
    num += (p.t - mt) * (p.v - mv);
    den += (p.t - mt) * (p.t - mt);
  }
  if (den === 0) return null;
  return (num / den) * 7; // per-day → per-week
}
