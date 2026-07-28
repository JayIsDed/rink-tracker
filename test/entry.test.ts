import { expect, test, describe } from "bun:test";
import { createEntry, STATUS, validateDepth, validateTemp } from "../public/shared/lib/entry.js";
import { serpentineOrder, POINT_COUNT } from "../public/shared/lib/rink-geom.js";

const session = () => createEntry({ rink: "U", date: "2026-07-28" });

describe("validation", () => {
  test("blank is legal — no field is forced", () => {
    expect(validateDepth("")).toMatchObject({ ok: true, value: null });
    expect(validateTemp(null)).toMatchObject({ ok: true, value: null });
  });

  test("rejects nonsense and out-of-range", () => {
    expect(validateDepth("abc").ok).toBe(false);
    expect(validateDepth(-1).ok).toBe(false);
    expect(validateDepth(99).ok).toBe(false);
    expect(validateTemp(200).ok).toBe(false);
  });

  test("unusual but real values are accepted with a flag, not refused", () => {
    // An app that refuses to record reality teaches people to stop recording.
    const v = validateDepth(0.2);
    expect(v.ok).toBe(true);
    expect(v.value).toBe(0.2);
    expect(v.warn).toBeTruthy();
  });
});

describe("walk order", () => {
  test("starts at the head of the serpentine walk", () => {
    const e = session();
    expect(e.sequence).toEqual(serpentineOrder());
    expect(e.current()).toBe(serpentineOrder()[0]);
  });

  test("next and prev clamp at the ends instead of wrapping", () => {
    const e = session();
    expect(e.prev()).toBe(e.sequence[0]);
    for (let i = 0; i < POINT_COUNT + 5; i++) e.next();
    expect(e.current()).toBe(e.sequence[POINT_COUNT - 1]);
    expect(e.atEnd()).toBe(true);
  });

  test("switching order keeps the operator on the point they are standing at", () => {
    // The bug this pins: reordering by INDEX moves you to a different physical
    // spot on the ice than the one you are holding a ruler over.
    const e = session();
    e.jumpTo(27);
    e.setOrder("numeric");
    expect(e.current()).toBe(27);
    expect(e.sequence[0]).toBe(1);
  });

  test("jumpTo ignores a point that is not on the sheet", () => {
    const e = session();
    const before = e.current();
    e.jumpTo(99);
    expect(e.current()).toBe(before);
  });
});

describe("durability", () => {
  test("typing a value does NOT make it saved", () => {
    // The whole reason this module exists.
    const e = session();
    e.setValue(1, { depth: 3.2 });
    expect(e.get(1)!.status).toBe(STATUS.DIRTY);
    expect(e.progress().saved).toBe(0);
    expect(e.progress().durable).toBe(false);
  });

  test("only a server confirmation promotes to saved", () => {
    const e = session();
    e.setValue(1, { depth: 3.2 });
    e.markQueued([1]);
    expect(e.get(1)!.status).toBe(STATUS.QUEUED);
    e.markSaved([1]);
    expect(e.get(1)!.status).toBe(STATUS.SAVED);
    expect(e.progress().durable).toBe(true);
  });

  test("a value edited mid-flight is not painted durable by the old write", () => {
    const e = session();
    e.setValue(1, { depth: 3.2 });
    e.markQueued([1]);
    e.setValue(1, { depth: 4.0 }); // operator corrects while the write is out
    expect(e.get(1)!.status).toBe(STATUS.DIRTY);
    e.markSaved([1]); // the OLD write lands
    expect(e.get(1)!.status).toBe(STATUS.DIRTY);
    expect(e.get(1)!.depth_in).toBe(4.0);
  });

  test("a failed write is visible and stays in the pending set", () => {
    const e = session();
    e.setValue(5, { depth: 2.5 });
    e.markQueued([5]);
    e.markFailed([5], "server said no");
    expect(e.get(5)!.status).toBe(STATUS.FAILED);
    expect(e.get(5)!.error).toBe("server said no");
    expect(e.pending().map((p: any) => p.point_nbr)).toContain(5);
    expect(e.progress().durable).toBe(false);
  });

  test("pending returns values in walk order, not point order", () => {
    const e = session();
    e.setValue(10, { depth: 3 });
    e.setValue(1, { depth: 3 });
    expect(e.pending().map((p: any) => p.point_nbr)).toEqual([1, 10]);
  });

  test("clearing a value returns the point to empty", () => {
    const e = session();
    e.setValue(1, { depth: 3.2 });
    e.setValue(1, { depth: "" });
    expect(e.get(1)!.status).toBe(STATUS.EMPTY);
    expect(e.progress().measured).toBe(0);
  });

  test("a rejected value never enters the state", () => {
    const e = session();
    e.setValue(1, { depth: 3.2 });
    e.markQueued([1]);
    e.markSaved([1]);
    const r = e.setValue(1, { depth: 500 });
    expect(r.ok).toBe(false);
    expect(e.get(1)!.depth_in).toBe(3.2);
    expect(e.get(1)!.status).toBe(STATUS.SAVED);
  });
});

describe("resume", () => {
  test("hydrated rows are durable and the cursor lands on the first gap", () => {
    const e = session();
    const walk = serpentineOrder();
    const done = walk.slice(0, 12).map((n) => ({ point_nbr: n, depth_in: 3, temp_f: 22 }));
    e.hydrate(done);
    expect(e.progress().saved).toBe(12);
    expect(e.progress().measured).toBe(12);
    expect(e.current()).toBe(walk[12]);
  });

  test("a hole in the middle is where the walk resumes", () => {
    const e = session();
    const walk = serpentineOrder();
    const done = walk.filter((_, i) => i !== 7).slice(0, 20).map((n) => ({ point_nbr: n, depth_in: 3 }));
    e.hydrate(done);
    expect(e.current()).toBe(walk[7]);
  });

  test("nextUnmeasured returns null once every point is recorded", () => {
    const e = session();
    e.hydrate(serpentineOrder().map((n) => ({ point_nbr: n, depth_in: 3 })));
    expect(e.nextUnmeasured()).toBeNull();
    expect(e.progress().complete).toBe(true);
  });

  test("rows with no readings are ignored rather than counted as measured", () => {
    const e = session();
    e.hydrate([{ point_nbr: 4, depth_in: null, temp_f: null }]);
    expect(e.progress().measured).toBe(0);
    expect(e.get(4)!.status).toBe(STATUS.EMPTY);
  });
});

describe("review", () => {
  test("catches a thin spot surrounded by healthy ice", () => {
    // n-71's actual finding: pt 27 at 1.19" with neighbours at 3.5-4.4", and
    // round one surfaced nothing at all.
    const e = createEntry({ rink: "U", date: "2026-07-14", thinAt: 2.0 });
    for (const n of serpentineOrder()) e.setValue(n, { depth: 3.9 });
    e.setValue(27, { depth: 1.19 });

    const flags = e.review();
    expect(flags[0].point_nbr).toBe(27);
    expect(flags[0].thin).toBe(true);
    expect(flags[0].odd).toBe(true);
    expect(flags[0].neighbour_mean).toBeCloseTo(3.9, 6);
    expect(flags[0].off_by).toBeCloseTo(1.19 - 3.9, 6);
  });

  test("uniform healthy ice raises nothing", () => {
    const e = session();
    for (const n of serpentineOrder()) e.setValue(n, { depth: 3.5 });
    expect(e.review()).toEqual([]);
  });

  test("a fat-fingered outlier is flagged even when it is thick", () => {
    const e = session();
    for (const n of serpentineOrder()) e.setValue(n, { depth: 3.5 });
    e.setValue(18, { depth: 8 }); // meant 3.5, hit the wrong key
    const flags = e.review();
    expect(flags.some((f: any) => f.point_nbr === 18 && f.odd && f.wild)).toBe(true);
  });

  test("an impossible depth is refused at entry, never left for review", () => {
    // Two tiers on purpose: 8" is wrong-but-possible so it lands and gets
    // flagged; 35" cannot be ice, so it is turned away at the keyboard and the
    // last good value survives.
    const e = session();
    e.setValue(18, { depth: 3.5 });
    expect(e.setValue(18, { depth: 35 }).ok).toBe(false);
    expect(e.get(18)!.depth_in).toBe(3.5);
  });

  test("flags come back thinnest first", () => {
    const e = session();
    for (const n of serpentineOrder()) e.setValue(n, { depth: 3.5 });
    e.setValue(2, { depth: 1.8 });
    e.setValue(27, { depth: 0.9 });
    expect(e.review().map((f: any) => f.point_nbr).slice(0, 2)).toEqual([27, 2]);
  });

  test("unmeasured points are not reviewed as zero", () => {
    const e = session();
    e.setValue(1, { depth: 3.5 });
    expect(e.review().every((f: any) => f.point_nbr === 1 || f.depth_in != null)).toBe(true);
    expect(e.review().length).toBeLessThanOrEqual(1);
  });
});

describe("stats", () => {
  test("are empty rather than zero on a blank session", () => {
    // "Credible when half-empty" — a blank session reporting min 0.00" would be
    // a lie the GM could read off the screen.
    expect(session().stats()).toEqual({ n: 0, min: null, max: null, mean: null });
  });

  test("summarise only what was measured", () => {
    const e = session();
    e.setValue(1, { depth: 2 });
    e.setValue(2, { depth: 4 });
    expect(e.stats()).toMatchObject({ n: 2, min: 2, max: 4, mean: 3 });
  });
});
