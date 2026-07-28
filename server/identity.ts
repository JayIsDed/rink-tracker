// Who is doing this, and are they allowed to do the dangerous bits.
//
// Ruled 07-28: pick-your-name once per device (long-lived cookie). A PIN guards
// admin only — severity, delete, settings, member management. Claiming a card
// must be ONE TAP, so identity is never a login.
//
// This is deliberately not security-grade. The threat model is "two crew
// members on the same tablet", not an adversary. Attribution is a convenience
// for the crew and a record for the GM; the PIN stops accidents, not attacks.

import { db, audit } from "./db";

export type Member = { id: number; name: string; role: string; active: number; created_at: number };

const qMembers = db.query<Member, []>(
  "SELECT id, name, role, active, created_at FROM members WHERE active = 1 ORDER BY name COLLATE NOCASE"
);
const qAllMembers = db.query<Member, []>(
  "SELECT id, name, role, active, created_at FROM members ORDER BY active DESC, name COLLATE NOCASE"
);
const qMemberByName = db.query<Member & { pin_hash: string | null }, [string]>(
  "SELECT * FROM members WHERE name = ? COLLATE NOCASE"
);
const qInsertMember = db.query<{ id: number }, [string, string, number]>(
  "INSERT INTO members (name, role, created_at) VALUES (?, ?, ?) RETURNING id"
);
const qSetRole = db.query("UPDATE members SET role = $role WHERE id = $id");
const qSetPin = db.query("UPDATE members SET pin_hash = $hash WHERE id = $id");
const qSetActive = db.query("UPDATE members SET active = $active WHERE id = $id");

export function listMembers(includeInactive = false): Member[] {
  return includeInactive ? qAllMembers.all() : qMembers.all();
}

export function findMember(name: string): (Member & { pin_hash: string | null }) | null {
  return qMemberByName.get(name.trim()) ?? null;
}

/** Names are trimmed and collapsed; empty or absurd ones are rejected. */
export function normaliseName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const n = raw.trim().replace(/\s+/g, " ");
  if (n.length < 1 || n.length > 40) return null;
  return n;
}

/**
 * Self-registration is on purpose. "Everyone types" — a crew tool that makes
 * you wait for an admin to add you is a crew tool nobody uses.
 */
export function ensureMember(name: string, role: "member" | "admin" = "member"): Member {
  const existing = findMember(name);
  if (existing) {
    if (!existing.active) qSetActive.run({ $active: 1, $id: existing.id });
    return existing;
  }
  const { id } = qInsertMember.get(name, role, Date.now())!;
  audit(name, "member.create", String(id), { role });
  return { id, name, role, active: 1, created_at: Date.now() };
}

export async function setPin(id: number, pin: string | null): Promise<void> {
  const hash = pin == null || pin === "" ? null : await Bun.password.hash(pin, "bcrypt");
  qSetPin.run({ $hash: hash, $id: id });
}

export function setRole(id: number, role: "member" | "admin"): void {
  qSetRole.run({ $role: role, $id: id });
}

export function setActive(id: number, active: boolean): void {
  qSetActive.run({ $active: active ? 1 : 0, $id: id });
}

export async function verifyPin(name: string, pin: string): Promise<boolean> {
  const m = findMember(name);
  if (!m || m.role !== "admin" || !m.pin_hash) return false;
  try {
    return await Bun.password.verify(pin, m.pin_hash);
  } catch {
    return false;
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────
// RINK_ADMIN_PINS="Jay:1234,Art:5678". Read once at boot; the pins live in the
// stack .env, never in the repo. Re-running is safe — it upserts.

export async function bootstrapAdmins(): Promise<void> {
  const spec = process.env.RINK_ADMIN_PINS;
  if (!spec) return;
  for (const pair of spec.split(",")) {
    const idx = pair.indexOf(":");
    if (idx < 1) continue;
    const name = normaliseName(pair.slice(0, idx));
    const pin = pair.slice(idx + 1).trim();
    if (!name || !pin) continue;
    const m = ensureMember(name, "admin");
    setRole(m.id, "admin");
    await setPin(m.id, pin);
  }
  console.log(`[identity] bootstrapped admins from RINK_ADMIN_PINS`);
}

// ── Cookies ───────────────────────────────────────────────────────────

const WHO_COOKIE = "rt_who";
const ADMIN_COOKIE = "rt_admin";
const YEAR = 60 * 60 * 24 * 365;
const ADMIN_TTL_MS = 12 * 60 * 60 * 1000;

// Behind Traefik the app speaks http, so Secure must key off the forwarded
// proto or the cookie silently never sets in production.
function isSecure(req: Request): boolean {
  const proto = req.headers.get("x-forwarded-proto");
  if (proto) return proto.split(",")[0].trim() === "https";
  return new URL(req.url).protocol === "https:";
}

function cookieAttrs(req: Request, maxAge: number): string {
  return `Path=/; Max-Age=${maxAge}; SameSite=Lax; HttpOnly${isSecure(req) ? "; Secure" : ""}`;
}

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

export function setWhoCookie(req: Request, name: string): string {
  return `${WHO_COOKIE}=${encodeURIComponent(name)}; ${cookieAttrs(req, YEAR)}`;
}

export function clearWhoCookie(req: Request): string {
  return `${WHO_COOKIE}=; ${cookieAttrs(req, 0)}`;
}

/** The acting crew member, or null if this device has never picked a name. */
export function who(req: Request): string | null {
  const name = readCookie(req, WHO_COOKIE);
  if (!name) return null;
  const n = normaliseName(name);
  if (!n) return null;
  // A name that is no longer an active member stops acting.
  const m = findMember(n);
  return m && m.active ? m.name : null;
}

// ── Admin session ─────────────────────────────────────────────────────
// HMAC over name+expiry. The secret is per-deployment; if it is absent we mint
// one and keep it in settings, so restarts don't log every admin out.

import { getSetting, setSetting } from "./db";

function adminSecret(): string {
  const fromEnv = process.env.RINK_SESSION_SECRET;
  if (fromEnv) return fromEnv;
  let s = getSetting("session_secret");
  if (!s) {
    s = crypto.randomUUID() + crypto.randomUUID();
    setSetting("session_secret", s);
  }
  return s;
}

async function sign(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(adminSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Buffer.from(sig).toString("base64url");
}

export async function mintAdminCookie(req: Request, name: string): Promise<string> {
  const exp = Date.now() + ADMIN_TTL_MS;
  const payload = `${name}|${exp}`;
  const token = `${payload}|${await sign(payload)}`;
  return `${ADMIN_COOKIE}=${encodeURIComponent(token)}; ${cookieAttrs(req, ADMIN_TTL_MS / 1000)}`;
}

export function clearAdminCookie(req: Request): string {
  return `${ADMIN_COOKIE}=; ${cookieAttrs(req, 0)}`;
}

/** Admin name if this request carries a valid, unexpired admin session. */
export async function admin(req: Request): Promise<string | null> {
  const token = readCookie(req, ADMIN_COOKIE);
  if (!token) return null;
  const parts = token.split("|");
  if (parts.length !== 3) return null;
  const [name, expStr, sig] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return null;
  const expected = await sign(`${name}|${expStr}`);
  // Length-equal compare; these are both base64url of a fixed-size digest.
  if (sig.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return null;
  const m = findMember(name);
  return m && m.active && m.role === "admin" ? m.name : null;
}
