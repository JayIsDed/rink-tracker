// Card photos.
//
// The `card_photos` table, the `photo_count` on every card row, and `sharp` in
// package.json have all been here since R1 — with no route that could write a
// photo and no screen that could show one. The composition check (AMENDMENT 1
// on n-72) found the gap: this is R2 scope that was specified in the runbook's
// data model and never built, not a round-one feature anyone decided to drop.
//
// It matters because the incumbent is pen and paper, and pen and paper cannot
// take a picture of the crack. "Photo, location, severity — done in 30 seconds"
// was round one's own pitch for the surface the crew never adopted.
//
// Storage mirrors round one: originals under <data>/photos/YYYY-MM-DD/, a 480px
// JPEG thumb alongside under thumbs/. Sharp auto-rotates from EXIF (phones
// almost always need it), resizes down, and strips metadata on the way out —
// which also strips the GPS tags a crew phone attaches by default.

import { mkdirSync, statSync, readFileSync, unlinkSync } from "node:fs";
import { join, normalize, dirname } from "node:path";
import { db, json, bad, audit, DB_PATH } from "../db";

// Derived from the database location, not hardcoded to ./data — the test
// harness points RINK_DB at a temp directory per file, and photos have to land
// there too or one test run scribbles into the real photo store.
const DATA_DIR = dirname(DB_PATH);
export const PHOTOS_DIR = join(DATA_DIR, "photos");
export const PHOTOS_THUMBS_DIR = join(PHOTOS_DIR, "thumbs");
mkdirSync(PHOTOS_THUMBS_DIR, { recursive: true });

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_PER_REQUEST = 8;

type PhotoRow = {
  id: number;
  card_id: number;
  path: string;
  thumb_path: string;
  width: number | null;
  height: number | null;
  added_by: string;
  added_at: number;
};

const qList = db.query<PhotoRow, [number]>(
  "SELECT * FROM card_photos WHERE card_id = ? ORDER BY added_at, id"
);
const qGet = db.query<PhotoRow, [number]>("SELECT * FROM card_photos WHERE id = ?");
const qInsert = db.query<{ id: number }, unknown[]>(`
  INSERT INTO card_photos (card_id, path, thumb_path, width, height, added_by, added_at)
  VALUES ($card, $path, $thumb, $w, $h, $by, $at)
  RETURNING id
`);
const qDelete = db.query("DELETE FROM card_photos WHERE id = $id");
const qCardExists = db.query<{ id: number }, [number]>("SELECT id FROM cards WHERE id = ?");

/** Public shape. The client never sees a filesystem path. */
export function shape(p: PhotoRow) {
  return {
    id: p.id,
    url: `/api/photos/${p.path}`,
    thumb_url: `/api/photos/thumbs/${p.thumb_path}`,
    width: p.width,
    height: p.height,
    added_by: p.added_by,
    added_at: p.added_at,
  };
}

export function listFor(cardId: number) {
  return qList.all(cardId).map(shape);
}

/** Thumbnails for many cards at once, so the board doesn't do an N+1. */
export function thumbsForCards(ids: number[]): Map<number, ReturnType<typeof shape>[]> {
  const out = new Map<number, ReturnType<typeof shape>[]>();
  if (!ids.length) return out;
  const rows = db
    .query<PhotoRow, unknown[]>(
      `SELECT * FROM card_photos WHERE card_id IN (${ids.map(() => "?").join(",")}) ORDER BY added_at, id`
    )
    .all(...ids);
  for (const r of rows) {
    const arr = out.get(r.card_id) ?? [];
    arr.push(shape(r));
    out.set(r.card_id, arr);
  }
  return out;
}

function todayDir(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function store(file: File, cardId: number, actor: string): Promise<PhotoRow> {
  if (file.size > MAX_BYTES) {
    throw new Error(`photo too large (${(file.size / 1024 / 1024).toFixed(1)} MB over the 25 MB cap)`);
  }
  const buf = Buffer.from(await file.arrayBuffer());
  // Lazy so a request that touches no photo never pays sharp's load cost.
  const sharp = (await import("sharp")).default;

  const dir = todayDir();
  mkdirSync(join(PHOTOS_DIR, dir), { recursive: true });
  mkdirSync(join(PHOTOS_THUMBS_DIR, dir), { recursive: true });

  const stem = `${Date.now()}-${randomHex(6)}`;
  const path = `${dir}/${stem}.jpg`;
  const thumb_path = `${dir}/${stem}-thumb.jpg`;

  const info = await sharp(buf, { failOn: "error" })
    .rotate()
    .resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toFile(join(PHOTOS_DIR, path));

  await sharp(buf, { failOn: "error" })
    .rotate()
    .resize({ width: 480, height: 480, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 75, mozjpeg: true })
    .toFile(join(PHOTOS_THUMBS_DIR, thumb_path));

  const at = Date.now();
  const { id } = qInsert.get({
    $card: cardId,
    $path: path,
    $thumb: thumb_path,
    $w: info.width,
    $h: info.height,
    $by: actor,
    $at: at,
  })!;
  return { id, card_id: cardId, path, thumb_path, width: info.width, height: info.height, added_by: actor, added_at: at };
}

export async function handleUpload(req: Request, cardId: number, actor: string | null): Promise<Response> {
  if (!actor) return bad("pick your name first", 401);
  if (!qCardExists.get(cardId)) return bad("no such card", 404);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return bad("invalid multipart body");
  }

  const files = form.getAll("photos").filter((f): f is File => f instanceof File && f.size > 0);
  if (!files.length) return bad("no photos in the upload");
  if (files.length > MAX_PER_REQUEST) return bad(`at most ${MAX_PER_REQUEST} photos at a time`);

  const stored = [];
  for (const f of files) {
    try {
      stored.push(await store(f, cardId, actor));
    } catch (err) {
      // Fail loudly. Round one swallowed a failed upload and kept the issue
      // alive, which means someone photographs a hazard, sees the card save,
      // and walks away believing the picture went with it.
      return bad(`couldn't process that image: ${(err as Error).message}`);
    }
  }

  audit(actor, "card.photos", String(cardId), { added: stored.length });
  return json({ ok: true, photos: stored.map(shape) });
}

export function handleDelete(cardId: number, photoId: number, actor: string | null, isAdmin: boolean): Response {
  if (!actor) return bad("pick your name first", 401);
  if (!isAdmin) return bad("admin required", 403);
  const photo = qGet.get(photoId);
  if (!photo || photo.card_id !== cardId) return bad("no such photo", 404);

  qDelete.run({ $id: photoId });
  audit(actor, "card.photo_delete", String(cardId), { photo: photoId });
  // Best effort on disk — a row that no longer exists must not resurrect
  // because a file was already gone.
  for (const p of [join(PHOTOS_DIR, photo.path), join(PHOTOS_THUMBS_DIR, photo.thumb_path)]) {
    try {
      unlinkSync(p);
    } catch {
      /* already gone */
    }
  }
  return json({ ok: true });
}

/**
 * Resolve a request path inside a base directory, or null.
 *
 * The whole point is that `rel` arrives from the URL. Traversal, absolute
 * paths, backslashes and embedded nulls are all rejected before `normalize`,
 * and the resolved path is re-checked against the base afterwards.
 */
export function safeResolve(baseDir: string, rel: string): string | null {
  if (!rel || rel.includes("\0") || rel.includes("\\") || rel.startsWith("/")) return null;
  const full = normalize(join(baseDir, rel));
  if (!full.startsWith(baseDir + "/")) return null;
  return full;
}

export function handleServe(rel: string, kind: "full" | "thumb"): Response {
  const path = safeResolve(kind === "thumb" ? PHOTOS_THUMBS_DIR : PHOTOS_DIR, decodeURIComponent(rel));
  if (!path) return new Response("forbidden", { status: 403 });
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return new Response("not found", { status: 404 });
    return new Response(readFileSync(path), {
      headers: {
        "content-type": "image/jpeg",
        // Private: these are pictures of a workplace, and the filename is a
        // random stem rather than a guessable id, but they are not secrets
        // either. Immutable because a stem is never reused.
        "cache-control": "private, max-age=86400, immutable",
        "content-length": String(stat.size),
      },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}
