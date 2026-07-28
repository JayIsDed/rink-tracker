// Service worker.
//
// FOOTGUN 2 (n-71): the old worker's cache key was the server's BOOT TIMESTAMP,
// so every container restart busted every client's cache — including restarts
// that changed nothing. The key is now the build sha, injected by the server at
// request time from the BUILD_SHA env var (set by a Docker build arg, because
// the image has no .git for `git rev-parse` to read).
//
// It also precached nine paths that no longer exist. That was survivable only
// because the install used allSettled — meaning the shell cache was quietly
// half-populated on every install. The core list below is deliberately tiny and
// everything else is cached opportunistically as it is fetched.

const VERSION = "__BUILD_SHA__";
const SHELL_CACHE = `rink-shell-${VERSION}`;
const RUNTIME_CACHE = `rink-runtime-${VERSION}`;

// Only files that certainly exist. A 404 here aborts installation.
const CORE = ["/", "/index.html", "/app.js", "/shared/theme.css", "/manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((c) => c.addAll(CORE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE).map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Writes never touch the cache — the page-level outbox owns offline writes.
  if (req.method !== "GET") return;
  if (url.origin !== self.location.origin) return;

  // The API is always live. A stale reading presented as current is worse than
  // no reading, and the UI has explicit stale and error states for this.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(req).catch(
        () =>
          new Response(JSON.stringify({ error: "offline" }), {
            status: 503,
            headers: { "content-type": "application/json" },
          })
      )
    );
    return;
  }

  // Navigations: network first so a deploy lands immediately, shell as fallback
  // so the app still opens on a dead connection.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() => caches.match("/index.html").then((r) => r ?? Response.error()))
    );
    return;
  }

  // Static assets: serve from cache, revalidate behind it.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(RUNTIME_CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached ?? Response.error());
      return cached ?? network;
    })
  );
});
