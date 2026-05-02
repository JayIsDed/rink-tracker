// Rink Tracker — client identity + admin login helpers (mirrors server/auth.ts).
//
// Two-tier model:
//   member identity → localStorage, picked once, stamped on writes via X-User-Id.
//   admin session   → server-issued httpOnly cookie, 12h TTL, gates admin writes.

const KEY = "rinkTracker.user";

export function getIdentity() {
  try { return JSON.parse(localStorage.getItem(KEY) || "null"); }
  catch { return null; }
}

export function setIdentity(u) {
  if (!u || typeof u.id !== "number") throw new Error("setIdentity: bad user object");
  localStorage.setItem(KEY, JSON.stringify({ id: u.id, name: u.name, role: u.role || "member" }));
}

export function clearIdentity() { localStorage.removeItem(KEY); }

export async function listUsers() {
  const r = await fetch("/api/users", { cache: "no-store" });
  if (!r.ok) throw new Error(`listUsers: http ${r.status}`);
  return r.json();
}

export async function addUser(name) {
  const r = await fetch("/api/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(out.error || `addUser: http ${r.status}`);
  return out;
}

export async function adminLogin(name, pin) {
  const r = await fetch("/api/auth/admin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, pin }),
    credentials: "same-origin",
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(out.error || `adminLogin: http ${r.status}`);
  return out.user;
}

export async function adminLogout() {
  await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
}

export async function whoami() {
  const r = await fetch("/api/auth/whoami", { credentials: "same-origin", cache: "no-store" });
  if (!r.ok) return { user: null, admin_session: false };
  return r.json();
}
