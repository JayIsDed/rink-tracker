// Small DOM helpers and the sheet. Light DOM, no framework.

/** Build an element. `el("div.card", {onclick}, [children])` */
export function el(spec, props = {}, children = []) {
  const [tag, ...classes] = String(spec).split(".");
  const node = document.createElement(tag || "div");
  if (classes.length) node.className = classes.join(" ");
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function empty(title, hint) {
  // "Credible when half-empty" is a law — an empty surface says what it is
  // waiting for, and never apologises for existing.
  return el("div.empty", {}, [el("strong", { text: title }), hint ? el("span", { text: hint }) : null]);
}

// ── Sheet ─────────────────────────────────────────────────────────────
// One sheet element, reused. Body scroll is locked by position:fixed with the
// scroll offset saved — the app scrolls inside .view, but iOS still bleeds
// without this.

let sheetEl = null;
let backdropEl = null;
let savedScroll = 0;
let onCloseCb = null;

function ensureSheet() {
  if (sheetEl) return;
  backdropEl = el("div.backdrop", { onclick: closeSheet });
  sheetEl = el("div.sheet", { role: "dialog", "aria-modal": "true", "aria-hidden": "true" }, [
    el("div.sheet-head", {}, [
      el("h2", { id: "sheet-title", text: "" }),
      el("button.btn.small", { type: "button", "aria-label": "Close", text: "Close", onclick: closeSheet }),
    ]),
    el("div.sheet-body"),
  ]);
  document.body.append(backdropEl, sheetEl);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && sheetEl.classList.contains("open")) closeSheet();
  });
}

export function openSheet(title, content, { onClose } = {}) {
  ensureSheet();
  onCloseCb = onClose ?? null;
  sheetEl.querySelector("#sheet-title").textContent = title;
  const body = clear(sheetEl.querySelector(".sheet-body"));
  for (const c of [].concat(content)) if (c) body.append(c);

  savedScroll = window.scrollY;
  document.body.style.position = "fixed";
  document.body.style.top = `-${savedScroll}px`;
  document.body.style.width = "100%";

  sheetEl.setAttribute("aria-hidden", "false");
  backdropEl.classList.add("open");
  requestAnimationFrame(() => sheetEl.classList.add("open"));
  return sheetEl;
}

export function closeSheet() {
  if (!sheetEl || !sheetEl.classList.contains("open")) return;
  sheetEl.classList.remove("open");
  backdropEl.classList.remove("open");
  sheetEl.setAttribute("aria-hidden", "true");

  document.body.style.position = "";
  document.body.style.top = "";
  document.body.style.width = "";
  window.scrollTo(0, savedScroll);

  const cb = onCloseCb;
  onCloseCb = null;
  if (cb) cb();
}

export function isSheetOpen() {
  return !!sheetEl && sheetEl.classList.contains("open");
}

// ── Toast ─────────────────────────────────────────────────────────────

let toastEl = null;
let toastTimer = null;

export function toast(message, tone = "") {
  if (!toastEl) {
    toastEl = el("div", {
      style: {
        position: "fixed",
        left: "50%",
        transform: "translateX(-50%)",
        bottom: "calc(var(--dock-h) + 24px + env(safe-area-inset-bottom))",
        zIndex: "60",
        maxWidth: "min(92vw, 460px)",
        padding: "10px 16px",
        borderRadius: "var(--r-full)",
        background: "var(--elevated)",
        border: "1px solid var(--border-strong)",
        boxShadow: "var(--shadow)",
        fontSize: "14px",
        fontWeight: "600",
        textAlign: "center",
        opacity: "0",
        pointerEvents: "none",
        transition: "opacity var(--tx)",
      },
      role: "status",
      "aria-live": "polite",
    });
    document.body.append(toastEl);
  }
  toastEl.textContent = message;
  toastEl.style.color = tone === "red" ? "var(--red)" : tone === "green" ? "var(--green)" : "var(--text)";
  toastEl.style.opacity = "1";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.style.opacity = "0";
  }, 2600);
}

/** navigator.vibrate is absent on desktop and iOS — guard, never assume. */
export function tick(ms = 10) {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* no haptics here */
  }
}
