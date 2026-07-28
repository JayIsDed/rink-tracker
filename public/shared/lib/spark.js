// A sparkline, as geometry.
//
// Round one drew this inline in the point-detail panel: it measured the canvas,
// computed the scale and stroked the path in one function, so the only way to
// ask "does a flat series sit on the baseline or off the top edge" was to look
// at a screenshot. Here the shape is a pure function of the series and a box,
// and the view strokes whatever comes back.
//
// Coordinate space is the box: x→right, y→DOWN (canvas convention), so the
// HIGHEST value has the SMALLEST y. Getting that inverted is the classic
// upside-down-chart bug and a test pins it.

/**
 * Lay out a series inside a box.
 *
 * @param {Array<{date:string, value:number}>} series  chronological
 * @param {object} box
 * @param {number} box.w  width in px
 * @param {number} box.h  height in px
 * @param {number} [box.pad=3]  inset so the stroke and the dot aren't clipped
 * @returns {{
 *   points: Array<{x:number, y:number, value:number, date:string}>,
 *   min:number, max:number, first:object|null, last:object|null,
 *   baselineY:number|null, flat:boolean
 * }|null} null when there is nothing worth drawing (fewer than two readings)
 */
export function sparkline(series, { w, h, pad = 3 } = {}) {
  const pts = (series ?? [])
    .filter((p) => p && p.value != null && Number.isFinite(p.value))
    .map((p) => ({ date: String(p.date), value: Number(p.value), t: Date.parse(`${p.date}T12:00:00Z`) }))
    .filter((p) => Number.isFinite(p.t))
    .sort((a, b) => a.t - b.t);

  // One reading is a dot, not a line, and a dot conveys nothing about trend.
  if (pts.length < 2 || !(w > 0) || !(h > 0)) return null;

  const values = pts.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const flat = max === min;

  const t0 = pts[0].t;
  const t1 = pts[pts.length - 1].t;
  const spanT = t1 - t0;
  const innerW = Math.max(0, w - pad * 2);
  const innerH = Math.max(0, h - pad * 2);
  const spanV = flat ? 1 : max - min;

  const points = pts.map((p, i) => ({
    // Time-proportional, not index-proportional. Sessions are weekly-ish but
    // not evenly spaced, and an index axis silently redraws a two-month gap as
    // one step — which is exactly the kind of quiet lie a trend line must not
    // tell.
    x: pad + (spanT === 0 ? (i / (pts.length - 1)) * innerW : ((p.t - t0) / spanT) * innerW),
    // A flat series sits on the middle line rather than pinned to an edge,
    // where it would read as "at the maximum" or "at the minimum".
    y: pad + (flat ? innerH / 2 : (1 - (p.value - min) / spanV) * innerH),
    value: p.value,
    date: p.date,
  }));

  return {
    points,
    min,
    max,
    flat,
    first: points[0],
    last: points[points.length - 1],
    baselineY: null,
  };
}

/**
 * The same layout, plus the y of a reference value (the thin-spot threshold)
 * when it falls inside the drawn range. Outside the range it is null — drawing
 * a threshold line clamped to the edge would claim the series touches it.
 */
export function sparklineWithThreshold(series, box, threshold) {
  const s = sparkline(series, box);
  if (!s) return null;
  if (threshold == null || !Number.isFinite(threshold)) return s;
  if (s.flat || threshold < s.min || threshold > s.max) return s;
  const pad = box?.pad ?? 3;
  const innerH = Math.max(0, (box?.h ?? 0) - pad * 2);
  return { ...s, baselineY: pad + (1 - (threshold - s.min) / (s.max - s.min)) * innerH };
}
