// Card photos — the pipeline round one had and the rebuild shipped a schema for
// without ever building. Found by the composition check (AMENDMENT 1 on n-72).

import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { startServer, type TestServer } from "./helpers/server";
import { safeResolve } from "../server/routes/photos";

let srv: TestServer;
const call = (path: string, init?: RequestInit) => srv.call(path, init);

/** A real JPEG, so sharp does real work rather than being mocked around. */
async function jpeg(w = 1200, h = 900): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: 40, g: 90, b: 160 } } })
    .jpeg()
    .toBuffer();
}

/**
 * Raw fetch rather than `srv.call`, because that helper always sets a JSON
 * content-type and a multipart request must let fetch write its own — the
 * boundary token lives in that header. Cookies are carried by hand.
 */
async function postForm(path: string, fd: FormData, cookie = srv.cookies) {
  const res = await fetch(srv.base + path, { method: "POST", body: fd, headers: cookie ? { cookie } : {} });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body: body as never };
}

async function uploadTo(cardId: number, files: { name: string; buf: Buffer }[]) {
  const fd = new FormData();
  for (const f of files) fd.append("photos", new Blob([f.buf], { type: "image/jpeg" }), f.name);
  return postForm(`/api/cards/${cardId}/photos`, fd);
}

let cardId: number;

beforeAll(async () => {
  srv = await startServer("photos");
  await call("/api/identity", { method: "POST", body: JSON.stringify({ name: "Dana" }) });
  const c = await call("/api/cards", { method: "POST", body: JSON.stringify({ title: "Crack by the blue line" }) });
  cardId = c.body.id;
});

afterAll(() => srv?.stop());

describe("upload", () => {
  test("a photo attaches to a card and comes back with both urls", async () => {
    const r = await uploadTo(cardId, [{ name: "crack.jpg", buf: await jpeg() }]);
    expect(r.status).toBe(200);
    expect(r.body.photos.length).toBe(1);
    const p = r.body.photos[0];
    expect(p.url).toMatch(/^\/api\/photos\/\d{4}-\d{2}-\d{2}\//);
    expect(p.thumb_url).toMatch(/^\/api\/photos\/thumbs\//);
    expect(p.added_by).toBe("Dana");
  });

  test("the card now carries its photos, on the detail AND in the list", async () => {
    const one = await call(`/api/cards/${cardId}`);
    expect(one.body.photos.length).toBe(1);
    // The board renders thumbnails inline, so the list has to carry them too —
    // otherwise every row needs its own request.
    const list = await call("/api/cards");
    const mine = list.body.find((c: { id: number }) => c.id === cardId);
    expect(mine.photos.length).toBe(1);
    expect(mine.photo_count).toBe(1);
  });

  test("the stored image is served, resized and re-encoded as JPEG", async () => {
    const p = (await call(`/api/cards/${cardId}`)).body.photos[0];
    const res = await fetch(srv.base + p.url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(Number(res.headers.get("content-length"))).toBeGreaterThan(0);
  });

  test("the thumb is capped at 480px on its long edge", async () => {
    const sharp = (await import("sharp")).default;
    const p = (await call(`/api/cards/${cardId}`)).body.photos[0];
    const res = await fetch(srv.base + p.thumb_url);
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(480);
  });

  test("EXIF is stripped — a crew phone tags its photos with GPS by default", async () => {
    const sharp = (await import("sharp")).default;
    const p = (await call(`/api/cards/${cardId}`)).body.photos[0];
    const res = await fetch(srv.base + p.url);
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    expect(meta.exif).toBeUndefined();
  });

  test("several photos at once, in one request", async () => {
    const c = await call("/api/cards", { method: "POST", body: JSON.stringify({ title: "Multi" }) });
    const r = await uploadTo(c.body.id, [
      { name: "a.jpg", buf: await jpeg(600, 400) },
      { name: "b.jpg", buf: await jpeg(400, 600) },
    ]);
    expect(r.body.photos.length).toBe(2);
    expect((await call(`/api/cards/${c.body.id}`)).body.photos.length).toBe(2);
  });

  test("a nameless device cannot attach photos", async () => {
    const fd = new FormData();
    fd.append("photos", new Blob([await jpeg()], { type: "image/jpeg" }), "x.jpg");
    const r = await postForm(`/api/cards/${cardId}/photos`, fd, "");
    expect(r.status).toBe(401);
  });

  test("uploading to a card that doesn't exist is a 404, not a stray file", async () => {
    expect((await uploadTo(999999, [{ name: "x.jpg", buf: await jpeg() }])).status).toBe(404);
  });

  test("an empty upload is rejected rather than silently succeeding", async () => {
    expect((await postForm(`/api/cards/${cardId}/photos`, new FormData())).status).toBe(400);
  });

  test("A FILE THAT IS NOT AN IMAGE FAILS LOUDLY", async () => {
    // Round one swallowed this and kept the issue alive, which means someone
    // photographs a hazard, watches the card save, and walks away believing the
    // picture went with it.
    const r = await uploadTo(cardId, [{ name: "notes.txt", buf: Buffer.from("this is not a jpeg") }]);
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toContain("couldn't process");
  });

  test("more than eight at a time is refused", async () => {
    const buf = await jpeg(200, 200);
    const files = Array.from({ length: 9 }, (_, i) => ({ name: `p${i}.jpg`, buf }));
    expect((await uploadTo(cardId, files)).status).toBe(400);
  });
});

describe("delete", () => {
  test("an ordinary member cannot delete a photo", async () => {
    const p = (await call(`/api/cards/${cardId}`)).body.photos[0];
    const r = await call(`/api/cards/${cardId}/photos/${p.id}`, { method: "DELETE" });
    expect(r.status).toBe(403);
  });

  test("an admin can, and the row goes with it", async () => {
    await call("/api/admin/unlock", { method: "POST", body: JSON.stringify({ name: "Boss", pin: "9999" }) });
    const before = (await call(`/api/cards/${cardId}`)).body.photos;
    const r = await call(`/api/cards/${cardId}/photos/${before[0].id}`, { method: "DELETE" });
    expect(r.status).toBe(200);
    const after = (await call(`/api/cards/${cardId}`)).body.photos;
    expect(after.length).toBe(before.length - 1);
  });

  test("a photo id from another card is not deletable through this one", async () => {
    const other = await call("/api/cards", { method: "POST", body: JSON.stringify({ title: "Other" }) });
    await uploadTo(other.body.id, [{ name: "o.jpg", buf: await jpeg(300, 300) }]);
    const theirs = (await call(`/api/cards/${other.body.id}`)).body.photos[0];
    const r = await call(`/api/cards/${cardId}/photos/${theirs.id}`, { method: "DELETE" });
    expect(r.status).toBe(404);
    // And it is still there.
    expect((await call(`/api/cards/${other.body.id}`)).body.photos.length).toBe(1);
  });

  test("deleting the card takes its photo rows with it", async () => {
    const c = await call("/api/cards", { method: "POST", body: JSON.stringify({ title: "Doomed" }) });
    await uploadTo(c.body.id, [{ name: "d.jpg", buf: await jpeg(300, 300) }]);
    expect((await call(`/api/cards/${c.body.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await call(`/api/cards/${c.body.id}`)).status).toBe(404);
  });
});

describe("serving is confined to the photo directory", () => {
  // The relative path arrives straight off the URL, so this is the guard that
  // stops it addressing the database sitting one directory up.
  const base = "/srv/data/photos";

  test("traversal, absolute paths, backslashes and nulls are all refused", () => {
    expect(safeResolve(base, "../rink.db")).toBeNull();
    expect(safeResolve(base, "a/../../rink.db")).toBeNull();
    expect(safeResolve(base, "/etc/passwd")).toBeNull();
    expect(safeResolve(base, "..\\rink.db")).toBeNull();
    expect(safeResolve(base, "a\0.jpg")).toBeNull();
    expect(safeResolve(base, "")).toBeNull();
  });

  test("an ordinary stored path resolves inside the base", () => {
    expect(safeResolve(base, "2026-07-28/1753-abcdef.jpg")).toBe(`${base}/2026-07-28/1753-abcdef.jpg`);
  });

  test("a sibling directory sharing the prefix is not inside it", () => {
    // `/srv/data/photos-private` starts with `/srv/data/photos` as a string.
    expect(safeResolve(base, "../photos-private/x.jpg")).toBeNull();
  });

  test("over HTTP, an encoded traversal gets nothing", async () => {
    const res = await fetch(srv.base + "/api/photos/..%2F..%2Frink.db");
    expect(res.status).toBeGreaterThanOrEqual(400);
    const thumb = await fetch(srv.base + "/api/photos/thumbs/..%2F..%2Frink.db");
    expect(thumb.status).toBeGreaterThanOrEqual(400);
  });

  test("a photo path that no longer exists is a 404, not a crash", async () => {
    const res = await fetch(srv.base + "/api/photos/2026-01-01/nope.jpg");
    expect(res.status).toBe(404);
  });
});
