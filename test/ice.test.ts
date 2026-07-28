// Behavioural tests over the R3 ice surface, driven through the real HTTP
// routes so validation, idempotency and the thin-spot maths are all exercised
// where the client actually meets them.

import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { startServer, type TestServer } from "./helpers/server";

let srv: TestServer;
const call = (path: string, init?: RequestInit) => srv.call(path, init);

beforeAll(async () => {
  srv = await startServer("ice");
  await call("/api/identity", { method: "POST", body: JSON.stringify({ name: "Dana" }) });
});

afterAll(() => srv?.stop());

const write = (date: string, points: any[], headers: Record<string, string> = {}) =>
  call("/api/ice/measurements", {
    method: "POST",
    headers,
    body: JSON.stringify({ rink: "U", date, points }),
  });

// A day far enough back that it never collides with the trend windows below.
const DAY = (n: number) => {
  const d = new Date(Date.now() - n * 86400000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
};

describe("write path", () => {
  test("a nameless device cannot record ice", async () => {
    const r = await call("/api/ice/measurements", {
      method: "POST",
      headers: { cookie: "" },
      body: JSON.stringify({ rink: "U", date: DAY(1), points: [{ point_nbr: 1, depth_in: 3 }] }),
    });
    expect(r.status).toBe(401);
  });

  test("one point at a time is the supported shape", async () => {
    // Entry mode posts the moment a value is typed, so an interrupted walk on
    // cold ice loses nothing.
    const r = await write(DAY(1), [{ point_nbr: 1, depth_in: 3.2, temp_f: 22 }]);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, written: [1] });
  });

  test("re-writing the same point corrects it instead of duplicating", async () => {
    await write(DAY(1), [{ point_nbr: 1, depth_in: 4.1 }]);
    const s = await call(`/api/ice/session?rink=U&date=${DAY(1)}`);
    const p1 = s.body.points.find((p: any) => p.point_nbr === 1);
    expect(p1.depth_in).toBe(4.1);
    expect(s.body.points.filter((p: any) => p.point_nbr === 1).length).toBe(1);
  });

  test("an unkeyed retry converges — the upsert is idempotent on its own", async () => {
    await write(DAY(1), [{ point_nbr: 2, depth_in: 3.7 }]);
    await write(DAY(1), [{ point_nbr: 2, depth_in: 3.7 }]);
    const s = await call(`/api/ice/session?rink=U&date=${DAY(1)}`);
    expect(s.body.stats.n).toBe(2);
  });

  test("a keyed replay is short-circuited, not re-applied", async () => {
    const key = "ice-replay-test-1";
    const a = await write(DAY(2), [{ point_nbr: 9, depth_in: 2.2 }], { "idempotency-key": key });
    const b = await write(DAY(2), [{ point_nbr: 9, depth_in: 9.9 }], { "idempotency-key": key });
    expect(b.headers.get("idempotent-replayed")).toBe("1");
    expect(b.body).toEqual(a.body);
    const s = await call(`/api/ice/session?rink=U&date=${DAY(2)}`);
    expect(s.body.points.find((p: any) => p.point_nbr === 9).depth_in).toBe(2.2);
  });

  test("clearing both readings removes the row rather than storing a hollow one", async () => {
    await write(DAY(3), [{ point_nbr: 5, depth_in: 3 }]);
    await write(DAY(3), [{ point_nbr: 5, depth_in: null, temp_f: null }]);
    const s = await call(`/api/ice/session?rink=U&date=${DAY(3)}`);
    expect(s.body.stats).toBeNull();
  });

  test("rejects impossible readings, out-of-range points and duplicates", async () => {
    expect((await write(DAY(1), [{ point_nbr: 0, depth_in: 3 }])).status).toBe(400);
    expect((await write(DAY(1), [{ point_nbr: 36, depth_in: 3 }])).status).toBe(400);
    expect((await write(DAY(1), [{ point_nbr: 3, depth_in: 99 }])).status).toBe(400);
    expect((await write(DAY(1), [{ point_nbr: 3, temp_f: 500 }])).status).toBe(400);
    expect((await write(DAY(1), [{ point_nbr: 3, depth_in: 3 }, { point_nbr: 3, depth_in: 4 }])).status).toBe(400);
    expect((await write("14-07-2026", [{ point_nbr: 3, depth_in: 3 }])).status).toBe(400);
    expect((await write(DAY(1), [])).status).toBe(400);
  });

  test("a future date is a typo, not a measurement", async () => {
    expect((await write(DAY(-5), [{ point_nbr: 3, depth_in: 3 }])).status).toBe(400);
  });

  test("the Lower rink is refused with the reason, not a generic 400", async () => {
    const r = await call("/api/ice/measurements", {
      method: "POST",
      body: JSON.stringify({ rink: "L", date: DAY(1), points: [{ point_nbr: 1, depth_in: 3 }] }),
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("sand");
  });
});

describe("reading a session", () => {
  test("returns all 35 points even when only a few were walked", async () => {
    const s = await call(`/api/ice/session?rink=U&date=${DAY(2)}`);
    expect(s.body.points.length).toBe(35);
    expect(s.body.points.filter((p: any) => p.depth_in != null).length).toBe(1);
  });

  test("carries the previous session's reading so change mode has something to subtract", async () => {
    await write(DAY(20), [{ point_nbr: 12, depth_in: 3.0 }]);
    await write(DAY(10), [{ point_nbr: 12, depth_in: 2.5 }]);
    const s = await call(`/api/ice/session?rink=U&date=${DAY(10)}`);
    const p = s.body.points.find((x: any) => x.point_nbr === 12);
    expect(s.body.prev_date).toBe(DAY(20));
    expect(p.prev_depth_in).toBe(3.0);
    expect(p.delta_in).toBeCloseTo(-0.5, 6);
  });

  test("defaults to the newest session when no date is given", async () => {
    const s = await call("/api/ice/session?rink=U");
    const list = await call("/api/ice/sessions?rink=U");
    expect(s.body.date).toBe(list.body[0].measure_date);
  });

  test("the Lower rink says it is not measured instead of faking an empty sheet", async () => {
    const s = await call("/api/ice/session?rink=L");
    expect(s.body.measured).toBe(false);
    expect((await call("/api/ice/sessions?rink=L")).body).toEqual([]);
  });
});
