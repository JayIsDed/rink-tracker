import { expect, test, describe } from "bun:test";
import { fieldAt, samplesFrom, K } from "../public/shared/lib/field.js";
import { pointXY, numericOrder } from "../public/shared/lib/rink-geom.js";

const flat = (v: number) => numericOrder().map((n) => ({ point_nbr: n, value: v }));

describe("fieldAt", () => {
  test("returns null when nothing has a value", () => {
    expect(fieldAt([], 100, 50)).toBeNull();
    expect(fieldAt(numericOrder().map((n) => ({ point_nbr: n, value: null })), 100, 50)).toBeNull();
  });

  test("a uniform field interpolates to that value everywhere", () => {
    const s = flat(3.5);
    for (const [x, y] of [[10, 10], [100, 50], [190, 90]]) {
      expect(fieldAt(s, x, y)!.v).toBeCloseTo(3.5, 9);
    }
  });

  test("querying exactly on a sample returns it with full confidence", () => {
    const s = flat(2);
    s[17] = { point_nbr: 18, value: 9.9 }; // centre point
    const xy = pointXY(18)!;
    const got = fieldAt(s, xy.x, xy.y)!;
    expect(got.v).toBe(9.9);
    expect(got.conf).toBe(1);
  });

  test("interpolated values stay within the sample range", () => {
    const s = flat(2);
    s[0] = { point_nbr: 1, value: 6 };
    for (let x = 0; x <= 200; x += 20) {
      for (let y = 0; y <= 100; y += 20) {
        const got = fieldAt(s, x, y);
        expect(got!.v).toBeGreaterThanOrEqual(2 - 1e-9);
        expect(got!.v).toBeLessThanOrEqual(6 + 1e-9);
      }
    }
  });

  test("nearer samples pull harder", () => {
    // Two samples only: 1 (bottom-left) and 35 (top-right).
    const s = [
      { point_nbr: 1, value: 0 },
      { point_nbr: 35, value: 10 },
    ];
    const near1 = pointXY(1)!;
    const near35 = pointXY(35)!;
    const a = fieldAt(s, near1.x + 5, near1.y - 5)!.v;
    const b = fieldAt(s, near35.x - 5, near35.y + 5)!.v;
    expect(a).toBeLessThan(5);
    expect(b).toBeGreaterThan(5);
  });

  test("ignores non-finite values instead of poisoning the average", () => {
    const s = flat(4);
    s[3] = { point_nbr: 4, value: NaN as unknown as number };
    s[4] = { point_nbr: 5, value: Infinity as unknown as number };
    const got = fieldAt(s, 100, 50)!;
    expect(Number.isFinite(got.v)).toBe(true);
    expect(got.v).toBeCloseTo(4, 9);
  });

  test("uses at most K samples", () => {
    // With 35 uniform samples at 1 and one distant outlier at 100, the outlier
    // must not reach a query surrounded by K nearer points.
    const s = flat(1);
    s[34] = { point_nbr: 35, value: 100 };
    const centre = fieldAt(s, pointXY(3)!.x, pointXY(3)!.y + 1)!;
    expect(centre.v).toBeLessThan(2);
    expect(K).toBe(6);
  });

  test("confidence is clamped to the shipped 0.5..0.95 band", () => {
    const s = [{ point_nbr: 1, value: 3 }];
    const far = fieldAt(s, 195, 5)!;
    expect(far.conf).toBeGreaterThanOrEqual(0.5);
    expect(far.conf).toBeLessThanOrEqual(0.95);
  });
});

describe("samplesFrom", () => {
  test("projects the requested column", () => {
    const rows = [{ point_nbr: 1, depth_in: 3, temp_f: 20 }];
    expect(samplesFrom(rows)).toEqual([{ point_nbr: 1, value: 3 }]);
    expect(samplesFrom(rows, "temp_f")).toEqual([{ point_nbr: 1, value: 20 }]);
  });
});
