import { expect, test, describe } from "bun:test";
import { edgeYAt, insideRink, rinkMarkings, heatCells, cellForWidth } from "../public/shared/lib/render.js";
import { RINK_W, RINK_H, CORNER_R, MARK, POINT_XY } from "../public/shared/lib/rink-geom.js";

describe("boundary", () => {
  test("is the full height along the straight middle", () => {
    expect(edgeYAt(100)).toEqual([0, RINK_H]);
    expect(edgeYAt(CORNER_R)).toEqual([0, RINK_H]);
    expect(edgeYAt(RINK_W - CORNER_R)).toEqual([0, RINK_H]);
  });

  test("pinches to a single point at the extreme ends", () => {
    const [t, b] = edgeYAt(0)!;
    expect(t).toBeCloseTo(CORNER_R, 6);
    expect(b).toBeCloseTo(RINK_H - CORNER_R, 6);
  });

  test("is symmetric end to end", () => {
    for (const x of [0, 5, 12, 20, 27]) {
      expect(edgeYAt(x)!).toEqual(edgeYAt(RINK_W - x)!);
    }
  });

  test("off the sheet has no boundary", () => {
    expect(edgeYAt(-1)).toBeNull();
    expect(edgeYAt(RINK_W + 1)).toBeNull();
  });

  test("every measurement point is on the ice", () => {
    // If a surveyed point ever falls outside the drawn outline, the outline is
    // wrong — the points came off the real sheet.
    for (const [n, xy] of POINT_XY) {
      expect({ n, on: insideRink(xy.x, xy.y) }).toEqual({ n, on: true });
    }
  });

  test("the corner cut-out is genuinely outside", () => {
    expect(insideRink(1, 1)).toBe(false);
    expect(insideRink(RINK_W - 1, RINK_H - 1)).toBe(false);
    expect(insideRink(100, 50)).toBe(true);
  });
});

describe("markings", () => {
  const shapes = rinkMarkings();
  const lineAt = (x: number) => shapes.find((s: any) => s.kind === "line" && s.x1 === x) as any;

  test("goal lines stop at the corner arc instead of running past the boards", () => {
    const goal = lineAt(MARK.goalLineLeft);
    expect(goal).toBeDefined();
    // 28ft radius, goal line 10ft in from the corner centre → ~26.15ft of chord.
    expect(goal.y1).toBeCloseTo(CORNER_R - Math.sqrt(CORNER_R ** 2 - (CORNER_R - MARK.goalLineLeft) ** 2), 6);
    expect(goal.y1).toBeGreaterThan(0);
    expect(goal.y2).toBeCloseTo(RINK_H - goal.y1, 6);
  });

  test("blue lines and centre line span the full height", () => {
    for (const x of [MARK.blueLineLeft, MARK.blueLineRight, MARK.centerLine]) {
      const l = lineAt(x);
      expect(l.y1).toBe(0);
      expect(l.y2).toBe(RINK_H);
    }
  });

  test("every shape lies within the sheet", () => {
    for (const s of shapes as any[]) {
      if (s.kind === "line") {
        for (const [x, y] of [[s.x1, s.y1], [s.x2, s.y2]]) {
          expect(x).toBeGreaterThanOrEqual(0);
          expect(x).toBeLessThanOrEqual(RINK_W);
          expect(y).toBeGreaterThanOrEqual(0);
          expect(y).toBeLessThanOrEqual(RINK_H);
        }
      }
      if (s.kind === "circle") {
        expect(s.cx - s.r).toBeGreaterThanOrEqual(0);
        expect(s.cx + s.r).toBeLessThanOrEqual(RINK_W);
      }
    }
  });

  test("creases open toward centre ice, not into the boards", () => {
    const arcs = shapes.filter((s: any) => s.kind === "arc") as any[];
    expect(arcs.length).toBe(2);
    const left = arcs.find((a) => a.cx === MARK.goalLineLeft)!;
    const right = arcs.find((a) => a.cx === MARK.goalLineRight)!;

    // Sample the arc midpoint: it must sit on the centre-ice side of its line.
    const mid = (a: any) => ({
      x: a.cx + a.r * Math.cos((a.from + a.to) / 2),
      y: a.cy + a.r * Math.sin((a.from + a.to) / 2),
    });
    expect(mid(left).x).toBeGreaterThan(MARK.goalLineLeft);
    expect(mid(right).x).toBeLessThan(MARK.goalLineRight);
  });

  test("four end-zone faceoff circles, on the surveyed dots", () => {
    const circles = (shapes as any[]).filter((s) => s.kind === "circle" && s.r === MARK.faceoffR);
    expect(circles.length).toBe(4);
    for (const c of circles) {
      expect([MARK.faceoffDotXL, MARK.faceoffDotXR]).toContain(c.cx);
      expect([MARK.faceoffYTop, MARK.faceoffYBot]).toContain(c.cy);
    }
  });
});

describe("heat grid", () => {
  const samples = [...POINT_XY.keys()].map((n) => ({ point_nbr: n, value: 3 }));

  test("returns nothing when no sample carries a value", () => {
    expect(heatCells([])).toEqual([]);
    expect(heatCells([{ point_nbr: 1, value: null as any }])).toEqual([]);
  });

  test("covers the ice and stops at the boards", () => {
    const cells = heatCells(samples, { cell: 2 });
    expect(cells.length).toBeGreaterThan(1000);
    for (const c of cells) expect(insideRink(c.x + c.w / 2, c.y + c.h / 2)).toBe(true);
  });

  test("excludes the corners a naive rectangle grid would paint", () => {
    const cells = heatCells(samples, { cell: 2 });
    const full = Math.ceil(RINK_W / 2) * Math.ceil(RINK_H / 2);
    expect(cells.length).toBeLessThan(full);
  });

  test("cover mode paints past the boards so a clip has something to trim", () => {
    // A centre-tested grid under a clip leaves a visible staircase along the
    // boards, because a clip can only cut away — it cannot fill in a cell that
    // was never painted.
    const centre = heatCells(samples, { cell: 4, edge: "centre" });
    const cover = heatCells(samples, { cell: 4, edge: "cover" });
    expect(cover.length).toBeGreaterThan(centre.length);
    // Every centre-qualifying cell is still there; cover only ever adds.
    const key = (c: any) => `${c.x},${c.y}`;
    const covered = new Set(cover.map(key));
    for (const c of centre) expect(covered.has(key(c))).toBe(true);
  });

  test("cover mode still stops at the bounding box, not the whole canvas", () => {
    const cover = heatCells(samples, { cell: 4, edge: "cover" });
    for (const c of cover) {
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.x).toBeLessThan(RINK_W);
      expect(c.y).toBeLessThan(RINK_H);
    }
  });

  test("a uniform field reads uniform", () => {
    for (const c of heatCells(samples, { cell: 4 })) expect(c.v).toBeCloseTo(3, 6);
  });

  test("interpolates toward the nearer sample", () => {
    const two = [
      { point_nbr: 3, value: 1 }, // left goal line, centre row
      { point_nbr: 33, value: 5 }, // right goal line, centre row
    ];
    const cells = heatCells(two, { cell: 4 });
    const nearLeft = cells.find((c) => c.x < 24 && Math.abs(c.y - 48) < 6)!;
    const nearRight = cells.find((c) => c.x > 172 && Math.abs(c.y - 48) < 6)!;
    expect(nearLeft.v).toBeLessThan(nearRight.v);
  });

  test("cell size tracks canvas width so banding stays constant on screen", () => {
    const phone = cellForWidth(360);
    const ultrawide = cellForWidth(3440);
    expect(phone).toBeGreaterThan(ultrawide);
    expect(phone).toBeLessThanOrEqual(5);
    expect(ultrawide).toBeGreaterThanOrEqual(1.25);
  });
});

describe("the Zamboni door", () => {
  const zam = rinkMarkings().find((s: any) => s.label === "ZAM") as any;

  test("is drawn at all — it is the sheet's only asymmetric feature", () => {
    // Without it the drawing is symmetric both ways, and an operator standing
    // on the ice has nothing to tell them which end of the picture they're at.
    expect(zam).toBeDefined();
    expect(zam.kind).toBe("rect");
  });

  test("sits on the bottom boards, past the corner arc", () => {
    expect(zam.y + zam.h).toBeCloseTo(RINK_H, 6);
    expect(zam.x).toBeGreaterThan(CORNER_R);
    expect(zam.x + zam.w).toBeLessThan(RINK_W - CORNER_R);
  });

  test("its whole span is actually on the ice, not hanging off a corner", () => {
    for (const x of [zam.x, zam.x + zam.w / 2, zam.x + zam.w]) {
      expect(insideRink(x, RINK_H - 0.5)).toBe(true);
    }
  });

  test("it is the ONLY labelled shape, so the label branch stays unambiguous", () => {
    expect(rinkMarkings().filter((s: any) => s.label).length).toBe(1);
  });
});
