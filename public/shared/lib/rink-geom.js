// Rink geometry — pure data + ordering. No DOM, no canvas.
//
// Carried verbatim from the old heatmap tab (f9afd03) because the numbers are
// surveyed against the real sheet and re-deriving them would be re-surveying.
// What changed is only that they now live somewhere a test can reach them.
//
// Coordinate space is FEET, origin top-left, x→right, y→down. 200×100 is the
// nominal NHL sheet the Upper rink was measured against.

export const RINK_W = 200;
export const RINK_H = 100;
export const CORNER_R = 28;

export const MARK = {
  goalLineLeft: 18,
  goalLineRight: 182,
  blueLineLeft: 79,
  blueLineRight: 121,
  centerLine: 100,
  faceoffDotXL: 35,
  faceoffDotXR: 165,
  faceoffYTop: 27,
  faceoffYBot: 73,
  centerY: 50,
  faceoffR: 15.5,
  centerCircleR: 16,
  goalCreaseR: 6,
  goalLineMargin: 4,
};

// The five measurement rows, top→bottom.
export const Y_LINE = [14, 32, 50, 68, 86];

// Faceoff-cluster offsets from the dot.
const FX = 13;
const FY = 10;

// 35 points, 7 columns × 5 rows. Column K holds points (K*5-4)…(K*5), listed
// here top→bottom as K*5 down to K*5-4 — so col 1 reads 5,4,3,2,1. That
// inversion is not a typo; it is how the sheet is numbered in the field.
export const POINT_XY = new Map([
  // Col 1 — left goal line
  [5, { x: MARK.goalLineLeft, y: Y_LINE[0] }],
  [4, { x: MARK.goalLineLeft, y: Y_LINE[1] }],
  [3, { x: MARK.goalLineLeft, y: Y_LINE[2] }],
  [2, { x: MARK.goalLineLeft, y: Y_LINE[3] }],
  [1, { x: MARK.goalLineLeft, y: Y_LINE[4] }],
  // Col 2 — left faceoff zone
  [10, { x: MARK.faceoffDotXL + FX, y: MARK.faceoffYTop - FY }],
  [9, { x: MARK.faceoffDotXL + FX, y: MARK.faceoffYTop + FY }],
  [8, { x: MARK.faceoffDotXL, y: MARK.centerY }],
  [7, { x: MARK.faceoffDotXL + FX, y: MARK.faceoffYBot - FY }],
  [6, { x: MARK.faceoffDotXL + FX, y: MARK.faceoffYBot + FY }],
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
  [28, { x: MARK.faceoffDotXR, y: MARK.centerY }],
  [27, { x: MARK.faceoffDotXR - FX, y: MARK.faceoffYBot - FY }],
  [26, { x: MARK.faceoffDotXR - FX, y: MARK.faceoffYBot + FY }],
  // Col 7 — right goal line
  [35, { x: MARK.goalLineRight, y: Y_LINE[0] }],
  [34, { x: MARK.goalLineRight, y: Y_LINE[1] }],
  [33, { x: MARK.goalLineRight, y: Y_LINE[2] }],
  [32, { x: MARK.goalLineRight, y: Y_LINE[3] }],
  [31, { x: MARK.goalLineRight, y: Y_LINE[4] }],
]);

export const POINT_COUNT = 35;
export const COLS = 7;
export const ROWS = 5;

/** Feet coordinate of a point number, or null if out of range. */
export function pointXY(nbr) {
  return POINT_XY.get(nbr) ?? null;
}

/** Column (1-7) a point sits in. */
export function colOf(nbr) {
  return Math.ceil(nbr / ROWS);
}

/**
 * Walking order for entry mode. The operator walks the sheet column by column,
 * reversing direction each time, so the app should never ask them to teleport
 * from the top of one column back to the bottom of the next.
 *
 * Odd columns (1-indexed) walk bottom→top in point-number terms, even columns
 * top→bottom. Verified against the old implementation's output.
 */
export function serpentineOrder() {
  const order = [];
  for (let col = 0; col < COLS; col++) {
    const top = (col + 1) * ROWS; // point at Y_LINE[0]
    const bot = top - (ROWS - 1); // point at Y_LINE[4]
    if (col % 2 === 0) {
      for (let p = bot; p <= top; p++) order.push(p);
    } else {
      for (let p = top; p >= bot; p--) order.push(p);
    }
  }
  return order;
}

/** Plain 1..35. */
export function numericOrder() {
  return Array.from({ length: POINT_COUNT }, (_, i) => i + 1);
}

/**
 * Rink outline as primitive commands, so the pure module stays DOM-free and the
 * renderer turns them into a Path2D. scale = px per foot.
 */
export function rinkOutlineCommands(scale) {
  const r = CORNER_R * scale;
  const W = RINK_W * scale;
  const H = RINK_H * scale;
  return [
    ["moveTo", r, 0],
    ["lineTo", W - r, 0],
    ["arcTo", W, 0, W, r, r],
    ["lineTo", W, H - r],
    ["arcTo", W, H, W - r, H, r],
    ["lineTo", r, H],
    ["arcTo", 0, H, 0, H - r, r],
    ["lineTo", 0, r],
    ["arcTo", 0, 0, r, 0, r],
  ];
}

/**
 * Nearest point to a feet-space coordinate, with its distance. Used by
 * tap-on-rink entry. Returns null only if no points were supplied.
 */
export function nearestPoint(xFt, yFt, numbers = numericOrder()) {
  let best = null;
  for (const n of numbers) {
    const xy = POINT_XY.get(n);
    if (!xy) continue;
    const dx = xFt - xy.x;
    const dy = yFt - xy.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (!best || dist < best.dist) best = { point_nbr: n, dist };
  }
  return best;
}
