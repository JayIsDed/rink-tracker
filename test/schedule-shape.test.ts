import { expect, test, describe } from "bun:test";
import {
  groupByDay,
  nextIceCut,
  iceCutsOn,
  cutContext,
  dayLabel,
  until,
  pullFreshness,
} from "../public/shared/lib/schedule.js";
import { DAY_MS } from "../public/shared/lib/dates.js";

// 2026-07-28 14:05 ET → 18:05 UTC. Same anchor dates.test.ts uses.
const NOW = Date.parse("2026-07-28T18:05:00Z");

const slot = (starts: string, mins = 10, kind = "ice_cut", rink = "U", title = "Ice Cut") => ({
  id: Math.round(Date.parse(starts) / 1000),
  rink_code: rink,
  starts_at: Date.parse(starts),
  ends_at: Date.parse(starts) + mins * 60000,
  title,
  kind,
});

describe("groupByDay", () => {
  test("groups into local days, ascending, regardless of input order", () => {
    const days = groupByDay([
      slot("2026-07-29T14:00:00Z"),
      slot("2026-07-28T14:00:00Z"),
      slot("2026-07-28T16:00:00Z"),
    ]);
    expect(days.map((d) => d.date)).toEqual(["2026-07-28", "2026-07-29"]);
    expect(days[0].slots).toHaveLength(2);
    expect(days[0].slots[0].starts_at).toBeLessThan(days[0].slots[1].starts_at);
  });

  test("a late-night slot belongs to the day it STARTS, in rink-local time", () => {
    // 23:50 ET on the 28th is 03:50 UTC on the 29th. To the person driving the
    // Zamboni this is still tonight — grouping by UTC would file it tomorrow.
    const late = slot("2026-07-29T03:50:00Z");
    expect(groupByDay([late])[0].date).toBe("2026-07-28");
  });
});

describe("nextIceCut", () => {
  const slots = [
    slot("2026-07-28T12:00:00Z"), // past
    slot("2026-07-28T19:00:00Z"), // next
    slot("2026-07-28T20:00:00Z", 10, "ice_cut", "L"),
    slot("2026-07-28T18:30:00Z", 90, "booking", "U", "Freestyle"),
  ];

  test("ignores bookings and past cuts", () => {
    const n = nextIceCut(slots, NOW);
    expect(n?.starts_at).toBe(Date.parse("2026-07-28T19:00:00Z"));
  });

  test("a cut already in progress is still the next cut", () => {
    // The one that matters most: at 18:05 a cut that started at 18:00 and runs
    // to 18:10 is the cut you are doing right now. Filtering on start time
    // would blank the strip at the exact moment it earns its place.
    const running = slot("2026-07-28T18:00:00Z");
    expect(nextIceCut([running], NOW)?.id).toBe(running.id);
  });

  test("a cut that has finished is not", () => {
    expect(nextIceCut([slot("2026-07-28T17:50:00Z")], NOW)).toBeNull();
  });

  test("filters by rink when asked", () => {
    expect(nextIceCut(slots, NOW, "L")?.rink_code).toBe("L");
  });

  test("returns null rather than throwing on an empty schedule", () => {
    expect(nextIceCut([], NOW)).toBeNull();
  });
});

describe("iceCutsOn", () => {
  test("returns only that local day's cuts, ascending", () => {
    const cuts = iceCutsOn(
      [
        slot("2026-07-28T20:00:00Z"),
        slot("2026-07-28T14:00:00Z"),
        slot("2026-07-29T14:00:00Z"),
        slot("2026-07-28T15:00:00Z", 90, "booking", "U", "Public Skate"),
      ],
      "2026-07-28"
    );
    expect(cuts).toHaveLength(2);
    expect(cuts[0].starts_at).toBeLessThan(cuts[1].starts_at);
  });
});

describe("cutContext", () => {
  // A realistic afternoon on the Upper sheet.
  const freestyle = slot("2026-07-28T18:00:00Z", 60, "booking", "U", "Freestyle Figure Skating");
  const cut = slot("2026-07-28T19:00:00Z", 10, "ice_cut", "U");
  const iph = slot("2026-07-28T19:10:00Z", 120, "booking", "U", "IPH");
  const otherSheet = slot("2026-07-28T19:05:00Z", 60, "booking", "L", "Learn to Skate");

  test("names what came off and what goes on, with the gaps", () => {
    const ctx = cutContext([freestyle, cut, iph, otherSheet], cut);
    expect(ctx.before?.title).toBe("Freestyle Figure Skating");
    expect(ctx.after?.title).toBe("IPH");
    expect(ctx.gapBefore).toBe(0);
    expect(ctx.gapAfter).toBe(0);
  });

  test("never reaches across to the other sheet", () => {
    // The Lower rink's booking starts mid-cut and is the nearest event by time.
    // It is still not what the Upper crew is waiting on.
    const ctx = cutContext([cut, otherSheet], cut);
    expect(ctx.after).toBeNull();
  });

  test("reports real gaps rather than pretending things are adjacent", () => {
    const late = slot("2026-07-28T20:00:00Z", 60, "booking", "U", "Public Skate");
    const ctx = cutContext([freestyle, cut, late], cut);
    expect(ctx.gapAfter).toBe(50);
  });

  test("the last cut of the night does not borrow tomorrow's first booking", () => {
    // 23:50 ET cut; the next booking is 06:00 the following morning. Reaching
    // across the small hours would report it as "then: Public Skate", which is
    // true only in the sense that everything eventually happens.
    const nightCut = slot("2026-07-29T03:50:00Z", 10, "ice_cut", "U");
    const tomorrow = slot("2026-07-29T10:00:00Z", 60, "booking", "U", "Public Skate");
    expect(cutContext([nightCut, tomorrow], nightCut).after).toBeNull();
  });

  test("the first cut of the day has nothing before it", () => {
    expect(cutContext([cut, iph], cut).before).toBeNull();
  });

  test("ignores other ice cuts when looking for context", () => {
    // Two cuts in a day would otherwise describe each other, which tells the
    // reader nothing about who is actually on the ice. The second cut here
    // follows IPH the way a real one does — bookings and cuts abut, they do
    // not overlap (verified against 382 real cuts: none is enclosed by a
    // booking, and every one has a booking before it).
    const second = slot("2026-07-28T21:10:00Z", 10, "ice_cut", "U");
    const ctx = cutContext([cut, freestyle, iph, second], second);
    expect(ctx.before?.title).toBe("IPH");
    expect(ctx.after).toBeNull();
  });

  test("survives a null cut rather than throwing", () => {
    expect(cutContext([freestyle], null)).toEqual({
      before: null,
      after: null,
      gapBefore: null,
      gapAfter: null,
    });
  });
});

describe("dayLabel", () => {
  test("names today, tomorrow and yesterday", () => {
    expect(dayLabel("2026-07-28", NOW)).toBe("Today");
    expect(dayLabel("2026-07-29", NOW)).toBe("Tomorrow");
    expect(dayLabel("2026-07-27", NOW)).toBe("Yesterday");
  });

  test("falls back to a weekday a reader can just read", () => {
    expect(dayLabel("2026-07-30", NOW)).toBe("Thu, Jul 30");
  });

  test("the weekday does not slip a day across the zone offset", () => {
    // Parsing "2026-07-30" as UTC midnight and formatting locally lands on the
    // 29th in Eastern. Noon-anchoring is what stops that.
    expect(dayLabel("2026-07-30", NOW)).toContain("Jul 30");
  });
});

describe("until", () => {
  test("stays at minute resolution where minutes are the instruction", () => {
    expect(until(NOW + 12 * 60000, NOW)).toBe("in 12 min");
    expect(until(NOW + 59 * 60000, NOW)).toBe("in 59 min");
  });

  test("carries the remainder in the hour range", () => {
    expect(until(NOW + 2 * 3600000 + 20 * 60000, NOW)).toBe("in 2h 20m");
    expect(until(NOW + 3 * 3600000, NOW)).toBe("in 3h");
  });

  test("collapses to days once hours stop being useful", () => {
    expect(until(NOW + 2 * DAY_MS, NOW)).toBe("in 2 days");
  });

  test("anything at or before now reads 'now', never a negative", () => {
    expect(until(NOW, NOW)).toBe("now");
    expect(until(NOW - 60000, NOW)).toBe("now");
  });
});

describe("pullFreshness", () => {
  test("a same-day pull is green", () => {
    expect(pullFreshness(NOW - 3600000, NOW).tone).toBe("green");
  });

  test("the source updates daily, so ~a day old is still green", () => {
    expect(pullFreshness(NOW - 25 * 3600000, NOW).tone).toBe("green");
  });

  test("two days silent is amber, longer is red and says how long", () => {
    expect(pullFreshness(NOW - 30 * 3600000, NOW).tone).toBe("amber");
    const cold = pullFreshness(NOW - 5 * DAY_MS, NOW);
    expect(cold.tone).toBe("red");
    expect(cold.label).toBe("5 days behind");
  });

  test("never pulled is red, not blank", () => {
    // The weather job died silently for two months. A missing pull has to read
    // as a fault, not as an absence of news.
    expect(pullFreshness(null, NOW)).toEqual({ tone: "red", label: "never pulled" });
  });
});
