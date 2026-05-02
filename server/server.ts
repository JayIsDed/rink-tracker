// Rink Tracker — main HTTP server. Routes auth + serves static shell.
//
// Single-page app shell at /, hash-routed in the browser (#/heatmap, #/issues, etc).
// Each tab has its own HTML partial under public/tabs/<name>/ that the shell loads
// lazily. Server hosts the API surface; tabs talk to it via fetch().

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { db, PUBLIC, SW_VERSION, json } from "./db";
import {
  seedAdmins,
  handleAdminLogin, handleAdminLogout, handleWhoami,
  handleListUsers, handleAddUser,
} from "./auth";
import {
  handleGetPoints, handleGetDates, handleGetMeasurements, handleGetTimeseries,
  handleGetConcrete, handleGetStats, handleGetAnomalies,
  handleGetWeatherAll, handleGetWeatherByDate, handlePostMeasurements,
} from "./routes/heatmap";

const PORT = Number(process.env.PORT ?? 3737);
const ADMIN_PINS = process.env.ADMIN_PINS ?? "";

await seedAdmins(ADMIN_PINS);
console.log(`sw version: ${SW_VERSION}`);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".mjs":  "text/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico":  "image/x-icon",
};

function serveStatic(pathname: string): Response {
  const rel = pathname === "/" ? "/index.html" : pathname;
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) return new Response("forbidden", { status: 403 });
  try {
    const data = readFileSync(file);
    const dot = rel.lastIndexOf(".");
    const ext = dot >= 0 ? rel.slice(dot) : "";
    return new Response(data, { headers: { "content-type": MIME[ext] ?? "application/octet-stream" } });
  } catch {
    return new Response("not found", { status: 404 });
  }
}

// /sw.js: cache-bust the SW itself + inject build version so caches rotate per-deploy.
function serveServiceWorker(): Response {
  try {
    const raw = readFileSync(join(PUBLIC, "sw.js"), "utf8");
    const body = raw.replace(/__SW_VERSION__/g, SW_VERSION);
    return new Response(body, {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-cache",
        "service-worker-allowed": "/",
      },
    });
  } catch {
    return new Response("// sw.js not found\n", { status: 404, headers: { "content-type": "text/javascript" } });
  }
}

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;

    // Auth + identity
    if (req.method === "POST" && p === "/api/auth/admin")  return handleAdminLogin(req);
    if (req.method === "POST" && p === "/api/auth/logout") return handleAdminLogout(req);
    if (p === "/api/auth/whoami") return handleWhoami(req);
    if (req.method === "POST" && p === "/api/users") return handleAddUser(req);
    if (p === "/api/users") return handleListUsers();

    // Heatmap (ported from ice-tracker; rink-aware via ?rink=U|L)
    if (req.method === "POST" && p === "/api/measurements") return handlePostMeasurements(req);
    if (p === "/api/measurements") return handleGetMeasurements(url);
    if (p === "/api/points") return handleGetPoints(url);
    if (p === "/api/dates")  return handleGetDates(url);
    if (p === "/api/concrete-profile") return handleGetConcrete(url);
    if (p === "/api/stats") return handleGetStats(url);
    if (p === "/api/anomalies") return handleGetAnomalies(url);
    if (p === "/api/weather") return handleGetWeatherAll();
    if (p.startsWith("/api/weather/")) return handleGetWeatherByDate(p.split("/").pop() ?? "");
    if (p.startsWith("/api/timeseries/")) return handleGetTimeseries(url, p.split("/").pop() ?? "");

    // Health
    if (p === "/api/health") {
      const total = db.query("SELECT COUNT(*) AS n FROM measurements").get() as { n: number };
      return json({ ok: true, measurements: total.n, sw_version: SW_VERSION });
    }

    if (p === "/sw.js") return serveServiceWorker();

    return serveStatic(p);
  },
});

console.log(`rink-tracker server: http://${server.hostname}:${server.port}`);
