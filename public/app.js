// Shell: boot, identity, routing, dock. Views register themselves; this file
// knows nothing about what any of them contain.

import { get, post } from "/shared/api.js";
import { el, clear, openSheet, closeSheet, toast, tick } from "/shared/ui.js";
import * as views from "/shared/views.js";

// Registering a view is what puts it in the dock. Add the import when the
// surface ships — never before.
import "/views/home.js";
import "/views/edger.js";
import "/views/maintenance.js";
import "/views/settings.js";

export const state = {
  who: null,
  isAdmin: false,
  members: [],
  machines: [],
  rinks: [],
  settings: {},
  build: "dev",
  rink: localStorage.getItem("rt:rink") || "U",
};

const listeners = new Set();
export function onState(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit() {
  for (const fn of listeners) fn(state);
}

export async function refreshBootstrap() {
  const b = await get("/api/bootstrap");
  Object.assign(state, b);
  emit();
  return b;
}

export function setRink(code) {
  state.rink = code;
  localStorage.setItem("rt:rink", code);
  emit();
}

// ── Routing ───────────────────────────────────────────────────────────

const viewEl = document.getElementById("view");
const titleEl = document.getElementById("view-title");
const dockEl = document.getElementById("dock");

let cleanup = null;

export function navigate(path, { replace = false } = {}) {
  if (replace) history.replaceState({}, "", path);
  else history.pushState({}, "", path);
  render();
}

async function render() {
  const url = new URL(location.href);
  const shipped = views.all();

  if (shipped.length === 0) {
    // Not reachable in a shipped build — the guard exists so a bad import
    // yields a plain message rather than a blank screen.
    clear(viewEl).append(el("div.empty", {}, [el("strong", { text: "No surfaces registered" })]));
    return;
  }

  let v = views.matchPath(url.pathname);
  if (!v) {
    v = shipped[0];
    history.replaceState({}, "", v.path + url.search);
  }
  if (v.adminOnly && !state.isAdmin) {
    toast("Admin PIN required", "red");
    v = shipped.find((x) => !x.adminOnly) ?? shipped[0];
    history.replaceState({}, "", v.path);
  }

  if (cleanup) {
    try { cleanup(); } catch (e) { console.warn("[shell] cleanup failed", e); }
    cleanup = null;
  }
  closeSheet();

  titleEl.textContent = v.title;
  document.title = `${v.title} · Rink Tracker`;
  clear(viewEl);
  renderDock(v);

  try {
    cleanup = (await v.mount({ root: viewEl, url, state, navigate, refresh: refreshBootstrap })) ?? null;
  } catch (err) {
    console.error("[shell] view failed", v.id, err);
    clear(viewEl).append(
      el("div.empty", {}, [
        el("strong", { text: "This screen hit an error" }),
        el("span", { text: String(err?.message ?? err) }),
      ])
    );
  }
  viewEl.scrollTop = 0;
}

function renderDock(active) {
  const items = views.dockViews({ isAdmin: state.isAdmin });
  clear(dockEl);
  // One shipped surface needs no navigation — a single-item dock is chrome
  // pretending to be a choice.
  dockEl.hidden = items.length < 2;
  if (dockEl.hidden) {
    document.documentElement.style.setProperty("--dock-h", "0px");
    return;
  }
  document.documentElement.style.removeProperty("--dock-h");
  for (const v of items) {
    dockEl.append(
      el(
        "a",
        {
          href: v.path,
          "aria-current": v.id === active.id ? "page" : null,
          onclick: (e) => {
            e.preventDefault();
            tick();
            navigate(v.path);
          },
        },
        [el("span.ico", { "aria-hidden": "true", text: v.icon }), el("span", { text: v.label })]
      )
    );
  }
}

addEventListener("popstate", render);

// ── Identity ──────────────────────────────────────────────────────────
// Pick-your-name once per device. Deep links carry ?return= so an NFC tap on a
// cold phone lands on the prefilled form, never on home.

const whoBtn = document.getElementById("who-btn");

function renderWho() {
  whoBtn.textContent = state.who ? (state.isAdmin ? `${state.who} ★` : state.who) : "Who are you?";
}
onState(renderWho);

whoBtn.addEventListener("click", () => openIdentity());

export function openIdentity({ returnTo = null } = {}) {
  const status = el("div.dim", { text: "" });

  const pick = async (name) => {
    try {
      await post("/api/identity", { name });
      await refreshBootstrap();
      closeSheet();
      toast(`Hi, ${name}`, "green");
      if (returnTo) navigate(returnTo, { replace: true });
    } catch (err) {
      status.textContent = err.message;
    }
  };

  const list = el(
    "div",
    { style: { display: "flex", flexWrap: "wrap", gap: "var(--s2)" } },
    state.members.map((m) =>
      el("button.btn", { type: "button", text: m.name, onclick: () => pick(m.name) })
    )
  );

  const nameInput = el("input.input", {
    type: "text",
    placeholder: "Type your name",
    maxlength: "40",
    autocomplete: "off",
    enterkeyhint: "go",
  });
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && nameInput.value.trim()) pick(nameInput.value.trim());
  });

  openSheet("Who's logging?", [
    el("p.muted.prose", {
      text: "Pick your name so the crew can see who did what. Saved on this device — you only do this once.",
    }),
    state.members.length ? list : el("p.dim", { text: "Nobody's on the list yet. Add yourself below." }),
    el("div.field", {}, [
      el("label", { text: "Not on the list?" }),
      el("div.row", {}, [
        el("span.grow", {}, [nameInput]),
        el("button.btn.primary.fixed", {
          type: "button",
          text: "Add",
          onclick: () => nameInput.value.trim() && pick(nameInput.value.trim()),
        }),
      ]),
    ]),
    status,
    state.who
      ? el("button.btn.small", { type: "button", text: "Admin sign-in", onclick: () => openAdminUnlock() })
      : null,
  ]);
}

export function openAdminUnlock() {
  const status = el("div.dim", { text: "" });
  const pin = el("input.input", {
    type: "password",
    inputmode: "numeric",
    maxlength: "12",
    autocomplete: "off",
    placeholder: "PIN",
    enterkeyhint: "go",
  });
  const nameSel = el(
    "select.input",
    {},
    state.members.filter((m) => m.role === "admin").map((m) => el("option", { value: m.name, text: m.name }))
  );
  if (state.who) nameSel.value = state.who;

  const submit = async () => {
    try {
      await post("/api/admin/unlock", { name: nameSel.value, pin: pin.value });
      await refreshBootstrap();
      closeSheet();
      toast("Admin unlocked", "green");
      render();
    } catch (err) {
      status.textContent = err.message;
      status.style.color = "var(--red)";
    }
  };
  pin.addEventListener("keydown", (e) => e.key === "Enter" && submit());

  openSheet("Admin sign-in", [
    el("p.muted.prose", { text: "Only needed for severity, deleting things, and settings." }),
    nameSel.children.length
      ? el("div.field", {}, [el("label", { text: "Name" }), nameSel])
      : el("p.dim", { text: "No admins are configured. Set RINK_ADMIN_PINS on the server." }),
    el("div.field", {}, [el("label", { text: "PIN" }), pin]),
    status,
    el("div.row", {}, [
      el("button.btn.primary.grow", { type: "button", text: "Sign in", onclick: submit }),
    ]),
  ]);
}

// ── Boot ──────────────────────────────────────────────────────────────

(async function boot() {
  try {
    await refreshBootstrap();
  } catch (err) {
    console.error("[shell] bootstrap failed", err);
    clear(viewEl).append(
      el("div.empty", {}, [
        el("strong", { text: "Can't reach the server" }),
        el("span", { text: "Check the connection and pull down to retry." }),
      ])
    );
    return;
  }
  renderWho();
  await render();

  // A deep link (an NFC tap) on a device that has never picked a name opens
  // the picker with the destination held, so the params survive the detour.
  if (!state.who) {
    const here = location.pathname + location.search;
    openIdentity({ returnTo: here !== "/" ? here : null });
  }
})();
