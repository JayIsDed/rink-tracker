// Behavioural tests over the R2 write paths, driven through the real HTTP
// surface so routing, cookies and idempotency are exercised too.
//
// The server runs as its own process with its own temp database — see
// test/helpers/server.ts for why importing the module directly does not survive
// a second test file doing the same.

import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { startServer, type TestServer } from "./helpers/server";

let srv: TestServer;
const call = (path: string, init?: RequestInit) => srv.call(path, init);

beforeAll(async () => {
  srv = await startServer("board");
});

afterAll(() => srv?.stop());

describe("identity gate", () => {
  test("a nameless device cannot write", async () => {
    const r = await call("/api/cards", { method: "POST", body: JSON.stringify({ title: "x" }) });
    expect(r.status).toBe(401);
  });

  test("picking a name is one call and sticks", async () => {
    const r = await call("/api/identity", { method: "POST", body: JSON.stringify({ name: "Dana" }) });
    expect(r.status).toBe(200);
    expect(r.body.who).toBe("Dana");
    const b = await call("/api/bootstrap");
    expect(b.body.who).toBe("Dana");
    expect(b.body.is_admin).toBe(false);
  });
});

describe("cards — one card type", () => {
  let id = 0;

  test("anyone can raise a card, and it starts unclaimed", async () => {
    const r = await call("/api/cards", {
      method: "POST",
      body: JSON.stringify({ title: "Door latch sticks", body: "north door", rink_code: "U" }),
    });
    expect(r.status).toBe(200);
    id = r.body.id;
    expect(r.body.status).toBe("noticed");
    expect(r.body.claimed_by).toBeNull();
    expect(r.body.created_by).toBe("Dana");
    expect(r.body.severity).toBe(1);
  });

  test("severity above tier 2 needs admin — a card is not a megaphone", async () => {
    const r = await call("/api/cards", {
      method: "POST",
      body: JSON.stringify({ title: "loud", severity: 3 }),
    });
    expect(r.body.severity).toBe(2);
  });

  test("claiming turns a problem into a project — one tap, attributed", async () => {
    const r = await call(`/api/cards/${id}/claim`, { method: "POST" });
    expect(r.body.status).toBe("doing");
    expect(r.body.claimed_by).toBe("Dana");
    expect(r.body.claimed_at).toBeGreaterThan(0);
  });

  test("claim-on-create does both in one gesture", async () => {
    const r = await call("/api/cards", {
      method: "POST",
      body: JSON.stringify({ title: "Regrind blade", claim: true }),
    });
    expect(r.body.status).toBe("doing");
    expect(r.body.claimed_by).toBe("Dana");
  });

  test("only the person on it can drop it", async () => {
    await call("/api/identity", { method: "POST", body: JSON.stringify({ name: "Sam" }) });
    const r = await call(`/api/cards/${id}/unclaim`, { method: "POST" });
    expect(r.status).toBe(403);
    await call("/api/identity", { method: "POST", body: JSON.stringify({ name: "Dana" }) });
    expect((await call(`/api/cards/${id}/unclaim`, { method: "POST" })).body.status).toBe("noticed");
  });

  test("finishing records who and when, and back-fills the claim", async () => {
    const r = await call(`/api/cards/${id}/done`, { method: "POST" });
    expect(r.body.status).toBe("done");
    expect(r.body.done_by).toBe("Dana");
    expect(r.body.claimed_by).toBe("Dana");
  });

  test("reopening clears the completion", async () => {
    const r = await call(`/api/cards/${id}/reopen`, { method: "POST" });
    expect(r.body.status).toBe("doing");
    expect(r.body.done_at).toBeNull();
  });

  describe("due-date trichotomy", () => {
    test("none is the default and needs no fields", async () => {
      const r = await call("/api/cards", { method: "POST", body: JSON.stringify({ title: "whenever" }) });
      expect(r.body.due_kind).toBe("none");
    });

    test("a free-text anchor is a first-class option", async () => {
      const r = await call("/api/cards", {
        method: "POST",
        body: JSON.stringify({ title: "nets", due_kind: "before", due_text: "the tournament" }),
      });
      expect(r.body.due_kind).toBe("before");
      expect(r.body.due_text).toBe("the tournament");
    });

    test("an anchor with no text is rejected rather than silently dropped", async () => {
      const r = await call("/api/cards", {
        method: "POST",
        body: JSON.stringify({ title: "x", due_kind: "before", due_text: "  " }),
      });
      expect(r.status).toBe(400);
    });

    test("a hard timestamp round-trips", async () => {
      const at = Date.now() + 86400000;
      const r = await call("/api/cards", {
        method: "POST",
        body: JSON.stringify({ title: "inspection", due_kind: "at", due_at: at }),
      });
      expect(r.body.due_at).toBe(at);
    });
  });

  test("admin-only levers refuse a plain crew member", async () => {
    const r = await call(`/api/cards/${id}`, { method: "PATCH", body: JSON.stringify({ severity: 3 }) });
    expect(r.status).toBe(403);
    expect((await call(`/api/cards/${id}`, { method: "DELETE" })).status).toBe(403);
  });

  test("an idempotent retry does not create a second card", async () => {
    const key = crypto.randomUUID();
    const one = await call("/api/cards", {
      method: "POST",
      headers: { "idempotency-key": key },
      body: JSON.stringify({ title: "outbox retry" }),
    });
    const two = await call("/api/cards", {
      method: "POST",
      headers: { "idempotency-key": key },
      body: JSON.stringify({ title: "outbox retry" }),
    });
    expect(two.body.id).toBe(one.body.id);
    expect(two.headers.get("idempotent-replayed")).toBe("1");
  });
});

describe("admin unlock", () => {
  test("a wrong PIN does not unlock", async () => {
    const r = await call("/api/admin/unlock", {
      method: "POST",
      body: JSON.stringify({ name: "Boss", pin: "0000" }),
    });
    expect(r.status).toBe(403);
  });

  test("the right PIN unlocks, and severity 3 becomes available", async () => {
    const r = await call("/api/admin/unlock", {
      method: "POST",
      body: JSON.stringify({ name: "Boss", pin: "9999" }),
    });
    expect(r.status).toBe(200);
    const c = await call("/api/cards", {
      method: "POST",
      body: JSON.stringify({ title: "top tier", severity: 3 }),
    });
    expect(c.body.severity).toBe(3);
  });

  test("admin is a PERMISSION, not an identity — attribution stays with the device", async () => {
    // Ruled 07-28: pick-your-name once per device; the PIN guards admin only.
    // The two axes are orthogonal, so Boss's PIN grants powers to whoever is
    // holding the device and the work is still recorded against them. If this
    // ever flips to "unlocking makes you Boss", the audit trail changes meaning
    // and this test is the place that says so.
    const b = await call("/api/bootstrap");
    expect(b.body.who).toBe("Dana");
    expect(b.body.is_admin).toBe(true);

    const c = await call("/api/cards", {
      method: "POST",
      body: JSON.stringify({ title: "raised while elevated", severity: 3 }),
    });
    expect(c.body.severity).toBe(3);
    expect(c.body.created_by).toBe("Dana");
  });

  test("a tampered admin cookie is rejected", async () => {
    const good = srv.cookies;
    srv.cookies = good.replace(/.$/, (ch) => (ch === "A" ? "B" : "A"));
    const b = await call("/api/bootstrap");
    expect(b.body.is_admin).toBe(false);
    srv.cookies = good;
  });
});

describe("tickers and the outcome selector", () => {
  let tickerId = 0;

  test("seeded tickers derive red/never before anything is logged", async () => {
    const r = await call("/api/tickers");
    expect(r.body.length).toBeGreaterThan(0);
    tickerId = r.body[0].id;
    expect(r.body[0].state).toBe("red");
    expect(r.body[0].never).toBe(true);
  });

  test("completing one turns it green and records the doer", async () => {
    const r = await call(`/api/tickers/${tickerId}/complete`, {
      method: "POST",
      body: JSON.stringify({ outcome: "went_well" }),
    });
    expect(r.status).toBe(200);
    expect(r.body.ticker.state).toBe("green");
    expect(r.body.ticker.last_done_by).toBe("Dana");
    expect(r.body.spawned_card).toBeNull();
  });

  test("V8 — 'something else is wrong' spawns an attributed, linked card", async () => {
    const r = await call(`/api/tickers/${tickerId}/complete`, {
      method: "POST",
      body: JSON.stringify({ outcome: "something_wrong", notes: "hydraulic weep at the fitting" }),
    });
    expect(r.body.spawned_card).not.toBeNull();
    expect(r.body.spawned_card.created_by).toBe("Dana");
    expect(r.body.spawned_card.body).toBe("hydraulic weep at the fitting");
    expect(r.body.spawned_card.status).toBe("noticed");

    const log = await call(`/api/maintenance?ticker_id=${tickerId}`);
    expect(log.body[0].spawned_card_id).toBe(r.body.spawned_card.id);
  });

  test("an unknown outcome is refused", async () => {
    const r = await call(`/api/tickers/${tickerId}/complete`, {
      method: "POST",
      body: JSON.stringify({ outcome: "fine" }),
    });
    expect(r.status).toBe(400);
  });

  test("anyone can nudge a green ticker to amber", async () => {
    const r = await call(`/api/tickers/${tickerId}/nudge`, { method: "POST" });
    expect(r.body.state).toBe("amber");
    expect(r.body.nudged).toBe(true);
    expect(r.body.nudged_by).toBe("Dana");
  });

  test("doing the job clears the nudge", async () => {
    await call(`/api/tickers/${tickerId}/complete`, {
      method: "POST",
      body: JSON.stringify({ outcome: "went_well" }),
    });
    const r = await call("/api/tickers");
    const t = r.body.find((x: any) => x.id === tickerId);
    expect(t.nudged).toBe(false);
    expect(t.state).toBe("green");
  });

  test("interval edits are admin-only and bounded", async () => {
    const r = await call(`/api/tickers/${tickerId}`, {
      method: "PATCH",
      body: JSON.stringify({ interval_days: 99999 }),
    });
    expect(r.status).toBe(400);
    const ok = await call(`/api/tickers/${tickerId}`, {
      method: "PATCH",
      body: JSON.stringify({ interval_days: 45 }),
    });
    expect(ok.body.interval_days).toBe(45);
  });
});

describe("propane — time-since only", () => {
  test("all four slots exist before any swap is logged", async () => {
    const r = await call("/api/propane");
    expect(r.body.length).toBe(4);
    expect(r.body.every((s: any) => s.swapped_at === null)).toBe(true);
    expect(new Set(r.body.map((s: any) => s.side))).toEqual(new Set(["L", "R"]));
  });

  test("a swap can be logged by rink alone — the NFC tag has no database id", async () => {
    const r = await call("/api/propane", {
      method: "POST",
      body: JSON.stringify({ rink: "U", side: "L" }),
    });
    expect(r.status).toBe(200);
    const slot = r.body.propane.find((s: any) => s.rink_code === "U" && s.side === "L");
    expect(slot.swapped_by).toBe("Dana");
    expect(slot.swap_count).toBe(1);
  });

  test("each side keeps its own history", async () => {
    await call("/api/propane", { method: "POST", body: JSON.stringify({ rink: "U", side: "R" }) });
    const r = await call("/api/propane");
    const l = r.body.find((s: any) => s.rink_code === "U" && s.side === "L");
    const rr = r.body.find((s: any) => s.rink_code === "U" && s.side === "R");
    expect(l.swap_count).toBe(1);
    expect(rr.swap_count).toBe(1);
    const lower = r.body.filter((s: any) => s.rink_code === "L");
    expect(lower.every((s: any) => s.swap_count === 0)).toBe(true);
  });

  test("a bad side is refused", async () => {
    const r = await call("/api/propane", {
      method: "POST",
      body: JSON.stringify({ rink: "U", side: "middle" }),
    });
    expect(r.status).toBe(400);
  });
});

describe("feed", () => {
  test("unions every kind of event without an events table", async () => {
    const r = await call("/api/feed");
    const kinds = new Set(r.body.events.map((e: any) => e.kind));
    expect(kinds.has("card_created")).toBe(true);
    expect(kinds.has("maintenance")).toBe(true);
    expect(kinds.has("propane")).toBe(true);
    expect(kinds.has("nudge")).toBe(true);
  });

  test("is newest-first", async () => {
    const r = await call("/api/feed");
    const ats = r.body.events.map((e: any) => e.at);
    expect([...ats].sort((a, b) => b - a)).toEqual(ats);
  });

  test("since-marker counts only what is newer", async () => {
    const all = await call("/api/feed");
    const newest = all.body.events[0].at;
    const r = await call(`/api/feed?since=${newest}`);
    expect(r.body.unseen).toBe(0);
    expect(r.body.events.length).toBe(0);
  });

  test("carried ice sessions show up as sessions", async () => {
    const r = await call("/api/sessions?limit=3");
    expect(Array.isArray(r.body)).toBe(true);
  });
});
