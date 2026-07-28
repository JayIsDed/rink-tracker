// The entry-mode state machine.
//
// This module exists because of how round one failed. Entry mode was the single
// most important surface in the app — 35 numbers, gloves off, cold building —
// and it lived inside a 1,779-line closure where "did that value actually save"
// was unanswerable without reading the network tab. It could not be tested, so
// it was never tested, so it was wrong.
//
// So the machine is separated from the screen. No DOM, no fetch, no timers.
// The view renders whatever this says and calls back in; the outbox reports
// what the server confirmed. Everything here is deterministic and driven in
// tests.
//
// THE LOAD-BEARING RULE: a point is `saved` only when the server has confirmed
// it. Not when it was typed, not when it was queued. The map on screen colours
// from this status, so what the operator sees is what is actually durable —
// which is the one thing round one could not tell them.

import { POINT_COUNT, serpentineOrder, numericOrder, nearestNeighbours } from "./rink-geom.js";

export const STATUS = {
  EMPTY: "empty",
  DIRTY: "dirty",
  QUEUED: "queued",
  SAVED: "saved",
  FAILED: "failed",
};

// Plausibility bands. The hard bounds REJECT; the soft bounds only flag, since
// unusual ice is a thing that happens and an app that refuses to record reality
// teaches people to stop recording.
export const DEPTH_HARD = { min: 0, max: 24 };
export const DEPTH_SOFT = { min: 0.5, max: 6 };
export const TEMP_HARD = { min: -20, max: 60 };
export const TEMP_SOFT = { min: 10, max: 34 };

/** How far off its neighbours a depth has to sit before entry calls it suspect. */
export const NEIGHBOUR_FLAG_IN = 1.25;

function checkNumber(raw, hard, soft, label) {
  if (raw === "" || raw == null) return { ok: true, value: null, warn: null };
  const v = Number(raw);
  if (!Number.isFinite(v)) return { ok: false, value: null, reason: `${label} must be a number` };
  if (v < hard.min || v > hard.max) {
    return { ok: false, value: null, reason: `${label} must be between ${hard.min} and ${hard.max}` };
  }
  const warn = v < soft.min || v > soft.max ? `${label} of ${v} is outside the usual range` : null;
  return { ok: true, value: v, warn };
}

export const validateDepth = (raw) => checkNumber(raw, DEPTH_HARD, DEPTH_SOFT, "Depth");
export const validateTemp = (raw) => checkNumber(raw, TEMP_HARD, TEMP_SOFT, "Temp");

/**
 * @param {object} opts
 * @param {string} opts.rink            "U" | "L"
 * @param {string} opts.date            YYYY-MM-DD
 * @param {"walk"|"numeric"} [opts.order="walk"]
 * @param {number} [opts.thinAt=2.0]    thin-spot threshold, inches
 */
export function createEntry({ rink, date, order = "walk", thinAt = 2.0 } = {}) {
  let sequence = order === "numeric" ? numericOrder() : serpentineOrder();
  let cursor = 0;

  /** point_nbr → {depth_in, temp_f, status, error} */
  const points = new Map();
  for (let n = 1; n <= POINT_COUNT; n++) {
    points.set(n, { point_nbr: n, depth_in: null, temp_f: null, status: STATUS.EMPTY, error: null });
  }

  const rec = (n) => points.get(n) ?? null;

  const api = {
    rink,
    date,

    get order() {
      return order;
    },
    get sequence() {
      return [...sequence];
    },

    /**
     * Reorder the walk. The cursor follows the point it was ON, not the index —
     * switching order mid-session must never silently move the operator to a
     * different part of the sheet than the one they are standing at.
     */
    setOrder(next) {
      const here = api.current();
      order = next === "numeric" ? "numeric" : "walk";
      sequence = order === "numeric" ? numericOrder() : serpentineOrder();
      const idx = sequence.indexOf(here);
      cursor = idx >= 0 ? idx : 0;
      return api;
    },

    // ── Cursor ──
    current() {
      return sequence[cursor];
    },
    position() {
      return { index: cursor, total: sequence.length, point_nbr: sequence[cursor] };
    },
    next() {
      cursor = Math.min(sequence.length - 1, cursor + 1);
      return api.current();
    },
    prev() {
      cursor = Math.max(0, cursor - 1);
      return api.current();
    },
    atEnd() {
      return cursor >= sequence.length - 1;
    },
    jumpTo(nbr) {
      const idx = sequence.indexOf(Number(nbr));
      if (idx >= 0) cursor = idx;
      return api.current();
    },
    /** Next point in walk order with nothing recorded, wrapping. Null if done. */
    nextUnmeasured(from = cursor) {
      for (let i = 1; i <= sequence.length; i++) {
        const n = sequence[(from + i) % sequence.length];
        if (rec(n).depth_in == null && rec(n).temp_f == null) return n;
      }
      return null;
    },

    // ── Values ──
    get(nbr) {
      const r = rec(Number(nbr));
      return r ? { ...r } : null;
    },
    all() {
      return [...points.values()].map((r) => ({ ...r }));
    },

    /**
     * Record a typed value. Returns {ok, warn, reason} — a rejected value never
     * enters the state, so the machine cannot hold something the server will
     * refuse. Writing a value always drops the point back to DIRTY: an edit
     * after a save is unsaved again until the server says otherwise.
     */
    setValue(nbr, { depth, temp } = {}) {
      const r = rec(Number(nbr));
      if (!r) return { ok: false, reason: `no point ${nbr}` };

      const warns = [];
      let d = r.depth_in;
      let t = r.temp_f;

      if (depth !== undefined) {
        const v = validateDepth(depth);
        if (!v.ok) return { ok: false, reason: v.reason };
        d = v.value;
        if (v.warn) warns.push(v.warn);
      }
      if (temp !== undefined) {
        const v = validateTemp(temp);
        if (!v.ok) return { ok: false, reason: v.reason };
        t = v.value;
        if (v.warn) warns.push(v.warn);
      }

      r.depth_in = d;
      r.temp_f = t;
      r.error = null;
      r.status = d == null && t == null ? STATUS.EMPTY : STATUS.DIRTY;
      return { ok: true, warn: warns.length ? warns.join(" · ") : null };
    },

    // ── Durability transitions (driven by the outbox, never by typing) ──
    markQueued(nbrs) {
      for (const n of [].concat(nbrs)) {
        const r = rec(Number(n));
        if (r && r.status === STATUS.DIRTY) r.status = STATUS.QUEUED;
      }
      return api;
    },
    markSaved(nbrs) {
      for (const n of [].concat(nbrs)) {
        const r = rec(Number(n));
        // A value edited while its write was in flight stays DIRTY — confirming
        // the OLD write must not paint the NEW value as durable.
        if (r && r.status === STATUS.QUEUED) {
          r.status = STATUS.SAVED;
          r.error = null;
        }
      }
      return api;
    },
    markFailed(nbrs, reason) {
      for (const n of [].concat(nbrs)) {
        const r = rec(Number(n));
        if (r && (r.status === STATUS.QUEUED || r.status === STATUS.DIRTY)) {
          r.status = STATUS.FAILED;
          r.error = reason ?? "write failed";
        }
      }
      return api;
    },

    /** Rows the server already holds. Land as SAVED — they are durable. */
    hydrate(rows = []) {
      for (const row of rows) {
        const r = rec(Number(row.point_nbr));
        if (!r) continue;
        if (row.depth_in == null && row.temp_f == null) continue;
        r.depth_in = row.depth_in ?? null;
        r.temp_f = row.temp_f ?? null;
        r.status = STATUS.SAVED;
        r.error = null;
      }
      // Resume where the work actually stopped, not at point 1.
      const gap = api.nextUnmeasured(-1);
      if (gap != null) api.jumpTo(gap);
      return api;
    },

    /** Everything not yet confirmed by the server, in walk order. */
    pending() {
      return sequence
        .map((n) => rec(n))
        .filter((r) => r.status === STATUS.DIRTY || r.status === STATUS.FAILED)
        .map((r) => ({ point_nbr: r.point_nbr, depth_in: r.depth_in, temp_f: r.temp_f }));
    },

    // ── Derived ──
    progress() {
      let saved = 0;
      let inflight = 0;
      let failed = 0;
      let measured = 0;
      for (const r of points.values()) {
        const has = r.depth_in != null || r.temp_f != null;
        if (has) measured++;
        if (r.status === STATUS.SAVED) saved++;
        else if (r.status === STATUS.QUEUED || r.status === STATUS.DIRTY) inflight++;
        else if (r.status === STATUS.FAILED) failed++;
      }
      return {
        measured,
        saved,
        inflight,
        failed,
        total: POINT_COUNT,
        remaining: POINT_COUNT - measured,
        complete: measured === POINT_COUNT,
        durable: saved === measured && failed === 0,
      };
    },

    stats() {
      const vals = [...points.values()].map((r) => r.depth_in).filter((v) => v != null);
      if (!vals.length) return { n: 0, min: null, max: null, mean: null };
      const sum = vals.reduce((s, v) => s + v, 0);
      return { n: vals.length, min: Math.min(...vals), max: Math.max(...vals), mean: sum / vals.length };
    },

    /**
     * Points worth a second look before walking away: at or under the thin
     * threshold, or far enough off their measured neighbours to look mistyped.
     *
     * Deliberately a plain absolute comparison, not a z-score — the client holds
     * one session and has no per-point history. The statistically real anomaly
     * call belongs to the server, which does have it. Two different questions:
     * "did you fat-finger this" here, "is this ice eroding" there.
     */
    review() {
      const out = [];
      for (const r of points.values()) {
        if (r.depth_in == null) continue;
        const near = nearestNeighbours(r.point_nbr, 4)
          .map((nb) => rec(nb.point_nbr).depth_in)
          .filter((v) => v != null);
        const nbMean = near.length ? near.reduce((s, v) => s + v, 0) / near.length : null;
        const off = nbMean == null ? null : r.depth_in - nbMean;

        const thin = r.depth_in <= thinAt;
        const odd = off != null && Math.abs(off) >= NEIGHBOUR_FLAG_IN;
        const wild = r.depth_in < DEPTH_SOFT.min || r.depth_in > DEPTH_SOFT.max;
        if (!thin && !odd && !wild) continue;

        out.push({
          point_nbr: r.point_nbr,
          depth_in: r.depth_in,
          neighbour_mean: nbMean,
          off_by: off,
          thin,
          odd,
          wild,
        });
      }
      // Thinnest first — the thin spot is the reason this screen exists.
      return out.sort((a, b) => a.depth_in - b.depth_in);
    },
  };

  return api;
}
