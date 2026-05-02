// Rink Tracker — auth + identity + audit module.
//
// Two-tier model:
//   members — anyone with the URL. Pick name from dropdown (or self-add).
//             Stored in localStorage on the client. Stamped via X-User-Id header.
//   admins  — env-seeded via ADMIN_PINS. Login with name+PIN → server cookie session.
//             Required for editing other people's entries, altering priorities, etc.
//
// Honors X-Forwarded-Proto so cookie Secure flag works behind traefik+ACME.

import { db, json } from "./db";

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

export type UserRole = "member" | "admin";
export type UserPublic = { id: number; name: string; role: UserRole };

type UserRow = { id: number; name: string; role: UserRole; active: number };
type UserRowFull = UserRow & { pin_hash: string | null };

// ──────────────────────────────────────────────────────────────────────
// Prepared queries
// ──────────────────────────────────────────────────────────────────────
const qFindUserByName = db.query<UserRowFull, [string]>(
  `SELECT id, name, role, pin_hash, active FROM users WHERE name = $1 COLLATE NOCASE`
);
const qFindUserById = db.query<UserRow, [number]>(
  `SELECT id, name, role, active FROM users WHERE id = $1`
);
const qListUsers = db.query<UserPublic, []>(
  `SELECT id, name, role FROM users WHERE active = 1 ORDER BY name COLLATE NOCASE ASC`
);
const qInsertMember = db.query(
  `INSERT INTO users (name, role, created_at, active) VALUES ($name, 'member', $now, 1)`
);
const qUpsertAdmin = db.query(`
  INSERT INTO users (name, role, pin_hash, created_at, active)
  VALUES ($name, 'admin', $hash, $now, 1)
  ON CONFLICT(name) DO UPDATE SET role='admin', pin_hash=$hash, active=1
`);
const qInsertSession = db.query(
  `INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES ($token, $user_id, $expires_at, $created_at)`
);
const qGetSession = db.query<
  { user_id: number; expires_at: number; name: string; role: UserRole },
  [string]
>(`
  SELECT s.user_id, s.expires_at, u.name, u.role
  FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.token = $1 AND u.active = 1
`);
const qDeleteSession = db.query(`DELETE FROM sessions WHERE token = $1`);
const qPurgeExpiredSessions = db.query(`DELETE FROM sessions WHERE expires_at < $1`);

const qAuditInsert = db.query(`
  INSERT INTO audit_log (user_id, action, target_table, target_id, payload, at)
  VALUES ($user_id, $action, $target_table, $target_id, $payload, $at)
`);

// ──────────────────────────────────────────────────────────────────────
// Audit helper — call from any write that should leave a trail.
// ──────────────────────────────────────────────────────────────────────
export function audit(
  userId: number | null,
  action: string,
  targetTable: string | null = null,
  targetId: string | null = null,
  payload: unknown = null,
): void {
  qAuditInsert.run({
    $user_id: userId,
    $action: action,
    $target_table: targetTable,
    $target_id: targetId,
    $payload: payload == null ? null : JSON.stringify(payload),
    $at: Date.now(),
  });
}

// ──────────────────────────────────────────────────────────────────────
// Cookie helpers
// ──────────────────────────────────────────────────────────────────────
function randomToken(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function isSecure(req: Request): boolean {
  const proto = req.headers.get("x-forwarded-proto");
  if (proto) return proto.toLowerCase() === "https";
  try { return new URL(req.url).protocol === "https:"; } catch { return false; }
}

export function buildCookie(
  name: string,
  value: string,
  opts: { httpOnly?: boolean; secure?: boolean; sameSite?: "Strict" | "Lax" | "None"; maxAge?: number; path?: string } = {},
): string {
  const parts = [`${name}=${value}`, `Path=${opts.path ?? "/"}`];
  if (opts.httpOnly) parts.push("HttpOnly");
  if (opts.secure)   parts.push("Secure");
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  return parts.join("; ");
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const pair of header.split(";")) {
    const i = pair.indexOf("=");
    if (i < 0) continue;
    const k = pair.slice(0, i).trim();
    const v = pair.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// Identity resolution
// ──────────────────────────────────────────────────────────────────────
// Resolves to: admin session cookie (preferred) → X-User-Id header → null.
// X-User-Id alone never grants admin, even if the user is an admin in the DB.
export function getRequestUser(req: Request): UserPublic | null {
  const cookies = parseCookies(req.headers.get("cookie"));
  const token = cookies.session;
  if (token) {
    const row = qGetSession.get(token);
    if (row && row.expires_at >= Date.now()) {
      return { id: row.user_id, name: row.name, role: row.role };
    }
    if (row) qDeleteSession.run(token);
  }
  const headerId = Number(req.headers.get("x-user-id") ?? "");
  if (Number.isInteger(headerId) && headerId > 0) {
    const u = qFindUserById.get(headerId);
    if (u && u.active === 1) return { id: u.id, name: u.name, role: u.role };
  }
  return null;
}

// Returns user if authorized, or a Response (401/403) ready to send back.
export function requireAdmin(req: Request): UserPublic | Response {
  const u = getRequestUser(req);
  if (!u) return json({ error: "auth required" }, 401);
  const cookies = parseCookies(req.headers.get("cookie"));
  if (!cookies.session) return json({ error: "admin session required" }, 403);
  if (u.role !== "admin") return json({ error: "admin role required" }, 403);
  return u;
}

// ──────────────────────────────────────────────────────────────────────
// Endpoint handlers
// ──────────────────────────────────────────────────────────────────────
export function handleListUsers(): Response {
  return json(qListUsers.all());
}

export async function handleAddUser(req: Request): Promise<Response> {
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (name.length < 1 || name.length > 40) return json({ error: "name must be 1–40 chars" }, 400);
  const existing = qFindUserByName.get(name);
  if (existing) {
    if (existing.active !== 1) return json({ error: "user is deactivated — ask an admin" }, 409);
    return json({ id: existing.id, name: existing.name, role: existing.role });
  }
  const result = qInsertMember.run({ $name: name, $now: Date.now() });
  const id = Number(result.lastInsertRowid);
  audit(id, "user.self_add", "users", String(id), { name });
  return json({ id, name, role: "member" satisfies UserRole });
}

export async function handleAdminLogin(req: Request): Promise<Response> {
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const pin  = typeof body?.pin  === "string" ? body.pin.trim()  : "";
  if (!name || !pin) return json({ error: "name and pin required" }, 400);

  const user = qFindUserByName.get(name);
  // Always run a hash compare even when user is missing — prevents timing
  // sidechannel that would otherwise enumerate admin names.
  const cmpHash = user?.pin_hash ?? "$2b$10$............................................................";
  const ok = await Bun.password.verify(pin, cmpHash).catch(() => false);
  if (!user || user.role !== "admin" || !user.pin_hash || !ok || user.active !== 1) {
    audit(user?.id ?? null, "auth.admin_login_failed", "users", user ? String(user.id) : null, { name });
    return json({ error: "invalid credentials" }, 401);
  }

  const token = randomToken();
  const now = Date.now();
  const expires = now + SESSION_TTL_MS;
  qInsertSession.run({ $token: token, $user_id: user.id, $expires_at: expires, $created_at: now });
  audit(user.id, "auth.admin_login", "users", String(user.id), null);

  const cookie = buildCookie("session", token, {
    httpOnly: true, secure: isSecure(req), sameSite: "Lax",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
  return new Response(JSON.stringify({ ok: true, user: { id: user.id, name: user.name, role: user.role } }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store", "set-cookie": cookie },
  });
}

export function handleAdminLogout(req: Request): Response {
  const cookies = parseCookies(req.headers.get("cookie"));
  const token = cookies.session;
  if (token) qDeleteSession.run(token);
  const cleared = buildCookie("session", "", {
    httpOnly: true, secure: isSecure(req), sameSite: "Lax", maxAge: 0,
  });
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store", "set-cookie": cleared },
  });
}

export function handleWhoami(req: Request): Response {
  const u = getRequestUser(req);
  const cookies = parseCookies(req.headers.get("cookie"));
  const adminSession = u?.role === "admin" && !!cookies.session;
  return json({ user: u, admin_session: adminSession });
}

// ──────────────────────────────────────────────────────────────────────
// Boot-time admin seeding from ADMIN_PINS env var.
// ──────────────────────────────────────────────────────────────────────
// Format: "name:pin,name:pin"  (PINs bcrypt-hashed at boot; idempotent re-seed)
export async function seedAdmins(adminPinsEnv: string): Promise<void> {
  if (!adminPinsEnv.trim()) {
    console.warn("[auth] ADMIN_PINS env not set — no admin accounts will be available");
    return;
  }
  const entries = adminPinsEnv.split(",").map((s) => s.trim()).filter(Boolean);
  let seeded = 0;
  for (const entry of entries) {
    const idx = entry.indexOf(":");
    if (idx < 0) { console.warn(`[auth] bad ADMIN_PINS entry (missing colon): ${entry}`); continue; }
    const name = entry.slice(0, idx).trim();
    const pin  = entry.slice(idx + 1).trim();
    if (!name || !pin) { console.warn(`[auth] bad ADMIN_PINS entry: ${entry}`); continue; }
    const hash = await Bun.password.hash(pin, { algorithm: "bcrypt", cost: 10 });
    qUpsertAdmin.run({ $name: name, $hash: hash, $now: Date.now() });
    seeded++;
  }
  console.log(`[auth] seeded ${seeded} admin account${seeded === 1 ? "" : "s"}`);
  qPurgeExpiredSessions.run(Date.now());
}
