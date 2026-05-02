// Rink Tracker — tiny hash router with lazy tab loading.
//
// Tabs live under /tabs/<name>/. Each tab has:
//   - index.html (HTML partial — injected into the shell main)
//   - tab.js     (optional — ES module, exports `init(ctx)` called after HTML mounts)
//
// The shell renders the HTML partial first, then dynamically imports tab.js
// and calls init() so the tab can wire up its DOM. ctx provides shared helpers
// (current rink, current identity) without each tab having to bootstrap them.

const TABS = ["home", "heatmap", "issues", "maintenance", "work", "handoff", "admin"];
const DEFAULT_TAB = "home";
const ROUTES = new Map(TABS.map((t) => [t, `/tabs/${t}/`]));

let currentTab = null;
let currentTeardown = null;

function parseHash() {
  const h = location.hash.replace(/^#\/?/, "");
  const [tabRaw] = h.split("?");
  const tab = TABS.includes(tabRaw) ? tabRaw : DEFAULT_TAB;
  return { tab };
}

async function loadTab(tab, ctx) {
  const main = document.getElementById("shell-main");
  if (!main) return;
  // Tear down the previous tab so its window listeners / timers go away.
  if (currentTeardown) {
    try { currentTeardown(); } catch (err) { console.warn(`[router] teardown error:`, err); }
    currentTeardown = null;
  }
  main.innerHTML = `<div class="tab-loading">loading…</div>`;
  // Highlight nav
  for (const el of document.querySelectorAll(".tab")) {
    el.classList.toggle("active", el.dataset.tab === tab);
  }
  // Fetch HTML partial
  let html = "";
  try {
    const r = await fetch(`${ROUTES.get(tab)}index.html`, { cache: "no-store" });
    if (r.ok) html = await r.text();
    else html = `<div class="tab-stub"><h1>${tab}</h1><p>tab partial missing (http ${r.status}).</p></div>`;
  } catch (err) {
    html = `<div class="tab-stub"><h1>${tab}</h1><p>couldn't load tab — offline?</p></div>`;
  }
  main.innerHTML = html;

  // Try to dynamically import tab.js for that tab. Optional — tabs without JS
  // logic are fine. init() may return a teardown function (sync) called on tab
  // unmount, or void if there's nothing to clean up.
  try {
    const mod = await import(`${ROUTES.get(tab)}tab.js`).catch(() => null);
    if (mod?.init) {
      const result = await Promise.resolve(mod.init(ctx));
      if (typeof result === "function") currentTeardown = result;
      else if (result && typeof result.destroy === "function") currentTeardown = result.destroy;
    }
  } catch (err) {
    console.warn(`[router] tab.js for ${tab} failed:`, err);
  }

  currentTab = tab;
  document.title = tab === "home" ? "Rink Tracker" : `Rink Tracker — ${tab}`;
}

export function startRouter(ctx) {
  window.addEventListener("hashchange", () => {
    const { tab } = parseHash();
    if (tab !== currentTab) loadTab(tab, ctx);
  });
  // Initial load
  if (!location.hash) location.hash = `#/${DEFAULT_TAB}`;
  const { tab } = parseHash();
  loadTab(tab, ctx);
}

export function getCurrentTab() { return currentTab; }
