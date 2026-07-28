// Maintenance — the full per-machine log behind the home summary.
//
// Home answers "is anything due". This answers "what has actually been done to
// this machine", which is the question the GM asks and the question a new crew
// member needs answered before they touch anything.

import { register } from "/shared/views.js";
import { get, post } from "/shared/api.js";
import { el, clear, empty, openSheet, closeSheet, toast } from "/shared/ui.js";
import { ago, stamp } from "/shared/lib/dates.js";

const OUTCOME_LABEL = {
  went_well: "went well",
  had_issues: "had issues",
  something_wrong: "something else was wrong",
};
const OUTCOME_TONE = { went_well: "green", had_issues: "amber", something_wrong: "red" };

register({
  id: "maintenance",
  path: "/maintenance",
  title: "Maintenance",
  label: "Maint",
  icon: "⚙",

  async mount({ root, state }) {
    const render = async () => {
      clear(root);
      const [tickers, log, propane] = await Promise.all([
        get("/api/tickers"),
        get("/api/maintenance?limit=200"),
        get("/api/propane/history?limit=100"),
      ]);

      // Group by machine — the mental model is "the 546" and "the Olympia",
      // not a flat list of task types.
      const machines = new Map();
      for (const t of tickers) {
        const key = t.machine_id ?? 0;
        if (!machines.has(key)) {
          machines.set(key, { name: t.machine_name ?? "General", rink: t.rink_code, tickers: [] });
        }
        machines.get(key).tickers.push(t);
      }

      for (const [id, m] of machines) {
        const card = el("div.card", {}, [
          el("div.row", {}, [
            el("p.section-title.grow", { style: { margin: 0 }, text: m.name }),
            m.rink ? el("span.chip.fixed", { text: m.rink === "U" ? "Upper" : "Lower" }) : null,
          ]),
        ]);

        for (const t of m.tickers) {
          const entries = log.filter((l) => l.ticker_id === t.id);
          card.append(
            el("div", { style: { marginTop: "var(--s4)" } }, [
              el("div.row", {}, [
                el("span.grow", {}, [
                  el("div", { style: { fontWeight: "650" }, text: t.label }),
                  el("div.dim", {
                    style: { fontSize: "12px" },
                    text: t.interval_days ? `every ${t.interval_days} days` : "no set interval",
                  }),
                ]),
                el(`span.chip.fixed.${t.state}`, {
                  text: t.never ? "never done" : t.state === "red" ? "due" : t.state === "amber" ? "soon" : "ok",
                }),
              ]),
              entries.length
                ? el(
                    "div",
                    { style: { marginTop: "var(--s2)" } },
                    entries.slice(0, 6).map((l) =>
                      el("div.row", { style: { marginTop: "var(--s1)" } }, [
                        el("span.grow", {}, [
                          el("div.dim", {
                            style: { fontSize: "13px" },
                            text: `${l.done_by} · ${stamp(l.done_at)}`,
                          }),
                          l.notes
                            ? el("div.dim", { style: { fontSize: "12px", fontStyle: "italic" }, text: l.notes })
                            : null,
                        ]),
                        el(`span.chip.fixed.${OUTCOME_TONE[l.outcome] ?? ""}`, {
                          text: OUTCOME_LABEL[l.outcome] ?? l.outcome,
                        }),
                      ])
                    )
                  )
                : el("p.dim", { style: { fontSize: "12px", margin: "var(--s2) 0 0" }, text: "No entries yet." }),
            ])
          );
        }

        // Propane sits under its machine here, where the full swap history is
        // the point — home only shows time-since.
        const swaps = propane.filter((p) => p.machine_id === id);
        if (swaps.length) {
          card.append(
            el("div", { style: { marginTop: "var(--s5)" } }, [
              el("p.section-title", { text: "Propane swaps" }),
              ...swaps.slice(0, 10).map((p) =>
                el("div.row", { style: { marginTop: "var(--s1)" } }, [
                  el("span.chip.fixed", { text: `${p.side} tank` }),
                  el("span.grow.dim", { style: { fontSize: "13px" }, text: `${p.swapped_by} · ${stamp(p.swapped_at)}` }),
                  el("span.fixed.dim", { style: { fontSize: "12px" }, text: ago(p.swapped_at) }),
                ])
              ),
            ])
          );
        }

        root.append(card);
      }

      if (!machines.size) root.append(empty("No machines configured", "Add them in Settings."));
    };

    await render();
    return () => {};
  },
});
