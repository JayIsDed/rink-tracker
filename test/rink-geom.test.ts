import { expect, test, describe } from "bun:test";
import {
  POINT_XY,
  POINT_COUNT,
  serpentineOrder,
  numericOrder,
  pointXY,
  colOf,
  gridOf,
  nearestPoint,
  Y_LINE,
  MARK,
} from "../public/shared/lib/rink-geom.js";

describe("grid labels", () => {
  test("matches the numbering carried in the points table", () => {
    // Spot values read off the real carry: 1:c1r1, 5:c1r5, 6:c2r1, 35:c7r5.
    expect(gridOf(1)).toEqual({ col: 1, row: 1 });
    expect(gridOf(5)).toEqual({ col: 1, row: 5 });
    expect(gridOf(6)).toEqual({ col: 2, row: 1 });
    expect(gridOf(27)).toEqual({ col: 6, row: 2 });
    expect(gridOf(35)).toEqual({ col: 7, row: 5 });
  });

  test("every point gets a label, and columns hold five rows each", () => {
    const seen = new Set<string>();
    for (let n = 1; n <= POINT_COUNT; n++) {
      const g = gridOf(n)!;
      expect(g.col).toBe(colOf(n));
      expect(g.row).toBeGreaterThanOrEqual(1);
      expect(g.row).toBeLessThanOrEqual(5);
      seen.add(`${g.col}/${g.row}`);
    }
    expect(seen.size).toBe(POINT_COUNT);
  });

  test("ROW 1 IS THE BOTTOM OF THE SHEET — the carried convention, not a typo", () => {
    // Point 1 sits at y=86 and point 5 at y=14, so row numbers run upward while
    // screen y runs downward. Renumbering to match the screen would disagree
    // with fourteen months of readings people have already written down.
    expect(gridOf(1)!.row).toBe(1);
    expect(pointXY(1)!.y).toBe(Y_LINE[4]);
    expect(gridOf(5)!.row).toBe(5);
    expect(pointXY(5)!.y).toBe(Y_LINE[0]);
  });

  test("out of range is null, not a computed nonsense cell", () => {
    expect(gridOf(0)).toBeNull();
    expect(gridOf(36)).toBeNull();
    expect(gridOf(2.5)).toBeNull();
    expect(gridOf("x" as never)).toBeNull();
  });
});

describe("point map", () => {
  test("has all 35 points, exactly once", () => {
    expect(POINT_XY.size).toBe(POINT_COUNT);
    for (let n = 1; n <= POINT_COUNT; n++) expect(pointXY(n)).not.toBeNull();
  });

  test("points outside 1..35 have no coordinate", () => {
    expect(pointXY(0)).toBeNull();
    expect(pointXY(36)).toBeNull();
  });

  test("every point sits on one of the five measurement rows", () => {
    // Faceoff-cluster points are the deliberate exception — they hang off the
    // dot, not the grid rows.
    const faceoff = new Set([6, 7, 9, 10, 26, 27, 29, 30]);
    for (const [n, xy] of POINT_XY) {
      if (faceoff.has(n)) continue;
      expect(Y_LINE).toContain(xy.y);
    }
  });

  test("column 1 reads 5,4,3,2,1 top to bottom", () => {
    const col1 = [5, 4, 3, 2, 1].map((n) => pointXY(n)!.y);
    expect(col1).toEqual([...Y_LINE]);
    for (const n of [1, 2, 3, 4, 5]) expect(pointXY(n)!.x).toBe(MARK.goalLineLeft);
  });

  test("colOf maps 5 points per column across 7 columns", () => {
    expect(colOf(1)).toBe(1);
    expect(colOf(5)).toBe(1);
    expect(colOf(6)).toBe(2);
    expect(colOf(35)).toBe(7);
  });
});

describe("serpentine order", () => {
  const order = serpentineOrder();

  test("visits every point exactly once", () => {
    expect(order.length).toBe(POINT_COUNT);
    expect(new Set(order).size).toBe(POINT_COUNT);
    expect([...order].sort((a, b) => a - b)).toEqual(numericOrder());
  });

  test("alternates direction per column", () => {
    expect(order.slice(0, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(order.slice(5, 10)).toEqual([10, 9, 8, 7, 6]);
    expect(order.slice(10, 15)).toEqual([11, 12, 13, 14, 15]);
    expect(order.slice(30, 35)).toEqual([31, 32, 33, 34, 35]);
  });

  test("never jumps back across the sheet between consecutive points", () => {
    // The whole reason serpentine exists: the walk should not teleport. Any two
    // consecutive points must be in the same column or adjacent columns.
    for (let i = 1; i < order.length; i++) {
      const gap = Math.abs(colOf(order[i]) - colOf(order[i - 1]));
      expect(gap).toBeLessThanOrEqual(1);
    }
  });

  test("column handoff lands on the nearest row, not the far one", () => {
    // Last point of col 1 is 5 (y=14); first of col 2 should be the top of the
    // faceoff cluster, not the bottom.
    const idx = order.indexOf(5);
    const next = order[idx + 1];
    expect(pointXY(next)!.y).toBeLessThan(50);
  });
});

describe("nearestPoint", () => {
  test("returns the exact point when queried at its coordinate", () => {
    for (const n of [1, 18, 28, 35]) {
      const xy = pointXY(n)!;
      const hit = nearestPoint(xy.x, xy.y);
      expect(hit!.point_nbr).toBe(n);
      expect(hit!.dist).toBeCloseTo(0, 6);
    }
  });

  test("a tap between two points picks the closer one", () => {
    // Note the faceoff dot (pt 8, x=35) sits between the goal line and the blue
    // line on this row, so "a quarter of the way across" is nearest to 8, not 3.
    // Stay inside 8's shadow deliberately.
    const a = pointXY(3)!; // left goal line, centre row
    expect(nearestPoint(a.x + 6, a.y)!.point_nbr).toBe(3);
    expect(nearestPoint(pointXY(8)!.x - 2, a.y)!.point_nbr).toBe(8);
  });

  test("can be restricted to a subset", () => {
    const xy = pointXY(1)!;
    const hit = nearestPoint(xy.x, xy.y, [30, 31, 32]);
    expect([30, 31, 32]).toContain(hit!.point_nbr);
  });
});
