// Rink Tracker — Heatmap tab. Ported from ice-tracker.
//
// Scope notes:
//   - The shell injects this tab's HTML into #shell-main and then dynamically
//     imports this module. init(ctx) gets the shell context (identity, rink,
//     rink-change subscribers) and returns a destroy() function called when
//     the user navigates away.
//   - All DOM queries are scoped to the tab root so re-mounting on tab
//     re-entry stays clean.
//   - Writes go through apiFetch so X-User-Id stamps the entry automatically.
//   - Heatmap is Upper-only — Lower rink shows an empty state.

import { apiFetch } from "/shared/api.js";
import { enqueue, dequeue, drain, listPending } from "/shared/outbox.js";

const RINK_W = 200;
const RINK_H = 100;
const CORNER_R = 28;

const MARK = {
  goalLineLeft:  18,
  goalLineRight: 182,
  blueLineLeft:  79,
  blueLineRight: 121,
  centerLine:    100,
  faceoffDotXL:  35,
  faceoffDotXR:  165,
  faceoffYTop:   27,
  faceoffYBot:   73,
  centerY:       50,
  faceoffR:      15.5,
  centerCircleR: 16,
  goalCreaseR:   6,
  goalLineMargin: 4,
};

const Y_LINE = [14, 32, 50, 68, 86];
const FX = 13;
const FY = 10;

const POINT_XY = new Map([
  // Col 1 — left goal line
  [5,  { x: MARK.goalLineLeft, y: Y_LINE[0] }],
  [4,  { x: MARK.goalLineLeft, y: Y_LINE[1] }],
  [3,  { x: MARK.goalLineLeft, y: Y_LINE[2] }],
  [2,  { x: MARK.goalLineLeft, y: Y_LINE[3] }],
  [1,  { x: MARK.goalLineLeft, y: Y_LINE[4] }],
  // Col 2 — left faceoff zone
  [10, { x: MARK.faceoffDotXL + FX, y: MARK.faceoffYTop - FY }],
  [9,  { x: MARK.faceoffDotXL + FX, y: MARK.faceoffYTop + FY }],
  [8,  { x: MARK.faceoffDotXL,      y: MARK.centerY        }],
  [7,  { x: MARK.faceoffDotXL + FX, y: MARK.faceoffYBot - FY }],
  [6,  { x: MARK.faceoffDotXL + FX, y: MARK.faceoffYBot + FY }],
  // Col 3 — left blue line
  [15, { x: MARK.blueLineLeft, y: Y_LINE[0] }],
  [14, { x: MARK.blueLineLeft, y: Y_LINE[1] }],
  [13, { x: MARK.blueLineLeft, y: Y_LINE[2] }],
  [12, { x: MARK.blueLineLeft, y: Y_LINE[3] }],
  [11, { x: MARK.blueLineLeft, y: Y_LINE[4] }],
  // Col 4 — center red line
  [20, { x: MARK.centerLine, y: Y_LINE[0] }],
  [19, { x: MARK.centerLine, y: Y_LINE[1] }],
  [18, { x: MARK.centerLine, y: Y_LINE[2] }],
  [17, { x: MARK.centerLine, y: Y_LINE[3] }],
  [16, { x: MARK.centerLine, y: Y_LINE[4] }],
  // Col 5 — right blue line
  [25, { x: MARK.blueLineRight, y: Y_LINE[0] }],
  [24, { x: MARK.blueLineRight, y: Y_LINE[1] }],
  [23, { x: MARK.blueLineRight, y: Y_LINE[2] }],
  [22, { x: MARK.blueLineRight, y: Y_LINE[3] }],
  [21, { x: MARK.blueLineRight, y: Y_LINE[4] }],
  // Col 6 — right faceoff zone
  [30, { x: MARK.faceoffDotXR - FX, y: MARK.faceoffYTop - FY }],
  [29, { x: MARK.faceoffDotXR - FX, y: MARK.faceoffYTop + FY }],
  [28, { x: MARK.faceoffDotXR,      y: MARK.centerY        }],
  [27, { x: MARK.faceoffDotXR - FX, y: MARK.faceoffYBot - FY }],
  [26, { x: MARK.faceoffDotXR - FX, y: MARK.faceoffYBot + FY }],
  // Col 7 — right goal line
  [35, { x: MARK.goalLineRight, y: Y_LINE[0] }],
  [34, { x: MARK.goalLineRight, y: Y_LINE[1] }],
  [33, { x: MARK.goalLineRight, y: Y_LINE[2] }],
  [32, { x: MARK.goalLineRight, y: Y_LINE[3] }],
  [31, { x: MARK.goalLineRight, y: Y_LINE[4] }],
]);

const WMO = {0:"clear",1:"mostly clear",2:"partly cloudy",3:"overcast",45:"fog",48:"rime fog",51:"light drizzle",53:"drizzle",55:"heavy drizzle",61:"light rain",63:"rain",65:"heavy rain",66:"freezing rain",67:"freezing rain heavy",71:"light snow",73:"snow",75:"heavy snow",77:"snow grains",80:"light showers",81:"showers",82:"violent showers",85:"snow showers",86:"heavy snow showers",95:"thunderstorm",96:"tstorm + small hail",99:"tstorm + heavy hail"};

const fmt = n => (n == null ? "—" : Number(n).toFixed(2));
const fmtTemp = n => (n == null ? "—" : Number(n).toFixed(1) + "°F");
const fmtDepth = n => (n == null ? "—" : Number(n).toFixed(2) + '"');
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ───── color scales ───────────────────────────────────────────────────
function colorDepth(v) {
  if (v == null) return "rgba(60,80,100,0.2)";
  const t = clamp((v - 0.5) / (6 - 0.5), 0, 1);
  return ramp(t, [
    [0.0, [220,   0,  40]], [0.2, [255,  90,  20]], [0.4, [255, 200,   0]],
    [0.6, [180, 230,   0]], [0.8, [ 30, 200,  60]], [1.0, [  0, 150, 100]],
  ]);
}
function colorTemp(v) {
  if (v == null) return "rgba(60,80,100,0.2)";
  const t = clamp((v - 15) / (35 - 15), 0, 1);
  return ramp(t, [
    [0.0, [  0,  60, 220]], [0.25,[  0, 180, 240]], [0.5, [120, 220,  60]],
    [0.75,[255, 200,   0]], [1.0, [255,  60,  20]],
  ]);
}
function colorDanger(v) {
  if (v == null) return "rgba(60,80,100,0.2)";
  const t = clamp(v / 3, 0, 1);
  return ramp(t, [[0.0,[255,40,40]],[0.3,[255,140,60]],[0.6,[255,220,100]],[1.0,[80,220,160]]]);
}
function colorDelta(v) {
  if (v == null) return "rgba(60,80,100,0.2)";
  const t = clamp((v + 1.5) / 3, 0, 1);
  return ramp(t, [[0.0,[255,80,80]],[0.5,[180,180,180]],[1.0,[80,160,255]]]);
}
function colorPlan(v) { return colorDepth(v); }
function colorAnomaly(v) {
  if (v == null) return "rgba(60,80,100,0.2)";
  const t = clamp((v + 3) / 6, 0, 1);
  return ramp(t, [[0.0,[220,0,40]],[0.5,[180,180,180]],[1.0,[0,160,255]]]);
}
function ramp(t, stops) {
  for (let i = 0; i < stops.length - 1; i++) {
    const [a, ca] = stops[i], [b, cb] = stops[i + 1];
    if (t <= b) {
      const f = (t - a) / (b - a);
      const r = Math.round(ca[0] + (cb[0] - ca[0]) * f);
      const g = Math.round(ca[1] + (cb[1] - ca[1]) * f);
      const bl= Math.round(ca[2] + (cb[2] - ca[2]) * f);
      return `rgb(${r},${g},${bl})`;
    }
  }
  const c = stops[stops.length - 1][1];
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// ───── tab init ──────────────────────────────────────────────────────
export async function init(shellCtx) {
  const root = document.querySelector("[data-tab-root]");
  if (!root) return;
  const $ = (sel) => root.querySelector(sel);

  const canvas = $("#rink");
  const cx = canvas.getContext("2d");

  const state = {
    rinkCode: shellCtx.rinkCode,
    points: [],
    pointMap: new Map(),
    dates: [],
    current: [],
    compare: [],
    concrete: [],
    weather: null,
    mode: "depth",
    date: null,
    compareDate: null,
    hoverPoint: null,
    selectedPoint: null,
    showMesh: true,
    cutDepth: 0.25,
    safetyBuffer: 0.5,
    anomalies: [],
  };

  // ───── canvas + render ──────────────────────────────────────────────
  // Cached so render() doesn't recompute layout every frame. Updated only when
  // the wrap's content-box actually changes (ResizeObserver below).
  let cachedSize = { cssW: 0, cssH: 0 };

  function computeCanvasSize() {
    const wrap = canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    const aspect = RINK_W / RINK_H;
    const padding = 24;
    const wAvail = Math.max(0, wrap.clientWidth - padding * 2);
    const hAvail = Math.max(0, wrap.clientHeight - padding * 2);
    let cssW, cssH;
    if (wAvail / hAvail > aspect) { cssH = hAvail; cssW = cssH * aspect; }
    else { cssW = wAvail; cssH = cssW / aspect; }
    // Round to whole px — fractional canvas sizes cause AA shimmer between renders.
    cssW = Math.floor(cssW);
    cssH = Math.floor(cssH);
    return { cssW, cssH, dpr };
  }

  function applyCanvasSize(force = false) {
    const { cssW, cssH, dpr } = computeCanvasSize();
    if (!force && cssW === cachedSize.cssW && cssH === cachedSize.cssH) {
      return cachedSize;
    }
    cachedSize = { cssW, cssH };
    canvas.style.width  = cssW + "px";
    canvas.style.height = cssH + "px";
    canvas.width  = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return cachedSize;
  }

  function getValueAt(pt) {
    const m = state.current.find(x => x.point_nbr === pt.point_nbr);
    if (state.mode === "depth")    return m?.depth_in ?? null;
    if (state.mode === "temp")     return m?.temp_f   ?? null;
    if (state.mode === "concrete") {
      const cur = m?.depth_in ?? null;
      const c = state.concrete.find(x => x.point_nbr === pt.point_nbr);
      if (cur == null || !c) return null;
      return Math.max(0, cur - c.min_depth);
    }
    if (state.mode === "delta") {
      const a = m?.depth_in ?? null;
      const b = state.compare.find(x => x.point_nbr === pt.point_nbr)?.depth_in ?? null;
      if (a == null || b == null) return null;
      return a - b;
    }
    if (state.mode === "plan") {
      const cur = m?.depth_in ?? null;
      if (cur == null) return null;
      return Math.max(0, cur - state.cutDepth);
    }
    if (state.mode === "anomaly") {
      const a = state.anomalies.find(x => x.point_nbr === pt.point_nbr);
      return a?.z ?? null;
    }
    return null;
  }
  function colorFor(v) {
    switch (state.mode) {
      case "depth":    return colorDepth(v);
      case "temp":     return colorTemp(v);
      case "concrete": return colorDanger(v);
      case "delta":    return colorDelta(v);
      case "plan":     return colorPlan(v);
      case "anomaly":  return colorAnomaly(v);
    }
  }

  function ftToPx(scale) { return (xFt, yFt) => [xFt * scale, yFt * scale]; }
  function rinkOutlinePath(scale) {
    const path = new Path2D();
    const r = CORNER_R * scale;
    const W = RINK_W * scale;
    const H = RINK_H * scale;
    path.moveTo(r, 0);
    path.lineTo(W - r, 0); path.arcTo(W, 0, W, r, r);
    path.lineTo(W, H - r); path.arcTo(W, H, W - r, H, r);
    path.lineTo(r, H);     path.arcTo(0, H, 0, H - r, r);
    path.lineTo(0, r);     path.arcTo(0, 0, r, 0, r);
    return path;
  }

  function fieldAt(xFt, yFt) {
    const have = [];
    for (const p of state.points) {
      const v = getValueAt(p);
      if (v == null) continue;
      const xy = POINT_XY.get(p.point_nbr);
      if (!xy) continue;
      const dx = xFt - xy.x, dy = yFt - xy.y;
      const d2 = dx*dx + dy*dy;
      have.push({ v, d2, dist: Math.sqrt(d2) });
    }
    if (have.length === 0) return null;
    have.sort((a, b) => a.d2 - b.d2);
    if (have[0].d2 < 0.5) return { v: have[0].v, conf: 1.0 };
    const k = Math.min(6, have.length);
    let wsum = 0, vsum = 0;
    for (let i = 0; i < k; i++) {
      const w = 1 / Math.pow(have[i].dist, 2);
      wsum += w; vsum += w * have[i].v;
    }
    const v = vsum / wsum;
    const meanDist = have.slice(0, k).reduce((s, u) => s + u.dist, 0) / k;
    const conf = Math.max(0.5, Math.min(0.95, 1.05 - meanDist / 60));
    return { v, conf };
  }

  function ptCoords(p) {
    return POINT_XY.get(p.point_nbr) ?? { x: 100, y: 42.5 };
  }

  function render() {
    if (state.points.length === 0) return; // empty state already shown
    if (cachedSize.cssW === 0) applyCanvasSize(true); // first paint
    const { cssW, cssH } = cachedSize;
    const scale = cssW / RINK_W;
    cx.clearRect(0, 0, cssW, cssH);

    const outline = rinkOutlinePath(scale);
    cx.save();
    cx.fillStyle = "#f6fbff";
    cx.fill(outline);
    cx.clip(outline);

    const cellPx = 6;
    for (let yPx = 0; yPx < cssH; yPx += cellPx) {
      for (let xPx = 0; xPx < cssW; xPx += cellPx) {
        const xFt = xPx / scale, yFt = yPx / scale;
        const f = fieldAt(xFt, yFt);
        if (!f) continue;
        cx.fillStyle = colorFor(f.v);
        cx.globalAlpha = state.showMesh ? f.conf : 0.92;
        cx.fillRect(xPx, yPx, cellPx, cellPx);
      }
    }
    cx.globalAlpha = 1;
    cx.restore();

    const px = ftToPx(scale);
    cx.lineWidth = 2.5;
    cx.strokeStyle = "#0a1320";
    cx.stroke(outline);

    const RED = "#cc2222", BLUE = "#1f55c4";
    cx.fillStyle = BLUE;
    cx.fillRect(...px(MARK.blueLineLeft - 0.5, 0),  scale * 1, RINK_H * scale);
    cx.fillRect(...px(MARK.blueLineRight - 0.5, 0), scale * 1, RINK_H * scale);
    cx.fillStyle = RED;
    cx.fillRect(...px(MARK.centerLine - 0.5, 0), scale * 1, RINK_H * scale);

    cx.strokeStyle = RED; cx.lineWidth = 1.5;
    cx.beginPath();
    cx.moveTo(...px(MARK.goalLineLeft,  MARK.goalLineMargin));
    cx.lineTo(...px(MARK.goalLineLeft,  RINK_H - MARK.goalLineMargin));
    cx.moveTo(...px(MARK.goalLineRight, MARK.goalLineMargin));
    cx.lineTo(...px(MARK.goalLineRight, RINK_H - MARK.goalLineMargin));
    cx.stroke();

    cx.strokeStyle = BLUE; cx.lineWidth = 2;
    cx.beginPath();
    cx.arc(...px(MARK.centerLine, MARK.centerY), MARK.centerCircleR * scale, 0, Math.PI * 2);
    cx.stroke();
    cx.fillStyle = BLUE;
    cx.beginPath();
    cx.arc(...px(MARK.centerLine, MARK.centerY), 1 * scale, 0, Math.PI * 2);
    cx.fill();

    cx.strokeStyle = RED; cx.lineWidth = 2;
    for (const [x, y] of [
      [MARK.faceoffDotXL, MARK.faceoffYTop], [MARK.faceoffDotXL, MARK.faceoffYBot],
      [MARK.faceoffDotXR, MARK.faceoffYTop], [MARK.faceoffDotXR, MARK.faceoffYBot],
    ]) {
      cx.beginPath(); cx.arc(...px(x, y), MARK.faceoffR * scale, 0, Math.PI * 2); cx.stroke();
      cx.fillStyle = RED;
      cx.beginPath(); cx.arc(...px(x, y), 1 * scale, 0, Math.PI * 2); cx.fill();
      cx.lineWidth = 1.5;
      cx.beginPath();
      const r = MARK.faceoffR;
      cx.moveTo(...px(x - r - 1, y)); cx.lineTo(...px(x - r + 1, y));
      cx.moveTo(...px(x + r - 1, y)); cx.lineTo(...px(x + r + 1, y));
      cx.moveTo(...px(x, y - r - 1)); cx.lineTo(...px(x, y - r + 1));
      cx.moveTo(...px(x, y + r - 1)); cx.lineTo(...px(x, y + r + 1));
      cx.strokeStyle = RED; cx.stroke();
      cx.lineWidth = 2;
    }

    cx.fillStyle = "rgba(110, 180, 255, 0.45)";
    cx.strokeStyle = BLUE; cx.lineWidth = 1.5;
    for (const [gx, intoRink] of [[MARK.goalLineLeft, +1], [MARK.goalLineRight, -1]]) {
      cx.beginPath();
      if (intoRink > 0) cx.arc(...px(gx, MARK.centerY), MARK.goalCreaseR * scale, -Math.PI/2, Math.PI/2, false);
      else              cx.arc(...px(gx, MARK.centerY), MARK.goalCreaseR * scale, -Math.PI/2, Math.PI/2, true);
      cx.closePath(); cx.fill(); cx.stroke();
    }

    cx.strokeStyle = "rgba(10, 20, 35, 0.7)"; cx.lineWidth = 1.2;
    const tickHalf = 4;
    for (const tx of [MARK.goalLineLeft, MARK.blueLineLeft, MARK.centerLine, MARK.blueLineRight, MARK.goalLineRight]) {
      for (const ty of Y_LINE) {
        cx.beginPath();
        cx.moveTo(...px(tx - tickHalf, ty)); cx.lineTo(...px(tx + tickHalf, ty));
        cx.stroke();
      }
    }

    if (state.showMesh) {
      const anchorRadiusFt = 4;
      for (const p of state.points) {
        const { x, y } = ptCoords(p);
        const [ax, ay] = px(x, y);
        const v = getValueAt(p);
        if (v == null) continue;
        cx.beginPath(); cx.arc(ax, ay, anchorRadiusFt * scale, 0, Math.PI * 2);
        cx.strokeStyle = "rgba(255, 255, 255, 0.7)";
        cx.lineWidth = 1.2; cx.setLineDash([2, 3]); cx.stroke(); cx.setLineDash([]);
      }
    }

    for (const p of state.points) {
      const { x, y } = ptCoords(p);
      const [ax, ay] = px(x, y);
      const v = getValueAt(p);
      const isSel = state.selectedPoint === p.point_nbr;
      const isHov = state.hoverPoint === p.point_nbr;
      const r = isSel ? 11 : (isHov ? 10 : 8);

      if (isSel || isHov) {
        cx.beginPath(); cx.arc(ax, ay, r + 6, 0, Math.PI * 2);
        cx.fillStyle = isSel ? "rgba(255, 255, 255, 0.15)" : "rgba(255, 255, 255, 0.08)";
        cx.fill();
      }
      cx.beginPath(); cx.arc(ax, ay, r, 0, Math.PI * 2);
      cx.fillStyle = v == null ? "#445" : colorFor(v);
      cx.fill();
      cx.lineWidth = isSel ? 3 : 2;
      cx.strokeStyle = isSel ? "#fff" : "#0a1320";
      cx.stroke();
      cx.fillStyle = "#0a1320";
      cx.font = "bold 11px system-ui, sans-serif";
      cx.textAlign = "center"; cx.textBaseline = "middle";
      cx.fillText(String(p.point_nbr), ax, ay);
      if (v == null) {
        cx.beginPath();
        cx.moveTo(ax - r/2, ay - r/2); cx.lineTo(ax + r/2, ay + r/2);
        cx.moveTo(ax + r/2, ay - r/2); cx.lineTo(ax - r/2, ay + r/2);
        cx.strokeStyle = "rgba(255, 78, 110, 0.7)"; cx.lineWidth = 1.5; cx.stroke();
      }
    }

    cx.fillStyle = "rgba(78, 197, 255, 0.6)";
    cx.fillRect(...px(CORNER_R + 2, RINK_H), 14 * scale, -4);
    cx.fillStyle = "#aee7ff";
    cx.font = "9px system-ui"; cx.textAlign = "left";
    cx.fillText("ZAM", ...px(CORNER_R + 4, RINK_H - 2));

    drawLegend();
  }

  function drawLegend() {
    const legend = $("#legend");
    let label = "Depth (in)", lo = "0.5", hi = "6.0",
        grad = "#dc0028, #ff5a14, #ffc800, #b4e600, #1ec83c, #009664";
    if (state.mode === "temp")     { label = "Temp (°F)";     lo = "15"; hi = "35";
                                     grad = "#003cdc, #00b4f0, #78dc3c, #ffc800, #ff3c14"; }
    if (state.mode === "concrete") { label = "Headroom (in)"; lo = "0";  hi = "3+";
                                     grad = "#ff2828, #ff8c3c, #ffdc64, #50dca0"; }
    if (state.mode === "delta")    { label = "Δ Depth (in)";  lo = "-1.5"; hi = "+1.5";
                                     grad = "#ff5050, #b4b4b4, #50a0ff"; }
    if (state.mode === "plan")     { label = `Post-cut depth (-${state.cutDepth.toFixed(2)}")`;
                                     lo = "0"; hi = "6";
                                     grad = "#dc0028, #ff5a14, #ffc800, #b4e600, #1ec83c, #009664"; }
    if (state.mode === "anomaly")  { label = "Anomaly z-score"; lo = "-3σ"; hi = "+3σ";
                                     grad = "#dc0028, #b4b4b4, #00a0ff"; }
    legend.innerHTML = `
      <div>${label}</div>
      <div class="hm-scale" style="background: linear-gradient(90deg, ${grad});"></div>
      <div class="hm-scale-labels"><span>${lo}</span><span>${hi}</span></div>
    `;
  }

  // ───── interaction ──────────────────────────────────────────────────
  function isMobile() { return window.matchMedia("(max-width: 640px)").matches; }
  function pointAtCanvasXY(cssx, cssy) {
    const cssW = canvas.clientWidth;
    const scale = cssW / RINK_W;
    const hitR = isMobile() ? 26 : 18;
    for (const p of state.points) {
      const { x, y } = ptCoords(p);
      const px_ = x * scale, py_ = y * scale;
      const dx = cssx - px_, dy = cssy - py_;
      if (dx*dx + dy*dy <= hitR*hitR) return p;
    }
    return null;
  }
  // Body scroll lock for the mobile bottom-sheet — iOS-safe (position:fixed pattern
   // restores scroll position on release; document.body.style.overflow:hidden alone
   // doesn't stop touch scroll on iOS Safari).
  let savedScrollY = 0;
  function lockBodyScroll() {
    if (document.body.dataset.scrollLocked === "1") return;
    savedScrollY = window.scrollY;
    document.body.style.position = "fixed";
    document.body.style.top = `-${savedScrollY}px`;
    document.body.style.left = "0";
    document.body.style.right = "0";
    document.body.style.width = "100%";
    document.body.dataset.scrollLocked = "1";
  }
  function unlockBodyScroll() {
    if (document.body.dataset.scrollLocked !== "1") return;
    document.body.style.position = "";
    document.body.style.top = "";
    document.body.style.left = "";
    document.body.style.right = "";
    document.body.style.width = "";
    delete document.body.dataset.scrollLocked;
    window.scrollTo(0, savedScrollY);
  }

  function setSheetExpanded(expanded) {
    const sheet = $(".hm-side-pane");
    const backdrop = $("#sheet-backdrop");
    if (!sheet) return;
    sheet.classList.toggle("expanded", expanded);
    if (backdrop) backdrop.classList.toggle("active", expanded);
    if (isMobile()) {
      if (expanded) lockBodyScroll();
      else unlockBodyScroll();
    }
    updatePeekLabel();
  }
  function updatePeekLabel() {
    const peekLabel = $("#sheet-peek-label");
    if (!peekLabel) return;
    const sheet = $(".hm-side-pane");
    const expanded = sheet?.classList.contains("expanded");
    if (state.selectedPoint != null) {
      peekLabel.textContent = expanded ? `point ${state.selectedPoint} ▾` : `point ${state.selectedPoint} ▴`;
    } else if (state.mode === "plan") {
      peekLabel.textContent = expanded ? `Plan view ▾` : `Plan: ${state.cutDepth.toFixed(2)}" cut ▴`;
    } else if (state.mode === "anomaly") {
      const flagged = state.anomalies.filter(a => Math.abs(a.z) >= 2).length;
      peekLabel.textContent = expanded ? `Anomalies ▾` : `${flagged} anomalies ▴`;
    } else {
      peekLabel.textContent = expanded ? `tap a point ▾` : `tap a point on the rink ▴`;
    }
  }

  // ───── side panel ───────────────────────────────────────────────────
  async function showPointDetails(pt) {
    const side = $("#sheet-content");
    side.innerHTML = `<div class="hm-empty-tap">loading point ${pt}…</div>`;
    const r = await fetch(`/api/timeseries/${pt}?rink=${state.rinkCode}`).then(x => x.json());
    const concrete = state.concrete.find(c => c.point_nbr === pt);
    const point = state.pointMap.get(pt);
    const cur = state.current.find(m => m.point_nbr === pt);

    const recent = r.slice().reverse();
    const dPts = r.filter(x => x.depth_in != null);
    const minD = dPts.length ? Math.min(...dPts.map(x => x.depth_in)) : null;
    const maxD = dPts.length ? Math.max(...dPts.map(x => x.depth_in)) : null;
    const meanD = dPts.length ? dPts.reduce((s, x) => s + x.depth_in, 0) / dPts.length : null;

    const headroom = (cur?.depth_in != null && concrete) ? (cur.depth_in - concrete.min_depth) : null;
    const flag = headroom != null && headroom < 0.5;

    const w = state.weather;
    const wBlock = w ? `
      <h3>Outdoor weather (${state.date})</h3>
      <div class="hm-kv">
        <span class="k">Air temp</span><span class="v">${w.temp_low_f?.toFixed(0)}–${w.temp_high_f?.toFixed(0)}°F (mean ${w.temp_mean_f?.toFixed(1)}°F)</span>
        <span class="k">Conditions</span><span class="v">${WMO[w.weather_code] ?? "—"}</span>
        <span class="k">Cloud cover</span><span class="v">${w.cloud_cover_pct?.toFixed(0) ?? "—"}%</span>
        <span class="k">Precip / Snow</span><span class="v">${w.precip_in?.toFixed(2) ?? "0"}" / ${w.snow_in?.toFixed(2) ?? "0"}"</span>
        <span class="k">Wind max</span><span class="v">${w.wind_mph_max?.toFixed(0) ?? "—"} mph</span>
        <span class="k">Δ outside-vs-ice</span><span class="v">${(w.temp_mean_f != null && cur?.temp_f != null) ? `${(w.temp_mean_f - cur.temp_f).toFixed(1)}°F load` : "—"}</span>
      </div>` : "";

    side.innerHTML = `
      <h2>Point ${pt} <span style="color:var(--muted); font-weight:400;">grid (col ${point?.grid_col}, row ${point?.grid_row})</span></h2>
      <div class="hm-kv">
        <span class="k">Current depth</span>
        <span class="v ${flag ? 'flag' : ''}">${fmtDepth(cur?.depth_in)}${flag ? ' ⚠ low headroom' : ''}</span>
        <span class="k">Current temp</span>
        <span class="v">${fmtTemp(cur?.temp_f)}</span>
        <span class="k">Headroom*</span>
        <span class="v">${headroom == null ? "—" : fmtDepth(headroom)}</span>
      </div>
      ${wBlock}
      <h3>All-time stats</h3>
      <div class="hm-kv">
        <span class="k">Mean depth</span><span class="v">${fmtDepth(meanD)}</span>
        <span class="k">Min depth</span><span class="v">${fmtDepth(minD)} <span class="warn">(${concrete?.min_date ?? "?"})</span></span>
        <span class="k">Max depth</span><span class="v">${fmtDepth(maxD)}</span>
        <span class="k">Samples</span><span class="v">${dPts.length}</span>
      </div>
      <h3>Sparkline</h3>
      <canvas class="hm-spark" id="spark"></canvas>
      <h3>Recent readings</h3>
      <div class="hm-history">
        ${recent.slice(0, 60).map(x => `
          <div class="row">
            <span class="d">${x.measure_date}</span>
            <span>${fmtDepth(x.depth_in)}</span>
            <span style="color:var(--muted)">${fmtTemp(x.temp_f)}</span>
          </div>`).join("")}
      </div>
      <p style="font-size:11px; color:var(--muted); margin-top:8px;">
        *Headroom = current depth − all-time-thinnest (estimated concrete-strike floor).
      </p>
    `;
    drawSpark(r);
    updatePeekLabel();
  }

  function drawSpark(rows) {
    const c = $("#spark");
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    c.width = w * dpr; c.height = h * dpr;
    const sx = c.getContext("2d");
    sx.setTransform(dpr, 0, 0, dpr, 0, 0);
    sx.clearRect(0, 0, w, h);
    const ds = rows.filter(r => r.depth_in != null);
    if (ds.length < 2) return;
    const minD = Math.min(...ds.map(r => r.depth_in));
    const maxD = Math.max(...ds.map(r => r.depth_in));
    const range = maxD - minD || 1;
    const t0 = new Date(ds[0].measure_date).getTime();
    const t1 = new Date(ds[ds.length - 1].measure_date).getTime();
    sx.strokeStyle = "rgba(255, 78, 110, 0.4)";
    sx.lineWidth = 1; sx.setLineDash([3, 3]);
    sx.beginPath(); sx.moveTo(0, h - 4); sx.lineTo(w, h - 4); sx.stroke();
    sx.setLineDash([]);
    sx.strokeStyle = "#4ec5ff"; sx.lineWidth = 1.5;
    sx.beginPath();
    ds.forEach((r, i) => {
      const t = new Date(r.measure_date).getTime();
      const x = ((t - t0) / (t1 - t0 || 1)) * w;
      const y = h - 4 - ((r.depth_in - minD) / range) * (h - 8);
      i === 0 ? sx.moveTo(x, y) : sx.lineTo(x, y);
    });
    sx.stroke();
  }

  // ───── data loaders ─────────────────────────────────────────────────
  async function loadDate() {
    const [meas, w] = await Promise.all([
      fetch(`/api/measurements?date=${state.date}&rink=${state.rinkCode}`).then(r => r.json()),
      fetch(`/api/weather/${state.date}`).then(r => r.json()),
    ]);
    state.current = meas;
    state.weather = w;
    updateStatus();
  }
  async function loadCompare() {
    state.compare = await fetch(`/api/measurements?date=${state.compareDate}&rink=${state.rinkCode}`).then(r => r.json());
  }
  async function loadAnomalies() {
    state.anomalies = await fetch(`/api/anomalies?date=${state.date}&window=30&rink=${state.rinkCode}`).then(r => r.json());
  }

  function updateSidePanelForMode() {
    if (state.selectedPoint != null) return;
    const side = $("#sheet-content");
    if (state.mode === "plan") {
      const cut = state.cutDepth, buf = state.safetyBuffer;
      const rows = state.points.map(p => {
        const m = state.current.find(x => x.point_nbr === p.point_nbr);
        const c = state.concrete.find(x => x.point_nbr === p.point_nbr);
        if (!m || m.depth_in == null || !c) return null;
        const post = m.depth_in - cut;
        const headroom = post - c.min_depth;
        return { pt: p.point_nbr, cur: m.depth_in, post, minD: c.min_depth, headroom };
      }).filter(Boolean);
      const risky = rows.filter(r => r.headroom < buf).sort((a,b) => a.headroom - b.headroom);
      const safeMaxCut = rows.length ? Math.min(...rows.map(r => Math.max(0, r.cur - r.minD - buf))) : 0;
      const flood = [...rows].sort((a,b) => a.cur - b.cur).slice(0, 8);
      side.innerHTML = `
        <h2>Plan — Cut ${cut.toFixed(2)}"</h2>
        <div class="hm-kv">
          <span class="k">Max safe cut*</span>
          <span class="v ${safeMaxCut < cut ? 'flag' : ''}">${safeMaxCut.toFixed(2)}"</span>
          <span class="k">Cells at risk</span>
          <span class="v ${risky.length ? 'flag' : ''}">${risky.length} of ${rows.length}</span>
        </div>
        <h3>Risk zones (post-cut headroom &lt; ${buf}")</h3>
        ${risky.length === 0
          ? `<div style="color:var(--good); font-size:13px;">✓ no concrete-strike risk at this cut depth</div>`
          : `<div class="hm-history">${risky.slice(0, 12).map(r => `
              <div class="row">
                <span class="d">pt ${r.pt}</span>
                <span>cur ${r.cur.toFixed(2)}"</span>
                <span class="${r.headroom < 0.2 ? 'flag' : 'warn'}">post ${r.post.toFixed(2)}" / hr ${r.headroom.toFixed(2)}"</span>
              </div>`).join("")}</div>`}
        <h3>Flood priority (thinnest now)</h3>
        <div class="hm-history">${flood.map(r => `
          <div class="row">
            <span class="d">pt ${r.pt}</span>
            <span>${r.cur.toFixed(2)}"</span>
            <span style="color:var(--muted)">target +${(3 - r.cur).toFixed(2)}"</span>
          </div>`).join("")}</div>
        <p style="font-size:11px; color:var(--muted); margin-top:8px;">
          *Max safe cut = min(current_depth − all-time-min − ${buf}" buffer) across all measured points.
        </p>
      `;
    } else if (state.mode === "anomaly") {
      const a = state.anomalies.filter(x => x.current != null && Math.abs(x.z) >= 1.5)
                               .sort((p, q) => Math.abs(q.z) - Math.abs(p.z));
      const flagged = state.anomalies.filter(x => Math.abs(x.z) >= 2);
      side.innerHTML = `
        <h2>Anomaly Detector</h2>
        <div class="hm-kv">
          <span class="k">Date</span><span class="v">${state.date}</span>
          <span class="k">Window</span><span class="v">trailing 30 days</span>
          <span class="k">Flagged (|z|≥2)</span><span class="v ${flagged.length ? 'flag' : ''}">${flagged.length}</span>
        </div>
        <h3>Outliers (|z| ≥ 1.5)</h3>
        ${a.length === 0
          ? `<div style="color:var(--good); font-size:13px;">✓ no anomalies — all cells within 1.5σ of trailing baseline</div>`
          : `<div class="hm-history">${a.slice(0, 20).map(r => {
              const arrow = r.z < 0 ? '↓' : '↑';
              const klass = Math.abs(r.z) >= 2 ? 'flag' : 'warn';
              return `<div class="row">
                <span class="d">pt ${r.point_nbr}</span>
                <span>${r.current.toFixed(2)}"</span>
                <span class="${klass}">${arrow} ${r.z.toFixed(2)}σ vs ${r.mean.toFixed(2)}"</span>
              </div>`;
            }).join("")}</div>`}
      `;
    } else if (state.selectedPoint == null) {
      side.innerHTML = `<div class="hm-empty-tap">tap any point on the rink for its history</div>`;
    }
    updatePeekLabel();
  }

  function updateStatus() {
    const got = state.current.filter(m => m.depth_in != null).length;
    const got_ = Math.max(1, got);
    const avg = state.current.filter(m => m.depth_in != null).reduce((s, m) => s + m.depth_in, 0) / got_;
    const minR = state.current.reduce((acc, m) => (m.depth_in != null && (!acc || m.depth_in < acc.depth_in) ? m : acc), null);
    const minDepth = minR?.depth_in;
    const minClass = minDepth != null && minDepth < 1.0 ? "danger" : minDepth != null && minDepth < 1.5 ? "warn" : "";
    const w = state.weather;
    const chips = [
      chipHTML("date",     state.date),
      chipHTML("points",   `${got}/35`),
      chipHTML("avg",      `${avg.toFixed(2)}"`),
      chipHTML("thinnest", `pt ${minR?.point_nbr ?? "?"} · ${fmtDepth(minDepth)}`, minClass),
    ];
    if (w) {
      chips.push(chipHTML("outside", `${w.temp_low_f?.toFixed(0)}–${w.temp_high_f?.toFixed(0)}°F`));
      if (w.weather_code != null) chips.push(chipHTML("sky", WMO[w.weather_code] ?? "?"));
    }
    $("#status").innerHTML = chips.join("");
  }
  function chipHTML(key, val, valClass = "") {
    return `<span class="hm-chip"><span class="k">${key}</span><span class="v${valClass ? ' ' + valClass : ''}">${val}</span></span>`;
  }

  // ───── entry mode (canvas press-on-spot point-by-point) ────────────────
  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  }

  // Serpentine = walk physically left-to-right, alternating column direction so
  // we don't teleport from top-of-col-N back to bottom-of-col-N+1.
  // Numbering: col K's points are listed top→bottom as (K*5)…(K*5-4); so col 1 =
  // pts 5,4,3,2,1. Even cols (1-indexed) walk bottom→top, odd cols top→bottom —
  // mirrors the operator's actual walk down/up the rink.
  function serpentineOrder() {
    const order = [];
    for (let col = 0; col < 7; col++) {
      const top = (col + 1) * 5;     // pt at Y_LINE[0]
      const bot = top - 4;           // pt at Y_LINE[4]
      if (col % 2 === 0) {
        for (let p = bot; p <= top; p++) order.push(p); // bottom-to-top
      } else {
        for (let p = top; p >= bot; p--) order.push(p); // top-to-bottom
      }
    }
    return order;
  }
  function numericOrder() { return Array.from({ length: 35 }, (_, i) => i + 1); }

  // Local-storage draft persistence — keyed by rink+date.
  const draftKey = (rink, date) => `rt:draft:${rink}:${date}`;
  function readDraft(rink, date) {
    try { return JSON.parse(localStorage.getItem(draftKey(rink, date)) || "null"); }
    catch { return null; }
  }
  function writeDraft(rink, date, payload) {
    try { localStorage.setItem(draftKey(rink, date), JSON.stringify(payload)); }
    catch { /* quota / private mode — non-fatal */ }
  }
  function clearDraft(rink, date) {
    try { localStorage.removeItem(draftKey(rink, date)); } catch {}
  }
  function listDrafts(rink) {
    const out = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith(`rt:draft:${rink}:`)) continue;
        const date = k.split(":").pop();
        const v = readDraft(rink, date);
        if (v) out.push({ date, ...v });
      }
    } catch {}
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }

  // Entry-mode state — separate from the read-mode `state` so they can coexist.
  // entries: Map<point_nbr, {depth_in?, temp_f?, skipped?}>
  // baseline: Map<point_nbr, {mean, std, n, last, last_date}>
  const entry = {
    active: false,
    mode: "new",      // "new" | "edit"
    date: null,
    order: "serpentine",
    orderList: [],
    idx: 0,
    entries: new Map(),
    baseline: new Map(),
    initialEntries: new Map(),  // for "edit" mode, snapshot of existing readings
    rinkCode: "U",
  };
  const entryCanvas = $("#entry-rink");
  const entryCx = entryCanvas?.getContext("2d");
  let entryCachedSize = { cssW: 0, cssH: 0 };
  let entryResizeRO = null;

  function entryHasData(pt) {
    const e = entry.entries.get(pt);
    if (!e) return false;
    if (e.skipped) return true;
    return e.depth_in != null || e.temp_f != null;
  }
  function entryEffectiveCount() {
    let n = 0;
    for (const e of entry.entries.values()) if (!e.skipped && (e.depth_in != null || e.temp_f != null)) n++;
    return n;
  }

  function flagFor(pt, depthVal) {
    if (depthVal == null || !Number.isFinite(depthVal)) return null;
    const b = entry.baseline.get(pt);
    if (!b || b.n < 3 || b.std === 0) return null;
    const z = (depthVal - b.mean) / b.std;
    if (Math.abs(z) >= 3) return { level: "danger", z, mean: b.mean, last: b.last, last_date: b.last_date };
    if (Math.abs(z) >= 2) return { level: "warn", z, mean: b.mean, last: b.last, last_date: b.last_date };
    return null;
  }

  function applyEntryCanvasSize() {
    if (!entryCanvas) return;
    const wrap = entryCanvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    const aspect = RINK_W / RINK_H;
    const padding = 14;
    const wAvail = Math.max(0, wrap.clientWidth - padding * 2);
    const hAvail = Math.max(0, wrap.clientHeight - padding * 2);
    let cssW, cssH;
    if (wAvail / hAvail > aspect) { cssH = hAvail; cssW = cssH * aspect; }
    else { cssW = wAvail; cssH = cssW / aspect; }
    cssW = Math.floor(cssW); cssH = Math.floor(cssH);
    if (cssW === entryCachedSize.cssW && cssH === entryCachedSize.cssH) return;
    entryCachedSize = { cssW, cssH };
    entryCanvas.style.width = cssW + "px";
    entryCanvas.style.height = cssH + "px";
    entryCanvas.width = Math.round(cssW * dpr);
    entryCanvas.height = Math.round(cssH * dpr);
    entryCx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function renderEntryCanvas() {
    if (!entryCx) return;
    if (entryCachedSize.cssW === 0) applyEntryCanvasSize();
    const { cssW, cssH } = entryCachedSize;
    if (!cssW) return;
    const scale = cssW / RINK_W;
    entryCx.clearRect(0, 0, cssW, cssH);

    const outline = rinkOutlinePath(scale);
    entryCx.save();
    entryCx.fillStyle = "#0a1320";
    entryCx.fill(outline);
    entryCx.restore();

    entryCx.lineWidth = 2;
    entryCx.strokeStyle = "#3a4a60";
    entryCx.stroke(outline);

    const px = ftToPx(scale);
    // Full rink markings — same anchors as read mode so operator recognizes
    // landmarks (faceoff circles, goal creases, gridline ticks) while logging.
    // Tinted slightly cooler/dimmer than read mode so the entry-state point
    // dots remain dominant.
    const RED  = "rgba(220, 60, 60, 0.7)";
    const BLUE = "rgba(78, 130, 220, 0.7)";

    // Blue lines + red center line (full-height strips)
    entryCx.fillStyle = BLUE;
    entryCx.fillRect(...px(MARK.blueLineLeft - 0.5, 0),  scale * 1, RINK_H * scale);
    entryCx.fillRect(...px(MARK.blueLineRight - 0.5, 0), scale * 1, RINK_H * scale);
    entryCx.fillStyle = RED;
    entryCx.fillRect(...px(MARK.centerLine - 0.5, 0), scale * 1, RINK_H * scale);

    // Goal lines (red, vertical, inset from corners)
    entryCx.strokeStyle = RED; entryCx.lineWidth = 1.2;
    entryCx.beginPath();
    entryCx.moveTo(...px(MARK.goalLineLeft,  MARK.goalLineMargin));
    entryCx.lineTo(...px(MARK.goalLineLeft,  RINK_H - MARK.goalLineMargin));
    entryCx.moveTo(...px(MARK.goalLineRight, MARK.goalLineMargin));
    entryCx.lineTo(...px(MARK.goalLineRight, RINK_H - MARK.goalLineMargin));
    entryCx.stroke();

    // Center circle + dot
    entryCx.strokeStyle = BLUE; entryCx.lineWidth = 1.5;
    entryCx.beginPath();
    entryCx.arc(...px(MARK.centerLine, MARK.centerY), MARK.centerCircleR * scale, 0, Math.PI * 2);
    entryCx.stroke();
    entryCx.fillStyle = BLUE;
    entryCx.beginPath();
    entryCx.arc(...px(MARK.centerLine, MARK.centerY), 1 * scale, 0, Math.PI * 2);
    entryCx.fill();

    // Faceoff circles + dots + cross-hash marks
    for (const [x, y] of [
      [MARK.faceoffDotXL, MARK.faceoffYTop], [MARK.faceoffDotXL, MARK.faceoffYBot],
      [MARK.faceoffDotXR, MARK.faceoffYTop], [MARK.faceoffDotXR, MARK.faceoffYBot],
    ]) {
      entryCx.strokeStyle = RED; entryCx.lineWidth = 1.5;
      entryCx.beginPath(); entryCx.arc(...px(x, y), MARK.faceoffR * scale, 0, Math.PI * 2); entryCx.stroke();
      entryCx.fillStyle = RED;
      entryCx.beginPath(); entryCx.arc(...px(x, y), 1 * scale, 0, Math.PI * 2); entryCx.fill();
      entryCx.lineWidth = 1.2;
      const r = MARK.faceoffR;
      entryCx.beginPath();
      entryCx.moveTo(...px(x - r - 1, y)); entryCx.lineTo(...px(x - r + 1, y));
      entryCx.moveTo(...px(x + r - 1, y)); entryCx.lineTo(...px(x + r + 1, y));
      entryCx.moveTo(...px(x, y - r - 1)); entryCx.lineTo(...px(x, y - r + 1));
      entryCx.moveTo(...px(x, y + r - 1)); entryCx.lineTo(...px(x, y + r + 1));
      entryCx.stroke();
    }

    // Goal creases (semi-circle into rink, light blue fill)
    entryCx.fillStyle = "rgba(110, 180, 255, 0.18)";
    entryCx.strokeStyle = BLUE; entryCx.lineWidth = 1.2;
    for (const [gx, intoRink] of [[MARK.goalLineLeft, +1], [MARK.goalLineRight, -1]]) {
      entryCx.beginPath();
      if (intoRink > 0) entryCx.arc(...px(gx, MARK.centerY), MARK.goalCreaseR * scale, -Math.PI/2, Math.PI/2, false);
      else              entryCx.arc(...px(gx, MARK.centerY), MARK.goalCreaseR * scale, -Math.PI/2, Math.PI/2, true);
      entryCx.closePath(); entryCx.fill(); entryCx.stroke();
    }

    // Gridline tick marks at every measurement-point intersection — gives the
    // visual scaffold the operator uses to find anchors when 35 dots aren't enough.
    entryCx.strokeStyle = "rgba(255, 255, 255, 0.28)"; entryCx.lineWidth = 1;
    const tickHalf = 3.5;
    for (const tx of [MARK.goalLineLeft, MARK.blueLineLeft, MARK.centerLine, MARK.blueLineRight, MARK.goalLineRight]) {
      for (const ty of Y_LINE) {
        entryCx.beginPath();
        entryCx.moveTo(...px(tx - tickHalf, ty)); entryCx.lineTo(...px(tx + tickHalf, ty));
        entryCx.stroke();
      }
    }

    // ZAM door — short bar on the bottom wall just past the lower-left corner curve
    entryCx.fillStyle = "rgba(78, 197, 255, 0.55)";
    entryCx.fillRect(...px(CORNER_R + 2, RINK_H), 14 * scale, -4);
    entryCx.fillStyle = "rgba(174, 231, 255, 0.7)";
    entryCx.font = "9px system-ui"; entryCx.textAlign = "left";
    entryCx.fillText("ZAM", ...px(CORNER_R + 4, RINK_H - 2));

    const currentPt = entry.orderList[entry.idx];
    for (const p of state.points) {
      const xy = POINT_XY.get(p.point_nbr);
      if (!xy) continue;
      const [ax, ay] = px(xy.x, xy.y);
      const e = entry.entries.get(p.point_nbr);
      const isCurrent = p.point_nbr === currentPt;
      const hasData = e && !e.skipped && (e.depth_in != null || e.temp_f != null);
      const isSkipped = e?.skipped;

      // Background ring for state
      let fill = "#445", stroke = "#0a1320", textColor = "#0a1320";
      if (hasData) {
        const flag = flagFor(p.point_nbr, e.depth_in);
        if (flag?.level === "danger")    { fill = "rgba(255, 78, 110, 0.85)"; stroke = "#ff4e6e"; }
        else if (flag?.level === "warn") { fill = "rgba(255, 200, 60, 0.85)"; stroke = "#ffc83c"; }
        else                             { fill = "rgba(80, 220, 160, 0.9)";  stroke = "#50dca0"; textColor = "#001d11"; }
      } else if (isSkipped) {
        fill = "rgba(140, 140, 140, 0.3)"; stroke = "#5a6478"; textColor = "#aaa";
      }

      const r = isCurrent ? 13 : 10;
      if (isCurrent) {
        // Pulse ring
        const t = (Date.now() % 1200) / 1200;
        const pulseR = r + 6 + Math.sin(t * Math.PI * 2) * 4;
        entryCx.beginPath();
        entryCx.arc(ax, ay, pulseR, 0, Math.PI * 2);
        entryCx.strokeStyle = "rgba(78, 197, 255, 0.7)";
        entryCx.lineWidth = 2;
        entryCx.stroke();
      }
      entryCx.beginPath();
      entryCx.arc(ax, ay, r, 0, Math.PI * 2);
      entryCx.fillStyle = fill;
      entryCx.fill();
      entryCx.lineWidth = isCurrent ? 3 : 2;
      entryCx.strokeStyle = isCurrent ? "#fff" : stroke;
      entryCx.stroke();
      entryCx.fillStyle = textColor;
      entryCx.font = "bold 12px system-ui, sans-serif";
      entryCx.textAlign = "center"; entryCx.textBaseline = "middle";
      entryCx.fillText(String(p.point_nbr), ax, ay);

      if (isSkipped) {
        entryCx.strokeStyle = "rgba(200, 200, 200, 0.6)"; entryCx.lineWidth = 1.5;
        entryCx.beginPath();
        entryCx.moveTo(ax - r/2, ay - r/2); entryCx.lineTo(ax + r/2, ay + r/2);
        entryCx.moveTo(ax + r/2, ay - r/2); entryCx.lineTo(ax - r/2, ay + r/2);
        entryCx.stroke();
      }
    }
  }

  let entryAnimRAF = 0;
  function startEntryAnim() {
    cancelAnimationFrame(entryAnimRAF);
    const tick = () => {
      if (!entry.active) return;
      renderEntryCanvas();
      entryAnimRAF = requestAnimationFrame(tick);
    };
    entryAnimRAF = requestAnimationFrame(tick);
  }
  function stopEntryAnim() { cancelAnimationFrame(entryAnimRAF); }

  function entryPointAtCanvasXY(cssx, cssy) {
    const scale = entryCachedSize.cssW / RINK_W;
    const hitR = isMobile() ? 28 : 20;
    for (const p of state.points) {
      const xy = POINT_XY.get(p.point_nbr);
      if (!xy) continue;
      const px_ = xy.x * scale, py_ = xy.y * scale;
      const dx = cssx - px_, dy = cssy - py_;
      if (dx*dx + dy*dy <= hitR*hitR) return p;
    }
    return null;
  }

  function renderEntrySheet() {
    const pt = entry.orderList[entry.idx];
    if (pt == null) return;
    $("#entry-pt-num").textContent = String(pt);
    const point = state.pointMap.get(pt);
    $("#entry-pt-label").textContent = point ? `col ${point.grid_col}, row ${point.grid_row}` : `point ${pt}`;
    $("#entry-prev").disabled = entry.idx === 0;
    $("#entry-next").disabled = entry.idx === entry.orderList.length - 1;

    const rec = entry.entries.get(pt) ?? {};
    const dInp = $("#entry-depth"), tInp = $("#entry-temp");
    dInp.value = rec.depth_in != null ? String(rec.depth_in) : "";
    tInp.value = rec.temp_f   != null ? String(rec.temp_f)   : "";
    dInp.classList.remove("warn", "danger");
    tInp.classList.remove("warn", "danger");
    $("#entry-fields").hidden = false;

    // Hint: last reading + delta
    const b = entry.baseline.get(pt);
    const dHint = $("#entry-depth-hint"), tHint = $("#entry-temp-hint");
    if (b?.last != null) {
      let extra = "";
      if (rec.depth_in != null && Number.isFinite(rec.depth_in)) {
        const delta = rec.depth_in - b.last;
        const sign = delta >= 0 ? "+" : "";
        const cls = Math.abs(delta) >= 0.5 ? "flag" : delta >= 0 ? "up" : "down";
        extra = ` <span class="delta ${cls}">${sign}${delta.toFixed(2)}"</span>`;
      }
      dHint.innerHTML = `last: ${b.last.toFixed(2)}" (${b.last_date})${extra}`;
    } else {
      dHint.textContent = "no prior readings";
    }
    tHint.textContent = ""; // temps are too noisy for a useful prior

    // Flag
    const flagBox = $("#entry-flag");
    const flag = flagFor(pt, rec.depth_in);
    if (flag) {
      flagBox.hidden = false;
      flagBox.className = `hm-entry-flag${flag.level === "danger" ? " danger" : ""}`;
      const arrow = flag.z < 0 ? "↓" : "↑";
      flagBox.innerHTML = `<strong>${arrow} ${Math.abs(flag.z).toFixed(1)}σ off baseline</strong> — trailing-30 mean ${flag.mean.toFixed(2)}", last ${flag.last?.toFixed(2) ?? "—"}". Double-check the reading.`;
    } else {
      flagBox.hidden = true;
    }

    {
      const done = entryEffectiveCount();
      const prog = $("#entry-progress");
      const v = prog.querySelector(".v");
      if (v) v.textContent = `${done}/35`;
      prog.classList.toggle("complete", done === 35);
    }
  }

  function commitCurrent({ silent = false } = {}) {
    const pt = entry.orderList[entry.idx];
    if (pt == null) return true;
    const dInp = $("#entry-depth"), tInp = $("#entry-temp");
    const dv = dInp.value.trim(), tv = tInp.value.trim();
    let depth = null, temp = null;
    dInp.classList.remove("warn", "danger");
    tInp.classList.remove("warn", "danger");
    if (dv) {
      const n = Number(dv);
      if (!Number.isFinite(n) || n < 0 || n > 24) {
        dInp.classList.add("danger");
        if (!silent) $("#entry-flag").innerHTML = `<strong>Invalid depth</strong> — must be 0–24"`, $("#entry-flag").className = "hm-entry-flag danger", $("#entry-flag").hidden = false;
        return false;
      }
      if (n < 1) dInp.classList.add("warn");
      depth = n;
    }
    if (tv) {
      const n = Number(tv);
      if (!Number.isFinite(n) || n < -40 || n > 100) {
        tInp.classList.add("danger");
        if (!silent) $("#entry-flag").innerHTML = `<strong>Invalid temp</strong> — must be -40 to 100°F`, $("#entry-flag").className = "hm-entry-flag danger", $("#entry-flag").hidden = false;
        return false;
      }
      if (n < 10 || n > 40) tInp.classList.add("warn");
      temp = n;
    }
    const prev = entry.entries.get(pt) ?? {};
    if (depth == null && temp == null) {
      // Empty inputs — drop the entry unless explicitly skipped
      if (!prev.skipped) entry.entries.delete(pt);
    } else {
      entry.entries.set(pt, { ...prev, depth_in: depth, temp_f: temp, skipped: false });
    }
    persistDraft();
    return true;
  }

  function persistDraft() {
    if (!entry.active) return;
    const entriesObj = {};
    for (const [k, v] of entry.entries) entriesObj[k] = v;
    writeDraft(entry.rinkCode, entry.date, {
      mode: entry.mode, order: entry.order, idx: entry.idx,
      entries: entriesObj, savedAt: Date.now(),
    });
  }

  function goToPoint(pt) {
    if (!entry.active) return;
    const idx = entry.orderList.indexOf(pt);
    if (idx < 0) return;
    if (!commitCurrent()) return;
    entry.idx = idx;
    renderEntryCanvas();
    renderEntrySheet();
    $("#entry-depth").focus();
  }
  function nextPoint() {
    if (!commitCurrent()) return;
    if (entry.idx < entry.orderList.length - 1) entry.idx++;
    renderEntryCanvas(); renderEntrySheet();
    $("#entry-depth").focus();
  }
  function prevPoint() {
    if (!commitCurrent()) return;
    if (entry.idx > 0) entry.idx--;
    renderEntryCanvas(); renderEntrySheet();
    $("#entry-depth").focus();
  }
  function skipCurrent() {
    const pt = entry.orderList[entry.idx];
    if (pt == null) return;
    const prev = entry.entries.get(pt) ?? {};
    entry.entries.set(pt, { ...prev, depth_in: null, temp_f: null, skipped: true });
    persistDraft();
    if (entry.idx < entry.orderList.length - 1) entry.idx++;
    renderEntryCanvas(); renderEntrySheet();
  }
  function clearCurrent() {
    const pt = entry.orderList[entry.idx];
    if (pt == null) return;
    entry.entries.delete(pt);
    persistDraft();
    renderEntryCanvas(); renderEntrySheet();
  }

  async function startEntryMode({ date, mode, order, restoreEntries, restoreIdx }) {
    entry.active = true;
    entry.mode = mode;
    entry.date = date;
    entry.order = order;
    entry.orderList = order === "serpentine" ? serpentineOrder() : numericOrder();
    entry.idx = restoreIdx ?? 0;
    entry.entries = new Map();
    entry.initialEntries = new Map();
    entry.rinkCode = state.rinkCode;

    // Load baseline (trailing 30 days before this date) — drives anomaly flags
    try {
      const rows = await fetch(`/api/baseline?rink=${state.rinkCode}&before=${date}&window=30`).then(r => r.json());
      entry.baseline = new Map(rows.map(r => [r.point_nbr, r]));
    } catch {
      entry.baseline = new Map();
    }

    // For edit mode: prefill from existing readings
    if (mode === "edit") {
      try {
        const existing = await fetch(`/api/measurements?date=${date}&rink=${state.rinkCode}`).then(r => r.json());
        for (const m of existing) {
          if (m.depth_in != null || m.temp_f != null) {
            entry.entries.set(m.point_nbr, { depth_in: m.depth_in, temp_f: m.temp_f });
            entry.initialEntries.set(m.point_nbr, { depth_in: m.depth_in, temp_f: m.temp_f });
          }
        }
      } catch {}
    }

    // Restore draft (overrides edit prefill if user was mid-session)
    if (restoreEntries) {
      for (const [k, v] of Object.entries(restoreEntries)) entry.entries.set(Number(k), v);
    }

    // Wire UI
    $("#entry-mode").hidden = false;
    $("#entry-mode-date").textContent = date;
    const tag = $("#entry-mode-tag");
    tag.textContent = mode === "edit" ? "editing existing" : "new session";
    tag.className = `hm-entry-mode-tag${mode === "edit" ? " editing" : ""}`;
    document.body.classList.add("entry-mode-on");

    // Lazy-init resize observer for the entry canvas
    if (!entryResizeRO) {
      entryResizeRO = new ResizeObserver(() => { applyEntryCanvasSize(); renderEntryCanvas(); });
      entryResizeRO.observe(entryCanvas.parentElement);
    }
    applyEntryCanvasSize();
    renderEntryCanvas();
    renderEntrySheet();
    startEntryAnim();
    setTimeout(() => $("#entry-depth").focus(), 50);
  }

  function exitEntryMode({ saved = false } = {}) {
    entry.active = false;
    stopEntryAnim();
    $("#entry-mode").hidden = true;
    document.body.classList.remove("entry-mode-on");
    if (saved) clearDraft(entry.rinkCode, entry.date);
  }

  function renderSummary() {
    const body = $("#entry-summary-body");
    const entered = [], skipped = [], untouched = [], flagged = [];
    for (const pt of entry.orderList) {
      const e = entry.entries.get(pt);
      if (!e) { untouched.push(pt); continue; }
      if (e.skipped) { skipped.push(pt); continue; }
      if (e.depth_in == null && e.temp_f == null) { untouched.push(pt); continue; }
      entered.push(pt);
      const flag = flagFor(pt, e.depth_in);
      if (flag) flagged.push({ pt, flag, depth: e.depth_in });
    }
    let depthSum = 0, depthN = 0, depthMin = null, depthMinPt = null;
    for (const pt of entered) {
      const d = entry.entries.get(pt)?.depth_in;
      if (d == null) continue;
      depthSum += d; depthN++;
      if (depthMin == null || d < depthMin) { depthMin = d; depthMinPt = pt; }
    }
    const avgDepth = depthN > 0 ? (depthSum / depthN) : null;

    const stats = [
      `<div class="hm-summary-stat"><span>Entered</span><span class="v">${entered.length}/35</span></div>`,
      skipped.length ? `<div class="hm-summary-stat"><span>Skipped</span><span class="v">${skipped.length} (${skipped.join(", ")})</span></div>` : "",
      untouched.length ? `<div class="hm-summary-stat${untouched.length > 0 ? " warn" : ""}"><span>Untouched</span><span class="v">${untouched.length}${untouched.length <= 8 ? " (" + untouched.join(", ") + ")" : ""}</span></div>` : "",
      avgDepth != null ? `<div class="hm-summary-stat"><span>Avg depth</span><span class="v">${avgDepth.toFixed(2)}"</span></div>` : "",
      depthMin != null ? `<div class="hm-summary-stat"><span>Thinnest</span><span class="v">pt ${depthMinPt} · ${depthMin.toFixed(2)}"</span></div>` : "",
      flagged.length ? `<div class="hm-summary-stat danger"><span>⚠ Anomaly flags</span><span class="v">${flagged.length}</span></div>` : "",
    ].filter(Boolean).join("");

    const flagsList = flagged.length
      ? `<div class="hm-summary-flags">${flagged.map(f => {
          const arrow = f.flag.z < 0 ? "↓" : "↑";
          return `<div class="row${f.flag.level === "danger" ? " danger" : ""}"><span>pt ${f.pt}</span><span>${f.depth.toFixed(2)}" · ${arrow} ${Math.abs(f.flag.z).toFixed(1)}σ vs ${f.flag.mean.toFixed(2)}"</span></div>`;
        }).join("")}</div>`
      : "";

    body.innerHTML = stats + flagsList;
  }

  async function commitSession() {
    const entries = [];
    for (const [pt, e] of entry.entries) {
      if (e.skipped) continue;
      if (e.depth_in == null && e.temp_f == null) continue;
      entries.push({ point_nbr: pt, depth_in: e.depth_in ?? null, temp_f: e.temp_f ?? null });
    }
    if (entries.length === 0) return { ok: false, reason: "nothing to save" };

    const payload = { rink_code: entry.rinkCode, date: entry.date, entries };
    const record = await enqueue({ endpoint: "/api/measurements", method: "POST", body: payload });
    try {
      const r = await apiFetch("/api/measurements", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": record.idempotency_key },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const out = await r.json().catch(() => ({}));
        throw new Error(out.error ?? `http ${r.status}`);
      }
      const out = await r.json();
      await dequeue(record.idempotency_key);
      return { ok: true, written: out.written };
    } catch (err) {
      if ("serviceWorker" in navigator && "SyncManager" in window) {
        try {
          const reg = await navigator.serviceWorker.ready;
          await reg.sync.register("drain-outbox");
        } catch {}
      }
      return { ok: false, queued: true, reason: err.message };
    } finally {
      updateQueuedBadge();
    }
  }

  // ───── start-session dialog ────────────────────────────────────────────
  function openStartDialog(mode) {
    const dlg = $("#start-session-dialog");
    const dateInp = $("#start-session-date");
    const orderSel = $("#start-session-order");
    const status = $("#start-session-status");
    const title = $("#start-session-title");
    title.textContent = mode === "edit" ? "Edit Session" : "New Session";
    dlg.dataset.mode = mode;
    orderSel.value = entry.order || "serpentine";

    if (mode === "edit") {
      // Default to current viewing date — that's what they probably want to edit
      dateInp.value = state.date ?? todayISO();
    } else {
      dateInp.value = todayISO();
    }
    validateStartDate();
    dlg.showModal();
    setTimeout(() => dateInp.focus(), 50);

    function validateStartDate() {
      const d = dateInp.value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
        status.textContent = "pick a valid date";
        status.className = "hm-start-status err";
        $("#start-session-go").disabled = true;
        return;
      }
      const existing = state.dates.find(x => x.measure_date === d);
      if (mode === "new") {
        if (existing) {
          status.textContent = `⚠ ${d} already has ${existing.depth_count} reading${existing.depth_count === 1 ? "" : "s"} — switch to Edit instead, or pick a different date.`;
          status.className = "hm-start-status err";
          $("#start-session-go").disabled = true;
        } else {
          status.textContent = `fresh session — no readings yet for ${d}.`;
          status.className = "hm-start-status ok";
          $("#start-session-go").disabled = false;
        }
      } else {
        if (!existing) {
          status.textContent = `no readings on ${d} yet — start a New Session instead.`;
          status.className = "hm-start-status warn";
          $("#start-session-go").disabled = true;
        } else {
          status.textContent = `editing ${existing.depth_count}/35 existing depths on ${d}.`;
          status.className = "hm-start-status";
          $("#start-session-go").disabled = false;
        }
      }
    }
    dateInp.oninput = validateStartDate;
  }

  async function handleStartSession(e) {
    e.preventDefault();
    const mode = $("#start-session-dialog").dataset.mode || "new";
    const date = $("#start-session-date").value;
    const order = $("#start-session-order").value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    $("#start-session-dialog").close();

    // Check for existing draft on this date
    const draft = readDraft(state.rinkCode, date);
    if (draft && draft.entries && Object.keys(draft.entries).length > 0) {
      const summary = $("#draft-restore-summary");
      const ents = Object.entries(draft.entries);
      const filled = ents.filter(([_, v]) => !v.skipped && (v.depth_in != null || v.temp_f != null)).length;
      const skip = ents.filter(([_, v]) => v.skipped).length;
      const ts = new Date(draft.savedAt).toLocaleString();
      summary.innerHTML = `Found a draft for <strong>${date}</strong> from ${ts} — ${filled} entered${skip ? `, ${skip} skipped` : ""}. Resume it or discard?`;
      $("#draft-restore-dialog").showModal();
      $("#draft-restore-dialog").dataset.date = date;
      $("#draft-restore-dialog").dataset.mode = mode;
      $("#draft-restore-dialog").dataset.order = order;
      return;
    }

    await startEntryMode({ date, mode, order });
  }

  // Toggle order mid-session — preserves the current point so user keeps context
  function toggleEntryOrder() {
    const currentPt = entry.orderList[entry.idx];
    entry.order = entry.order === "serpentine" ? "numeric" : "serpentine";
    entry.orderList = entry.order === "serpentine" ? serpentineOrder() : numericOrder();
    const newIdx = entry.orderList.indexOf(currentPt);
    entry.idx = newIdx >= 0 ? newIdx : 0;
    persistDraft();
    renderEntryCanvas();
    renderEntrySheet();
  }

  // Live anomaly redraw on input — keeps inline flag and canvas color in sync
  function onEntryFieldInput() {
    // Snapshot current input as a tentative value for flag/delta calc
    const pt = entry.orderList[entry.idx];
    if (pt == null) return;
    const dv = $("#entry-depth").value.trim();
    const tv = $("#entry-temp").value.trim();
    const tentative = {};
    if (dv) {
      const n = Number(dv);
      if (Number.isFinite(n) && n >= 0 && n <= 24) tentative.depth_in = n;
    }
    if (tv) {
      const n = Number(tv);
      if (Number.isFinite(n) && n >= -40 && n <= 100) tentative.temp_f = n;
    }
    const prev = entry.entries.get(pt) ?? {};
    if (tentative.depth_in != null || tentative.temp_f != null) {
      entry.entries.set(pt, { ...prev, ...tentative, skipped: false });
    } else if (!prev.skipped) {
      entry.entries.delete(pt);
    }
    persistDraft();
    renderEntryCanvas();

    // Update hint + flag without re-rendering whole sheet (would steal focus)
    const b = entry.baseline.get(pt);
    const dHint = $("#entry-depth-hint");
    if (b?.last != null) {
      let extra = "";
      if (tentative.depth_in != null) {
        const delta = tentative.depth_in - b.last;
        const sign = delta >= 0 ? "+" : "";
        const cls = Math.abs(delta) >= 0.5 ? "flag" : delta >= 0 ? "up" : "down";
        extra = ` <span class="delta ${cls}">${sign}${delta.toFixed(2)}"</span>`;
      }
      dHint.innerHTML = `last: ${b.last.toFixed(2)}" (${b.last_date})${extra}`;
    }
    const flagBox = $("#entry-flag");
    const flag = flagFor(pt, tentative.depth_in);
    if (flag) {
      flagBox.hidden = false;
      flagBox.className = `hm-entry-flag${flag.level === "danger" ? " danger" : ""}`;
      const arrow = flag.z < 0 ? "↓" : "↑";
      flagBox.innerHTML = `<strong>${arrow} ${Math.abs(flag.z).toFixed(1)}σ off baseline</strong> — trailing-30 mean ${flag.mean.toFixed(2)}", last ${flag.last?.toFixed(2) ?? "—"}". Double-check the reading.`;
    } else {
      flagBox.hidden = true;
    }
    {
      const done = entryEffectiveCount();
      const prog = $("#entry-progress");
      const v = prog.querySelector(".v");
      if (v) v.textContent = `${done}/35`;
      prog.classList.toggle("complete", done === 35);
    }
  }

  async function updateQueuedBadge() {
    try {
      const pending = await listPending();
      const badge = $("#queued-badge");
      if (!badge) return;
      if (pending.length > 0) { badge.textContent = `${pending.length} queued`; badge.hidden = false; }
      else badge.hidden = true;
    } catch { /* IDB unavailable */ }
  }
  async function drainAndRefresh() {
    try {
      const r = await drain();
      if (r.sent > 0) { await refreshDates(); await loadDate(); render(); }
      if (r.deadLettered > 0) console.warn(`[outbox] ${r.deadLettered} record(s) dead-lettered`);
    } catch (err) {
      console.warn("[outbox] drain failed:", err);
    } finally { updateQueuedBadge(); }
  }
  async function refreshDates() {
    const [dates, concrete] = await Promise.all([
      fetch(`/api/dates?rink=${state.rinkCode}`).then(r => r.json()),
      fetch(`/api/concrete-profile?rink=${state.rinkCode}`).then(r => r.json()),
    ]);
    state.dates = dates.filter(d => d.depth_count > 0 || d.temp_count > 0);
    state.concrete = concrete;
    for (const sel of [$("#date-picker"), $("#delta-picker")]) {
      if (!sel) continue;
      const cur = sel.value;
      sel.innerHTML = "";
      for (const d of state.dates.slice().reverse()) {
        sel.appendChild(new Option(`${d.measure_date} (${d.depth_count}/35 depths, ${d.temp_count} temps)`, d.measure_date));
      }
      if (state.dates.find(d => d.measure_date === cur)) sel.value = cur;
      else if (sel === $("#date-picker")) sel.value = state.dates[state.dates.length - 1]?.measure_date ?? "";
    }
  }

  // ───── load + wire ──────────────────────────────────────────────────
  function showEmptyState(reason) {
    $("#hm-empty").hidden = false;
    $("#hm-main").hidden = true;
    document.querySelector(".hm-controls")?.classList.add("hm-disabled");
    document.querySelector(".hm-context")?.setAttribute("hidden", "");
  }
  function hideEmptyState() {
    $("#hm-empty").hidden = true;
    $("#hm-main").hidden = false;
    document.querySelector(".hm-controls")?.classList.remove("hm-disabled");
  }

  async function loadForRink(rinkCode) {
    state.rinkCode = rinkCode;
    state.selectedPoint = null;
    state.hoverPoint = null;
    const [points, dates, concrete] = await Promise.all([
      fetch(`/api/points?rink=${rinkCode}`).then(r => r.json()),
      fetch(`/api/dates?rink=${rinkCode}`).then(r => r.json()),
      fetch(`/api/concrete-profile?rink=${rinkCode}`).then(r => r.json()),
    ]);
    state.points = points;
    state.pointMap = new Map(points.map(p => [p.point_nbr, p]));
    state.dates = dates.filter(d => d.depth_count > 0);
    state.concrete = concrete;

    if (points.length === 0 || state.dates.length === 0) {
      showEmptyState();
      return;
    }
    hideEmptyState();

    const datePicker = $("#date-picker");
    const deltaPicker = $("#delta-picker");
    datePicker.innerHTML = "";
    deltaPicker.innerHTML = "";
    for (const d of state.dates.slice().reverse()) {
      const o = new Option(`${d.measure_date} (${d.depth_count}/35 depths, ${d.temp_count} temps)`, d.measure_date);
      datePicker.appendChild(o.cloneNode(true));
      deltaPicker.appendChild(o);
    }
    state.date = state.dates[state.dates.length - 1].measure_date;
    state.compareDate = state.dates[Math.max(0, state.dates.length - 2)].measure_date;
    datePicker.value = state.date;
    deltaPicker.value = state.compareDate;

    await loadDate();
    render();
    updateSidePanelForMode();
  }

  // Event handlers (kept as named refs so destroy() can detach)
  // resizeRO observes the canvas wrap and only triggers on actual size change.
  // This prevents the rink from re-painting (and visibly shimmering) on every
  // mousemove / iOS URL-bar collapse event.
  const resizeRO = new ResizeObserver(() => {
    const { cssW, cssH } = cachedSize;
    const next = computeCanvasSize();
    if (next.cssW !== cssW || next.cssH !== cssH) {
      applyCanvasSize();
      render();
    }
  });
  resizeRO.observe(canvas.parentElement);
  const onOnline = () => drainAndRefresh();
  const onVisibility = () => { if (document.visibilityState === "visible") drainAndRefresh(); };
  const onSWMessage = (e) => { if (e.data?.type === "sw:drain-outbox") drainAndRefresh(); };
  const onRinkChange = (newRink) => { loadForRink(newRink); };

  // Canvas mouse/touch
  canvas.addEventListener("mousemove", e => {
    const rect = canvas.getBoundingClientRect();
    const p = pointAtCanvasXY(e.clientX - rect.left, e.clientY - rect.top);
    if ((p?.point_nbr ?? null) !== state.hoverPoint) {
      state.hoverPoint = p?.point_nbr ?? null;
      render();
    }
  });
  canvas.addEventListener("click", e => {
    const rect = canvas.getBoundingClientRect();
    const p = pointAtCanvasXY(e.clientX - rect.left, e.clientY - rect.top);
    if (p) {
      state.selectedPoint = p.point_nbr;
      showPointDetails(p.point_nbr);
      setSheetExpanded(true);
      render();
    } else if (isMobile()) {
      setSheetExpanded(false);
    }
  });
  $("#sheet-peek").addEventListener("click", () => {
    const sheet = $(".hm-side-pane");
    setSheetExpanded(!sheet.classList.contains("expanded"));
  });
  $("#sheet-backdrop")?.addEventListener("click", () => setSheetExpanded(false));

  // Date pickers
  $("#date-picker").addEventListener("change", async () => {
    state.date = $("#date-picker").value;
    await loadDate();
    if (state.selectedPoint) showPointDetails(state.selectedPoint);
    if (state.mode === "anomaly") await loadAnomalies();
    render();
  });
  $("#delta-picker").addEventListener("change", async () => {
    state.compareDate = $("#delta-picker").value;
    await loadCompare();
    render();
  });

  // Mode buttons
  for (const btn of root.querySelectorAll(".hm-mode")) {
    btn.addEventListener("click", async () => {
      root.querySelectorAll(".hm-mode").forEach(b => b.classList.toggle("active", b === btn));
      state.mode = btn.dataset.mode;
      const showDelta = state.mode === "delta";
      const showPlan  = state.mode === "plan";
      $(".delta-ctl").hidden = !showDelta;
      $(".plan-ctl").hidden  = !showPlan;
      $("#context-row").hidden = !(showDelta || showPlan);
      if (state.mode === "delta")        await loadCompare();
      else if (state.mode === "anomaly") await loadAnomalies();
      render();
      updateSidePanelForMode();
    });
  }
  $("#plan-cut").addEventListener("input", e => {
    state.cutDepth = Number(e.target.value);
    $("#plan-cut-value").textContent = `${state.cutDepth.toFixed(2)}"`;
    render();
    if (state.mode === "plan") updateSidePanelForMode();
  });
  $("#mesh-toggle").addEventListener("click", () => {
    state.showMesh = !state.showMesh;
    $("#mesh-toggle").classList.toggle("active", state.showMesh);
    render();
  });

  // Entry — two paths: New Session (fresh date, blank entries) or Edit (existing date)
  $("#new-session-btn").addEventListener("click", () => openStartDialog("new"));
  $("#edit-session-btn").addEventListener("click", () => openStartDialog("edit"));
  $("#start-session-cancel").addEventListener("click", () => $("#start-session-dialog").close());
  $("#start-session-cancel-2").addEventListener("click", () => $("#start-session-dialog").close());
  $("#start-session-form").addEventListener("submit", handleStartSession);

  // Draft restore
  $("#draft-restore-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const dlg = $("#draft-restore-dialog");
    const date = dlg.dataset.date;
    const mode = dlg.dataset.mode || "new";
    const order = dlg.dataset.order || "serpentine";
    const draft = readDraft(state.rinkCode, date);
    dlg.close();
    if (!draft) return;
    await startEntryMode({
      date, mode: draft.mode || mode, order: draft.order || order,
      restoreEntries: draft.entries, restoreIdx: draft.idx ?? 0,
    });
  });
  $("#draft-discard").addEventListener("click", async () => {
    const dlg = $("#draft-restore-dialog");
    const date = dlg.dataset.date;
    const mode = dlg.dataset.mode || "new";
    const order = dlg.dataset.order || "serpentine";
    clearDraft(state.rinkCode, date);
    dlg.close();
    await startEntryMode({ date, mode, order });
  });

  // Entry-mode interactions
  $("#entry-exit").addEventListener("click", () => {
    commitCurrent({ silent: true });
    persistDraft();
    exitEntryMode();
  });
  $("#entry-prev").addEventListener("click", prevPoint);
  $("#entry-next").addEventListener("click", nextPoint);
  $("#entry-skip").addEventListener("click", skipCurrent);
  $("#entry-clear").addEventListener("click", clearCurrent);
  $("#entry-order-toggle").addEventListener("click", toggleEntryOrder);

  // Live input — fires for both depth and temp
  $("#entry-depth").addEventListener("input", onEntryFieldInput);
  $("#entry-temp").addEventListener("input", onEntryFieldInput);
  // Enter on depth advances to temp; enter on temp advances to next point
  $("#entry-depth").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); $("#entry-temp").focus(); }
  });
  $("#entry-temp").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); nextPoint(); }
  });
  // Arrow keys for desktop power users — only when not focused on inputs
  function onEntryKey(e) {
    if (!entry.active) return;
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === "ArrowRight") { e.preventDefault(); nextPoint(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); prevPoint(); }
    else if (e.key === "Escape") { e.preventDefault(); $("#entry-exit").click(); }
  }
  document.addEventListener("keydown", onEntryKey);

  // Tap a point on the entry canvas to jump cursor to it
  entryCanvas?.addEventListener("click", (e) => {
    const rect = entryCanvas.getBoundingClientRect();
    const p = entryPointAtCanvasXY(e.clientX - rect.left, e.clientY - rect.top);
    if (p) goToPoint(p.point_nbr);
  });

  // Save Session — show summary, then commit
  $("#entry-finish").addEventListener("click", () => {
    if (!commitCurrent()) return;
    if (entryEffectiveCount() === 0) {
      $("#entry-flag").innerHTML = `<strong>Nothing to save</strong> — enter at least one point first.`;
      $("#entry-flag").className = "hm-entry-flag";
      $("#entry-flag").hidden = false;
      return;
    }
    renderSummary();
    $("#entry-summary-dialog").showModal();
  });
  $("#entry-summary-back").addEventListener("click", () => $("#entry-summary-dialog").close());
  $("#entry-summary-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("#entry-summary-confirm");
    btn.disabled = true; btn.textContent = "Saving…";
    const result = await commitSession();
    btn.disabled = false; btn.textContent = "Save Session";
    $("#entry-summary-dialog").close();
    if (result.ok) {
      exitEntryMode({ saved: true });
      await refreshDates();
      // Jump heatmap to the date we just saved
      state.date = entry.date;
      $("#date-picker").value = entry.date;
      await loadDate();
      render();
    } else if (result.queued) {
      // Keep the draft as a safety net until SW drains
      $("#entry-flag").innerHTML = `<strong>Queued offline</strong> — will sync when network returns. Draft kept.`;
      $("#entry-flag").className = "hm-entry-flag";
      $("#entry-flag").hidden = false;
    }
  });

  // Window-level listeners
  window.addEventListener("online", onOnline);
  document.addEventListener("visibilitychange", onVisibility);
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", onSWMessage);
  }
  // Subscribe to rink switch in shell
  shellCtx.onRinkChange.add(onRinkChange);

  // Initial load
  await loadForRink(shellCtx.rinkCode);
  drainAndRefresh();

  // Teardown — called by router when user navigates away
  return () => {
    resizeRO.disconnect();
    if (entryResizeRO) { entryResizeRO.disconnect(); entryResizeRO = null; }
    stopEntryAnim();
    if (entry.active) { commitCurrent({ silent: true }); persistDraft(); exitEntryMode(); }
    document.removeEventListener("keydown", onEntryKey);
    unlockBodyScroll(); // release if user navigates away with sheet open
    window.removeEventListener("online", onOnline);
    document.removeEventListener("visibilitychange", onVisibility);
    if ("serviceWorker" in navigator) {
      try { navigator.serviceWorker.removeEventListener("message", onSWMessage); } catch {}
    }
    shellCtx.onRinkChange.delete(onRinkChange);
  };
}
