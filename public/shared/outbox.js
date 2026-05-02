// Ice Tracker — IndexedDB outbox for offline-tolerant POST /api/measurements (SCAFFOLD).
// Loaded as an ES module from index.html and used by app.js (impl phase wires this up).
//
// Why IDB (not localStorage): durable, async, structured, large quota. localStorage
// is sync, ~5MB cap, and stringly-typed.
//
// Object-store schema:
//   key: idempotency_key (UUID, also sent in Idempotency-Key request header)
//   value: { idempotency_key, created_at, endpoint, method, body, status, attempts, last_error, in_flight_at }
//   indexes: by_status (for cheap "find pending"), by_created_at (oldest-first drain)
//
// Statuses: 'pending' | 'in_flight' | 'failed'
// 'failed' = dead-letter after MAX_ATTEMPTS. Surfaced in UI so operator can retry manually.

const DB_NAME = "ice-tracker";
const DB_VERSION = 1;
const STORE = "outbox";
const MAX_ATTEMPTS = 5;
const IN_FLIGHT_RECOVERY_MS = 30_000; // a stuck in_flight older than this is presumed crashed → re-queue

let _dbPromise = null;
function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "idempotency_key" });
        store.createIndex("by_status", "status", { unique: false });
        store.createIndex("by_created_at", "created_at", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

function tx(mode) {
  return openDB().then((db) => db.transaction(STORE, mode).objectStore(STORE));
}

function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function newKey() {
  // crypto.randomUUID widely available in 2026 browsers; fallback for very old.
  if (crypto.randomUUID) return crypto.randomUUID();
  const a = crypto.getRandomValues(new Uint8Array(16));
  a[6] = (a[6] & 0x0f) | 0x40; a[8] = (a[8] & 0x3f) | 0x80;
  return [...a].map((b, i) => (i === 4 || i === 6 || i === 8 || i === 10 ? "-" : "") + b.toString(16).padStart(2, "0")).join("");
}

export async function enqueue({ endpoint, method, body }) {
  const idempotency_key = newKey();
  const record = {
    idempotency_key,
    created_at: Date.now(),
    endpoint,
    method,
    body,
    status: "pending",
    attempts: 0,
    last_error: null,
    in_flight_at: null,
  };
  const store = await tx("readwrite");
  await promisify(store.add(record));
  return record;
}

export async function listPending() {
  const store = await tx("readonly");
  const idx = store.index("by_status");
  return promisify(idx.getAll("pending"));
}

export async function listAll() {
  const store = await tx("readonly");
  return promisify(store.getAll());
}

async function update(key, patch) {
  const store = await tx("readwrite");
  const existing = await promisify(store.get(key));
  if (!existing) return null;
  const updated = { ...existing, ...patch };
  await promisify(store.put(updated));
  return updated;
}

export async function markInFlight(key) {
  return update(key, { status: "in_flight", in_flight_at: Date.now() });
}

export async function markFailed(key, errorMsg) {
  const store = await tx("readwrite");
  const existing = await promisify(store.get(key));
  if (!existing) return null;
  const attempts = (existing.attempts ?? 0) + 1;
  const status = attempts >= MAX_ATTEMPTS ? "failed" : "pending";
  const updated = { ...existing, status, attempts, last_error: errorMsg, in_flight_at: null };
  await promisify(store.put(updated));
  return updated;
}

export async function dequeue(key) {
  const store = await tx("readwrite");
  await promisify(store.delete(key));
}

// Recover stuck 'in_flight' records (page crashed mid-POST, response never received).
// Anything older than IN_FLIGHT_RECOVERY_MS goes back to 'pending' so drain() picks it up.
export async function recoverStuck() {
  const store = await tx("readwrite");
  const all = await promisify(store.getAll());
  const cutoff = Date.now() - IN_FLIGHT_RECOVERY_MS;
  for (const r of all) {
    if (r.status === "in_flight" && r.in_flight_at && r.in_flight_at < cutoff) {
      await promisify(store.put({ ...r, status: "pending", in_flight_at: null }));
    }
  }
}

// Drain pending records by POSTing each. Caller decides when to invoke
// (boot / online event / visibilitychange / sw 'sync' message).
//
// Returns { sent, failed, deadLettered } for UI surfacing.
//
// SCAFFOLD: the actual fetch wiring uses the same headers the app uses.
// Idempotency-Key is what makes the server-side dedupe table do its job.
export async function drain() {
  await recoverStuck();
  const pending = await listPending();
  // Oldest-first so the user's earliest unsynced session lands first.
  pending.sort((a, b) => a.created_at - b.created_at);

  let sent = 0, failed = 0, deadLettered = 0;
  for (const rec of pending) {
    await markInFlight(rec.idempotency_key);
    try {
      const res = await fetch(rec.endpoint, {
        method: rec.method,
        headers: {
          "content-type": "application/json",
          "idempotency-key": rec.idempotency_key,
        },
        body: JSON.stringify(rec.body),
      });
      if (res.ok) {
        await dequeue(rec.idempotency_key);
        sent++;
      } else {
        // 4xx is permanent — dead-letter immediately rather than retry forever.
        if (res.status >= 400 && res.status < 500) {
          await update(rec.idempotency_key, { status: "failed", attempts: MAX_ATTEMPTS, last_error: `http ${res.status}`, in_flight_at: null });
          deadLettered++;
        } else {
          const updated = await markFailed(rec.idempotency_key, `http ${res.status}`);
          if (updated?.status === "failed") deadLettered++; else failed++;
        }
      }
    } catch (err) {
      // Network failure → retry next drain.
      const updated = await markFailed(rec.idempotency_key, err?.message ?? "network error");
      if (updated?.status === "failed") deadLettered++; else failed++;
    }
  }
  return { sent, failed, deadLettered };
}

export const _internals = { DB_NAME, STORE, MAX_ATTEMPTS, IN_FLIGHT_RECOVERY_MS };
