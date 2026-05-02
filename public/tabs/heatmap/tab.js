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
  function resizeCanvas() {
    const wrap = canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    const aspect = RINK_W / RINK_H;
    const padding = 24;
    const wAvail = wrap.clientWidth - padding * 2;
    const hAvail = wrap.clientHeight - padding * 2;
    let cssW, cssH;
    if (wAvail / hAvail > aspect) { cssH = hAvail; cssW = cssH * aspect; }
    else { cssW = wAvail; cssH = cssW / aspect; }
    canvas.style.width  = cssW + "px";
    canvas.style.height = cssH + "px";
    canvas.width  = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { cssW, cssH };
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
    const { cssW, cssH } = resizeCanvas();
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
    cx.fillRect(...px(0, 30), 4, (RINK_H - 60) * scale);
    cx.fillStyle = "#aee7ff";
    cx.font = "9px system-ui"; cx.textAlign = "left";
    cx.fillText("ZAM", ...px(2, 28));

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
  function setSheetExpanded(expanded) {
    const sheet = $(".hm-side-pane");
    if (!sheet) return;
    sheet.classList.toggle("expanded", expanded);
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

  // ───── entry form ───────────────────────────────────────────────────
  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  }
  async function openEntry(prefillDate) {
    const dialog = $("#entry-dialog");
    const grid = $("#entry-grid");
    const date = prefillDate ?? todayISO();
    $("#entry-date").value = date;
    $("#entry-status").textContent = "";
    $("#entry-status").className = "hm-entry-status";
    grid.innerHTML = "";
    for (let pt = 1; pt <= 35; pt++) {
      const row = document.createElement("div");
      row.className = "hm-entry-row";
      row.dataset.pt = pt;
      row.innerHTML = `
        <div class="pt">${pt}</div>
        <label>
          <span>Depth (in)</span>
          <input type="text" inputmode="decimal" autocomplete="off"
                 data-pt="${pt}" data-field="depth"
                 placeholder="—" pattern="[0-9]*\\.?[0-9]*">
        </label>
        <label>
          <span>Temp (°F)</span>
          <input type="text" inputmode="decimal" autocomplete="off"
                 data-pt="${pt}" data-field="temp"
                 placeholder="—" pattern="-?[0-9]*\\.?[0-9]*">
        </label>
      `;
      grid.appendChild(row);
    }
    grid.addEventListener("input", onEntryInput);
    await loadEntryFor(date);
    dialog.showModal();
    setTimeout(() => grid.querySelector("input[data-field='depth']")?.focus(), 50);
  }
  function onEntryInput(e) {
    const inp = e.target;
    if (!(inp instanceof HTMLInputElement)) return;
    const v = inp.value.trim();
    inp.classList.remove("warn", "danger");
    const row = inp.closest(".hm-entry-row");
    if (!v) { row?.classList.toggle("has-data", rowHasAnyData(row)); return; }
    const n = Number(v);
    if (!Number.isFinite(n)) { inp.classList.add("danger"); return; }
    const field = inp.dataset.field;
    if (field === "depth") {
      if (n < 0 || n > 24) inp.classList.add("danger");
      else if (n < 1) inp.classList.add("warn");
    } else {
      if (n < -40 || n > 100) inp.classList.add("danger");
      else if (n < 10 || n > 40) inp.classList.add("warn");
    }
    row?.classList.toggle("has-data", true);
  }
  function rowHasAnyData(row) {
    return row && Array.from(row.querySelectorAll("input")).some(i => i.value.trim() !== "");
  }
  async function loadEntryFor(date) {
    $("#entry-subtitle").textContent = `for ${date}`;
    const grid = $("#entry-grid");
    const existing = await fetch(`/api/measurements?date=${date}&rink=${state.rinkCode}`)
      .then(r => r.json()).catch(() => []);
    const map = new Map(existing.map(e => [e.point_nbr, e]));
    let filled = 0;
    for (let pt = 1; pt <= 35; pt++) {
      const m = map.get(pt);
      const row = grid.querySelector(`.hm-entry-row[data-pt="${pt}"]`);
      if (!row) continue;
      const dInp = row.querySelector(`input[data-field="depth"]`);
      const tInp = row.querySelector(`input[data-field="temp"]`);
      dInp.value = m?.depth_in ?? "";
      tInp.value = m?.temp_f ?? "";
      const has = (m?.depth_in != null) || (m?.temp_f != null);
      row.classList.toggle("has-data", has);
      if (has) filled++;
    }
    $("#entry-status").textContent =
      filled > 0 ? `${filled}/35 points already have data on ${date} — editing existing entries.`
                 : `new session — no readings yet for ${date}.`;
    $("#entry-status").className = "hm-entry-status";
  }
  async function fillFromLatest() {
    if (!state.dates.length) return;
    const latest = state.dates[state.dates.length - 1].measure_date;
    const data = await fetch(`/api/measurements?date=${latest}&rink=${state.rinkCode}`).then(r => r.json());
    const map = new Map(data.map(e => [e.point_nbr, e]));
    const grid = $("#entry-grid");
    for (let pt = 1; pt <= 35; pt++) {
      const m = map.get(pt);
      const row = grid.querySelector(`.hm-entry-row[data-pt="${pt}"]`);
      const dInp = row.querySelector(`input[data-field="depth"]`);
      const tInp = row.querySelector(`input[data-field="temp"]`);
      if (m?.depth_in != null) dInp.value = m.depth_in;
      if (m?.temp_f   != null) tInp.value = m.temp_f;
      if (m) row.classList.add("has-data");
    }
    $("#entry-status").textContent = `pre-filled from ${latest} — edit any cell, blank = skip that point.`;
    $("#entry-status").className = "hm-entry-status";
  }
  async function saveEntry(e) {
    e.preventDefault();
    const date = $("#entry-date").value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      $("#entry-status").textContent = "pick a valid date";
      $("#entry-status").className = "hm-entry-status err"; return;
    }
    const entries = [];
    const grid = $("#entry-grid");
    for (let pt = 1; pt <= 35; pt++) {
      const row = grid.querySelector(`.hm-entry-row[data-pt="${pt}"]`);
      const dInp = row.querySelector(`input[data-field="depth"]`);
      const tInp = row.querySelector(`input[data-field="temp"]`);
      if (dInp.classList.contains("danger") || tInp.classList.contains("danger")) {
        $("#entry-status").textContent = `point ${pt}: invalid value — fix red fields`;
        $("#entry-status").className = "hm-entry-status err"; return;
      }
      const dv = dInp.value.trim(), tv = tInp.value.trim();
      if (!dv && !tv) continue;
      entries.push({ point_nbr: pt, depth_in: dv === "" ? null : Number(dv), temp_f: tv === "" ? null : Number(tv) });
    }
    if (entries.length === 0) {
      $("#entry-status").textContent = "nothing to save — fill at least one row";
      $("#entry-status").className = "hm-entry-status err"; return;
    }
    const btn = $("#entry-save");
    btn.disabled = true; btn.textContent = "Saving…";

    const payload = { rink_code: state.rinkCode, date, entries };
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
      $("#entry-status").textContent = `✓ saved ${out.written} reading${out.written === 1 ? "" : "s"} for ${date}`;
      $("#entry-status").className = "hm-entry-status ok";
      await refreshDates();
      if (state.date === date) await loadDate();
      render();
      setTimeout(() => $("#entry-dialog").close(), 800);
    } catch (err) {
      if ("serviceWorker" in navigator && "SyncManager" in window) {
        try {
          const reg = await navigator.serviceWorker.ready;
          await reg.sync.register("drain-outbox");
        } catch { /* not fatal */ }
      }
      $("#entry-status").textContent = `queued — will sync when network returns (${err.message})`;
      $("#entry-status").className = "hm-entry-status err";
      setTimeout(() => $("#entry-dialog").close(), 1400);
    } finally {
      btn.disabled = false; btn.textContent = "Save";
      updateQueuedBadge();
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
  const onResize = () => render();
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
    $(".hm-side-pane").classList.toggle("expanded");
    updatePeekLabel();
  });

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

  // Entry form
  $("#entry-btn").addEventListener("click", () => openEntry(state.date));
  $("#entry-cancel").addEventListener("click", () => $("#entry-dialog").close());
  $("#entry-form").addEventListener("submit", saveEntry);
  $("#entry-fill-now").addEventListener("click", fillFromLatest);
  $("#entry-date").addEventListener("change", e => loadEntryFor(e.target.value));

  // Window-level listeners
  window.addEventListener("resize", onResize);
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
    window.removeEventListener("resize", onResize);
    window.removeEventListener("online", onOnline);
    document.removeEventListener("visibilitychange", onVisibility);
    if ("serviceWorker" in navigator) {
      try { navigator.serviceWorker.removeEventListener("message", onSWMessage); } catch {}
    }
    shellCtx.onRinkChange.delete(onRinkChange);
  };
}
