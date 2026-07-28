// GET /api/ice/point — the data behind the point-detail sheet.
//
// Ported in the composition check (AMENDMENT 1 on n-72). Round one's heatmap
// answered "tap a dot" with a point's whole history; the rebuild answered with
// one line of text. The behaviour that most needs pinning here is the date
// window: history shown for an OLD session must not be computed from that
// session's future.

import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { startServer, type TestServer } from "./helpers/server";

let srv: TestServer;
const call = (path: string, init?: RequestInit) => srv.call(path, init);

const ISO = (n: number) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() - n * 86400000));

// Four weekly sessions on point 27, thin the whole way, then a fifth much
// thicker. Mirrors the real shape the R3 stamp calibrated against.
const D28 = ISO(28);
const D21 = ISO(21);
const D14 = ISO(14);
const D7 = ISO(7);
const D0 = ISO(0);

beforeAll(async () => {
  srv = await startServer("point-detail");
  await call("/api/identity", { method: "POST", body: JSON.stringify({ name: "Dana" }) });

  const write = (date: string, points: unknown[]) =>
    call("/api/ice/measurements", { method: "POST", body: JSON.stringify({ rink: "U", date, points }) });

  await write(D28, [{ point_nbr: 27, depth_in: 0.95, temp_f: 24.0 }, { point_nbr: 26, depth_in: 3.9 }]);
  await write(D21, [{ point_nbr: 27, depth_in: 0.83, temp_f: 23.5 }, { point_nbr: 26, depth_in: 4.0 }]);
  await write(D14, [{ point_nbr: 27, depth_in: 1.05, temp_f: 24.2 }, { point_nbr: 26, depth_in: 4.1 }]);
  await write(D7, [{ point_nbr: 27, depth_in: 1.1, temp_f: 24.4 }, { point_nbr: 26, depth_in: 4.2 }]);
  await write(D0, [{ point_nbr: 27, depth_in: 1.19, temp_f: 24.5 }, { point_nbr: 26, depth_in: 4.37 }]);
});

afterAll(() => srv?.stop());

describe("point detail", () => {
  test("returns the point's readings, newest session first on the map", async () => {
    const r = await call(`/api/ice/point?rink=U&point=27&date=${D0}`);
    expect(r.status).toBe(200);
    expect(r.body.point_nbr).toBe(27);
    expect(r.body.depth_in).toBe(1.19);
    expect(r.body.temp_f).toBe(24.5);
    expect(r.body.history.length).toBe(5);
  });

  test("carries the grid position, matching the carried numbering", async () => {
    // Point 27 is column 6, row 2 under the convention in the `points` table —
    // derived from geometry so a fresh install answers it too.
    const r = await call(`/api/ice/point?rink=U&point=27&date=${D0}`);
    expect(r.body.grid).toEqual({ col: 6, row: 2 });
  });

  test("delta is against the previous SESSION, not a fixed date", async () => {
    const r = await call(`/api/ice/point?rink=U&point=27&date=${D0}`);
    expect(r.body.prev_date).toBe(D7);
    expect(r.body.prev_depth_in).toBe(1.1);
    expect(r.body.delta_in).toBeCloseTo(0.09, 6);
  });

  test("stats summarise the point's own history", async () => {
    const r = await call(`/api/ice/point?rink=U&point=27&date=${D0}`);
    expect(r.body.stats.n).toBe(5);
    expect(r.body.stats.min).toBe(0.83);
    expect(r.body.stats.min_date).toBe(D21);
    expect(r.body.stats.max).toBe(1.19);
    expect(r.body.stats.mean).toBeCloseTo(1.024, 3);
  });

  test("headroom is today minus the thinnest ever — the concrete estimate", async () => {
    const r = await call(`/api/ice/point?rink=U&point=27&date=${D0}`);
    expect(r.body.headroom_in).toBeCloseTo(0.36, 6);
  });

  test("AN OLD SESSION'S HISTORY DOES NOT COME FROM ITS FUTURE", async () => {
    // Viewed at D21, point 27's thinnest-ever is that day's own 0.83 and there
    // are two readings, not five. The tidier alternative — always all-time —
    // would show a reading the session had not taken yet and call it history.
    const r = await call(`/api/ice/point?rink=U&point=27&date=${D21}`);
    expect(r.body.history.length).toBe(2);
    expect(r.body.stats.n).toBe(2);
    expect(r.body.stats.min).toBe(0.83);
    expect(r.body.stats.max).toBe(0.95);
    expect(r.body.headroom_in).toBe(0);
    expect(r.body.prev_date).toBe(D28);
  });

  test("neighbours come from the same session — the out-of-line comparison", async () => {
    const r = await call(`/api/ice/point?rink=U&point=27&date=${D0}`);
    const nbrs = r.body.neighbours.map((n: { point_nbr: number }) => n.point_nbr);
    expect(nbrs).toContain(26);
    expect(nbrs).not.toContain(27);
  });

  test("trend needs four sessions before it is claimed at all", async () => {
    const early = await call(`/api/ice/point?rink=U&point=27&date=${D21}`);
    expect(early.body.stats.trend_per_week).toBeNull();
    const late = await call(`/api/ice/point?rink=U&point=27&date=${D0}`);
    expect(late.body.stats.trend_per_week).not.toBeNull();
  });

  test("a point with no readings answers honestly instead of erroring", async () => {
    const r = await call(`/api/ice/point?rink=U&point=12&date=${D0}`);
    expect(r.status).toBe(200);
    expect(r.body.depth_in).toBeNull();
    expect(r.body.stats).toBeNull();
    expect(r.body.headroom_in).toBeNull();
    expect(r.body.history).toEqual([]);
  });

  test("a bad point number is rejected, not silently clamped", async () => {
    expect((await call(`/api/ice/point?rink=U&point=0`)).status).toBe(400);
    expect((await call(`/api/ice/point?rink=U&point=36`)).status).toBe(400);
    expect((await call(`/api/ice/point?rink=U&point=abc`)).status).toBe(400);
  });

  test("the Lower rink says it is not measured rather than inventing a point", async () => {
    const r = await call(`/api/ice/point?rink=L&point=27`);
    expect(r.status).toBe(200);
    expect(r.body.measured).toBe(false);
    expect(r.body.history).toEqual([]);
  });

  test("with no date it falls back to the latest session", async () => {
    const r = await call(`/api/ice/point?rink=U&point=27`);
    expect(r.body.date).toBe(D0);
    expect(r.body.depth_in).toBe(1.19);
  });
});
