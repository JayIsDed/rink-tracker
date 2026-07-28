// The thin-spot strip, on its own database.
//
// Its own database on purpose: the strip reads "the latest session" and derives
// trends from whatever history exists, so any other test writing a stray point
// silently changes what this one is measuring. It shares a file with nothing.
//
// What is being pinned here is the reasoning in server/routes/ice.ts: the n-71
// finding (point 27 at 1.19" while the sheet around it is healthy) is invisible
// to a per-point z-score, because that point has ALWAYS read about 1.1". Thin
// and eroding are two different questions and the strip must answer both
// separately.

import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { startServer, type TestServer } from "./helpers/server";
import { nearestNeighbours } from "../public/shared/lib/rink-geom.js";

let srv: TestServer;
const call = (path: string, init?: RequestInit) => srv.call(path, init);

const DAY = (n: number) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() - n * 86400000));

const write = (date: string, points: any[]) =>
  call("/api/ice/measurements", { method: "POST", body: JSON.stringify({ rink: "U", date, points }) });

// One chronically thin point against a healthy sheet, plus one point that is
// still thick but genuinely losing ice. The two must be reported differently.
const THIN_PT = 27;
const ERODING_PT = 18;
const SESSIONS = [63, 56, 49, 42, 35, 28, 21, 14, 7, 0];

beforeAll(async () => {
  srv = await startServer("thin");
  await call("/api/identity", { method: "POST", body: JSON.stringify({ name: "Dana" }) });

  const neighbours = new Set(nearestNeighbours(THIN_PT, 4).map((n: any) => n.point_nbr));
  for (let i = 0; i < SESSIONS.length; i++) {
    const back = SESSIONS[i];
    const points = [];
    for (let n = 1; n <= 35; n++) {
      if (n === THIN_PT) points.push({ point_nbr: n, depth_in: 1.1 + (i % 3) * 0.04 }); // flat and thin
      else if (n === ERODING_PT) points.push({ point_nbr: n, depth_in: 4.6 - i * 0.22 }); // thick, falling
      else if (neighbours.has(n)) points.push({ point_nbr: n, depth_in: 3.8 });
      else points.push({ point_nbr: n, depth_in: 3.5 });
    }
    await write(DAY(back), points);
  }
});

afterAll(() => srv?.stop());

describe("thin, in absolute and neighbour terms", () => {
  test("catches the chronically thin point a z-score alone would call normal", async () => {
    const r = await call("/api/ice/thin-spots?rink=U");
    const spot = r.body.spots.find((s: any) => s.point_nbr === THIN_PT);
    expect(spot).toBeDefined();
    expect(spot.thin).toBe(true);
    expect(spot.odd).toBe(true);

    // The load-bearing assertion. This point is normal FOR ITSELF — if the
    // strip were built on anomaly detection, the finding it exists to surface
    // would be exactly the one it missed.
    expect(Math.abs(spot.z)).toBeLessThan(2);
    expect(spot.unusual).toBe(false);
    expect(spot.dropping).toBe(false);
  });

  test("reports neighbour context, because thin only means anything in contrast", async () => {
    const r = await call("/api/ice/thin-spots?rink=U");
    const spot = r.body.spots.find((s: any) => s.point_nbr === THIN_PT);
    expect(spot.neighbour_mean).toBeCloseTo(3.8, 1);
    expect(spot.neighbour_min).toBeCloseTo(3.8, 1);
    expect(spot.off_by).toBeLessThan(-1.25);
  });

  test("spots come back thinnest first", async () => {
    const r = await call("/api/ice/thin-spots?rink=U");
    const depths = r.body.spots.map((s: any) => s.depth_in);
    expect(depths[0]).toBeCloseTo(1.1, 1);
    expect([...depths].sort((a: number, b: number) => a - b)).toEqual(depths);
  });
});

describe("eroding, which is a different question", () => {
  test("a point still well above the threshold is flagged as dropping", async () => {
    const r = await call("/api/ice/thin-spots?rink=U");
    const s = r.body.spots.find((x: any) => x.point_nbr === ERODING_PT);
    expect(s).toBeDefined();
    expect(s.dropping).toBe(true);
    expect(s.trend_per_week).toBeLessThan(0);
    expect(s.thin).toBe(false);
  });

  test("the thin point and the eroding point are both present and distinct", async () => {
    const r = await call("/api/ice/thin-spots?rink=U");
    const nbrs = r.body.spots.map((s: any) => s.point_nbr);
    expect(nbrs).toContain(THIN_PT);
    expect(nbrs).toContain(ERODING_PT);
    expect(r.body.counts.thin).toBe(1);
    expect(r.body.counts.dropping).toBe(1);
  });
});

describe("restraint", () => {
  test("healthy flat ice raises nothing at all", async () => {
    // Credible when half-empty is a law, and it cuts both ways: a strip that
    // finds something every session is one nobody reads.
    const r = await call("/api/ice/thin-spots?rink=U");
    const noise = r.body.spots.filter(
      (s: any) => s.point_nbr !== THIN_PT && s.point_nbr !== ERODING_PT
    );
    expect(noise).toEqual([]);
  });

  test("ordinary session-to-session scatter is not called a trend", async () => {
    // n-71 measured real per-point scatter at roughly +/-0.1 in/week. Anything
    // inside that band has to stay quiet or the alarm is worthless.
    const jitter = [0.0, 0.06, -0.05, 0.04, -0.03, 0.05, -0.04, 0.02, -0.02, 0.03];
    for (let i = 0; i < SESSIONS.length; i++) {
      await write(DAY(SESSIONS[i]), [{ point_nbr: 7, depth_in: 3.5 + jitter[i] }]);
    }
    const r = await call("/api/ice/thin-spots?rink=U");
    expect(r.body.spots.find((s: any) => s.point_nbr === 7)).toBeUndefined();
  });

  test("a trend is not claimed from too little history", async () => {
    const fresh = DAY(2);
    await write(fresh, [{ point_nbr: 14, depth_in: 3.5 }]);
    const r = await call(`/api/ice/thin-spots?rink=U&date=${fresh}`);
    const s = r.body.spots.find((x: any) => x.point_nbr === 14);
    // Two points make a perfect line and a meaningless slope.
    expect(s?.trend_per_week ?? null).toBeNull();
  });

  test("counts and thresholds are reported so the numbers can be checked", async () => {
    const r = await call("/api/ice/thin-spots?rink=U");
    expect(r.body.counts.measured).toBe(35);
    expect(r.body.threshold_in).toBeGreaterThan(0);
    expect(r.body.trend_window_days).toBeGreaterThan(0);
  });

  test("the Lower rink is honest about not being measured", async () => {
    const r = await call("/api/ice/thin-spots?rink=L");
    expect(r.body.measured).toBe(false);
    expect(r.body.spots).toEqual([]);
  });
});
