// Rink Tracker — shell entry point.
// Boots identity, mounts hash router, wires header controls (rink switcher + ident chip).

import {
  getIdentity, setIdentity,
  listUsers, addUser, adminLogin, whoami,
} from "/shared/auth.js";
import { startRouter, getCurrentTab } from "/shared/router.js";

const RINK_KEY = "rinkTracker.rink";

const ctx = {
  identity: null,        // { id, name, role } | null
  adminSession: false,
  rinkCode: localStorage.getItem(RINK_KEY) || "U",
  // Subscribers can listen for rink changes
  onRinkChange: new Set(),
};

// ───── identity chip + dialogs ──────────────────────────────────────
function renderIdentityChip() {
  const chip = document.getElementById("ident-chip");
  const nameEl = document.getElementById("ident-chip-name");
  if (!chip || !nameEl) return;
  if (!ctx.identity) {
    nameEl.textContent = "Sign in";
    chip.classList.remove("is-admin");
    return;
  }
  nameEl.textContent = ctx.identity.name;
  chip.classList.toggle("is-admin", ctx.adminSession);
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  }[c]));
}

async function populateIdentityList(highlightId) {
  const list = document.getElementById("identity-list");
  list.innerHTML = `<div class="ident-loading">loading…</div>`;
  let users;
  try { users = await listUsers(); }
  catch { list.innerHTML = `<div class="ident-empty">couldn't load users — check your connection</div>`; return; }
  if (users.length === 0) {
    list.innerHTML = `<div class="ident-empty">no one yet — add yourself below</div>`;
    return;
  }
  list.innerHTML = "";
  for (const u of users) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "ident-row";
    row.dataset.id = u.id;
    row.classList.toggle("is-me", u.id === highlightId);
    row.innerHTML = `
      <span class="ident-row-name">${escapeHTML(u.name)}</span>
      ${u.role === "admin" ? `<span class="ident-row-badge">admin</span>` : ``}
    `;
    row.addEventListener("click", () => {
      setIdentity(u);
      ctx.identity = u;
      ctx.adminSession = false; // re-pick clears any prior admin session locally
      renderIdentityChip();
      document.getElementById("identity-dialog").close();
    });
    list.appendChild(row);
  }
}

async function openIdentityDialog({ canCancel = true } = {}) {
  const dlg = document.getElementById("identity-dialog");
  document.getElementById("identity-cancel").hidden = !canCancel;
  document.getElementById("identity-status").textContent = "";
  document.getElementById("identity-new-name").value = "";
  await populateIdentityList(ctx.identity?.id);
  if (!dlg.open) dlg.showModal();
}

async function openAdminDialog() {
  const dlg = document.getElementById("admin-dialog");
  const sel = document.getElementById("admin-name");
  const status = document.getElementById("admin-status");
  status.textContent = "";
  document.getElementById("admin-pin").value = "";
  sel.innerHTML = `<option value="">loading…</option>`;
  try {
    const users = await listUsers();
    sel.innerHTML = "";
    const admins = users.filter(u => u.role === "admin");
    if (admins.length === 0) {
      sel.innerHTML = `<option value="">— no admins configured —</option>`;
    } else {
      for (const u of admins) sel.appendChild(new Option(u.name, u.name));
      if (ctx.identity && admins.find(a => a.name.toLowerCase() === ctx.identity.name.toLowerCase())) {
        sel.value = ctx.identity.name;
      }
    }
  } catch {
    sel.innerHTML = `<option value="">— offline —</option>`;
  }
  if (!dlg.open) dlg.showModal();
}

async function ensureIdentityOnBoot() {
  const me = getIdentity();
  let serverWho = null;
  try { serverWho = await whoami(); } catch { /* offline-fine */ }
  if (serverWho?.user) {
    if (!me || me.id !== serverWho.user.id) setIdentity(serverWho.user);
    ctx.identity = serverWho.user;
    ctx.adminSession = !!serverWho.admin_session;
  } else {
    ctx.identity = me;
  }
  renderIdentityChip();
  if (!ctx.identity) await openIdentityDialog({ canCancel: false });
}

function wireIdentityDialogs() {
  document.getElementById("ident-chip").addEventListener("click", () => openIdentityDialog({ canCancel: true }));

  document.getElementById("identity-add-btn").addEventListener("click", async () => {
    const input = document.getElementById("identity-new-name");
    const status = document.getElementById("identity-status");
    const name = input.value.trim();
    if (!name) { status.textContent = "type a name first"; status.className = "ident-status err"; return; }
    status.textContent = "adding…"; status.className = "ident-status";
    try {
      const u = await addUser(name);
      setIdentity(u);
      ctx.identity = u;
      ctx.adminSession = false;
      renderIdentityChip();
      document.getElementById("identity-dialog").close();
    } catch (e) {
      status.textContent = e.message || "couldn't add"; status.className = "ident-status err";
    }
  });
  document.getElementById("identity-new-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); document.getElementById("identity-add-btn").click(); }
  });

  document.getElementById("identity-admin-link").addEventListener("click", async () => {
    document.getElementById("identity-dialog").close();
    await openAdminDialog();
  });
  document.getElementById("identity-cancel").addEventListener("click", () => {
    document.getElementById("identity-dialog").close();
  });

  document.getElementById("admin-cancel").addEventListener("click", () => {
    document.getElementById("admin-dialog").close();
  });
  document.getElementById("admin-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("admin-name").value;
    const pin = document.getElementById("admin-pin").value;
    const status = document.getElementById("admin-status");
    if (!name || !pin) { status.textContent = "name and PIN required"; status.className = "admin-status err"; return; }
    status.textContent = "signing in…"; status.className = "admin-status";
    const btn = document.getElementById("admin-submit"); btn.disabled = true;
    try {
      const u = await adminLogin(name, pin);
      setIdentity(u);
      ctx.identity = u;
      ctx.adminSession = true;
      renderIdentityChip();
      document.getElementById("admin-dialog").close();
    } catch (err) {
      status.textContent = err.message || "sign-in failed"; status.className = "admin-status err";
    } finally {
      btn.disabled = false;
    }
  });
}

// ───── rink switcher ────────────────────────────────────────────────
function wireRinkSwitcher() {
  for (const btn of document.querySelectorAll(".rink-opt")) {
    btn.classList.toggle("active", btn.dataset.rink === ctx.rinkCode);
    btn.setAttribute("aria-selected", String(btn.dataset.rink === ctx.rinkCode));
    btn.addEventListener("click", () => {
      ctx.rinkCode = btn.dataset.rink;
      localStorage.setItem(RINK_KEY, ctx.rinkCode);
      for (const b of document.querySelectorAll(".rink-opt")) {
        b.classList.toggle("active", b.dataset.rink === ctx.rinkCode);
        b.setAttribute("aria-selected", String(b.dataset.rink === ctx.rinkCode));
      }
      for (const fn of ctx.onRinkChange) fn(ctx.rinkCode);
    });
  }
}

// ───── boot ──────────────────────────────────────────────────────────
async function boot() {
  wireIdentityDialogs();
  wireRinkSwitcher();
  await ensureIdentityOnBoot();
  startRouter(ctx);
}

boot().catch((err) => {
  console.error("[boot]", err);
  const main = document.getElementById("shell-main");
  if (main) main.innerHTML = `<div class="tab-stub"><h1>boot error</h1><p>${err.message}</p></div>`;
});

// Expose ctx for tabs that import the shell directly (rare).
window.__rinkCtx = ctx;
