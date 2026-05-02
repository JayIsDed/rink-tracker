// Rink Tracker — Issues tab.
//
// Frictionless logging for rink-floor "oh shit I found this" moments.
// Tap +, snap a photo, optional pin on the rink schematic, save. Done.
//
// Permission rules (mirror server/routes/issues.ts):
//   - members create + edit OWN title/body/photos + change ANY status + comment
//   - admins do all of the above plus change severity (priority) + delete photos
// The UI quietly hides controls that the current identity can't use.

import { apiFetch } from "/shared/api.js";

// ───── rink geometry (duplicated from heatmap; refactor in step 8) ───────
const RINK_W = 200;
const RINK_H = 100;
const CORNER_R = 28;
const SNAP_RADIUS_FT = 12;

const POINT_XY = new Map([
  [5,  { x: 18,  y: 14 }],  [4,  { x: 18,  y: 32 }],  [3,  { x: 18,  y: 50 }],  [2,  { x: 18,  y: 68 }],  [1,  { x: 18,  y: 86 }],
  [10, { x: 48,  y: 17 }],  [9,  { x: 48,  y: 37 }],  [8,  { x: 35,  y: 50 }],  [7,  { x: 48,  y: 63 }],  [6,  { x: 48,  y: 83 }],
  [15, { x: 79,  y: 14 }],  [14, { x: 79,  y: 32 }],  [13, { x: 79,  y: 50 }],  [12, { x: 79,  y: 68 }],  [11, { x: 79,  y: 86 }],
  [20, { x: 100, y: 14 }],  [19, { x: 100, y: 32 }],  [18, { x: 100, y: 50 }],  [17, { x: 100, y: 68 }],  [16, { x: 100, y: 86 }],
  [25, { x: 121, y: 14 }],  [24, { x: 121, y: 32 }],  [23, { x: 121, y: 50 }],  [22, { x: 121, y: 68 }],  [21, { x: 121, y: 86 }],
  [30, { x: 152, y: 17 }],  [29, { x: 152, y: 37 }],  [28, { x: 165, y: 50 }],  [27, { x: 152, y: 63 }],  [26, { x: 152, y: 83 }],
  [35, { x: 182, y: 14 }],  [34, { x: 182, y: 32 }],  [33, { x: 182, y: 50 }],  [32, { x: 182, y: 68 }],  [31, { x: 182, y: 86 }],
]);

// ───── helpers ───────────────────────────────────────────────────────────
function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
}
function relTime(ms) {
  if (!ms) return "";
  const dt = Date.now() - ms;
  const s = Math.floor(dt / 1000);
  if (s < 60)        return `${s}s`;
  const m = Math.floor(s / 60);  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);  if (d < 30) return `${d}d`;
  const mo = Math.floor(d / 30); if (mo < 12) return `${mo}mo`;
  return `${Math.floor(mo / 12)}y`;
}
function fmtAbsTime(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  return d.toLocaleString(undefined, { month:"short", day:"numeric", hour:"numeric", minute:"2-digit" });
}
function locationLabel(iss) {
  if (iss.point_nbr != null) return `point ${iss.point_nbr}`;
  if (iss.x_norm != null && iss.y_norm != null) return "pinned";
  return "no location";
}

// ───── tab init ──────────────────────────────────────────────────────────
export async function init(shellCtx) {
  const root = document.querySelector("[data-tab-root]");
  if (!root) return;
  const $ = (sel) => root.querySelector(sel);

  const state = {
    rinkCode: shellCtx.rinkCode,
    statusFilter: "open",  // 'open' | 'resolved' | 'all'
    issues: [],
    userMap: new Map(),    // id → { name, role }
    pin: { mode: "none", point_nbr: null, x_norm: null, y_norm: null }, // for new-issue dialog
    photoFiles: [],        // pending File[] for new-issue dialog
    detailIssue: null,     // currently-open issue (full shape)
  };

  function isAdmin() { return !!shellCtx.adminSession; }
  function myId()    { return shellCtx.identity?.id ?? null; }

  // ───── data fetch ──────────────────────────────────────────────────────
  async function loadUsers() {
    try {
      const users = await fetch("/api/users", { cache: "no-store" }).then(r => r.json());
      state.userMap.clear();
      for (const u of users) state.userMap.set(u.id, u);
    } catch { /* offline-fine */ }
  }
  async function loadIssues() {
    const list = $("#iss-list");
    list.innerHTML = `<div class="iss-loading">loading…</div>`;
    try {
      const r = await fetch(`/api/issues?rink=${state.rinkCode}&status=${state.statusFilter}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`http ${r.status}`);
      state.issues = await r.json();
    } catch (err) {
      list.innerHTML = `<div class="iss-empty"><div class="tab-stub"><h1>couldn't load</h1><p>${escapeHTML(err.message)}</p></div></div>`;
      return;
    }
    renderList();
  }

  function userName(id) {
    if (id == null) return "—";
    const u = state.userMap.get(id);
    return u ? u.name : `user ${id}`;
  }

  // ───── list rendering ──────────────────────────────────────────────────
  function renderList() {
    const list = $("#iss-list");
    const empty = $("#iss-empty");
    const counter = $("#iss-counter");
    counter.textContent = state.issues.length === 0 ? "" :
      state.issues.length === 1 ? "1 issue" : `${state.issues.length} issues`;
    if (state.issues.length === 0) {
      list.innerHTML = "";
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    list.innerHTML = state.issues.map(renderCard).join("");
    list.querySelectorAll(".iss-card").forEach(card => {
      card.addEventListener("click", () => openDetail(Number(card.dataset.id)));
    });
  }

  function renderCard(iss) {
    const thumb = iss.photos[0]
      ? `<img class="iss-card-thumb" src="${iss.photos[0].thumb_url}" alt="" loading="lazy">`
      : `<div class="iss-card-thumb iss-card-thumb-empty"><span aria-hidden="true">⊘</span></div>`;
    const sevClass = `iss-sev-pill iss-sev-${iss.severity}`;
    const statusClass = `iss-status-pill iss-status-${iss.status}`;
    const photoCount = iss.photos.length > 1 ? `<span class="iss-card-photo-count">+${iss.photos.length - 1}</span>` : "";
    return `
      <button type="button" class="iss-card" data-id="${iss.id}">
        <div class="iss-card-thumb-wrap">${thumb}${photoCount}</div>
        <div class="iss-card-main">
          <div class="iss-card-top">
            <span class="${sevClass}">${escapeHTML(iss.severity)}</span>
            <span class="${statusClass}">${escapeHTML(iss.status.replace("_"," "))}</span>
            <span class="iss-card-loc">${escapeHTML(locationLabel(iss))}</span>
          </div>
          <div class="iss-card-title">${escapeHTML(iss.title)}</div>
          <div class="iss-card-bottom">
            <span class="iss-card-author">${escapeHTML(userName(iss.created_by))}</span>
            <span class="iss-card-age" title="${escapeHTML(fmtAbsTime(iss.created_at))}">${relTime(iss.created_at)}</span>
          </div>
        </div>
      </button>
    `;
  }

  // ───── new-issue dialog ────────────────────────────────────────────────
  function resetNewDialog() {
    $("#iss-new-title-inp").value = "";
    $("#iss-new-body-inp").value = "";
    $("#iss-new-status").textContent = "";
    $("#iss-new-status").className = "iss-new-status";
    state.pin = { mode: "none", point_nbr: null, x_norm: null, y_norm: null };
    state.photoFiles = [];
    renderPinPane(false);
    renderPhotoPreviews();
    setSeverity("med");
    $("#iss-new-rink-hint").textContent = state.rinkCode === "U" ? "Upper rink" : "Lower rink";
  }
  function openNewDialog() {
    resetNewDialog();
    $("#iss-new-dialog").showModal();
    setTimeout(() => $("#iss-new-title-inp").focus(), 60);
  }
  function setSeverity(sev) {
    for (const btn of root.querySelectorAll(".iss-sev")) {
      const active = btn.dataset.sev === sev;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-checked", String(active));
    }
  }
  function getSeverity() {
    return root.querySelector(".iss-sev.active")?.dataset.sev ?? "med";
  }

  function renderPhotoPreviews() {
    const wrap = $("#iss-photo-previews");
    if (!wrap) return;
    wrap.innerHTML = state.photoFiles.map((file, i) => `
      <div class="iss-photo-prev" data-idx="${i}">
        <img alt="" src="${URL.createObjectURL(file)}">
        <button type="button" class="iss-photo-prev-x" aria-label="Remove" data-idx="${i}">×</button>
      </div>
    `).join("");
    wrap.querySelectorAll(".iss-photo-prev-x").forEach(b => {
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        const idx = Number(b.dataset.idx);
        state.photoFiles.splice(idx, 1);
        renderPhotoPreviews();
      });
    });
  }

  // ───── pin schematic (mini-rink for new-issue dialog) ──────────────────
  function renderPinPane(visible) {
    const pane = $("#iss-pin-pane");
    const toggle = $("#iss-pin-toggle");
    const label = $("#iss-pin-toggle-label");
    const clearBtn = $("#iss-pin-clear");
    pane.hidden = !visible;
    toggle.classList.toggle("active", visible || state.pin.mode !== "none");
    if (state.pin.mode === "point") {
      label.textContent = `📍 point ${state.pin.point_nbr}`;
    } else if (state.pin.mode === "free") {
      label.textContent = `📍 pinned anywhere on rink`;
    } else {
      label.textContent = visible ? "tap to drop a pin" : "Tap a spot on the rink";
    }
    clearBtn.hidden = state.pin.mode === "none";
    if (visible) drawPinCanvas();
  }
  function drawPinCanvas() {
    const canvas = $("#iss-pin-canvas");
    if (!canvas) return;
    const wrap = canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    const aspect = RINK_W / RINK_H;
    const wAvail = wrap.clientWidth - 4;
    const hAvail = 220;
    let cssW, cssH;
    if (wAvail / hAvail > aspect) { cssH = hAvail; cssW = cssH * aspect; }
    else { cssW = wAvail; cssH = cssW / aspect; }
    canvas.style.width = cssW + "px";
    canvas.style.height = cssH + "px";
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const cx = canvas.getContext("2d");
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const scale = cssW / RINK_W;

    // Outline
    cx.fillStyle = "#0e2236";
    cx.fillRect(0, 0, cssW, cssH);
    cx.beginPath();
    const r = CORNER_R * scale;
    const W = RINK_W * scale, H = RINK_H * scale;
    cx.moveTo(r, 0);
    cx.lineTo(W - r, 0); cx.arcTo(W, 0, W, r, r);
    cx.lineTo(W, H - r); cx.arcTo(W, H, W - r, H, r);
    cx.lineTo(r, H);     cx.arcTo(0, H, 0, H - r, r);
    cx.lineTo(0, r);     cx.arcTo(0, 0, r, 0, r);
    cx.closePath();
    cx.fillStyle = "#f6fbff";
    cx.fill();
    cx.strokeStyle = "#0a1320";
    cx.lineWidth = 2;
    cx.stroke();

    // Lines (blue + center red) — Upper rink only
    if (state.rinkCode === "U") {
      cx.fillStyle = "#1f55c4";
      cx.fillRect(79 * scale - 1, 0, 2, H);
      cx.fillRect(121 * scale - 1, 0, 2, H);
      cx.fillStyle = "#cc2222";
      cx.fillRect(100 * scale - 1, 0, 2, H);

      // Numbered points
      for (const [pt, xy] of POINT_XY) {
        cx.beginPath();
        cx.arc(xy.x * scale, xy.y * scale, 7, 0, Math.PI * 2);
        cx.fillStyle = state.pin.mode === "point" && state.pin.point_nbr === pt ? "#4ec5ff" : "#fff";
        cx.fill();
        cx.lineWidth = state.pin.mode === "point" && state.pin.point_nbr === pt ? 2 : 1;
        cx.strokeStyle = "#0a1320";
        cx.stroke();
        cx.fillStyle = "#0a1320";
        cx.font = "bold 9px system-ui, sans-serif";
        cx.textAlign = "center"; cx.textBaseline = "middle";
        cx.fillText(String(pt), xy.x * scale, xy.y * scale);
      }
    }

    // The placed pin
    if (state.pin.mode === "point") {
      const xy = POINT_XY.get(state.pin.point_nbr);
      if (xy) drawPin(cx, xy.x * scale, xy.y * scale);
    } else if (state.pin.mode === "free") {
      drawPin(cx, state.pin.x_norm * RINK_W * scale, state.pin.y_norm * RINK_H * scale);
    }
  }
  function drawPin(cx, x, y) {
    cx.beginPath();
    cx.arc(x, y - 14, 10, 0, Math.PI * 2);
    cx.fillStyle = "#ff4e6e";
    cx.fill();
    cx.strokeStyle = "#fff";
    cx.lineWidth = 2;
    cx.stroke();
    cx.beginPath();
    cx.moveTo(x - 6, y - 8);
    cx.lineTo(x, y);
    cx.lineTo(x + 6, y - 8);
    cx.closePath();
    cx.fill();
  }
  function pinFromCanvasXY(cssx, cssy) {
    const canvas = $("#iss-pin-canvas");
    const cssW = canvas.clientWidth;
    const scale = cssW / RINK_W;
    const xFt = cssx / scale;
    const yFt = cssy / scale;
    if (xFt < 0 || xFt > RINK_W || yFt < 0 || yFt > RINK_H) return; // outside rink
    if (state.rinkCode === "U") {
      // Snap to nearest numbered point if within radius.
      let best = null, bestD2 = Infinity;
      for (const [pt, xy] of POINT_XY) {
        const dx = xFt - xy.x, dy = yFt - xy.y;
        const d2 = dx*dx + dy*dy;
        if (d2 < bestD2) { bestD2 = d2; best = pt; }
      }
      if (best != null && Math.sqrt(bestD2) <= SNAP_RADIUS_FT) {
        state.pin = { mode: "point", point_nbr: best, x_norm: null, y_norm: null };
        $("#iss-pin-status").textContent = `snapped to point ${best}`;
        renderPinPane(true);
        return;
      }
    }
    state.pin = { mode: "free", point_nbr: null, x_norm: xFt / RINK_W, y_norm: yFt / RINK_H };
    $("#iss-pin-status").textContent = state.rinkCode === "U" ? "free pin (not on a numbered point)" : "free pin (lower rink — no grid)";
    renderPinPane(true);
  }

  async function saveNewIssue(e) {
    e.preventDefault();
    const title = $("#iss-new-title-inp").value.trim();
    const body  = $("#iss-new-body-inp").value.trim();
    if (!title) {
      $("#iss-new-status").textContent = "title required";
      $("#iss-new-status").className = "iss-new-status err";
      return;
    }
    const btn = $("#iss-new-save");
    btn.disabled = true; btn.textContent = "Saving…";
    $("#iss-new-status").textContent = state.photoFiles.length ? `uploading ${state.photoFiles.length} photo${state.photoFiles.length === 1 ? "" : "s"}…` : "saving…";
    $("#iss-new-status").className = "iss-new-status";
    try {
      const fd = new FormData();
      fd.append("rink_code", state.rinkCode);
      fd.append("title", title);
      if (body) fd.append("body", body);
      fd.append("severity", getSeverity());
      if (state.pin.mode === "point")    fd.append("point_nbr", String(state.pin.point_nbr));
      else if (state.pin.mode === "free") {
        fd.append("x_norm", String(state.pin.x_norm.toFixed(4)));
        fd.append("y_norm", String(state.pin.y_norm.toFixed(4)));
      }
      for (const f of state.photoFiles) fd.append("photos", f, f.name);
      const r = await apiFetch("/api/issues", { method: "POST", body: fd });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out.error ?? `http ${r.status}`);
      $("#iss-new-status").textContent = `saved · #${out.id}`;
      $("#iss-new-status").className = "iss-new-status ok";
      setTimeout(() => { $("#iss-new-dialog").close(); loadIssues(); }, 350);
    } catch (err) {
      $("#iss-new-status").textContent = err.message || "save failed";
      $("#iss-new-status").className = "iss-new-status err";
    } finally {
      btn.disabled = false; btn.textContent = "Save";
    }
  }

  // ───── detail dialog ───────────────────────────────────────────────────
  async function openDetail(id) {
    const dlg = $("#iss-detail-dialog");
    dlg.showModal();
    $("#iss-detail-title").textContent = `#${id}`;
    $("#iss-detail-meta").textContent = "";
    $("#iss-detail-body").innerHTML = `<div class="iss-loading">loading…</div>`;
    try {
      const r = await fetch(`/api/issues/${id}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`http ${r.status}`);
      state.detailIssue = await r.json();
      renderDetail();
    } catch (err) {
      $("#iss-detail-body").innerHTML = `<div class="iss-error">${escapeHTML(err.message)}</div>`;
    }
  }

  function renderDetail() {
    const iss = state.detailIssue;
    if (!iss) return;
    const me = myId();
    const admin = isAdmin();
    const owner = me != null && iss.created_by === me;
    const canEdit = admin || owner;

    $("#iss-detail-title").textContent = iss.title;
    $("#iss-detail-meta").innerHTML = `
      <span class="iss-sev-pill iss-sev-${iss.severity}">${escapeHTML(iss.severity)}</span>
      <span class="iss-status-pill iss-status-${iss.status}">${escapeHTML(iss.status.replace("_"," "))}</span>
      <span class="iss-detail-meta-loc">${escapeHTML(locationLabel(iss))}</span>
      <span class="iss-detail-meta-author">${escapeHTML(userName(iss.created_by))} · <span title="${escapeHTML(fmtAbsTime(iss.created_at))}">${relTime(iss.created_at)} ago</span></span>
    `;

    const photosHtml = iss.photos.length === 0 ? "" : `
      <section class="iss-detail-photos">
        ${iss.photos.map(p => `
          <a class="iss-detail-photo" href="${p.url}" target="_blank" rel="noopener">
            <img src="${p.thumb_url}" alt="" loading="lazy">
            ${admin ? `<button type="button" class="iss-detail-photo-x" data-photo-id="${p.id}" aria-label="Delete photo">×</button>` : ""}
          </a>
        `).join("")}
      </section>
    `;

    const bodyHtml = iss.body ? `<p class="iss-detail-body-text">${escapeHTML(iss.body)}</p>` : "";

    const sevControlHtml = admin ? `
      <div class="iss-detail-control">
        <span class="iss-detail-control-label">Severity</span>
        <div class="iss-sev-strip" role="radiogroup">
          ${["low","med","high"].map(s => `<button type="button" class="iss-sev iss-sev-${s} ${s===iss.severity?'active':''}" data-sev="${s}" data-act="set-sev">${s}</button>`).join("")}
        </div>
      </div>
    ` : "";

    const statusControlHtml = `
      <div class="iss-detail-control">
        <span class="iss-detail-control-label">Status</span>
        <div class="iss-status-strip">
          ${["open","in_progress","resolved"].map(s => `<button type="button" class="iss-status-pill iss-status-${s} ${s===iss.status?'active':''}" data-status="${s}" data-act="set-status">${s.replace("_"," ")}</button>`).join("")}
        </div>
      </div>
    `;

    const addPhotoHtml = canEdit ? `
      <div class="iss-detail-control">
        <label class="iss-photo-add">
          <span class="iss-photo-add-icon" aria-hidden="true">📷</span>
          <span>Add photo</span>
          <input type="file" data-act="add-photo" accept="image/*" capture="environment" multiple hidden>
        </label>
      </div>
    ` : "";

    const commentHtml = `
      <div class="iss-detail-control iss-detail-comment-row">
        <textarea data-act="comment-text" rows="2" maxlength="2000" placeholder="Add a comment…"></textarea>
        <button type="button" class="btn-primary iss-detail-comment-btn" data-act="comment-submit">Post</button>
      </div>
    `;

    const revisionsHtml = `
      <section class="iss-detail-timeline">
        <h3>Timeline</h3>
        <ol>
          ${iss.revisions.map(r => renderRevision(r)).reverse().join("")}
        </ol>
      </section>
    `;

    $("#iss-detail-body").innerHTML = `
      ${photosHtml}
      ${bodyHtml}
      <div class="iss-detail-controls">
        ${statusControlHtml}
        ${sevControlHtml}
        ${addPhotoHtml}
        ${commentHtml}
      </div>
      <div class="iss-detail-status" id="iss-detail-status"></div>
      ${revisionsHtml}
    `;

    wireDetailActions();
  }

  function renderRevision(r) {
    const who = userName(r.user_id);
    const when = `<time title="${escapeHTML(fmtAbsTime(r.at))}">${relTime(r.at)} ago</time>`;
    let text;
    switch (r.action) {
      case "created":          text = "<em>opened</em>"; break;
      case "status_changed":   text = `set status to <strong>${escapeHTML((r.new_value || "").replace("_"," "))}</strong>`; break;
      case "severity_changed": text = `set severity to <strong>${escapeHTML(r.new_value || "")}</strong>`; break;
      case "edited":           text = `edited <strong>${escapeHTML(r.field || "")}</strong>`; break;
      case "photo_added":      text = "added a photo"; break;
      case "photo_removed":    text = "removed a photo"; break;
      case "comment":          text = `<span class="iss-rev-comment">${escapeHTML(r.comment || "")}</span>`; break;
      default:                 text = escapeHTML(r.action);
    }
    return `<li class="iss-rev iss-rev-${r.action}"><span class="iss-rev-who">${escapeHTML(who)}</span> ${text} <span class="iss-rev-when">${when}</span></li>`;
  }

  function wireDetailActions() {
    const body = $("#iss-detail-body");
    body.querySelectorAll('[data-act="set-status"]').forEach(b => {
      b.addEventListener("click", () => patchIssue({ status: b.dataset.status }));
    });
    body.querySelectorAll('[data-act="set-sev"]').forEach(b => {
      b.addEventListener("click", () => patchIssue({ severity: b.dataset.sev }));
    });
    const photoInput = body.querySelector('[data-act="add-photo"]');
    if (photoInput) {
      photoInput.addEventListener("change", () => addPhotosToIssue([...photoInput.files]));
    }
    body.querySelectorAll(".iss-detail-photo-x").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        deletePhoto(Number(btn.dataset.photoId));
      });
    });
    const commentBtn = body.querySelector('[data-act="comment-submit"]');
    if (commentBtn) commentBtn.addEventListener("click", () => submitComment());
  }

  async function patchIssue(patch) {
    const id = state.detailIssue?.id;
    if (id == null) return;
    const status = $("#iss-detail-status");
    if (status) { status.textContent = "saving…"; status.className = "iss-detail-status"; }
    try {
      const r = await apiFetch(`/api/issues/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out.error ?? `http ${r.status}`);
      // Refresh both detail + list.
      await openDetail(id);
      loadIssues();
    } catch (err) {
      if (status) { status.textContent = err.message; status.className = "iss-detail-status err"; }
    }
  }

  async function addPhotosToIssue(files) {
    const id = state.detailIssue?.id;
    if (id == null || !files.length) return;
    const status = $("#iss-detail-status");
    if (status) { status.textContent = `uploading ${files.length}…`; status.className = "iss-detail-status"; }
    try {
      const fd = new FormData();
      for (const f of files) fd.append("photos", f, f.name);
      const r = await apiFetch(`/api/issues/${id}/photos`, { method: "POST", body: fd });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out.error ?? `http ${r.status}`);
      await openDetail(id);
      loadIssues();
    } catch (err) {
      if (status) { status.textContent = err.message; status.className = "iss-detail-status err"; }
    }
  }

  async function deletePhoto(photoId) {
    const id = state.detailIssue?.id;
    if (id == null) return;
    if (!confirm("Delete this photo? This is permanent.")) return;
    try {
      const r = await apiFetch(`/api/issues/${id}/photos/${photoId}`, { method: "DELETE" });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out.error ?? `http ${r.status}`);
      await openDetail(id);
      loadIssues();
    } catch (err) {
      const status = $("#iss-detail-status");
      if (status) { status.textContent = err.message; status.className = "iss-detail-status err"; }
    }
  }

  async function submitComment() {
    const id = state.detailIssue?.id;
    if (id == null) return;
    const inp = $('[data-act="comment-text"]');
    const text = inp?.value.trim();
    if (!text) return;
    try {
      const r = await apiFetch(`/api/issues/${id}/comment`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ comment: text }),
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out.error ?? `http ${r.status}`);
      inp.value = "";
      await openDetail(id);
    } catch (err) {
      const status = $("#iss-detail-status");
      if (status) { status.textContent = err.message; status.className = "iss-detail-status err"; }
    }
  }

  // ───── wire ────────────────────────────────────────────────────────────
  // Filter strip
  for (const btn of root.querySelectorAll(".iss-filter")) {
    btn.addEventListener("click", () => {
      root.querySelectorAll(".iss-filter").forEach(b => {
        const active = b === btn;
        b.classList.toggle("active", active);
        b.setAttribute("aria-selected", String(active));
      });
      state.statusFilter = btn.dataset.status;
      loadIssues();
    });
  }

  // FAB
  $("#iss-fab").addEventListener("click", openNewDialog);

  // New-issue dialog handlers
  $("#iss-new-cancel").addEventListener("click", () => $("#iss-new-dialog").close());
  $("#iss-new-form").addEventListener("submit", saveNewIssue);
  for (const btn of root.querySelectorAll(".iss-sev")) {
    btn.addEventListener("click", () => setSeverity(btn.dataset.sev));
  }
  $("#iss-photo-input").addEventListener("change", (e) => {
    const files = [...e.target.files];
    state.photoFiles.push(...files);
    e.target.value = ""; // allow re-selecting the same file later
    renderPhotoPreviews();
  });
  $("#iss-pin-toggle").addEventListener("click", () => {
    const pane = $("#iss-pin-pane");
    renderPinPane(pane.hidden);
  });
  $("#iss-pin-clear").addEventListener("click", () => {
    state.pin = { mode: "none", point_nbr: null, x_norm: null, y_norm: null };
    $("#iss-pin-status").textContent = "tap the rink to drop a pin · close points snap";
    renderPinPane(true);
  });
  const onPinCanvasClick = (e) => {
    const canvas = $("#iss-pin-canvas");
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    pinFromCanvasXY(e.clientX - rect.left, e.clientY - rect.top);
  };
  $("#iss-pin-canvas").addEventListener("click", onPinCanvasClick);

  // Detail dialog: close
  $("#iss-detail-close").addEventListener("click", () => $("#iss-detail-dialog").close());

  // Resize redraws pin canvas if open
  const onResize = () => { if (!$("#iss-pin-pane")?.hidden) drawPinCanvas(); };
  window.addEventListener("resize", onResize);

  // Rink switcher
  const onRinkChange = (newRink) => {
    state.rinkCode = newRink;
    state.detailIssue = null;
    if ($("#iss-detail-dialog").open) $("#iss-detail-dialog").close();
    if ($("#iss-new-dialog").open)    $("#iss-new-dialog").close();
    loadIssues();
  };
  shellCtx.onRinkChange.add(onRinkChange);

  // Initial load
  await loadUsers();
  await loadIssues();

  return () => {
    window.removeEventListener("resize", onResize);
    shellCtx.onRinkChange.delete(onRinkChange);
  };
}
