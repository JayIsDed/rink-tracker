// The offline outbox.
//
// This is the piece that lets entry mode promise a reading is safe the moment
// it is typed, so a bug here loses crew data silently — the worst failure this
// app has. Each of its three rules gets a test that fails if the rule is
// removed.
//
// The module is browser code: it reads localStorage, fetch and navigator.onLine
// off globals. Rather than mock a whole DOM, the globals it actually touches are
// stubbed before import — which is also a fair check that it does not quietly
// depend on anything else.

import { expect, test, describe, beforeEach, beforeAll, afterAll } from "bun:test";

// ── Browser stubs ─────────────────────────────────────────────────────

class MemoryStorage {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, String(v));
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

// localStorage must exist at import — the module reads its queue at module
// scope. Nothing else in the suite touches it, so this one can stay global.
(globalThis as any).localStorage = new MemoryStorage();

// navigator is EXTENDED, not replaced. Bun ships a real one and clobbering it
// would reach past this file.
function setOnline(v: boolean) {
  Object.defineProperty(globalThis.navigator, "onLine", { value: v, configurable: true });
}
setOnline(true);

type Call = { path: string; key: string; body: any };
let calls: Call[] = [];
let handler: (c: Call) => { status: number; body: any };

const stubFetch = async (path: string, init: any) => {
  const call = { path, key: init.headers["idempotency-key"], body: JSON.parse(init.body) };
  calls.push(call);
  const res = handler(call);
  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    text: async () => JSON.stringify(res.body),
  };
};

// fetch is stubbed only for the life of THIS file. Installing it at module scope
// broke the server-driven files: Bun evaluates every test module before running
// any test, so a module-scope stub is live during other files' beforeAll —
// which is the same shared-process trap test/helpers/server.ts exists for.
const realFetch = globalThis.fetch;
beforeAll(() => {
  (globalThis as any).fetch = stubFetch;
});
afterAll(() => {
  (globalThis as any).fetch = realFetch;
});

const outbox = await import("../public/shared/outbox.js");

const settled: { outcome: string; points: number[]; reason: string | null }[] = [];
outbox.onSettled(({ entry, outcome, reason }: any) =>
  settled.push({ outcome, points: entry.meta.points ?? [], reason: reason ?? null })
);

/** Queue a measurement the way entry mode does. */
const put = (point: number, depth: number) =>
  outbox.enqueue("/api/ice/measurements", { points: [{ point_nbr: point, depth_in: depth }] }, { points: [point] });

const settle = () => new Promise((r) => setTimeout(r, 30));

beforeEach(() => {
  outbox.discardAll();
  calls = [];
  settled.length = 0;
  setOnline(true);
  handler = () => ({ status: 200, body: { ok: true } });
});

// ── Rule 1: the key is minted once ────────────────────────────────────

describe("idempotency key", () => {
  test("is reused across retries of the same write", async () => {
    let attempt = 0;
    handler = () => (++attempt === 1 ? { status: 503, body: { error: "down" } } : { status: 200, body: { ok: true } });

    put(4, 3.2);
    await settle();
    await outbox.flush();
    await settle();

    expect(calls.length).toBeGreaterThanOrEqual(2);
    // A retry after a lost response MUST carry the same key, or the server
    // applies the write twice instead of recognising a replay.
    expect(calls[0].key).toBe(calls[1].key);
  });

  test("differs between distinct writes", async () => {
    put(4, 3.2);
    put(5, 3.4);
    await settle();
    expect(calls[0].key).not.toBe(calls[1].key);
  });
});

// ── Rule 2: strictly sequential ───────────────────────────────────────

describe("ordering", () => {
  test("a correction never overtakes the value it corrects", async () => {
    // Entry mode's exact shape: type 3.5, notice the mistake, type 4.0. Sent in
    // parallel these can land either way round and the correction can lose.
    //
    // Queued offline first on purpose — enqueueing online flushes each write
    // before the next arrives, so the drain loop never sees a queue deeper than
    // one and the ordering rule is never actually exercised.
    setOnline(false);
    put(9, 3.5);
    put(9, 4.0);
    put(9, 4.25);
    await settle();
    expect(calls.length).toBe(0);

    setOnline(true);
    await outbox.flush();
    await settle();

    expect(calls.map((c) => c.body.points[0].depth_in)).toEqual([3.5, 4.0, 4.25]);
  });

  test("everything behind a stalled write waits for it", async () => {
    let fail = true;
    handler = (c) => (fail && c.body.points[0].point_nbr === 1 ? { status: 503, body: {} } : { status: 200, body: {} });

    put(1, 3.0);
    put(2, 3.1);
    await settle();

    // Only the head has been attempted; point 2 must not have jumped it.
    expect(calls.every((c) => c.body.points[0].point_nbr === 1)).toBe(true);

    fail = false;
    await outbox.flush();
    await settle();
    expect(calls.map((c) => c.body.points[0].point_nbr)).toEqual([1, 1, 2]);
  });

  test("nothing is sent while offline, and the queue survives", async () => {
    setOnline(false);
    put(7, 2.9);
    await settle();
    expect(calls.length).toBe(0);
    expect(outbox.status().pending).toBe(1);

    setOnline(true);
    await outbox.flush();
    await settle();
    expect(calls.length).toBe(1);
    expect(outbox.status().pending).toBe(0);
  });
});

// ── Rule 3: rejected writes do not retry forever ──────────────────────

describe("dead letters", () => {
  test("a 400 is given up on rather than blocking the queue behind it", async () => {
    handler = (c) =>
      c.body.points[0].point_nbr === 1
        ? { status: 400, body: { error: "depth must be 0..24" } }
        : { status: 200, body: { ok: true } };

    put(1, 99);
    put(2, 3.0);
    await settle();

    expect(outbox.status().dead).toBe(1);
    expect(outbox.status().pending).toBe(0);
    // The good write behind it still went out.
    expect(calls.some((c) => c.body.points[0].point_nbr === 2)).toBe(true);
  });

  test("the rejection reason reaches the caller so the map can show it", async () => {
    handler = () => ({ status: 400, body: { error: "depth must be 0..24" } });
    put(1, 99);
    await settle();

    const dead = settled.find((s) => s.outcome === outbox.DEAD);
    expect(dead).toBeDefined();
    expect(dead!.points).toEqual([1]);
    expect(dead!.reason).toContain("0..24");
  });

  test("a 401 IS retried — it is a state that can resolve", async () => {
    // Pick-your-name has not happened yet. Dropping the reading would punish the
    // operator for the app's own gate.
    let denied = true;
    handler = () => (denied ? { status: 401, body: { error: "pick your name first" } } : { status: 200, body: {} });

    put(3, 3.3);
    await settle();
    expect(outbox.status().dead).toBe(0);
    expect(outbox.status().pending).toBe(1);

    denied = false;
    await outbox.flush();
    await settle();
    expect(outbox.status().pending).toBe(0);
    expect(settled.some((s) => s.outcome === outbox.SENT)).toBe(true);
  });

  test("a permanently unreachable server eventually gives up instead of spinning", async () => {
    handler = () => {
      throw new Error("network down");
    };
    put(6, 3.1);
    for (let i = 0; i < 10; i++) {
      await outbox.flush();
      await settle();
    }
    expect(outbox.status().dead).toBe(1);
    expect(outbox.status().pending).toBe(0);
  });
});

// ── Durability across a reload ────────────────────────────────────────

describe("persistence", () => {
  test("a queued reading is written to storage, not just held in memory", async () => {
    setOnline(false);
    put(11, 3.7);
    await settle();

    const raw = JSON.parse((globalThis as any).localStorage.getItem("rt:outbox"));
    expect(raw.length).toBe(1);
    expect(raw[0].body.points[0].point_nbr).toBe(11);
    // The key rides along, so the retry after a reload is still a replay.
    expect(typeof raw[0].key).toBe("string");
  });

  test("storage is cleared as writes land", async () => {
    put(12, 3.8);
    await settle();
    expect(JSON.parse((globalThis as any).localStorage.getItem("rt:outbox")).length).toBe(0);
  });
});

describe("reporting", () => {
  test("settle callbacks carry which points they were for", async () => {
    put(21, 3.0);
    await settle();
    expect(settled).toEqual([{ outcome: outbox.SENT, points: [21], reason: null }]);
  });

  test("status reflects the queue without needing a flush to be observed", async () => {
    setOnline(false);
    put(22, 3.0);
    put(23, 3.0);
    await settle();
    const s = outbox.status();
    expect(s.pending).toBe(2);
    expect(s.online).toBe(false);
  });
});
