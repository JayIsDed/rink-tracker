// Rink Tracker — service worker.
// Served from /sw.js by server.ts with __SW_VERSION__ token replaced at request time.
// Cache-Control: no-cache server-side so updates propagate same-day.
//
// Strategies:
//   - shell: cache-first (precached on install)
//   - GET /api/*: network-first with cache fallback
//   - POST /api/*: bypassed entirely (page-level outbox handles offline writes)

const VERSION = "__SW_VERSION__";
const SHELL_CACHE = `rink-tracker-shell-${VERSION}`;
const API_CACHE = `rink-tracker-api-${VERSION}`;

const SHELL_URLS = [
  "/",
  "/index.html",
  "/app.js",
  "/style.css",
  "/manifest.json",
  "/shared/auth.js",
  "/shared/api.js",
  "/shared/router.js",
  "/shared/outbox.js",
  "/tabs/home/index.html",
  "/tabs/heatmap/index.html",
  "/tabs/heatmap/tab.js",
  "/tabs/issues/index.html",
  "/tabs/issues/tab.js",
  "/tabs/maintenance/index.html",
  "/tabs/work/index.html",
  "/tabs/handoff/index.html",
  "/tabs/admin/index.html",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // Don't fail the install if a tab partial 404s during early scaffolding.
    await Promise.allSettled(SHELL_URLS.map((u) => cache.add(u)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((n) => n !== SHELL_CACHE && n !== API_CACHE)
        .map((n) => caches.delete(n))
    );
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (url.origin !== self.location.origin) return;
  if (req.method !== "GET") return;

  if (url.pathname.startsWith("/api/")) {
    event.respondWith(networkFirst(req, API_CACHE));
    return;
  }

  event.respondWith(cacheFirst(req, SHELL_CACHE));
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) {
    fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); }).catch(() => {});
    return cached;
  }
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    if (req.mode === "navigate") {
      const fallback = await cache.match("/index.html");
      if (fallback) return fallback;
    }
    throw err;
  }
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(req);
    if (cached) return cached;
    return new Response(JSON.stringify({ offline: true, error: "no cached response" }), {
      status: 503,
      headers: { "content-type": "application/json", "x-from-sw": "offline" },
    });
  }
}

self.addEventListener("message", (event) => {
  if (event.data?.type === "sw:skip-waiting") self.skipWaiting();
});
