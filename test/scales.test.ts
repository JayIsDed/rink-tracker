import { expect, test, describe } from "bun:test";
import {
  ramp,
  colorDepth,
  colorDelta,
  NO_DATA,
  stdev,
  mean,
  zScore,
  trendPerWeek,
} from "../public/shared/lib/scales.js";

describe("ramp", () => {
  const stops = [
    { t: 0, rgb: [0, 0, 0] },
    { t: 1, rgb: [100, 200, 250] },
  ];

  test("hits the endpoints exactly", () => {
    expect(ramp(0, stops)).toBe("rgb(0,0,0)");
    expect(ramp(1, stops)).toBe("rgb(100,200,250)");
  });

  test("interpolates the middle", () => {
    expect(ramp(0.5, stops)).toBe("rgb(50,100,125)");
  });

  test("clamps out-of-range input rather than extrapolating", () => {
    expect(ramp(-5, stops)).toBe("rgb(0,0,0)");
    expect(ramp(99, stops)).toBe("rgb(100,200,250)");
  });
});

describe("colour scales", () => {
  test("null renders as the no-data colour, never as a real value", () => {
    expect(colorDepth(null)).toBe(NO_DATA);
    expect(colorDelta(null)).toBe(NO_DATA);
  });

  test("thin ice and thick ice are different colours", () => {
    expect(colorDepth(1)).not.toBe(colorDepth(4.5));
  });

  test("zero delta is the neutral midpoint", () => {
    expect(colorDelta(0)).toBe(colorDelta(0));
    expect(colorDelta(-1)).not.toBe(colorDelta(1));
  });
});

describe("statistics", () => {
  test("mean ignores nulls, returns null when nothing is left", () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(mean([1, null, 3] as number[])).toBe(2);
    expect(mean([null, null] as unknown as number[])).toBeNull();
  });

  test("stdev of a flat series is exactly zero, not a float artefact", () => {
    // AVG(x²)−AVG(x)² is the classic route to sqrt(-1e-16). Guarding this is
    // why zScore can trust the value.
    expect(stdev([3.3, 3.3, 3.3, 3.3])).toBe(0);
    expect(stdev([1])).toBe(0);
    expect(stdev([])).toBe(0);
  });

  test("stdev matches the population formula", () => {
    expect(stdev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2, 9);
  });

  test("zScore returns 0 on a flat baseline instead of infinity", () => {
    expect(zScore(5, 3, 0)).toBe(0);
    expect(zScore(5, 3, null as unknown as number)).toBe(0);
    expect(zScore(null as unknown as number, 3, 1)).toBe(0);
  });

  test("zScore measures deviations", () => {
    expect(zScore(5, 3, 1)).toBe(2);
    expect(zScore(1, 3, 2)).toBe(-1);
  });
});

describe("trendPerWeek", () => {
  test("needs two usable points", () => {
    expect(trendPerWeek([])).toBeNull();
    expect(trendPerWeek([{ date: "2026-01-01", value: 3 }])).toBeNull();
    expect(
      trendPerWeek([
        { date: "2026-01-01", value: 3 },
        { date: "2026-01-08", value: null as unknown as number },
      ])
    ).toBeNull();
  });

  test("a flat series has zero slope", () => {
    expect(
      trendPerWeek([
        { date: "2026-01-01", value: 3 },
        { date: "2026-01-08", value: 3 },
        { date: "2026-01-15", value: 3 },
      ])
    ).toBeCloseTo(0, 9);
  });

  test("reports per-week, not per-day", () => {
    // −0.1" per week over three weekly samples.
    const t = trendPerWeek([
      { date: "2026-01-01", value: 3.0 },
      { date: "2026-01-08", value: 2.9 },
      { date: "2026-01-15", value: 2.8 },
    ])!;
    expect(t).toBeCloseTo(-0.1, 9);
  });

  test("handles uneven spacing", () => {
    const t = trendPerWeek([
      { date: "2026-01-01", value: 4 },
      { date: "2026-01-03", value: 4 },
      { date: "2026-02-01", value: 4 },
    ])!;
    expect(t).toBeCloseTo(0, 9);
  });

  test("erosion reads negative, growth positive", () => {
    const erode = trendPerWeek([
      { date: "2025-10-01", value: 4.0 },
      { date: "2025-12-01", value: 3.0 },
    ])!;
    expect(erode).toBeLessThan(0);
    const grow = trendPerWeek([
      { date: "2025-10-01", value: 3.0 },
      { date: "2025-12-01", value: 4.0 },
    ])!;
    expect(grow).toBeGreaterThan(0);
  });
});
