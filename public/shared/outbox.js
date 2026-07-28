// Offline write queue.
//
// The old app proved this pattern for measurements; this is the generalised
// version, and it is what lets entry mode claim a value is safe the moment it
// is typed. A rink is a metal building with bad signal and the crew are wearing
// gloves — "your connection dropped, retype those twelve points" is exactly the
// friction that loses to a pen.
//
// THREE RULES, each one load-bearing:
//
// 1. THE IDEMPOTENCY KEY IS MINTED AT ENQUEUE, not per attempt. A retry after a
//    lost response carries the SAME key, so the server recognises the replay
//    instead of applying the write twice.
//
// 2. THE FLUSH IS STRICTLY SEQUENTIAL. Entry mode can queue 3.5" for a point
//    and then a correction to 4.0". Sent in parallel those can land in either
//    order and the correction can lose. One at a time, in order, always.
//
// 3. A REJECTED WRITE IS NOT RETRIED FOREVER. A 400 means the server will never
//    accept this body; retrying it just blocks everything behind it. It goes to
//    a dead list the UI can show. Network failures and 5xx do retry.

const KEY = "rt:outbox";
const MAX_ATTEMPTS = 8;

/** Statuses a caller sees. */
export const SENT = "sent";
export const DEAD = "dead";

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function save(queue) {
  try {
    localStorage.setItem(KEY, JSON.stringify(queue));
  } catch {
    // A full or blocked store must not take the app down with it. The write
    // still goes out this session; it just will not survive a reload.
  }
}

let queue = load();
let dead = [];
let flushing = false;
let timer = null;
const listeners = new Set();

function emit() {
  const snapshot = status();
  for (const fn of listeners) {
    try {
      fn(snapshot);
    } catch (err) {
      console.warn("[outbox] listener failed", err);
    }
  }
}

export function onChange(fn) {
  listeners.add(fn);
  fn(status());
  return () => listeners.delete(fn);
}

export function status() {
  return {
    pending: queue.length,
    dead: dead.length,
    deadItems: dead.map((d) => ({ ...d })),
    online: navigator.onLine !== false,
    flushing,
  };
}

/**
 * Queue a write. Returns the entry so a caller can correlate the settle
 * callback with whatever it is tracking (entry mode uses meta.points).
 *
 * @param {string} path
 * @param {object} body
 * @param {object} [meta]  opaque, echoed back on settle
 */
export function enqueue(path, body, meta = {}) {
  const entry = {
    id: crypto.randomUUID(),
    key: crypto.randomUUID(), // rule 1: minted ONCE, reused on every attempt
    path,
    body,
    meta,
    attempts: 0,
    queued_at: Date.now(),
  };
  queue.push(entry);
  save(queue);
  emit();
  flush();
  return entry;
}

/** 4xx means the body is wrong and will stay wrong — except these. */
function retryable(statusCode) {
  if (statusCode == null) return true; // network failure
  if (statusCode === 401 || statusCode === 408 || statusCode === 429) return true;
  return statusCode >= 500;
}

async function send(entry) {
  const res = await fetch(entry.path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", "idempotency-key": entry.key },
    body: JSON.stringify(entry.body),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    const err = new Error(parsed?.error ?? `write failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return parsed;
}

export async function flush() {
  if (flushing) return;
  if (navigator.onLine === false) return;
  if (queue.length === 0) return;

  flushing = true;
  emit();

  try {
    // Rule 2: head of the queue only, awaited, then the next. Never a
    // Promise.all over the queue — that reorders corrections.
    while (queue.length > 0) {
      if (navigator.onLine === false) break;
      const entry = queue[0];
      entry.attempts++;

      try {
        const result = await send(entry);
        queue.shift();
        save(queue);
        settle(entry, SENT, result, null);
      } catch (err) {
        if (!retryable(err.status) || entry.attempts >= MAX_ATTEMPTS) {
          queue.shift();
          save(queue);
          const reason = err.status
            ? err.message
            : `${err.message} (gave up after ${entry.attempts} tries)`;
          dead.push({ ...entry, reason });
          settle(entry, DEAD, null, reason);
        } else {
          // Leave it at the head and back off — everything behind it waits, by
          // design, so ordering survives the outage.
          schedule(Math.min(30000, 1000 * 2 ** (entry.attempts - 1)));
          break;
        }
      }
    }
  } finally {
    flushing = false;
    emit();
  }
}

const settlers = new Set();

/** Called for every entry that leaves the queue, sent or dead. */
export function onSettled(fn) {
  settlers.add(fn);
  return () => settlers.delete(fn);
}

function settle(entry, outcome, result, reason) {
  for (const fn of settlers) {
    try {
      fn({ entry, outcome, result, reason });
    } catch (err) {
      console.warn("[outbox] settler failed", err);
    }
  }
  emit();
}

function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(flush, ms);
}

/** Drop the dead list once the user has seen it. */
export function clearDead() {
  dead = [];
  emit();
}

/** Discard everything — used only when the user explicitly abandons writes. */
export function discardAll() {
  queue = [];
  dead = [];
  save(queue);
  emit();
}

if (typeof window !== "undefined") {
  addEventListener("online", () => flush());
  addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") flush();
  });
  // A slow heartbeat catches the case where the browser never fires `online`
  // because it thinks it was connected the whole time — captive portals and
  // patchy rink wifi both do this.
  setInterval(flush, 20000);
  flush();
}
