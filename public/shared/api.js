// Fetch wrapper. Every write carries an Idempotency-Key so the offline outbox
// can retry blindly without double-writing.

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function newKey() {
  return crypto.randomUUID();
}

export async function api(path, { method = "GET", body, idempotencyKey, signal } = {}) {
  const headers = {};
  const init = { method, headers, credentials: "same-origin", signal };

  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  if (method !== "GET" && method !== "HEAD") {
    headers["idempotency-key"] = idempotencyKey ?? newKey();
  }

  const res = await fetch(path, init);
  const text = await res.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) {
    throw new ApiError(parsed?.error ?? `${method} ${path} failed (${res.status})`, res.status, parsed);
  }
  return parsed;
}

/**
 * Multipart POST, for photos.
 *
 * Deliberately NOT routed through `api()`: that one JSON-stringifies the body
 * and sets content-type, and a multipart request must let the browser write
 * its own header so the boundary token matches the payload. Setting it by hand
 * is the classic silent-400 on file uploads.
 *
 * No idempotency key either. Replaying a photo upload from a cached response
 * would hand back ids for files this request never stored; uploads are cheap
 * to retry by hand and duplicates are visible and deletable.
 */
export async function upload(path, formData) {
  const res = await fetch(path, { method: "POST", body: formData, credentials: "same-origin" });
  const text = await res.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) throw new ApiError(parsed?.error ?? `upload failed (${res.status})`, res.status, parsed);
  return parsed;
}

export const get = (p, opts) => api(p, { ...opts, method: "GET" });
export const post = (p, body, opts) => api(p, { ...opts, method: "POST", body });
export const put = (p, body, opts) => api(p, { ...opts, method: "PUT", body });
export const patch = (p, body, opts) => api(p, { ...opts, method: "PATCH", body });
export const del = (p, opts) => api(p, { ...opts, method: "DELETE" });
