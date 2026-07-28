import { expect, test, describe } from "bun:test";
import {
  DAY_MS,
  isoDate,
  clock12,
  ago,
  daysBetween,
  tickerState,
  dueLabel,
  AMBER_AT,
} from "../public/shared/lib/dates.js";

// 2026-07-28 14:05 ET  →  18:05 UTC
const NOW = Date.parse("2026-07-28T18:05:00Z");
const days = (n: number) => n * DAY_MS;

describe("formatting", () => {
  test("isoDate reports the rink's local day, not UTC's", () => {
    // 01:30 UTC on the 29th is still the 28th in Eastern.
    expect(isoDate(Date.parse("2026-07-29T01:30:00Z"))).toBe("2026-07-28");
    expect(isoDate(NOW)).toBe("2026-07-28");
  });

  test("clock12 is 12-hour with AM/PM — crew format, not Jay's 24h", () => {
    expect(clock12(NOW)).toBe("2:05 PM");
    expect(clock12(Date.parse("2026-07-28T13:00:00Z"))).toBe("9:00 AM");
  });

  test("ago is coarse and never negative-looking", () => {
    expect(ago(null)).toBe("never");
    expect(ago(NOW + 5000, NOW)).toBe("just now");
    expect(ago(NOW - 30 * 60000, NOW)).toBe("30m ago");
    expect(ago(NOW - 5 * 3600000, NOW)).toBe("5h ago");
    expect(ago(NOW - days(3), NOW)).toBe("3d ago");
    expect(ago(NOW - days(21), NOW)).toBe("3w ago");
    expect(ago(NOW - days(200), NOW)).toBe("6mo ago");
  });

  test("daysBetween floors", () => {
    expect(daysBetween(NOW - days(3) - 3600000, NOW)).toBe(3);
    expect(daysBetween(null, NOW)).toBeNull();
  });
});

describe("tickerState", () => {
  const t = (over: Record<string, unknown> = {}) =>
    tickerState({ last_done_at: NOW - days(1), interval_days: 30, nudged_at: null, ...over }, NOW);

  test("fresh is green", () => {
    expect(t().state).toBe("green");
  });

  test("crosses to amber at the configured fraction of the interval", () => {
    expect(t({ last_done_at: NOW - days(30 * AMBER_AT - 1) }).state).toBe("green");
    expect(t({ last_done_at: NOW - days(30 * AMBER_AT + 0.1) }).state).toBe("amber");
  });

  test("goes red once overdue", () => {
    expect(t({ last_done_at: NOW - days(31) }).state).toBe("red");
    expect(t({ last_done_at: NOW - days(31) }).due_in_days).toBeLessThan(0);
  });

  test("never-done is red and flagged, not an error", () => {
    const s = t({ last_done_at: null });
    expect(s.state).toBe("red");
    expect(s.never).toBe(true);
    expect(s.elapsed_days).toBeNull();
  });

  test("a nudge forces amber even when there is runway", () => {
    const s = t({ nudged_at: NOW - 3600000 });
    expect(s.state).toBe("amber");
    expect(s.nudged).toBe(true);
  });

  test("a nudge never downgrades red", () => {
    expect(t({ last_done_at: NOW - days(40), nudged_at: NOW - 3600000 }).state).toBe("red");
  });

  test("doing the job clears an older nudge", () => {
    const s = t({ last_done_at: NOW - days(1), nudged_at: NOW - days(5) });
    expect(s.nudged).toBe(false);
    expect(s.state).toBe("green");
  });

  test("interval-less tickers (propane) are time-since only and never go red", () => {
    const s = tickerState(
      { last_done_at: NOW - days(400), interval_days: null, nudged_at: null },
      NOW
    );
    expect(s.state).toBe("green");
    expect(s.due_in_days).toBeNull();
    expect(s.elapsed_days).toBe(400);
  });

  test("an interval-less ticker still respects a nudge", () => {
    const s = tickerState(
      { last_done_at: NOW - days(2), interval_days: null, nudged_at: NOW - 60000 },
      NOW
    );
    expect(s.state).toBe("amber");
  });
});

describe("dueLabel", () => {
  test("no due date renders no pill at all", () => {
    expect(dueLabel({ due_kind: "none" }, NOW)).toBeNull();
    expect(dueLabel({}, NOW)).toBeNull();
  });

  test("free-text anchors pass through", () => {
    expect(dueLabel({ due_kind: "before", due_text: "the tournament" }, NOW)!.label).toBe(
      "before the tournament"
    );
  });

  test("an empty anchor is not a pill", () => {
    expect(dueLabel({ due_kind: "before", due_text: "   " }, NOW)).toBeNull();
  });

  test("hard timestamps count down, then count overdue", () => {
    expect(dueLabel({ due_kind: "at", due_at: NOW + days(5) }, NOW)!.label).toBe("due in 5d");
    expect(dueLabel({ due_kind: "at", due_at: NOW + days(1.5) }, NOW)!.tone).toBe("amber");
    expect(dueLabel({ due_kind: "at", due_at: NOW + 3600000 * 5 }, NOW)!.label).toBe("due in 5h");
    expect(dueLabel({ due_kind: "at", due_at: NOW - days(3) }, NOW)!.label).toBe("3d overdue");
    expect(dueLabel({ due_kind: "at", due_at: NOW - days(3) }, NOW)!.tone).toBe("red");
  });

  test("a due_kind of at with no timestamp is not a pill", () => {
    expect(dueLabel({ due_kind: "at", due_at: null }, NOW)).toBeNull();
  });
});
