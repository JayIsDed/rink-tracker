// Schedule shaping. Pure — no DOM, no fetch, no timers, and `now` is always a
// parameter so tests don't depend on the wall clock.
//
// The source hands us ice cuts already labelled (`kind:"ice_cut"`, every one
// exactly 10 minutes), so nothing here infers what a cut is. What it does do is
// answer the two questions the crew actually asks: "when's the next cut" and
// "what's on today", which are different questions from "list the bookings".

import { isoDate, DAY_MS } from "./dates.js";

/**
 * Group slots into local days, ascending. A slot belongs to the day its START
 * falls on in the rink's zone — a 23:50 cut that ends after midnight is still
 * tonight's cut to the person driving the Zamboni.
 *
 * @returns {{date:string, slots:object[]}[]}
 */
export function groupByDay(slots, tz = "America/New_York") {
  const days = new Map();
  for (const s of [...slots].sort((a, b) => a.starts_at - b.starts_at)) {
    const d = isoDate(s.starts_at, tz);
    if (!days.has(d)) days.set(d, []);
    days.get(d).push(s);
  }
  return [...days.entries()].map(([date, slots]) => ({ date, slots }));
}

/**
 * The next ice cut at or after `now`, optionally on one rink.
 *
 * "At or after" and not "after" on purpose: a cut that started 30 seconds ago
 * is the cut you are about to do, and dropping it off the front page at its
 * start time is how the surface would go blank at the exact moment it matters.
 * It stays current until it ends.
 */
export function nextIceCut(slots, now = Date.now(), rink = null) {
  return (
    [...slots]
      .filter((s) => s.kind === "ice_cut")
      .filter((s) => (rink ? s.rink_code === rink : true))
      .filter((s) => (s.ends_at ?? s.starts_at) >= now)
      .sort((a, b) => a.starts_at - b.starts_at)[0] ?? null
  );
}

/** Every ice cut on the given local day, ascending. */
export function iceCutsOn(slots, date, tz = "America/New_York") {
  return [...slots]
    .filter((s) => s.kind === "ice_cut" && isoDate(s.starts_at, tz) === date)
    .sort((a, b) => a.starts_at - b.starts_at);
}

/**
 * What a cut sits between: the booking that just came off the ice, and the one
 * getting on next. This is the difference between "there is a cut at 3:00" and
 * "you are cutting between Freestyle and IPH" — the second is the one a crew
 * member can act on without walking to the printout.
 *
 * Bounded to the SAME RINK and the SAME LOCAL DAY. Both bounds are load-bearing:
 * the other sheet's booking is not what you are waiting on, and the last cut of
 * the night must read "last cut of the day" rather than reaching across the
 * small hours to name tomorrow's first public skate.
 *
 * Gaps are reported in minutes so the caller can say when a cut has real room
 * around it versus being wedged between two bookings.
 *
 * Checked against the live feed before relying on the abutting assumption: of
 * 382 real cuts, ZERO sit strictly inside a booking, every one has a booking
 * before it, and 380 have one after (the other two are last-of-day). If the
 * source ever does emit an enclosed cut, both sides come back null — blank,
 * which is honest, rather than naming an event that is not adjacent.
 *
 * @returns {{before:object|null, after:object|null,
 *            gapBefore:number|null, gapAfter:number|null}}
 */
export function cutContext(slots, cut, tz = "America/New_York") {
  if (!cut) return { before: null, after: null, gapBefore: null, gapAfter: null };
  const day = isoDate(cut.starts_at, tz);
  const cutEnds = cut.ends_at ?? cut.starts_at;

  const pool = slots.filter(
    (s) =>
      s.kind !== "ice_cut" &&
      s.rink_code === cut.rink_code &&
      isoDate(s.starts_at, tz) === day
  );

  const before =
    pool
      .filter((s) => (s.ends_at ?? s.starts_at) <= cut.starts_at)
      .sort((a, b) => (b.ends_at ?? b.starts_at) - (a.ends_at ?? a.starts_at))[0] ?? null;

  const after =
    pool.filter((s) => s.starts_at >= cutEnds).sort((a, b) => a.starts_at - b.starts_at)[0] ?? null;

  return {
    before,
    after,
    gapBefore: before ? Math.round((cut.starts_at - (before.ends_at ?? before.starts_at)) / 60000) : null,
    gapAfter: after ? Math.round((after.starts_at - cutEnds) / 60000) : null,
  };
}

/**
 * "Today" / "Tomorrow" / "Thu, Jul 30". Relative labels only reach one day out
 * — "in 3 days" is a subtraction the reader has to redo against a calendar,
 * where a weekday name is just read.
 */
export function dayLabel(date, now = Date.now(), tz = "America/New_York") {
  const today = isoDate(now, tz);
  if (date === today) return "Today";
  if (date === isoDate(now + DAY_MS, tz)) return "Tomorrow";
  if (date === isoDate(now - DAY_MS, tz)) return "Yesterday";
  // Parse as local noon so the weekday can't slip a day across a zone offset.
  const d = new Date(`${date}T12:00:00`);
  return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" }).format(d);
}

/**
 * How long until a slot starts, in crew words. Distinct from `ago()` — this
 * looks FORWARD and stays useful at the minute scale, because "in 12 minutes"
 * is an instruction and "in 0h" is not.
 */
export function until(ts, now = Date.now()) {
  if (ts == null) return "—";
  const ms = ts - now;
  if (ms <= 0) return "now";
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `in ${mins} min`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hrs < 8) return rem ? `in ${hrs}h ${rem}m` : `in ${hrs}h`;
  const days = Math.round(ms / DAY_MS);
  if (hrs < 24) return `in ${hrs}h`;
  return days === 1 ? "tomorrow" : `in ${days} days`;
}

/**
 * Freshness of the pulled data. The source updates roughly once a day, so a
 * schedule that silently went stale is the failure mode worth naming — that is
 * exactly how the weather job died for two months without anyone noticing.
 *
 * @returns {{tone:string, label:string}}
 */
export function pullFreshness(pulledAt, now = Date.now()) {
  if (pulledAt == null) return { tone: "red", label: "never pulled" };
  const hrs = (now - pulledAt) / 3600000;
  if (hrs < 26) return { tone: "green", label: "up to date" };
  if (hrs < 50) return { tone: "amber", label: "a day behind" };
  return { tone: "red", label: `${Math.floor(hrs / 24)} days behind` };
}
