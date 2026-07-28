// Edger — log a run against the rink map.
//
// Ruled 07-28: anchor dots are the default, freehand is the escape hatch. Both
// ship. Tapping the anchor points is faster with gloves on than drawing, and it
// produces data you can actually aggregate; freehand exists because the real
// world does not always fit 35 dots.

import { register } from "/shared/views.js";
import { get, post } from "/shared/api.js";
import { el, clear, empty, toast, tick } from "/shared/ui.js";
import { ago, stamp } from "/shared/lib/dates.js";
import {
  RINK_W, RINK_H, POINT_XY, numericOrder, rinkOutlineCommands, nearestPoint,
} from "/shared/lib/rink-geom.js";

register({
  id: "edger",
  path: "/edger",
  title: "Edger",
  label: "Edger",
  icon: "◎",
  alsoOwns: ["/log/edger"],

  // `setRink` here is the SHELL's, so the choice persists across visits the way
  // round one's global switcher did. The control lives on this surface rather
  // than in the header — rink is meaningful on two screens out of six, and a
  // header control that greys out most of the app is worse than a local one —
  // but "which rink was I on" is still worth remembering between sessions.
  async mount({ root, url, state, navigate, rememberRink }) {
    // A deep link wins over the remembered choice: an NFC tag on the Lower
    // rink's edger means the Lower rink, whatever this phone last looked at.
    let rink = url.searchParams.get("rink") === "L" ? "L" : state.rink === "L" ? "L" : "U";
    let mode = "dots";
    const dots = new Set();
    let path = [];
    let drawing = false;

    const canvas = el("canvas", {
      style: { width: "100%", display: "block", touchAction: "none", borderRadius: "var(--r-md)" },
    });
    const laps = el("input.input", { type: "number", min: "0", max: "99", inputmode: "numeric", placeholder: "optional" });
    const notes = el("input.input", { type: "text", maxlength: "200", placeholder: "optional" });
    const historyWrap = el("div.card");
    const countLabel = el("span.chip", { text: "0 marked" });

    const rinkSwitch = el("div.row", { style: { gap: "var(--s2)" } }, [
      el("button.btn.small.grow", { type: "button", text: "Upper", onclick: () => setRink("U") }),
      el("button.btn.small.grow", { type: "button", text: "Lower", onclick: () => setRink("L") }),
    ]);
    const modeSwitch = el("div.row", { style: { gap: "var(--s2)" } }, [
      el("button.btn.small.grow", { type: "button", text: "Tap points", onclick: () => setMode("dots") }),
      el("button.btn.small.grow", { type: "button", text: "Draw", onclick: () => setMode("path") }),
    ]);

    function markActive() {
      const [u, l] = rinkSwitch.querySelectorAll("button");
      u.classList.toggle("primary", rink === "U");
      l.classList.toggle("primary", rink === "L");
      const [d, p] = modeSwitch.querySelectorAll("button");
      d.classList.toggle("primary", mode === "dots");
      p.classList.toggle("primary", mode === "path");
      countLabel.textContent =
        mode === "dots" ? `${dots.size} marked` : path.length ? `${path.length} points drawn` : "nothing drawn";
    }

    function setRink(r) {
      rink = r;
      rememberRink(r);
      markActive();
      draw();
      loadHistory();
    }
    function setMode(m) {
      mode = m;
      markActive();
      draw();
    }

    // ── Canvas ──
    let scale = 1;
    function sizeCanvas() {
      const rect = canvas.getBoundingClientRect();
      const cssW = rect.width || 320;
      const cssH = (cssW * RINK_H) / RINK_W;
      canvas.style.height = `${cssH}px`;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      const cx = canvas.getContext("2d");
      cx.setTransform(dpr, 0, 0, dpr, 0, 0);
      scale = cssW / RINK_W;
      return cx;
    }

    function draw() {
      const cx = sizeCanvas();
      // Read theme colours fresh every draw — never cached at module load.
      const css = getComputedStyle(document.documentElement);
      const line = css.getPropertyValue("--border-strong").trim() || "#456";
      const accent = css.getPropertyValue("--accent").trim() || "#5cc8f5";
      const dim = css.getPropertyValue("--text-3").trim() || "#748";
      const surface = css.getPropertyValue("--surface").trim() || "#0e141c";

      cx.clearRect(0, 0, canvas.width, canvas.height);
      cx.fillStyle = surface;
      cx.fillRect(0, 0, RINK_W * scale, RINK_H * scale);

      const p = new Path2D();
      for (const [op, ...args] of rinkOutlineCommands(scale)) p[op](...args);
      cx.strokeStyle = line;
      cx.lineWidth = 2;
      cx.stroke(p);

      if (mode === "dots") {
        for (const n of numericOrder()) {
          const xy = POINT_XY.get(n);
          const on = dots.has(n);
          cx.beginPath();
          cx.arc(xy.x * scale, xy.y * scale, on ? 7 : 4.5, 0, Math.PI * 2);
          cx.fillStyle = on ? accent : dim;
          cx.fill();
        }
      } else {
        cx.strokeStyle = accent;
        cx.lineWidth = 4;
        cx.lineJoin = "round";
        cx.lineCap = "round";
        cx.beginPath();
        path.forEach(([x, y], i) => (i ? cx.lineTo(x * scale, y * scale) : cx.moveTo(x * scale, y * scale)));
        cx.stroke();
      }
      markActive();
    }

    function toFeet(ev) {
      const rect = canvas.getBoundingClientRect();
      return [((ev.clientX - rect.left) / rect.width) * RINK_W, ((ev.clientY - rect.top) / rect.height) * RINK_H];
    }

    canvas.addEventListener("pointerdown", (ev) => {
      canvas.setPointerCapture(ev.pointerId);
      const [x, y] = toFeet(ev);
      if (mode === "dots") {
        const hit = nearestPoint(x, y);
        // Only count a tap that lands near a point — a stray tap in open ice
        // should do nothing rather than mark the far side of the rink.
        if (hit && hit.dist < 14) {
          dots.has(hit.point_nbr) ? dots.delete(hit.point_nbr) : dots.add(hit.point_nbr);
          tick();
          draw();
        }
      } else {
        drawing = true;
        path.push([x, y]);
        draw();
      }
    });
    canvas.addEventListener("pointermove", (ev) => {
      if (!drawing || mode !== "path") return;
      const [x, y] = toFeet(ev);
      const last = path[path.length - 1];
      if (!last || Math.hypot(x - last[0], y - last[1]) > 1.5) {
        path.push([x, y]);
        draw();
      }
    });
    const stop = () => (drawing = false);
    canvas.addEventListener("pointerup", stop);
    canvas.addEventListener("pointercancel", stop);

    const onResize = () => draw();
    window.addEventListener("resize", onResize);

    const save = async () => {
      const coverage =
        mode === "dots"
          ? dots.size
            ? { mode: "dots", dots: [...dots] }
            : null
          : path.length
            ? { mode: "path", path }
            : null;
      try {
        await post("/api/edger", {
          rink,
          laps: laps.value === "" ? null : Number(laps.value),
          notes: notes.value,
          coverage,
        });
        dots.clear();
        path = [];
        laps.value = "";
        notes.value = "";
        tick();
        toast("Run logged", "green");
        draw();
        loadHistory();
      } catch (err) {
        toast(err.message, "red");
      }
    };

    async function loadHistory() {
      clear(historyWrap).append(el("p.section-title", { text: "Recent runs" }));
      const runs = await get(`/api/edger?rink=${rink}&limit=15`);
      if (!runs.length) {
        historyWrap.append(empty("No runs logged", "Log one above and it shows up here."));
        return;
      }
      for (const r of runs) {
        const marked =
          r.coverage?.mode === "dots"
            ? `${r.coverage.dots.length} points`
            : r.coverage?.mode === "path"
              ? "freehand"
              : "no map";
        historyWrap.append(
          el("div.row", { style: { marginTop: "var(--s2)" } }, [
            el("span.grow", {}, [
              el("div", { text: `${r.run_by} · ${stamp(r.run_at)}` }),
              el("div.dim", {
                style: { fontSize: "12px" },
                text: `${r.laps != null ? `${r.laps} laps · ` : ""}${marked}${r.notes ? ` · ${r.notes}` : ""}`,
              }),
            ]),
            el("span.fixed.dim", { style: { fontSize: "12px" }, text: ago(r.run_at) }),
          ])
        );
      }
    }

    root.append(
      el("div.card", {}, [
        el("div.row", {}, [
          el("p.section-title.grow", { style: { margin: 0 }, text: "Log a run" }),
          countLabel,
        ]),
        el("div", { style: { marginTop: "var(--s3)" } }, [rinkSwitch]),
        el("div", { style: { marginTop: "var(--s2)" } }, [modeSwitch]),
        el("div", { style: { marginTop: "var(--s3)" } }, [canvas]),
        el("div.row", { style: { marginTop: "var(--s3)", gap: "var(--s3)" } }, [
          el("span.grow", {}, [el("div.field", {}, [el("label", { text: "Laps" }), laps])]),
          el("span.grow", {}, [el("div.field", {}, [el("label", { text: "Notes" }), notes])]),
        ]),
        el("div.row", { style: { marginTop: "var(--s3)", gap: "var(--s2)" } }, [
          el("button.btn.primary.grow", { type: "button", text: "Log run", onclick: save }),
          el("button.btn", {
            type: "button",
            text: "Clear",
            onclick: () => {
              dots.clear();
              path = [];
              draw();
            },
          }),
        ]),
      ]),
      historyWrap
    );

    markActive();
    // First paint after layout so getBoundingClientRect has a real width.
    requestAnimationFrame(draw);
    await loadHistory();

    return () => window.removeEventListener("resize", onResize);
  },
});
