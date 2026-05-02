// Rink Tracker — apiFetch wrapper. Auto-attaches X-User-Id from localStorage
// so every write is stamped with the current member. Cookie session for admin
// is auto-attached by the browser via credentials: same-origin.

import { getIdentity } from "./auth.js";

export async function apiFetch(url, opts = {}) {
  const me = getIdentity();
  const headers = new Headers(opts.headers || {});
  if (me?.id) headers.set("x-user-id", String(me.id));
  return fetch(url, { ...opts, headers, credentials: "same-origin" });
}
