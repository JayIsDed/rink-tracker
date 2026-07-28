// Inverse-distance-weighted interpolation over the measurement points.
//
// Pure: takes samples, returns a value. The old version read `state.points`
// from an enclosing 1,779-line scope, which is exactly why it could never be
// tested. Same math, no closure.

import { POINT_XY } from "./rink-geom.js";

/** How many nearest samples contribute. */
export const K = 6;
/** Below this squared distance (ft²) we treat the query as sitting on a sample. */
export const EXACT_D2 = 0.5;

/**
 * @param {Array<{point_nbr:number, value:number}>} samples
 * @param {number} xFt
 * @param {number} yFt
 * @returns {{v:number, conf:number}|null} null when no sample has a value
 */
export function fieldAt(samples, xFt, yFt) {
  const have = [];
  for (const s of samples) {
    if (s == null || s.value == null || !Number.isFinite(s.value)) continue;
    const xy = POINT_XY.get(s.point_nbr);
    if (!xy) continue;
    const dx = xFt - xy.x;
    const dy = yFt - xy.y;
    const d2 = dx * dx + dy * dy;
    have.push({ v: s.value, d2, dist: Math.sqrt(d2) });
  }
  if (have.length === 0) return null;

  have.sort((a, b) => a.d2 - b.d2);

  // Sitting on a sample — return it exactly rather than dividing by ~zero.
  if (have[0].d2 < EXACT_D2) return { v: have[0].v, conf: 1.0 };

  const k = Math.min(K, have.length);
  let wsum = 0;
  let vsum = 0;
  for (let i = 0; i < k; i++) {
    const w = 1 / (have[i].dist * have[i].dist);
    wsum += w;
    vsum += w * have[i].v;
  }
  const v = vsum / wsum;

  // Confidence falls off with mean distance to the contributing samples. The
  // 60ft divisor and the 0.5/0.95 clamp are the shipped values, not new.
  const meanDist = have.slice(0, k).reduce((s, u) => s + u.dist, 0) / k;
  const conf = Math.max(0.5, Math.min(0.95, 1.05 - meanDist / 60));
  return { v, conf };
}

/** Convenience: build the sample array from measurement rows for one field. */
export function samplesFrom(rows, key = "depth_in") {
  return rows.map((r) => ({ point_nbr: r.point_nbr, value: r[key] }));
}
