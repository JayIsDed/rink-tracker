// Time, interval and ticker maths. Pure — every function takes `now` so tests
// don't depend on the wall clock.
//
// Crew-facing format is 12-hour AM/PM: this app has a general audience, not
// Jay's personal 24h preference (runbook, needs-Jay).

export const DAY_MS = 86400000;

/** YYYY-MM-DD in the given IANA zone (default the rink's local zone). */
export function isoDate(now = Date.now(), tz = "America/New_York") {
  const d = new Date(now);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** "2:05 PM" — crew-facing clock. */
export function clock12(ts, tz = "America/New_York") {
  if (ts == null) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(ts));
}

/** "Jul 28" / "Jul 28, 2025" when the year differs from now's. */
export function shortDate(ts, now = Date.now(), tz = "America/New_York") {
  if (ts == null) return "—";
  const y = (t) => new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric" }).format(new Date(t));
  const sameYear = y(ts) === y(now);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(new Date(ts));
}

/** "Jul 28, 2:05 PM" */
export function stamp(ts, now = Date.now(), tz = "America/New_York") {
  if (ts == null) return "—";
  return `${shortDate(ts, now, tz)}, ${clock12(ts, tz)}`;
}

/**
 * Time-since, the trust primitive. Coarse on purpose — "3 days ago" is what a
 * crew member needs; "3d 4h 12m" is noise on a wall of tickers.
 */
export function ago(ts, now = Date.now()) {
  if (ts == null) return "never";
  const ms = now - ts;
  if (ms < 0) return "just now";
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 14) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 9) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 24) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/** Whole days elapsed between two epoch-ms stamps. */
export function daysBetween(from, to) {
  if (from == null || to == null) return null;
  return Math.floor((to - from) / DAY_MS);
}

// ── Ticker state machine ──────────────────────────────────────────────
//
// A ticker is green while there is comfortable runway, amber as it comes due,
// red once it is overdue. Anyone can NUDGE a ticker ("blade's dull") which
// forces amber regardless of elapsed time — the nudge is a human observation
// and it outranks the calendar. A nudge never downgrades red.

/** Fraction of the interval at which green becomes amber. */
export const AMBER_AT = 0.8;

export const TICKER_STATES = ["green", "amber", "red"];

/**
 * @param {object} t
 * @param {number|null} t.last_done_at   epoch ms of the last completion
 * @param {number}      t.interval_days
 * @param {number|null} t.nudged_at      epoch ms, or null
 * @param {number}      now
 * @returns {{state:string, elapsed_days:number|null, due_in_days:number|null,
 *            fraction:number|null, nudged:boolean, never:boolean}}
 */
export function tickerState(t, now = Date.now()) {
  const interval = Number(t.interval_days);
  const hasInterval = Number.isFinite(interval) && interval > 0;

  // A nudge only counts if it landed after the last completion — doing the job
  // clears the complaint.
  const nudged =
    t.nudged_at != null && (t.last_done_at == null || t.nudged_at > t.last_done_at);

  if (t.last_done_at == null) {
    // Never done. Not an error state — a new ticker is legitimately blank, and
    // "credible when half-empty" is a law. Red, because it IS outstanding.
    return {
      state: "red",
      elapsed_days: null,
      due_in_days: null,
      fraction: null,
      nudged,
      never: true,
    };
  }

  const elapsed = (now - t.last_done_at) / DAY_MS;
  const elapsed_days = Math.floor(elapsed);

  if (!hasInterval) {
    // Time-since-only ticker (propane is the case): no deadline, never red.
    return {
      state: nudged ? "amber" : "green",
      elapsed_days,
      due_in_days: null,
      fraction: null,
      nudged,
      never: false,
    };
  }

  const fraction = elapsed / interval;
  const due_in_days = Math.ceil(interval - elapsed);

  let state;
  if (fraction >= 1) state = "red";
  else if (fraction >= AMBER_AT) state = "amber";
  else state = "green";

  // Nudge escalates to amber but never masks red.
  if (nudged && state === "green") state = "amber";

  return { state, elapsed_days, due_in_days, fraction, nudged, never: false };
}

// ── Due dates on cards ────────────────────────────────────────────────
//
// Trichotomy (ruled 07-28): a hard timestamp, a free-text anchor ("before the
// tournament"), or nothing. Optional is load-bearing — no forced fields.

/**
 * @returns {{kind:string, label:string, tone:string}|null} null when due_kind
 *   is "none", so callers can skip rendering the pill entirely.
 */
export function dueLabel(card, now = Date.now()) {
  if (!card || card.due_kind === "none" || card.due_kind == null) return null;

  if (card.due_kind === "before") {
    const text = (card.due_text || "").trim();
    if (!text) return null;
    return { kind: "before", label: `before ${text}`, tone: "neutral" };
  }

  if (card.due_kind === "at" && card.due_at != null) {
    const ms = card.due_at - now;
    const days = Math.floor(Math.abs(ms) / DAY_MS);
    if (ms < 0) {
      return {
        kind: "at",
        label: days === 0 ? "overdue today" : `${days}d overdue`,
        tone: "red",
      };
    }
    const hrs = Math.floor(ms / 3600000);
    if (hrs < 24) return { kind: "at", label: hrs <= 1 ? "due now" : `due in ${hrs}h`, tone: "amber" };
    return {
      kind: "at",
      label: `due in ${days}d`,
      tone: days <= 2 ? "amber" : "neutral",
    };
  }

  return null;
}
