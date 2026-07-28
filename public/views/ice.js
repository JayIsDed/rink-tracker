// Ice: read the sheet, and walk it.
//
// Two surfaces behind one registration — /ice reads, /ice/entry records. They
// share a canvas painter and, more importantly, they share the pure modules, so
// this file is wiring rather than logic. Round one's equivalent was 1,779 lines
// with the geometry, the interpolation, the colour ramps and the entry flow all
// tangled in one closure; the arithmetic here lives in rink-geom / field /
// scales / render / entry and is tested there.

import { register } from "/shared/views.js";
import { get } from "/shared/api.js";
import { el, clear, empty, toast, tick, openSheet, closeSheet } from "/shared/ui.js";
import { isoDate, shortDate } from "/shared/lib/dates.js";
import { RINK_W, RINK_H, POINT_XY, rinkOutlineCommands, nearestPoint } from "/shared/lib/rink-geom.js";
import { rinkMarkings, heatCells, cellForWidth } from "/shared/lib/render.js";
import { colorDepth, colorTemp, colorDelta, NO_DATA, SCALES, gradientStops } from "/shared/lib/scales.js";
import { createEntry, STATUS } from "/shared/lib/entry.js";
import { sparklineWithThreshold } from "/shared/lib/spark.js";
import { summarise, thermalLoad } from "/shared/lib/weather.js";
import * as outbox from "/shared/outbox.js";

// ── Canvas ────────────────────────────────────────────────────────────
// One painter, both surfaces. It executes shapes; it decides nothing.

const MARK_COLOR = {
  "mark-red": "rgba(226,80,72,0.55)",
  "mark-blue": "rgba(74,150,255,0.55)",
  "mark-faint": "rgba(150,180,210,0.30)",
};

function createSheetCanvas({ onTap, onResize } = {}) {
  const canvas = el("canvas", {
    style: { width: "100%", display: "block", touchAction: "manipulation", borderRadius: "var(--r-md)" },
  });
  let scale = 1;
  let cssW = 320;
  let lastCssW = -1;
  let opts = null;

  function context() {
    const rect = canvas.getBoundingClientRect();
    cssW = rect.width || 320;
    lastCssW = cssW;
    const cssH = (cssW * RINK_H) / RINK_W;
    canvas.style.height = `${cssH}px`;
    // Back the canvas at device resolution or the dots and the rink lines are
    // soft on every phone in the building.
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const cx = canvas.getContext("2d");
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    scale = cssW / RINK_W;
    return cx;
  }

  function draw(next) {
    if (next) opts = next;
    if (!opts) return;
    const { cells = [], colorOf, labelOf, ringed = null, dimUnset = true } = opts;
    const cx = context();
    const css = getComputedStyle(document.documentElement);
    const surface = css.getPropertyValue("--surface").trim() || "#0e141c";
    const border = css.getPropertyValue("--border-strong").trim() || "#456";
    const text = css.getPropertyValue("--text").trim() || "#e8f0f8";
    const accent = css.getPropertyValue("--accent").trim() || "#5cc8f5";

    cx.clearRect(0, 0, canvas.width, canvas.height);

    const outline = new Path2D();
    for (const [op, ...args] of rinkOutlineCommands(scale)) outline[op](...args);

    cx.save();
    cx.clip(outline);
    cx.fillStyle = surface;
    cx.fillRect(0, 0, RINK_W * scale, RINK_H * scale);
    for (const c of cells) {
      cx.fillStyle = c.color;
      // Fade with the interpolator's own confidence. `heatCells` has always
      // returned a `conf` per cell and the view threw it away, so ice measured
      // three feet from a probe and ice interpolated thirty feet from the
      // nearest one were painted with identical certainty. Between the goal
      // line and the boards that is a claim nobody took a reading to support.
      cx.globalAlpha = c.alpha ?? 1;
      // +1px bleed so the grid does not show hairline seams at fractional scale.
      cx.fillRect(c.x * scale, c.y * scale, c.w * scale + 1, c.h * scale + 1);
    }
    cx.globalAlpha = 1;
    cx.restore();

    for (const s of rinkMarkings()) {
      cx.strokeStyle = MARK_COLOR[s.color] ?? border;
      cx.fillStyle = cx.strokeStyle;
      cx.lineWidth = Math.max(1, s.width * scale);
      cx.beginPath();
      if (s.kind === "line") {
        cx.moveTo(s.x1 * scale, s.y1 * scale);
        cx.lineTo(s.x2 * scale, s.y2 * scale);
        cx.stroke();
      } else if (s.kind === "circle") {
        cx.arc(s.cx * scale, s.cy * scale, s.r * scale, 0, Math.PI * 2);
        s.fill ? cx.fill() : cx.stroke();
      } else if (s.kind === "arc") {
        cx.arc(s.cx * scale, s.cy * scale, s.r * scale, s.from, s.to);
        cx.stroke();
      } else if (s.kind === "rect") {
        // A labelled rect is filled — the Zamboni door has to read as a solid
        // marker at phone width, where a 1.2ft-tall outline is a hairline.
        if (s.label) cx.fillRect(s.x * scale, s.y * scale, s.w * scale, s.h * scale);
        else cx.strokeRect(s.x * scale, s.y * scale, s.w * scale, s.h * scale);
        if (s.label && cssW >= 420) {
          cx.save();
          cx.font = "600 8px ui-sans-serif, system-ui, sans-serif";
          cx.textAlign = "left";
          cx.textBaseline = "bottom";
          cx.fillText(s.label, s.x * scale, (s.y - 0.6) * scale);
          cx.restore();
        }
      }
    }

    cx.strokeStyle = border;
    cx.lineWidth = 2;
    cx.stroke(outline);

    const showLabels = cssW >= 520 && typeof labelOf === "function";
    const r = Math.max(4, Math.min(9, cssW / 55));
    cx.font = `600 ${Math.max(9, r * 1.25)}px ui-sans-serif, system-ui, sans-serif`;
    cx.textAlign = "center";
    cx.textBaseline = "middle";

    for (const [n, xy] of POINT_XY) {
      const fill = colorOf ? colorOf(n) : NO_DATA;
      const x = xy.x * scale;
      const y = xy.y * scale;
      cx.beginPath();
      cx.arc(x, y, n === ringed ? r * 1.35 : r, 0, Math.PI * 2);
      cx.fillStyle = fill ?? NO_DATA;
      cx.globalAlpha = dimUnset && fill === NO_DATA ? 0.5 : 1;
      cx.fill();
      cx.globalAlpha = 1;
      cx.lineWidth = 1;
      cx.strokeStyle = "rgba(7,11,16,0.75)";
      cx.stroke();

      if (n === ringed) {
        cx.beginPath();
        cx.arc(x, y, r * 2.1, 0, Math.PI * 2);
        cx.strokeStyle = accent;
        cx.lineWidth = 2.5;
        cx.stroke();
      }

      if (showLabels) {
        const label = labelOf(n);
        if (label) {
          cx.fillStyle = "rgba(7,11,16,0.8)";
          cx.fillText(label, x, y + r * 2.4 + 1);
          cx.fillStyle = text;
          cx.fillText(label, x, y + r * 2.4);
        }
      }
    }
  }

  if (onTap) {
    canvas.addEventListener("pointerdown", (ev) => {
      const rect = canvas.getBoundingClientRect();
      const xFt = ((ev.clientX - rect.left) / rect.width) * RINK_W;
      const yFt = ((ev.clientY - rect.top) / rect.height) * RINK_H;
      const hit = nearestPoint(xFt, yFt);
      if (hit && hit.dist < 16) onTap(hit.point_nbr);
    });
  }

  /**
   * Repaint only when the WIDTH actually changed.
   *
   * The sheet is width-driven — its height is derived from the 2:1 aspect — so
   * a height-only viewport change needs no repaint. That matters because the
   * mobile URL bar collapsing on scroll fires `resize`, and repainting here
   * would re-run ~2,000 IDW samples and reset the backing store mid-scroll on
   * every single scroll gesture. That is the canvas half of "borders shimmer".
   */
  function handleResize() {
    const w = canvas.getBoundingClientRect().width || 0;
    if (Math.abs(w - lastCssW) < 1) return;
    (onResize ?? draw)();
  }
  window.addEventListener("resize", handleResize);

  return {
    canvas,
    draw,
    destroy: () => window.removeEventListener("resize", handleResize),
  };
}

// ── Point detail ──────────────────────────────────────────────────────
// Tap a dot, get the point's story. Round one had this and the rebuild dropped
// it silently — the gap that AMENDMENT 1 on n-72 was called to close.

/** The sparkline, drawn from pure geometry. Depth only; temp is too noisy. */
function sparkCanvas(history, threshold) {
  const canvas = el("canvas", { style: { width: "100%", height: "64px", display: "block" } });

  function paint() {
    const rect = canvas.getBoundingClientRect();
    const w = rect.width || 320;
    const h = 64;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const cx = canvas.getContext("2d");
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx.clearRect(0, 0, w, h);

    const s = sparklineWithThreshold(
      history.filter((r) => r.depth_in != null).map((r) => ({ date: r.measure_date, value: r.depth_in })),
      { w, h, pad: 6 },
      threshold
    );
    if (!s) return;

    const css = getComputedStyle(document.documentElement);
    const accent = css.getPropertyValue("--accent").trim() || "#5cc8f5";
    const red = css.getPropertyValue("--red").trim() || "#e25048";

    if (s.baselineY != null) {
      cx.strokeStyle = red;
      cx.globalAlpha = 0.45;
      cx.setLineDash([3, 3]);
      cx.lineWidth = 1;
      cx.beginPath();
      cx.moveTo(0, s.baselineY);
      cx.lineTo(w, s.baselineY);
      cx.stroke();
      cx.setLineDash([]);
      cx.globalAlpha = 1;
    }

    cx.strokeStyle = accent;
    cx.lineWidth = 1.75;
    cx.lineJoin = "round";
    cx.beginPath();
    s.points.forEach((p, i) => (i ? cx.lineTo(p.x, p.y) : cx.moveTo(p.x, p.y)));
    cx.stroke();

    // The latest reading gets a dot — on a 60-session line the right-hand end
    // is the one anybody is actually looking for.
    cx.fillStyle = accent;
    cx.beginPath();
    cx.arc(s.last.x, s.last.y, 3, 0, Math.PI * 2);
    cx.fill();
  }

  requestAnimationFrame(paint);
  return canvas;
}

async function openPointSheet(n, date) {
  let d;
  try {
    d = await get(`/api/ice/point?rink=U&point=${n}&date=${date}`);
  } catch (err) {
    openSheet(`Point ${n}`, [empty("Couldn't load this point", err.message)]);
    return;
  }

  const grid = d.grid ? `column ${d.grid.col}, row ${d.grid.row}` : `point ${n}`;
  const thin = d.depth_in != null && d.threshold_in != null && d.depth_in <= d.threshold_in;
  const nb = d.neighbours ?? [];
  const nbMin = nb.length ? Math.min(...nb.map((x) => x.depth_in)) : null;
  const nbMax = nb.length ? Math.max(...nb.map((x) => x.depth_in)) : null;

  const chips = [
    d.temp_f != null ? el("span.chip", { text: `${d.temp_f.toFixed(1)}°F` }) : null,
    d.headroom_in != null
      ? el("span.chip", {
          style: d.headroom_in < 0.5 ? { color: "var(--amber)" } : {},
          text: `${d.headroom_in.toFixed(2)}" over its thinnest`,
        })
      : null,
    nbMin != null ? el("span.chip", { text: `neighbours ${nbMin.toFixed(1)}–${nbMax.toFixed(1)}"` }) : null,
  ].filter(Boolean);

  const w = d.weather;
  const line = summarise(w);
  const load = thermalLoad(w?.temp_mean_f, d.temp_f);

  const stats = d.stats;
  const recent = [...(d.history ?? [])].reverse().slice(0, 24);

  openSheet(`Point ${n}`, [
    el("p.dim", { style: { marginTop: 0, fontSize: "13px" }, text: grid }),

    el("div.row", { style: { gap: "var(--s3)", alignItems: "baseline" } }, [
      el("span.num", {
        style: { fontSize: "34px", color: thin ? "var(--red)" : "var(--text)" },
        text: d.depth_in == null ? "—" : `${d.depth_in.toFixed(2)}"`,
      }),
      d.delta_in != null
        ? el("span.dim", {
            style: { fontSize: "13px" },
            text: `${d.delta_in > 0 ? "+" : ""}${d.delta_in.toFixed(2)}" since ${shortDate(Date.parse(d.prev_date + "T12:00:00"))}`,
          })
        : el("span.dim", { style: { fontSize: "13px" }, text: "no earlier reading" }),
    ]),
    d.depth_in == null ? el("p.muted.prose", { text: "Not measured in this session." }) : null,
    chips.length ? el("div.row", { style: { gap: "var(--s2)", marginTop: "var(--s2)" } }, chips) : null,

    // History
    stats && stats.n >= 2
      ? el("div", { style: { marginTop: "var(--s4)" } }, [
          el("p.section-title", { text: `History · ${stats.n} readings` }),
          sparkCanvas(d.history, d.threshold_in),
          el("div.row", { style: { gap: "var(--s2)", marginTop: "var(--s2)" } }, [
            el("span.chip", { text: `average ${stats.mean.toFixed(2)}"` }),
            el("span.chip", { text: `thinnest ${stats.min.toFixed(2)}" · ${shortDate(Date.parse(stats.min_date + "T12:00:00"))}` }),
            el("span.chip", { text: `thickest ${stats.max.toFixed(2)}"` }),
            stats.trend_per_week != null
              ? el("span.chip", {
                  style: stats.trend_per_week <= -0.15 ? { color: "var(--amber)" } : {},
                  text: `${stats.trend_per_week > 0 ? "+" : ""}${stats.trend_per_week.toFixed(2)}"/wk`,
                })
              : null,
          ])
        ])
      : el("p.muted.prose", { style: { marginTop: "var(--s4)" }, text: "Not enough readings yet to show a trend." }),

    // Weather
    line
      ? el("div", { style: { marginTop: "var(--s4)" } }, [
          el("p.section-title", { text: "Outside that day" }),
          el("p.muted.prose", { style: { marginTop: 0 }, text: line }),
          load != null
            ? el("p.dim", { style: { fontSize: "12px" }, text: `${load.toFixed(1)}°F between the air and this point.` })
            : null,
        ])
      : null,

    // Readings
    recent.length
      ? el("div", { style: { marginTop: "var(--s4)" } }, [
          el("p.section-title", { text: "Readings" }),
          ...recent.map((r) =>
            el("div.row", { style: { marginTop: "var(--s1)", fontSize: "13px" } }, [
              el("span.dim.grow", { text: shortDate(Date.parse(r.measure_date + "T12:00:00")) }),
              el("span.num.fixed", { style: { minWidth: "56px", textAlign: "right" }, text: r.depth_in == null ? "—" : `${r.depth_in.toFixed(2)}"` }),
              el("span.dim.fixed", { style: { minWidth: "58px", textAlign: "right" }, text: r.temp_f == null ? "" : `${r.temp_f.toFixed(1)}°F` }),
            ])
          ),
        ])
      : null,

    d.headroom_in != null
      ? el("p.dim", {
          style: { fontSize: "12px", marginTop: "var(--s4)" },
          text: "\"Over its thinnest\" compares today against the thinnest this point has ever read — the best estimate of where the concrete sits. It's history, not a survey.",
        })
      : null,
  ]);
}

// Lower is a sand base — it has never held a measurement and has no surveyed
// points. Saying so plainly beats rendering an empty sheet that looks broken.
function notMeasured(navigate, setRink) {
  return el("div.card", {}, [
    empty(
      "The Lower rink isn't measured",
      "It's a sand base with no surveyed points, so there's no depth to map. Everything else in the app covers both rinks."
    ),
    el("div.row", { style: { marginTop: "var(--s3)" } }, [
      el("button.btn.primary.grow", {
        type: "button",
        text: "Show the Upper rink",
        onclick: () => setRink("U"),
      }),
    ]),
  ]);
}

// ── Read ──────────────────────────────────────────────────────────────

const MODES = [
  { id: "depth", label: "Depth", unit: '"', pick: (p) => p.depth_in, color: colorDepth },
  { id: "temp", label: "Temp", unit: "°F", pick: (p) => p.temp_f, color: colorTemp },
  { id: "change", label: "Change", unit: '"', pick: (p) => p.delta_in, color: colorDelta },
];

async function mountRead({ root, state, navigate, setRink }) {
  if (state.rink === "L") {
    root.append(notMeasured(navigate, setRink));
    return;
  }

  let mode = MODES[0];
  let session = null;
  let sessions = [];

  const mapCard = el("div.card");
  const legend = el("div", { style: { marginTop: "var(--s2)" } });
  const statsRow = el("div.row", { style: { gap: "var(--s2)" } });
  // A map you can tap looks exactly like a map you can't, so it has to say so.
  // Round one wrote this on the sheet's peek handle; here it sits under the
  // canvas as a permanent cue rather than a slot that fills in after the fact.
  const readout = el("div.dim", {
    style: { fontSize: "12px", minHeight: "18px", marginTop: "var(--s2)" },
    text: "Tap any point for its history.",
  });
  const stripCard = el("div.card");

  const sheet = createSheetCanvas({
    // Read mode derives its cell size from the width, so a real width change
    // needs the view's repaint, not a redraw of the last cell grid.
    onResize: () => paint(),
    onTap: (n) => {
      if (!session?.date) return;
      tick();
      openPointSheet(n, session.date);
    },
  });

  const dateSel = el("select.input", { onchange: () => load(dateSel.value) });
  const modeSwitch = el("div.row", { style: { gap: "var(--s2)" } },
    MODES.map((m) =>
      el("button.btn.small.grow", {
        type: "button",
        text: m.label,
        onclick: () => {
          mode = m;
          paint();
          markModes();
          renderLegend();
        },
      })
    )
  );

  function markModes() {
    modeSwitch.querySelectorAll("button").forEach((b, i) => b.classList.toggle("primary", MODES[i].id === mode.id));
  }

  /** The key for whichever ramp is on screen. */
  function renderLegend() {
    const s = SCALES[mode.id];
    clear(legend);
    if (!s) return;
    legend.append(
      el("div", {
        style: {
          height: "8px",
          borderRadius: "var(--r-full)",
          border: "1px solid var(--border)",
          background: `linear-gradient(90deg, ${gradientStops(s.stops)})`,
        },
      }),
      el("div.row", { style: { marginTop: "var(--s1)", fontSize: "11px" } }, [
        el("span.dim.fixed", { text: s.lo }),
        el("span.dim.grow", { style: { textAlign: "center" }, text: s.mid ?? s.label }),
        el("span.dim.fixed", { text: s.hi }),
      ])
    );
  }

  function paint() {
    if (!session?.points) return;
    const samples = session.points.map((p) => ({ point_nbr: p.point_nbr, value: mode.pick(p) }));
    const byPoint = new Map(samples.map((s) => [s.point_nbr, s.value]));
    const cell = cellForWidth(sheet.canvas.getBoundingClientRect().width || 360);
    sheet.draw({
      // "cover" because the painter clips to the outline — a centre-tested grid
      // leaves a staircase along the boards that the clip cannot fill back in.
      cells: heatCells(samples, { cell, edge: "cover" }).map((c) => ({
        ...c,
        color: mode.color(c.v),
        alpha: c.conf,
      })),
      colorOf: (n) => (byPoint.get(n) == null ? NO_DATA : mode.color(byPoint.get(n))),
      labelOf: (n) => {
        const v = byPoint.get(n);
        return v == null ? "" : mode.id === "temp" ? v.toFixed(0) : v.toFixed(1);
      },
    });
  }

  function renderStats() {
    clear(statsRow);
    if (!session?.stats) {
      statsRow.append(el("span.dim", { text: "Nothing measured on this date." }));
      return;
    }
    const s = session.stats;
    const w = session.weather;
    const chip = (label, value, tone) =>
      el("span.chip", { style: tone ? { color: `var(--${tone})` } : {} }, [
        el("span.dim", { text: `${label} ` }),
        el("span.num", { text: value }),
      ]);
    statsRow.append(
      chip("thinnest", `${s.min.toFixed(2)}"`, s.min <= 2 ? "red" : null),
      chip("average", `${s.mean.toFixed(2)}"`),
      chip("thickest", `${s.max.toFixed(2)}"`),
      chip("points", `${s.n}/35`, s.n < 35 ? "amber" : null),
      w?.temp_mean_f != null ? chip("outside", `${Math.round(w.temp_mean_f)}°F`) : null
    );
  }

  async function renderStrip(date) {
    clear(stripCard).append(el("p.section-title", { text: "Worth a look" }));
    let data;
    try {
      data = await get(`/api/ice/thin-spots?rink=U&date=${date}`);
    } catch (err) {
      stripCard.append(empty("Couldn't load the check", err.message));
      return;
    }
    if (!data.spots.length) {
      stripCard.append(
        empty(
          "Nothing standing out",
          `Every measured point is above ${data.threshold_in}" and in line with its neighbours.`
        )
      );
      return;
    }

    stripCard.append(
      el("p.muted.prose", {
        style: { marginTop: 0 },
        text: `${data.counts.thin} at or under ${data.threshold_in}", ${data.counts.dropping} losing ice.`,
      })
    );

    for (const s of data.spots) {
      const tags = [];
      if (s.thin) tags.push({ text: "thin", tone: "red" });
      if (s.odd) tags.push({ text: "off its neighbours", tone: "amber" });
      if (s.dropping) tags.push({ text: `${s.trend_per_week.toFixed(2)}"/wk`, tone: "amber" });
      if (s.unusual) tags.push({ text: "unusual for this point", tone: "amber" });

      stripCard.append(
        el("div.row", { style: { marginTop: "var(--s3)", gap: "var(--s3)", alignItems: "flex-start" } }, [
          el("span.num.fixed", {
            style: { minWidth: "62px", color: s.thin ? "var(--red)" : "var(--text)", fontSize: "17px" },
            text: `${s.depth_in.toFixed(2)}"`,
          }),
          el("span.grow", {}, [
            el("div", { text: `Point ${s.point_nbr}` }),
            el("div.dim", {
              style: { fontSize: "12px" },
              text:
                s.neighbour_mean == null
                  ? "no measured neighbours"
                  : `neighbours ${s.neighbour_min.toFixed(1)}–${s.neighbour_max.toFixed(1)}" (avg ${s.neighbour_mean.toFixed(2)}")`,
            }),
            el("div.row", { style: { gap: "var(--s1)", marginTop: "var(--s1)" } },
              tags.map((t) => el("span.chip", { style: { color: `var(--${t.tone})` }, text: t.text }))
            ),
          ]),
        ])
      );
    }
  }

  async function load(date) {
    session = await get(`/api/ice/session?rink=U${date ? `&date=${date}` : ""}`);
    if (!session.date) {
      clear(mapCard).append(
        empty("No measurements yet", "Walk the sheet once and the map fills in."),
        el("div.row", { style: { marginTop: "var(--s3)" } }, [
          el("button.btn.primary.grow", { type: "button", text: "Measure the ice", onclick: () => navigate("/ice/entry") }),
        ])
      );
      clear(stripCard);
      return;
    }
    dateSel.value = session.date;
    renderStats();
    requestAnimationFrame(paint);
    await renderStrip(session.date);
  }

  sessions = await get("/api/ice/sessions?rink=U&limit=60");
  clear(dateSel).append(
    ...sessions.map((s) =>
      el("option", {
        value: s.measure_date,
        text: `${shortDate(Date.parse(s.measure_date + "T12:00:00"))} · ${s.depth_count} pts${s.min_depth != null ? ` · min ${s.min_depth.toFixed(2)}"` : ""}`,
      })
    )
  );

  mapCard.append(
    el("div.row", { style: { gap: "var(--s2)" } }, [
      el("span.grow", {}, [el("div.field", {}, [el("label", { text: "Session" }), dateSel])]),
    ]),
    el("div", { style: { marginTop: "var(--s3)" } }, [modeSwitch]),
    el("div", { style: { marginTop: "var(--s3)" } }, [sheet.canvas]),
    legend,
    readout,
    el("div", { style: { marginTop: "var(--s3)" } }, [statsRow]),
    el("div.row", { style: { marginTop: "var(--s3)" } }, [
      el("button.btn.primary.grow", { type: "button", text: "Measure the ice", onclick: () => navigate("/ice/entry") }),
    ])
  );

  root.append(mapCard, stripCard);
  markModes();
  renderLegend();
  await load(null);
  return () => sheet.destroy();
}

// ── Entry ─────────────────────────────────────────────────────────────

const STATUS_COLOR = {
  // Not NO_DATA. On the read map an unmeasured point is background, but here
  // the dots ARE the progress display and the jump targets — at 0/35 the whole
  // sheet is "empty", and a barely-visible dot is one you cannot aim at.
  [STATUS.EMPTY]: "var(--text-3)",
  [STATUS.DIRTY]: "var(--amber)",
  [STATUS.QUEUED]: "var(--amber)",
  [STATUS.SAVED]: "var(--green)",
  [STATUS.FAILED]: "var(--red)",
};

function resolveColor(token) {
  if (!token.startsWith("var(")) return token;
  const name = token.slice(4, -1);
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";
}

async function mountEntry({ root, url, state, navigate, setRink }) {
  if (state.rink === "L") {
    root.append(notMeasured(navigate, setRink));
    return;
  }
  if (!state.who) {
    root.append(
      el("div.card", {}, [
        empty("Pick your name first", "Every reading is stamped with who took it. Tap the name button up top."),
      ])
    );
    return;
  }

  const asked = url.searchParams.get("date");
  const date = /^\d{4}-\d{2}-\d{2}$/.test(asked ?? "") ? asked : isoDate();
  const thinAt = Number(state.settings?.thin_spot_in ?? 2) || 2;
  const session = createEntry({ rink: "U", date, thinAt });

  // What this point read LAST time, per point. Round one put it under the depth
  // field and it is the cheapest anomaly check there is — an operator who can
  // see "3.42\" last week" catches their own fat-finger before the server ever
  // has to have an opinion. The session API already returns it, so this costs
  // one map and no extra request.
  const prevByPoint = new Map();
  let prevDate = null;

  const progressChip = el("span.chip");
  const savedChip = el("span.chip");
  const pointTitle = el("h2", { style: { margin: 0, fontSize: "24px" } });
  const pointNote = el("div.dim", { style: { fontSize: "13px" } });
  const lastLine = el("div.dim", { style: { fontSize: "12px", minHeight: "16px", marginTop: "var(--s1)" } });
  const depthIn = el("input.input", {
    type: "number",
    step: "0.01",
    inputmode: "decimal",
    enterkeyhint: "next",
    placeholder: "inches",
    style: { fontSize: "24px", height: "56px", textAlign: "center" },
  });
  const tempIn = el("input.input", {
    type: "number",
    step: "0.1",
    inputmode: "decimal",
    enterkeyhint: "next",
    placeholder: "optional",
  });
  const hint = el("div", { style: { fontSize: "13px", minHeight: "18px", marginTop: "var(--s2)" } });
  const banner = el("div", { style: { display: "none" } });

  const sheet = createSheetCanvas({
    onResize: () => paint(),
    onTap: (n) => {
      commit();
      session.jumpTo(n);
      tick();
      renderAll();
    },
  });

  function paint() {
    sheet.draw({
      cells: [],
      colorOf: (n) => resolveColor(STATUS_COLOR[session.get(n).status]),
      labelOf: (n) => {
        const d = session.get(n).depth_in;
        return d == null ? "" : d.toFixed(1);
      },
      ringed: session.current(),
    });
  }

  /** Take whatever is in the inputs and record + queue it. */
  function commit() {
    const n = session.current();
    const before = session.get(n);
    const depth = depthIn.value.trim();
    const temp = tempIn.value.trim();

    const unchanged =
      (before.depth_in == null ? "" : String(before.depth_in)) === depth &&
      (before.temp_f == null ? "" : String(before.temp_f)) === temp;
    if (unchanged) return true;

    const res = session.setValue(n, { depth, temp });
    if (!res.ok) {
      hint.textContent = res.reason;
      hint.style.color = "var(--red)";
      return false;
    }
    hint.textContent = res.warn ?? "";
    hint.style.color = "var(--amber)";

    const now = session.get(n);
    // Queue immediately. This is the whole promise of the screen: the value is
    // on its way to durable storage before the operator's hand leaves the keys.
    outbox.enqueue(
      "/api/ice/measurements",
      { rink: "U", date, points: [{ point_nbr: n, depth_in: now.depth_in, temp_f: now.temp_f }] },
      { date, points: [n] }
    );
    session.markQueued([n]);
    return true;
  }

  function loadInputs() {
    const r = session.get(session.current());
    depthIn.value = r.depth_in == null ? "" : String(r.depth_in);
    tempIn.value = r.temp_f == null ? "" : String(r.temp_f);
    hint.textContent = r.error ?? "";
    hint.style.color = r.error ? "var(--red)" : "var(--amber)";
  }

  function step(dir) {
    if (!commit()) return;
    dir > 0 ? session.next() : session.prev();
    tick();
    renderAll();
    depthIn.focus();
    depthIn.select?.();
  }

  /**
   * "last: 3.42" (Jul 07)", plus the change if something is typed. Live on
   * input, because the moment the number is worth checking is while the hand
   * is still on the keys.
   */
  function renderLastReading() {
    const n = session.current();
    const prev = prevByPoint.get(n);
    if (prev == null) {
      lastLine.textContent = "no earlier reading for this point";
      lastLine.style.color = "";
      return;
    }
    const stamp = prevDate ? ` (${shortDate(Date.parse(prevDate + "T12:00:00"))})` : "";
    const typed = Number(depthIn.value.trim());
    if (!depthIn.value.trim() || !Number.isFinite(typed)) {
      lastLine.textContent = `last: ${prev.toFixed(2)}"${stamp}`;
      lastLine.style.color = "";
      return;
    }
    const delta = typed - prev;
    lastLine.textContent = `last: ${prev.toFixed(2)}"${stamp} · ${delta >= 0 ? "+" : ""}${delta.toFixed(2)}"`;
    // Half an inch in a week is not impossible, but it is worth a second look
    // before you walk away from it.
    lastLine.style.color = Math.abs(delta) >= 0.5 ? "var(--amber)" : "";
  }

  function renderAll() {
    const n = session.current();
    const pos = session.position();
    const p = session.progress();
    pointTitle.textContent = `Point ${n}`;
    // Short enough not to wrap mid-phrase beside the chips on a 412px phone.
    pointNote.textContent = `${pos.index + 1} of ${pos.total} · ${session.order === "numeric" ? "by number" : "walk order"}`;
    progressChip.textContent = `${p.measured}/35 measured`;
    savedChip.textContent = p.failed
      ? `${p.failed} failed`
      : p.inflight
        ? `${p.saved} saved · ${p.inflight} sending`
        : `${p.saved} saved`;
    savedChip.style.color = p.failed ? "var(--red)" : p.inflight ? "var(--amber)" : "var(--green)";
    loadInputs();
    renderLastReading();
    markOrder();
    paint();
  }

  /**
   * Walk order vs numeric. `entry.setOrder` has existed and been tested since
   * R3 with nothing on screen ever calling it — round one had the toggle in its
   * entry bar. It matters because the serpentine walk assumes you started at
   * one particular corner, and an operator who came in the other door is being
   * marched backwards through their own sheet.
   */
  const orderBtn = el("button.btn.small", {
    type: "button",
    onclick: () => {
      commit();
      session.setOrder(session.order === "numeric" ? "walk" : "numeric");
      tick();
      renderAll();
    },
  });
  function markOrder() {
    orderBtn.textContent = session.order === "numeric" ? "Walking order" : "By number";
  }

  function renderBanner(s) {
    const stuck = !s.online || s.dead > 0;
    banner.style.display = stuck ? "block" : "none";
    if (!stuck) return;
    clear(banner);
    banner.append(
      el("div.card", { style: { borderColor: s.dead ? "var(--red)" : "var(--amber)" } }, [
        el("strong", {
          text: s.dead ? `${s.dead} reading${s.dead > 1 ? "s" : ""} were rejected` : "You're offline",
        }),
        el("p.muted.prose", {
          style: { marginBottom: 0 },
          text: s.dead
            ? "They're marked red on the map. Tap one to see why and retype it."
            : `${s.pending} reading${s.pending === 1 ? "" : "s"} are saved on this phone and will send themselves when signal comes back. Keep going.`,
        }),
      ])
    );
  }

  depthIn.addEventListener("keydown", (e) => e.key === "Enter" && step(1));
  tempIn.addEventListener("keydown", (e) => e.key === "Enter" && step(1));
  depthIn.addEventListener("blur", () => commit());
  tempIn.addEventListener("blur", () => commit());
  depthIn.addEventListener("input", renderLastReading);

  function finish() {
    commit();
    const p = session.progress();
    const flags = session.review();
    const s = session.stats();

    openSheet(`${shortDate(Date.parse(date + "T12:00:00"))} — ${p.measured} points`, [
      el("div.row", { style: { gap: "var(--s2)" } }, [
        el("span.chip", { text: s.n ? `thinnest ${s.min.toFixed(2)}"` : "nothing measured" }),
        s.n ? el("span.chip", { text: `average ${s.mean.toFixed(2)}"` }) : null,
        el("span.chip", {
          style: { color: p.durable ? "var(--green)" : "var(--amber)" },
          text: p.durable ? "all saved" : `${p.inflight} still sending`,
        }),
      ]),
      p.remaining > 0
        ? el("p.muted.prose", {
            text: `${p.remaining} point${p.remaining === 1 ? "" : "s"} not measured yet. That's fine — the session stays open and you can come back to it.`,
          })
        : null,
      flags.length
        ? el("div", {}, [
            el("p.section-title", { text: "Worth a second look" }),
            ...flags.map((f) =>
              el("div.row", { style: { marginTop: "var(--s2)" } }, [
                el("span.num.fixed", {
                  style: { minWidth: "58px", color: f.thin ? "var(--red)" : "var(--amber)" },
                  text: `${f.depth_in.toFixed(2)}"`,
                }),
                el("span.grow", {}, [
                  el("div", { text: `Point ${f.point_nbr}` }),
                  el("div.dim", {
                    style: { fontSize: "12px" },
                    text: [
                      f.thin ? "under the thin threshold" : null,
                      f.odd && f.neighbour_mean != null
                        ? `${Math.abs(f.off_by).toFixed(2)}" ${f.off_by < 0 ? "below" : "above"} its neighbours`
                        : null,
                      f.wild ? "outside the usual range — check the reading" : null,
                    ]
                      .filter(Boolean)
                      .join(" · "),
                  }),
                ]),
                el("button.btn.small.fixed", {
                  type: "button",
                  text: "Go",
                  onclick: () => {
                    closeSheet();
                    session.jumpTo(f.point_nbr);
                    renderAll();
                  },
                }),
              ])
            ),
          ])
        : el("p.muted.prose", { text: "Nothing looks out of place." }),
      el("div.row", { style: { marginTop: "var(--s4)", gap: "var(--s2)" } }, [
        el("button.btn.grow", { type: "button", text: "Keep measuring", onclick: closeSheet }),
        el("button.btn.primary.grow", {
          type: "button",
          text: "See the map",
          onclick: () => {
            closeSheet();
            navigate(`/ice?date=${date}`);
          },
        }),
      ]),
    ]);
  }

  root.append(
    banner,
    el("div.card", {}, [
      el("div.row", { style: { gap: "var(--s2)" } }, [
        el("span.grow", {}, [
          pointTitle,
          pointNote,
        ]),
        el("div.row", { style: { gap: "var(--s1)", justifyContent: "flex-end" } }, [progressChip, savedChip]),
      ]),
      el("div.row", { style: { marginTop: "var(--s3)", gap: "var(--s3)" } }, [
        el("span.grow", {}, [
          el("div.field", {}, [el("label", { text: "Depth (inches)" }), depthIn]),
          lastLine,
        ]),
        el("span.fixed", { style: { width: "34%" } }, [
          el("div.field", {}, [el("label", { text: "Temp °F" }), tempIn]),
        ]),
      ]),
      hint,
      el("div.row", { style: { marginTop: "var(--s3)", gap: "var(--s2)" } }, [
        el("button.btn.grow", { type: "button", text: "← Back", onclick: () => step(-1) }),
        el("button.btn.primary.grow", { type: "button", text: "Next →", onclick: () => step(1) }),
      ]),
      el("div", { style: { marginTop: "var(--s4)" } }, [sheet.canvas]),
      el("p.dim", {
        style: { fontSize: "12px", marginTop: "var(--s2)" },
        text: "Green means the server has it. Amber is still sending. Tap any dot to jump there.",
      }),
      el("div.row", { style: { marginTop: "var(--s3)", gap: "var(--s2)" } }, [
        orderBtn,
        el("button.btn.grow", {
          type: "button",
          text: "Next gap",
          onclick: () => {
            commit();
            const gap = session.nextUnmeasured();
            if (gap == null) return toast("Every point is measured", "green");
            session.jumpTo(gap);
            renderAll();
          },
        }),
        el("button.btn.primary.grow", { type: "button", text: "Finish", onclick: finish }),
      ]),
    ])
  );

  // Resume whatever is already recorded for this date before anything renders,
  // so an interrupted walk picks up at the gap instead of back at point 1.
  try {
    const existing = await get(`/api/ice/session?rink=U&date=${date}`);
    if (existing?.points) {
      session.hydrate(existing.points);
      prevDate = existing.prev_date ?? null;
      for (const p of existing.points) {
        if (p.prev_depth_in != null) prevByPoint.set(p.point_nbr, p.prev_depth_in);
      }
    }
  } catch {
    // Losing the previous-reading hints is survivable; losing what is already
    // saved is not, because the walk would restart at point 1 over the top of
    // real data. Say so rather than starting a silent second session.
    toast("Couldn't check what's already saved — starting fresh", "amber");
  }

  const offSettled = outbox.onSettled(({ entry, outcome, reason }) => {
    if (entry.meta?.date !== date) return;
    if (outcome === outbox.SENT) session.markSaved(entry.meta.points);
    else session.markFailed(entry.meta.points, reason);
    renderAll();
  });
  const offChange = outbox.onChange(renderBanner);

  renderAll();
  requestAnimationFrame(paint);
  depthIn.focus();

  return () => {
    commit();
    offSettled();
    offChange();
    sheet.destroy();
  };
}

// ── Registration ──────────────────────────────────────────────────────

register({
  id: "ice",
  path: "/ice",
  title: "Ice",
  label: "Ice",
  icon: "❄",
  alsoOwns: ["/ice/entry"],
  async mount(ctx) {
    return ctx.url.pathname === "/ice/entry" ? mountEntry(ctx) : mountRead(ctx);
  },
});
