// Rink Tracker — issues + photos + comments routes (step 3).
//
// Frictionless logging for "oh shit I found this" moments. Members create + edit
// their own issues, anyone can comment, admins can edit anything + delete photos
// + change severity (priority).
//
// Photos: stored on disk under data/photos/YYYY-MM-DD/<ts>-<rand>.jpg with a
// 480px JPEG thumb under data/photos/thumbs/YYYY-MM-DD/<ts>-<rand>-thumb.jpg.
// Sharp auto-rotates from EXIF, resizes down, and strips metadata on the way out.
//
// Location: optional. point_nbr snaps to the heatmap's 35-point grid (Upper rink
// only); x_norm/y_norm are free-form pins anywhere on the rink schematic.
// NULL location = "no specific spot" (e.g. a zamboni issue).

import { mkdirSync, statSync, readFileSync, unlinkSync } from "node:fs";
import { join, normalize } from "node:path";
import { db, json, PHOTOS_DIR, PHOTOS_THUMBS_DIR } from "../db";
import { audit, getRequestUser, parseCookies } from "../auth";

const TITLE_MAX = 200;
const BODY_MAX = 4000;
const COMMENT_MAX = 2000;
const SEVERITIES = new Set(["low", "med", "high"]);
const STATUSES = new Set(["open", "in_progress", "resolved"]);
const MAX_PHOTO_BYTES = 25 * 1024 * 1024; // 25MB upload cap, pre-resize
const MAX_PHOTOS_PER_REQUEST = 8;

type IssueRow = {
  id: number;
  rink_code: string;
  point_nbr: number | null;
  x_norm: number | null;
  y_norm: number | null;
  severity: string;
  status: string;
  title: string;
  body: string | null;
  created_by: number | null;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
  resolved_by: number | null;
};
type PhotoRow = {
  id: number;
  issue_id: number;
  filename: string;
  thumb_filename: string;
  width: number | null;
  height: number | null;
  size_bytes: number | null;
  mime_type: string | null;
  uploaded_by: number | null;
  uploaded_at: number;
};
type RevisionRow = {
  id: number;
  issue_id: number;
  user_id: number | null;
  action: string;
  field: string | null;
  old_value: string | null;
  new_value: string | null;
  comment: string | null;
  at: number;
};

// ──────────────────────────────────────────────────────────────────────
// Prepared queries
// ──────────────────────────────────────────────────────────────────────
const qListIssuesAll = db.query<IssueRow, [string]>(
  `SELECT * FROM issues WHERE rink_code = $1 ORDER BY created_at DESC LIMIT 500`
);
const qListIssuesByStatus = db.query<IssueRow, [string, string]>(
  `SELECT * FROM issues WHERE rink_code = $1 AND status = $2 ORDER BY created_at DESC LIMIT 500`
);
const qListIssuesOpen = db.query<IssueRow, [string]>(
  `SELECT * FROM issues WHERE rink_code = $1 AND status IN ('open','in_progress') ORDER BY created_at DESC LIMIT 500`
);
const qGetIssue = db.query<IssueRow, [number]>(`SELECT * FROM issues WHERE id = $1`);
const qInsertIssue = db.query(`
  INSERT INTO issues (rink_code, point_nbr, x_norm, y_norm, severity, status, title, body, created_by, created_at, updated_at)
  VALUES ($rink, $pt, $xn, $yn, $sev, 'open', $title, $body, $uid, $now, $now)
`);
const qUpdateIssue = db.query(`
  UPDATE issues
     SET title = $title, body = $body, severity = $sev, status = $status,
         point_nbr = $pt, x_norm = $xn, y_norm = $yn,
         updated_at = $now,
         resolved_at = CASE WHEN $status = 'resolved' AND resolved_at IS NULL THEN $now
                            WHEN $status <> 'resolved' THEN NULL
                            ELSE resolved_at END,
         resolved_by = CASE WHEN $status = 'resolved' AND resolved_by IS NULL THEN $uid
                            WHEN $status <> 'resolved' THEN NULL
                            ELSE resolved_by END
   WHERE id = $id
`);

const qListPhotos = db.query<PhotoRow, [number]>(
  `SELECT * FROM issue_photos WHERE issue_id = $1 ORDER BY uploaded_at, id`
);
const qGetPhoto = db.query<PhotoRow, [number]>(`SELECT * FROM issue_photos WHERE id = $1`);
const qInsertPhoto = db.query(`
  INSERT INTO issue_photos (issue_id, filename, thumb_filename, width, height, size_bytes, mime_type, uploaded_by, uploaded_at)
  VALUES ($issue_id, $filename, $thumb_filename, $w, $h, $sz, $mime, $uid, $now)
`);
const qDeletePhoto = db.query(`DELETE FROM issue_photos WHERE id = $1`);

const qListRevisions = db.query<RevisionRow, [number]>(
  `SELECT * FROM issue_revisions WHERE issue_id = $1 ORDER BY at, id`
);
const qInsertRevision = db.query(`
  INSERT INTO issue_revisions (issue_id, user_id, action, field, old_value, new_value, comment, at)
  VALUES ($issue_id, $uid, $action, $field, $old, $new, $comment, $at)
`);

const qListByPoint = db.query<
  { point_nbr: number; count: number; max_severity: string; statuses: string },
  [string]
>(`
  SELECT point_nbr,
         COUNT(*) AS count,
         CASE WHEN SUM(severity = 'high') > 0 THEN 'high'
              WHEN SUM(severity = 'med')  > 0 THEN 'med'
              ELSE 'low' END AS max_severity,
         GROUP_CONCAT(DISTINCT status) AS statuses
    FROM issues
   WHERE rink_code = $1 AND point_nbr IS NOT NULL AND status IN ('open','in_progress')
   GROUP BY point_nbr
`);

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────
function getRink(url: URL): string {
  const r = url.searchParams.get("rink");
  return r === "U" || r === "L" ? r : "U";
}

function pad(n: number): string { return String(n).padStart(2, "0"); }
function todayDir(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function randomHex(len: number): string {
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

function clampStr(v: unknown, max: number): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}
function parseNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function parsePoint(v: unknown): number | null {
  const n = parseNum(v);
  if (n == null) return null;
  if (!Number.isInteger(n) || n < 1 || n > 35) return null;
  return n;
}
function parseNorm(v: unknown): number | null {
  const n = parseNum(v);
  if (n == null) return null;
  if (n < 0 || n > 1) return null;
  return n;
}
function parseSeverity(v: unknown): string | null {
  if (typeof v !== "string") return null;
  return SEVERITIES.has(v) ? v : null;
}
function parseStatus(v: unknown): string | null {
  if (typeof v !== "string") return null;
  return STATUSES.has(v) ? v : null;
}
function parseRink(v: unknown): string {
  return v === "L" ? "L" : "U";
}

function adminFromCookie(req: Request): boolean {
  const cookies = parseCookies(req.headers.get("cookie"));
  return !!cookies.session;
}

function thumbUrl(p: PhotoRow): string { return `/api/photos/thumbs/${p.thumb_filename}`; }
function fullUrl(p: PhotoRow): string { return `/api/photos/${p.filename}`; }

function shapeIssue(row: IssueRow, photos: PhotoRow[]) {
  return {
    ...row,
    photos: photos.map((p) => ({
      id: p.id,
      url: fullUrl(p),
      thumb_url: thumbUrl(p),
      width: p.width,
      height: p.height,
      size_bytes: p.size_bytes,
      uploaded_by: p.uploaded_by,
      uploaded_at: p.uploaded_at,
    })),
  };
}

// ──────────────────────────────────────────────────────────────────────
// Sharp pipeline
// ──────────────────────────────────────────────────────────────────────
async function storePhoto(
  file: File,
  issueId: number,
  uploaderId: number | null,
): Promise<PhotoRow> {
  if (file.size > MAX_PHOTO_BYTES) {
    throw new Error(`photo too large (${(file.size / 1024 / 1024).toFixed(1)} MB > 25 MB cap)`);
  }
  const buf = Buffer.from(await file.arrayBuffer());

  // Lazy-import sharp so unrelated requests don't pay its load cost on cold start.
  const sharp = (await import("sharp")).default;

  const dateDir = todayDir();
  const baseDir = join(PHOTOS_DIR, dateDir);
  const thumbDir = join(PHOTOS_THUMBS_DIR, dateDir);
  mkdirSync(baseDir, { recursive: true });
  mkdirSync(thumbDir, { recursive: true });

  const stem = `${Date.now()}-${randomHex(6)}`;
  const filename = `${dateDir}/${stem}.jpg`;
  const thumbFilename = `${dateDir}/${stem}-thumb.jpg`;
  const fullPath = join(PHOTOS_DIR, filename);
  const thumbPath = join(PHOTOS_THUMBS_DIR, thumbFilename);

  const mainPipeline = sharp(buf, { failOn: "error" })
    .rotate()
    .resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true });

  const mainInfo = await mainPipeline.toFile(fullPath);

  await sharp(buf, { failOn: "error" })
    .rotate()
    .resize({ width: 480, height: 480, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 75, mozjpeg: true })
    .toFile(thumbPath);

  const now = Date.now();
  const result = qInsertPhoto.run({
    $issue_id: issueId,
    $filename: filename,
    $thumb_filename: thumbFilename,
    $w: mainInfo.width,
    $h: mainInfo.height,
    $sz: mainInfo.size,
    $mime: "image/jpeg",
    $uid: uploaderId,
    $now: now,
  });
  return {
    id: Number(result.lastInsertRowid),
    issue_id: issueId,
    filename,
    thumb_filename: thumbFilename,
    width: mainInfo.width,
    height: mainInfo.height,
    size_bytes: mainInfo.size,
    mime_type: "image/jpeg",
    uploaded_by: uploaderId,
    uploaded_at: now,
  };
}

// Splits photos[] from FormData and validates count.
function extractPhotos(form: FormData): File[] {
  const out: File[] = [];
  for (const f of form.getAll("photos")) {
    if (f instanceof File && f.size > 0) out.push(f);
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// Handlers — list + read
// ──────────────────────────────────────────────────────────────────────
export function handleListIssues(url: URL): Response {
  const rink = getRink(url);
  const status = url.searchParams.get("status");
  let rows: IssueRow[];
  if (status === "all") rows = qListIssuesAll.all(rink);
  else if (status && STATUSES.has(status)) rows = qListIssuesByStatus.all(rink, status);
  else rows = qListIssuesOpen.all(rink); // default = open + in_progress
  // Bulk-load photos so the list view can show thumbnails inline without N+1.
  const ids = rows.map((r) => r.id);
  const photoMap = new Map<number, PhotoRow[]>();
  if (ids.length > 0) {
    const placeholders = ids.map(() => "?").join(",");
    const stmt = db.prepare(
      `SELECT * FROM issue_photos WHERE issue_id IN (${placeholders}) ORDER BY uploaded_at, id`
    );
    const allPhotos = stmt.all(...ids) as PhotoRow[];
    for (const p of allPhotos) {
      const arr = photoMap.get(p.issue_id) ?? [];
      arr.push(p);
      photoMap.set(p.issue_id, arr);
    }
  }
  return json(rows.map((r) => shapeIssue(r, photoMap.get(r.id) ?? [])));
}

export function handleGetIssue(idStr: string): Response {
  const id = Number(idStr);
  if (!Number.isInteger(id) || id < 1) return json({ error: "bad id" }, 400);
  const row = qGetIssue.get(id);
  if (!row) return json({ error: "not found" }, 404);
  const photos = qListPhotos.all(id);
  const revisions = qListRevisions.all(id);
  return json({ ...shapeIssue(row, photos), revisions });
}

export function handleListIssuesByPoint(url: URL): Response {
  return json(qListByPoint.all(getRink(url)));
}

// ──────────────────────────────────────────────────────────────────────
// Handlers — create
// ──────────────────────────────────────────────────────────────────────
export async function handleCreateIssue(req: Request): Promise<Response> {
  const me = getRequestUser(req);
  // Both JSON and multipart paths supported. Multipart wins when there are photos.
  const ct = req.headers.get("content-type") ?? "";
  let title: string | null;
  let body: string | null;
  let severity: string | null;
  let rink: string;
  let point: number | null;
  let xNorm: number | null;
  let yNorm: number | null;
  let photoFiles: File[] = [];

  if (ct.startsWith("multipart/")) {
    let form: FormData;
    try { form = await req.formData(); }
    catch { return json({ error: "invalid multipart body" }, 400); }
    title    = clampStr(form.get("title"), TITLE_MAX);
    body     = clampStr(form.get("body"),  BODY_MAX);
    severity = parseSeverity(form.get("severity")) ?? "med";
    rink     = parseRink(form.get("rink_code"));
    point    = parsePoint(form.get("point_nbr"));
    xNorm    = parseNorm(form.get("x_norm"));
    yNorm    = parseNorm(form.get("y_norm"));
    photoFiles = extractPhotos(form);
  } else {
    let payload: any;
    try { payload = await req.json(); }
    catch { return json({ error: "invalid JSON body" }, 400); }
    title    = clampStr(payload?.title, TITLE_MAX);
    body     = clampStr(payload?.body,  BODY_MAX);
    severity = parseSeverity(payload?.severity) ?? "med";
    rink     = parseRink(payload?.rink_code);
    point    = parsePoint(payload?.point_nbr);
    xNorm    = parseNorm(payload?.x_norm);
    yNorm    = parseNorm(payload?.y_norm);
  }

  if (!title) return json({ error: "title required" }, 400);
  if (photoFiles.length > MAX_PHOTOS_PER_REQUEST) {
    return json({ error: `too many photos (${photoFiles.length} > ${MAX_PHOTOS_PER_REQUEST} per request)` }, 400);
  }
  // point_nbr wins; if provided, drop normalized coords for tidiness.
  if (point != null) { xNorm = null; yNorm = null; }
  // Lower rink doesn't have the 35-point grid — clear point_nbr if rink=L.
  if (rink === "L") point = null;

  const now = Date.now();
  const result = qInsertIssue.run({
    $rink: rink,
    $pt: point,
    $xn: xNorm,
    $yn: yNorm,
    $sev: severity,
    $title: title,
    $body: body,
    $uid: me?.id ?? null,
    $now: now,
  });
  const id = Number(result.lastInsertRowid);
  qInsertRevision.run({
    $issue_id: id, $uid: me?.id ?? null,
    $action: "created", $field: null, $old: null, $new: null, $comment: null,
    $at: now,
  });
  audit(me?.id ?? null, "issue.create", "issues", String(id), {
    rink_code: rink, point_nbr: point, severity, title,
  });

  // Process photos after the issue row exists so FK is satisfied.
  const storedPhotos: PhotoRow[] = [];
  for (const file of photoFiles) {
    try {
      const p = await storePhoto(file, id, me?.id ?? null);
      storedPhotos.push(p);
      qInsertRevision.run({
        $issue_id: id, $uid: me?.id ?? null,
        $action: "photo_added", $field: null, $old: null, $new: String(p.id), $comment: null,
        $at: Date.now(),
      });
    } catch (err: any) {
      // Best-effort — keep the issue alive even if a single photo fails.
      console.warn(`[issues] photo upload failed for issue ${id}:`, err?.message);
    }
  }

  const created = qGetIssue.get(id)!;
  return json(shapeIssue(created, storedPhotos), 201);
}

// ──────────────────────────────────────────────────────────────────────
// Handlers — patch
// ──────────────────────────────────────────────────────────────────────
//
// Permission rules:
//   - any signed-in user: change status of an issue (own or anyone's)
//   - owner of issue: edit title/body, replace location, edit own status
//   - admin (cookie session): edit anything, including severity (priority lever)
//
// Status changes count as edits-by-anyone because moving issues forward is the
// whole point — friction here defeats the AIO model.
export async function handlePatchIssue(req: Request, idStr: string): Promise<Response> {
  const id = Number(idStr);
  if (!Number.isInteger(id) || id < 1) return json({ error: "bad id" }, 400);
  const cur = qGetIssue.get(id);
  if (!cur) return json({ error: "not found" }, 404);

  const me = getRequestUser(req);
  if (!me) return json({ error: "auth required" }, 401);
  const isAdmin = me.role === "admin" && adminFromCookie(req);
  const isOwner = cur.created_by != null && cur.created_by === me.id;

  let payload: any;
  try { payload = await req.json(); }
  catch { return json({ error: "invalid JSON body" }, 400); }

  const next = {
    title: cur.title,
    body: cur.body,
    severity: cur.severity,
    status: cur.status,
    point_nbr: cur.point_nbr,
    x_norm: cur.x_norm,
    y_norm: cur.y_norm,
  };
  const changed: { field: string; old: string | null; new: string | null }[] = [];

  if ("title" in payload) {
    if (!isAdmin && !isOwner) return json({ error: "title: admin or owner required" }, 403);
    const t = clampStr(payload.title, TITLE_MAX);
    if (!t) return json({ error: "title cannot be empty" }, 400);
    if (t !== cur.title) { changed.push({ field: "title", old: cur.title, new: t }); next.title = t; }
  }
  if ("body" in payload) {
    if (!isAdmin && !isOwner) return json({ error: "body: admin or owner required" }, 403);
    const b = clampStr(payload.body, BODY_MAX);
    if (b !== cur.body) { changed.push({ field: "body", old: cur.body, new: b }); next.body = b; }
  }
  if ("severity" in payload) {
    if (!isAdmin) return json({ error: "severity: admin required" }, 403);
    const s = parseSeverity(payload.severity);
    if (!s) return json({ error: "bad severity" }, 400);
    if (s !== cur.severity) { changed.push({ field: "severity", old: cur.severity, new: s }); next.severity = s; }
  }
  if ("status" in payload) {
    const s = parseStatus(payload.status);
    if (!s) return json({ error: "bad status" }, 400);
    if (s !== cur.status) { changed.push({ field: "status", old: cur.status, new: s }); next.status = s; }
  }
  if ("point_nbr" in payload || "x_norm" in payload || "y_norm" in payload) {
    if (!isAdmin && !isOwner) return json({ error: "location: admin or owner required" }, 403);
    let pt = "point_nbr" in payload ? parsePoint(payload.point_nbr) : cur.point_nbr;
    let xn = "x_norm" in payload ? parseNorm(payload.x_norm) : cur.x_norm;
    let yn = "y_norm" in payload ? parseNorm(payload.y_norm) : cur.y_norm;
    if (pt != null) { xn = null; yn = null; }
    if (cur.rink_code === "L") pt = null;
    if (pt !== cur.point_nbr) {
      changed.push({ field: "point_nbr", old: cur.point_nbr == null ? null : String(cur.point_nbr), new: pt == null ? null : String(pt) });
      next.point_nbr = pt;
    }
    if (xn !== cur.x_norm || yn !== cur.y_norm) {
      changed.push({ field: "coords", old: cur.x_norm == null ? null : `${cur.x_norm},${cur.y_norm}`, new: xn == null ? null : `${xn},${yn}` });
      next.x_norm = xn;
      next.y_norm = yn;
    }
  }

  if (changed.length === 0) return json({ ok: true, no_change: true });

  const now = Date.now();
  qUpdateIssue.run({
    $id: id,
    $title: next.title, $body: next.body, $sev: next.severity, $status: next.status,
    $pt: next.point_nbr, $xn: next.x_norm, $yn: next.y_norm,
    $uid: me.id, $now: now,
  });
  for (const c of changed) {
    qInsertRevision.run({
      $issue_id: id, $uid: me.id,
      $action: c.field === "status" ? "status_changed"
             : c.field === "severity" ? "severity_changed"
             : "edited",
      $field: c.field, $old: c.old, $new: c.new, $comment: null,
      $at: now,
    });
  }
  audit(me.id, "issue.update", "issues", String(id), { changed: changed.map((c) => c.field) });
  const photos = qListPhotos.all(id);
  return json(shapeIssue(qGetIssue.get(id)!, photos));
}

// ──────────────────────────────────────────────────────────────────────
// Handlers — photos
// ──────────────────────────────────────────────────────────────────────
export async function handleAddIssuePhotos(req: Request, idStr: string): Promise<Response> {
  const id = Number(idStr);
  if (!Number.isInteger(id) || id < 1) return json({ error: "bad id" }, 400);
  const cur = qGetIssue.get(id);
  if (!cur) return json({ error: "not found" }, 404);
  const me = getRequestUser(req);
  if (!me) return json({ error: "auth required" }, 401);
  const isAdmin = me.role === "admin" && adminFromCookie(req);
  const isOwner = cur.created_by != null && cur.created_by === me.id;
  if (!isAdmin && !isOwner) return json({ error: "admin or owner required" }, 403);

  let form: FormData;
  try { form = await req.formData(); }
  catch { return json({ error: "invalid multipart body" }, 400); }
  const photos = extractPhotos(form);
  if (photos.length === 0) return json({ error: "no photos in upload" }, 400);
  if (photos.length > MAX_PHOTOS_PER_REQUEST) {
    return json({ error: `too many photos (${photos.length} > ${MAX_PHOTOS_PER_REQUEST})` }, 400);
  }

  const stored: PhotoRow[] = [];
  for (const file of photos) {
    try {
      const p = await storePhoto(file, id, me.id);
      stored.push(p);
      qInsertRevision.run({
        $issue_id: id, $uid: me.id,
        $action: "photo_added", $field: null, $old: null, $new: String(p.id), $comment: null,
        $at: Date.now(),
      });
    } catch (err: any) {
      return json({ error: `photo failed: ${err?.message ?? "unknown"}` }, 400);
    }
  }
  audit(me.id, "issue.add_photos", "issues", String(id), { count: stored.length });
  return json({ ok: true, photos: stored.map((p) => ({ id: p.id, url: fullUrl(p), thumb_url: thumbUrl(p) })) });
}

export function handleDeleteIssuePhoto(req: Request, idStr: string, photoIdStr: string): Response {
  const id = Number(idStr);
  const photoId = Number(photoIdStr);
  if (!Number.isInteger(id) || id < 1)       return json({ error: "bad issue id" }, 400);
  if (!Number.isInteger(photoId) || photoId < 1) return json({ error: "bad photo id" }, 400);

  const me = getRequestUser(req);
  if (!me) return json({ error: "auth required" }, 401);
  if (me.role !== "admin" || !adminFromCookie(req)) return json({ error: "admin required" }, 403);

  const photo = qGetPhoto.get(photoId);
  if (!photo || photo.issue_id !== id) return json({ error: "not found" }, 404);

  qDeletePhoto.run(photoId);
  qInsertRevision.run({
    $issue_id: id, $uid: me.id,
    $action: "photo_removed", $field: null, $old: String(photo.id), $new: null, $comment: null,
    $at: Date.now(),
  });
  audit(me.id, "issue.delete_photo", "issue_photos", String(photoId), { issue_id: id });
  // Best-effort disk cleanup; don't fail the response if a file is already missing.
  for (const path of [join(PHOTOS_DIR, photo.filename), join(PHOTOS_THUMBS_DIR, photo.thumb_filename)]) {
    try { unlinkSync(path); } catch { /* gone already */ }
  }
  return json({ ok: true });
}

// ──────────────────────────────────────────────────────────────────────
// Handlers — comment
// ──────────────────────────────────────────────────────────────────────
export async function handleIssueComment(req: Request, idStr: string): Promise<Response> {
  const id = Number(idStr);
  if (!Number.isInteger(id) || id < 1) return json({ error: "bad id" }, 400);
  const cur = qGetIssue.get(id);
  if (!cur) return json({ error: "not found" }, 404);
  const me = getRequestUser(req);
  if (!me) return json({ error: "auth required" }, 401);
  let payload: any;
  try { payload = await req.json(); }
  catch { return json({ error: "invalid JSON body" }, 400); }
  const comment = clampStr(payload?.comment, COMMENT_MAX);
  if (!comment) return json({ error: "comment required" }, 400);
  const now = Date.now();
  const result = qInsertRevision.run({
    $issue_id: id, $uid: me.id,
    $action: "comment", $field: null, $old: null, $new: null, $comment: comment,
    $at: now,
  });
  audit(me.id, "issue.comment", "issues", String(id), null);
  return json({ ok: true, revision_id: Number(result.lastInsertRowid), at: now });
}

// ──────────────────────────────────────────────────────────────────────
// Handlers — serve photos (path-traversal-safe)
// ──────────────────────────────────────────────────────────────────────
function safeResolve(baseDir: string, rel: string): string | null {
  // Reject anything with backslashes / null / leading slash; normalize and
  // confirm the resolved path stays inside baseDir.
  if (!rel || rel.includes("\0") || rel.includes("\\") || rel.startsWith("/")) return null;
  const full = normalize(join(baseDir, rel));
  if (!full.startsWith(baseDir + "/") && full !== baseDir) return null;
  return full;
}

export function handleServePhoto(rel: string, kind: "full" | "thumb"): Response {
  const base = kind === "thumb" ? PHOTOS_THUMBS_DIR : PHOTOS_DIR;
  const path = safeResolve(base, rel);
  if (!path) return new Response("forbidden", { status: 403 });
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return new Response("not found", { status: 404 });
    const data = readFileSync(path);
    return new Response(data, {
      headers: {
        "content-type": "image/jpeg",
        "cache-control": "private, max-age=86400",
        "content-length": String(stat.size),
      },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}
