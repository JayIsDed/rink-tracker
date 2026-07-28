import { expect, test, describe } from "bun:test";
import { sparkline, sparklineWithThreshold } from "../public/shared/lib/spark.js";
import { conditions, thermalLoad, summarise } from "../public/shared/lib/weather.js";

const BOX = { w: 100, h: 50, pad: 5 };

const series = (pairs: [string, number][]) => pairs.map(([date, value]) => ({ date, value }));

describe("sparkline", () => {
  test("one reading draws nothing — a dot says nothing about trend", () => {
    expect(sparkline(series([["2026-07-14", 2.4]]), BOX)).toBeNull();
  });

  test("no readings, zero-size box, and all-null series draw nothing", () => {
    expect(sparkline([], BOX)).toBeNull();
    expect(sparkline(series([["2026-07-07", 1], ["2026-07-14", 2]]), { w: 0, h: 50 })).toBeNull();
    expect(sparkline([{ date: "2026-07-07", value: null }, { date: "2026-07-14", value: null }] as never, BOX)).toBeNull();
  });

  test("HIGHER value sits HIGHER on screen — the upside-down-chart bug", () => {
    const s = sparkline(series([["2026-07-07", 1.0], ["2026-07-14", 4.0]]), BOX)!;
    const [lo, hi] = s.points;
    expect(lo.value).toBe(1.0);
    expect(hi.value).toBe(4.0);
    // Canvas y grows downward, so the bigger reading must have the smaller y.
    expect(hi.y).toBeLessThan(lo.y);
  });

  test("the extremes land on the padded edges", () => {
    const s = sparkline(series([["2026-07-07", 1.0], ["2026-07-14", 4.0]]), BOX)!;
    expect(Math.min(...s.points.map((p) => p.y))).toBeCloseTo(5, 6);
    expect(Math.max(...s.points.map((p) => p.y))).toBeCloseTo(45, 6);
    expect(s.min).toBe(1);
    expect(s.max).toBe(4);
  });

  test("x is proportional to TIME, not to index", () => {
    // Two weeks, then one. Index spacing would put the middle point at the
    // halfway mark; time spacing puts it two-thirds along.
    const s = sparkline(
      series([
        ["2026-06-01", 3],
        ["2026-06-15", 3.5],
        ["2026-06-22", 4],
      ]),
      BOX
    )!;
    const span = s.last!.x - s.first!.x;
    expect((s.points[1].x - s.first!.x) / span).toBeCloseTo(2 / 3, 6);
  });

  test("a flat series rides the middle, not an edge", () => {
    const s = sparkline(series([["2026-07-07", 2], ["2026-07-14", 2]]), BOX)!;
    expect(s.flat).toBe(true);
    for (const p of s.points) expect(p.y).toBeCloseTo(25, 6);
  });

  test("out-of-order input is sorted before it is drawn", () => {
    const s = sparkline(series([["2026-07-14", 4], ["2026-06-01", 1]]), BOX)!;
    expect(s.points.map((p) => p.date)).toEqual(["2026-06-01", "2026-07-14"]);
    expect(s.first!.x).toBeLessThan(s.last!.x);
  });

  test("point 27's real shape: thin all along, so it must not read as a cliff", () => {
    // Its actual band per the R3 stamp — 0.83"–1.19" every session since May.
    const s = sparkline(
      series([
        ["2026-05-12", 0.95],
        ["2026-05-19", 0.83],
        ["2026-06-02", 1.05],
        ["2026-07-14", 1.19],
      ]),
      BOX
    )!;
    expect(s.max - s.min).toBeCloseTo(0.36, 6);
    // Full-height rescaling is correct — the sparkline shows shape, and the
    // absolute claim is the number printed beside it.
    expect(s.points.some((p) => p.y === 5)).toBe(true);
  });
});

describe("sparkline threshold line", () => {
  test("a threshold inside the range gets a y", () => {
    const s = sparklineWithThreshold(series([["2026-07-07", 1], ["2026-07-14", 4]]), BOX, 2.5)!;
    expect(s.baselineY).toBeCloseTo(25, 6);
  });

  test("a threshold outside the range is NOT drawn clamped to the edge", () => {
    // Clamping would claim the series touches the threshold when it never does.
    expect(sparklineWithThreshold(series([["2026-07-07", 3], ["2026-07-14", 4]]), BOX, 2)!.baselineY).toBeNull();
    expect(sparklineWithThreshold(series([["2026-07-07", 1], ["2026-07-14", 1.5]]), BOX, 2)!.baselineY).toBeNull();
  });

  test("a flat series gets no threshold line, and a missing threshold is fine", () => {
    expect(sparklineWithThreshold(series([["2026-07-07", 2], ["2026-07-14", 2]]), BOX, 2)!.baselineY).toBeNull();
    expect(sparklineWithThreshold(series([["2026-07-07", 1], ["2026-07-14", 4]]), BOX, null)!.baselineY).toBeNull();
  });
});

describe("weather", () => {
  test("known WMO codes read as words", () => {
    expect(conditions(0)).toBe("clear");
    expect(conditions(73)).toBe("snow");
    expect(conditions(95)).toBe("thunderstorm");
  });

  test("an unknown or missing code is null, never the string 'unknown'", () => {
    expect(conditions(4242)).toBeNull();
    expect(conditions(null)).toBeNull();
    expect(conditions(undefined)).toBeNull();
  });

  test("thermal load is air minus ice, and null if either is missing", () => {
    expect(thermalLoad(40.2, 24.5)).toBe(15.7);
    expect(thermalLoad(null, 24.5)).toBeNull();
    expect(thermalLoad(40.2, null)).toBeNull();
  });

  test("the summary skips what is missing instead of printing dashes", () => {
    expect(summarise({ temp_low_f: 34, temp_high_f: 47, weather_code: 3, wind_mph_max: 12.4 })).toBe(
      "34–47°F · overcast · wind 12 mph"
    );
    // No precip key at all, and a zero must not print as "0.00\" rain".
    expect(summarise({ temp_mean_f: 30, precip_in: 0, snow_in: 0 })).toBe("30°F");
    expect(summarise(null)).toBeNull();
    expect(summarise({})).toBeNull();
  });
});
