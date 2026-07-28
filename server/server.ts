// Bun HTTP server: static shell + JSON API.
//
// Routing is a small explicit table rather than a framework. Deep links
// (/log/propane?rink=U&side=L — the NFC contract) fall through to index.html so
// the client router can land on the prefilled form.

import { db, json, bad, allSettings, setSetting } from "./db";
import {
  who, admin, listMembers, ensureMember, normaliseName, verifyPin,
  setWhoCookie, clearWhoCookie, mintAdminCookie, clearAdminCookie,
  bootstrapAdmins, setRole, setActive, setPin, findMember,
} from "./identity";
import { seedFixtures } from "./seed";
import * as tickers from "./routes/tickers";

const PORT = Number(process.env.PORT ?? 3739);
const PUBLIC = new URL("../public/", import.meta.url).pathname;

// Footgun 2: the old service worker keyed its cache on boot time, so every
// container restart busted every client. This rides a build arg instead, and
// falls back to a constant in dev so the loop isn't fighting cache churn.
export const BUILD_SHA = process.env.BUILD_SHA || "dev";

await bootstrapAdmins();
seedFixtures();

// Client-routed paths. Anything here serves the shell; anything else that isn't
// a real file 404s, so a typo doesn't silently render the app.
const CLIENT_ROUTES = [
  "/", "/board", "/ice", "/edger", "/maintenance", "/schedule", "/settings",
  "/log/propane", "/log/edger", "/ice/entry",
];

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const b = await req.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ── API ───────────────────────────────────────────────────────────────

async function api(req: Request, url: URL): Promise<Response> {
  const path = url.pathname;
  const method = req.method;
  const actor = who(req);

  if (path === "/api/health") {
    return json({ ok: true, build: BUILD_SHA, schema: db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version });
  }

  // One call the shell makes on boot: everything needed to render chrome.
  if (path === "/api/bootstrap") {
    return json({
      who: actor,
      is_admin: (await admin(req)) != null,
      members: listMembers().map((m) => ({ id: m.id, name: m.name, role: m.role })),
      machines: db.query("SELECT id, code, name, rink_code FROM machines ORDER BY sort, id").all(),
      rinks: db.query("SELECT code, description, floor FROM rinks ORDER BY code").all(),
      settings: allSettings(),
      build: BUILD_SHA,
    });
  }

  // ── Identity ──
  if (path === "/api/identity" && method === "POST") {
    const body = await readBody(req);
    const name = normaliseName(body?.name);
    if (!name) return bad("name required");
    const m = ensureMember(name);
    return json({ who: m.name }, 200, { "set-cookie": setWhoCookie(req, m.name) });
  }
  if (path === "/api/identity" && method === "DELETE") {
    return json({ who: null }, 200, { "set-cookie": clearWhoCookie(req) });
  }

  if (path === "/api/admin/unlock" && method === "POST") {
    const body = await readBody(req);
    const name = normaliseName(body?.name) ?? actor;
    const pin = typeof body?.pin === "string" ? body.pin : "";
    if (!name || !pin) return bad("name and pin required");
    if (!(await verifyPin(name, pin))) return bad("wrong name or PIN", 403);
    return json({ is_admin: true, who: name }, 200, {
      "set-cookie": await mintAdminCookie(req, name),
    });
  }
  if (path === "/api/admin/lock" && method === "POST") {
    return json({ is_admin: false }, 200, { "set-cookie": clearAdminCookie(req) });
  }

  // ── Members ──
  if (path === "/api/members" && method === "GET") {
    const isAdmin = (await admin(req)) != null;
    return json(
      listMembers(isAdmin).map((m) => ({ id: m.id, name: m.name, role: m.role, active: m.active }))
    );
  }
  if (path === "/api/members/add" && method === "POST") {
    if (!(await admin(req))) return bad("admin required", 403);
    const body = await readBody(req);
    const name = normaliseName(body?.name);
    if (!name) return bad("name required");
    return json(ensureMember(name));
  }
  if (path === "/api/members" && method === "PATCH") {
    const adminName = await admin(req);
    if (!adminName) return bad("admin required", 403);
    const body = await readBody(req);
    const id = Number(body?.id);
    if (!Number.isInteger(id)) return bad("id required");
    if (body?.role === "member" || body?.role === "admin") setRole(id, body.role);
    if (typeof body?.active === "boolean") setActive(id, body.active);
    if (typeof body?.pin === "string" || body?.pin === null) await setPin(id, body.pin as string | null);
    return json({ ok: true });
  }

  // ── Tickers ──
  if (path === "/api/tickers" && method === "GET") return tickers.handleList();
  const tickerMatch = /^\/api\/tickers\/(\d+)(\/nudge)?$/.exec(path);
  if (tickerMatch) {
    const id = Number(tickerMatch[1]);
    if (tickerMatch[2] === "/nudge" && method === "POST") {
      return tickers.handleNudge(req, id, actor);
    }
    if (method === "PATCH") return tickers.handlePatch(req, id, (await admin(req)) != null);
  }

  // ── Job health ──
  if (path === "/api/jobs/health" && method === "GET") {
    return json(
      db.query(`
        SELECT job, ran_at, ok, detail, duration_ms FROM job_runs r
         WHERE r.id = (SELECT id FROM job_runs WHERE job = r.job ORDER BY ran_at DESC LIMIT 1)
         ORDER BY job
      `).all()
    );
  }

  // ── Settings ──
  if (path === "/api/settings" && method === "GET") return json(allSettings());
  if (path === "/api/settings" && method === "PUT") {
    const adminName = await admin(req);
    if (!adminName) return bad("admin required", 403);
    const body = await readBody(req);
    if (!body) return bad("invalid JSON");
    for (const [k, v] of Object.entries(body)) {
      if (typeof k !== "string" || k.length > 64) continue;
      setSetting(k, String(v));
    }
    return json(allSettings());
  }

  return json({ error: "not found" }, 404);
}

// ── Static ────────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

async function serveFile(pathname: string): Promise<Response | null> {
  // Reject traversal before touching the filesystem.
  if (pathname.includes("..") || pathname.includes("\0")) return null;
  const file = Bun.file(PUBLIC + pathname.replace(/^\//, ""));
  if (!(await file.exists())) return null;

  // The worker's cache key is the build sha, substituted here. Footgun 2: this
  // must never become a boot timestamp again, or every restart logs every
  // installed client out of its cache.
  if (pathname === "/sw.js") {
    const src = (await file.text()).replace("__BUILD_SHA__", BUILD_SHA);
    return new Response(src, {
      headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" },
    });
  }

  const ext = pathname.slice(pathname.lastIndexOf("."));
  const headers: Record<string, string> = {
    "content-type": MIME[ext] ?? file.type ?? "application/octet-stream",
  };
  // The shell and the worker must never be cached by the browser, or a deploy
  // cannot reach an installed PWA. Everything else is fine to revalidate.
  if (pathname === "/index.html" || pathname === "/sw.js") {
    headers["cache-control"] = "no-cache";
  } else {
    headers["cache-control"] = "public, max-age=0, must-revalidate";
  }
  return new Response(file, { headers });
}

const server = Bun.serve({
  port: PORT,
  idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname.startsWith("/api/")) {
      try {
        return await api(req, url);
      } catch (err) {
        console.error("[api]", url.pathname, err);
        return json({ error: "server error" }, 500);
      }
    }

    const direct = await serveFile(url.pathname);
    if (direct) return direct;

    if (CLIENT_ROUTES.includes(url.pathname)) {
      const shell = await serveFile("/index.html");
      if (shell) return shell;
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(`[rink] listening on http://localhost:${server.port}  build=${BUILD_SHA}`);
