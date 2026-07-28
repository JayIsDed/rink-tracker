// Database handle, pragmas, migrations, and the tiny helpers every route uses.

import { Database } from "bun:sqlite";
import { migrate, TARGET_VERSION } from "./migrations";

export const DB_PATH = process.env.RINK_DB ?? "data/rink.db";

export const db = new Database(DB_PATH, { create: true });

db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA foreign_keys = ON");
db.run("PRAGMA busy_timeout = 5000");
// The carry source taught this one: a WAL that never checkpoints means the .db
// file on disk is months stale, so any backup that copies only the .db silently
// loses everything since the last checkpoint.
db.run("PRAGMA wal_autocheckpoint = 512");

const applied = migrate(db, (m) => console.log(`[db] ${m}`));
if (applied !== TARGET_VERSION) {
  throw new Error(`[db] expected schema v${TARGET_VERSION}, got v${applied}`);
}

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  });
}

export function bad(message: string, status = 400): Response {
  return json({ error: message }, status);
}

// ── Idempotency ───────────────────────────────────────────────────────
// Every POST write is replay-safe: the offline outbox retries blindly, and a
// retry must never double-write.

const qIdemGet = db.query<{ response: string }, [string]>(
  "SELECT response FROM idempotency_keys WHERE key = ?"
);
const qIdemPut = db.query(
  "INSERT OR REPLACE INTO idempotency_keys (key, response, at) VALUES ($key, $response, $at)"
);

export function replayed(req: Request): Response | null {
  const key = req.headers.get("idempotency-key");
  if (!key) return null;
  const cached = qIdemGet.get(key);
  if (!cached) return null;
  return new Response(cached.response, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "idempotent-replayed": "1",
    },
  });
}

export function remember(req: Request, body: unknown): Response {
  const payload = JSON.stringify(body);
  const key = req.headers.get("idempotency-key");
  if (key) qIdemPut.run({ $key: key, $response: payload, $at: Date.now() });
  return new Response(payload, {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// ── Audit ─────────────────────────────────────────────────────────────

const qAudit = db.query(
  "INSERT INTO audit_log (actor, action, target, detail, at) VALUES ($actor, $action, $target, $detail, $at)"
);

export function audit(actor: string | null, action: string, target?: string, detail?: unknown): void {
  qAudit.run({
    $actor: actor,
    $action: action,
    $target: target ?? null,
    $detail: detail == null ? null : JSON.stringify(detail),
    $at: Date.now(),
  });
}

// ── Settings ──────────────────────────────────────────────────────────

const qSettingGet = db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?");
const qSettingPut = db.query(
  "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ($k, $v, $at)"
);
const qSettingAll = db.query<{ key: string; value: string }, []>("SELECT key, value FROM settings");

export const SETTING_DEFAULTS: Record<string, string> = {
  archive_days: "14",
  thin_spot_in: "2.0",
  trend_window_days: "120",
  anomaly_window_days: "30",
};

export function getSetting(key: string): string {
  return qSettingGet.get(key)?.value ?? SETTING_DEFAULTS[key] ?? "";
}

export function getSettingNum(key: string): number {
  const n = Number(getSetting(key));
  return Number.isFinite(n) ? n : Number(SETTING_DEFAULTS[key] ?? 0);
}

export function setSetting(key: string, value: string): void {
  qSettingPut.run({ $k: key, $v: value, $at: Date.now() });
}

export function allSettings(): Record<string, string> {
  const out = { ...SETTING_DEFAULTS };
  for (const r of qSettingAll.all()) out[r.key] = r.value;
  return out;
}
