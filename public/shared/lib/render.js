// What the rink LOOKS like, as data — plus the interpolated field grid.
//
// Round one drew the sheet with ~200 lines of inline ctx calls buried in a
// 1,779-line closure, so "is the goal crease on the right side" was a question
// only a human squinting at a screenshot could answer. Here the markings are a
// list of shapes in FEET and the heat grid is an array of cells, both produced
// by pure functions. The canvas is a dumb executor; the geometry is testable.
//
// Coordinate space matches rink-geom: feet, origin top-left, x→right, y→down.

import { RINK_W, RINK_H, CORNER_R, MARK } from "./rink-geom.js";
import { fieldAt } from "./field.js";

/**
 * The rink boundary at a given x, as [yTop, yBottom]. Straight along the middle
 * of the sheet, pinched by the corner radius at either end. Goal lines sit at
 * x=18 with a 28ft corner, so they genuinely intersect the arc — drawing them
 * 0→100 would push red line out past the boards.
 *
 * @returns {[number, number]|null} null when x is off the sheet entirely.
 */
export function edgeYAt(x) {
  if (x < 0 || x > RINK_W) return null;
  let inset = 0;
  if (x < CORNER_R) inset = CORNER_R - Math.sqrt(Math.max(0, CORNER_R * CORNER_R - (CORNER_R - x) ** 2));
  else if (x > RINK_W - CORNER_R) {
    const dx = x - (RINK_W - CORNER_R);
    inset = CORNER_R - Math.sqrt(Math.max(0, CORNER_R * CORNER_R - dx * dx));
  }
  return [inset, RINK_H - inset];
}

/** Is a feet-space point on the ice (inside the rounded rectangle)? */
export function insideRink(x, y) {
  const edge = edgeYAt(x);
  if (!edge) return false;
  return y >= edge[0] && y <= edge[1];
}

// Shape colours are names, not values — the view resolves them against the
// theme so light/dark and any future palette change land in one place.
const RED = "mark-red";
const BLUE = "mark-blue";
const FAINT = "mark-faint";

/**
 * The full set of sheet markings, top of the list drawn first.
 *
 * @returns {Array<object>} shapes in feet:
 *   {kind:"line", x1,y1,x2,y2, color, width}
 *   {kind:"circle", cx,cy,r, color, width, fill?}
 *   {kind:"arc", cx,cy,r, from,to, color, width}   angles in radians
 *   {kind:"rect", x,y,w,h, color, width}
 */
export function rinkMarkings() {
  const shapes = [];

  const vline = (x, color, width = 0.6) => {
    const e = edgeYAt(x);
    if (!e) return;
    shapes.push({ kind: "line", x1: x, y1: e[0], x2: x, y2: e[1], color, width });
  };

  // Goal lines first — they are the ones the corner arc actually clips.
  vline(MARK.goalLineLeft, RED, 0.4);
  vline(MARK.goalLineRight, RED, 0.4);
  vline(MARK.blueLineLeft, BLUE, 1.0);
  vline(MARK.blueLineRight, BLUE, 1.0);
  vline(MARK.centerLine, RED, 1.0);

  // Centre ice.
  shapes.push({ kind: "circle", cx: MARK.centerLine, cy: MARK.centerY, r: MARK.centerCircleR, color: BLUE, width: 0.4 });
  shapes.push({ kind: "circle", cx: MARK.centerLine, cy: MARK.centerY, r: 0.8, color: BLUE, width: 0, fill: true });

  // Four end-zone faceoff circles and their dots.
  for (const cx of [MARK.faceoffDotXL, MARK.faceoffDotXR]) {
    for (const cy of [MARK.faceoffYTop, MARK.faceoffYBot]) {
      shapes.push({ kind: "circle", cx, cy, r: MARK.faceoffR, color: RED, width: 0.4 });
      shapes.push({ kind: "circle", cx, cy, r: 1, color: RED, width: 0, fill: true });
    }
  }

  // Creases: a half-disc on the ICE side of each goal line, so the left crease
  // opens right and the right crease opens left. Getting this backwards is the
  // classic mirrored-rink bug and a test now pins it.
  shapes.push({
    kind: "arc",
    cx: MARK.goalLineLeft,
    cy: MARK.centerY,
    r: MARK.goalCreaseR,
    from: -Math.PI / 2,
    to: Math.PI / 2,
    color: BLUE,
    width: 0.4,
  });
  shapes.push({
    kind: "arc",
    cx: MARK.goalLineRight,
    cy: MARK.centerY,
    r: MARK.goalCreaseR,
    from: Math.PI / 2,
    to: (3 * Math.PI) / 2,
    color: BLUE,
    width: 0.4,
  });

  // Nets, behind their goal lines.
  const netW = MARK.goalLineMargin;
  const netH = 6;
  shapes.push({
    kind: "rect",
    x: MARK.goalLineLeft - netW,
    y: MARK.centerY - netH / 2,
    w: netW,
    h: netH,
    color: FAINT,
    width: 0.4,
  });
  shapes.push({
    kind: "rect",
    x: MARK.goalLineRight,
    y: MARK.centerY - netH / 2,
    w: netW,
    h: netH,
    color: FAINT,
    width: 0.4,
  });

  return shapes;
}

/**
 * The interpolated field, as a grid of cells to fill. Only cells whose centre
 * is on the ice are returned, so the caller can paint without clipping and the
 * heat never bleeds past the boards.
 *
 * @param {Array<{point_nbr:number, value:number}>} samples
 * @param {object} [opts]
 * @param {number} [opts.cell=2]  cell size in FEET
 * @returns {Array<{x:number,y:number,w:number,h:number,v:number,conf:number}>}
 */
export function heatCells(samples, { cell = 2 } = {}) {
  const out = [];
  if (!samples || samples.length === 0) return out;
  // Bail before the grid loop if nothing has a value — fieldAt would return
  // null for every one of ~2,500 cells otherwise.
  if (!samples.some((s) => s && s.value != null && Number.isFinite(s.value))) return out;

  const size = Math.max(0.5, cell);
  for (let y = 0; y < RINK_H; y += size) {
    for (let x = 0; x < RINK_W; x += size) {
      const cx = x + size / 2;
      const cy = y + size / 2;
      if (!insideRink(cx, cy)) continue;
      const f = fieldAt(samples, cx, cy);
      if (!f) continue;
      out.push({ x, y, w: size, h: size, v: f.v, conf: f.conf });
    }
  }
  return out;
}

/**
 * Cell size that keeps the grid roughly constant in SCREEN terms across a phone
 * and a 3440px desktop — a fixed 2ft cell is 4px on a phone (invisible banding)
 * and 34px on an ultrawide (visible blocks).
 *
 * @param {number} cssWidth  canvas CSS width in px
 */
export function cellForWidth(cssWidth) {
  const targetPx = 7;
  const ftPerPx = RINK_W / Math.max(1, cssWidth);
  return Math.min(5, Math.max(1.25, Math.round(targetPx * ftPerPx * 4) / 4));
}
