// Settings — admin-gated. Ticker intervals, thresholds, member management,
// archive window, cron health.
//
// Registered unconditionally so there is always a way in to unlock admin; the
// controls inside are what gate on the PIN, not the tab.

import { register } from "/shared/views.js";
import { get, put, patch, post } from "/shared/api.js";
import { el, clear, toast, openSheet, closeSheet } from "/shared/ui.js";
import { ago, stamp } from "/shared/lib/dates.js";

const NUMERIC = [
  { key: "archive_days", label: "Archive done cards after", unit: "days", hint: "Done cards fade, then leave the board." },
  { key: "thin_spot_in", label: "Thin-spot threshold", unit: "inches", hint: "Depths at or under this are called out." },
  { key: "trend_window_days", label: "Erosion trend window", unit: "days", hint: "How far back the per-point trend looks." },
  { key: "anomaly_window_days", label: "Anomaly baseline window", unit: "days", hint: "Trailing window an entry is compared against." },
];

register({
  id: "settings",
  path: "/settings",
  title: "Settings",
  label: "Settings",
  icon: "⚙",

  async mount({ root, state, refresh }) {
    const render = async () => {
      clear(root);

      if (!state.isAdmin) {
        root.append(
          el("div.card", {}, [
            el("p.section-title", { text: "Admin only" }),
            el("p.muted.prose", {
              text: "Settings change what everyone sees, so they sit behind a PIN. Everything else in this app is one tap and needs no sign-in.",
            }),
            el("button.btn.primary", {
              type: "button",
              text: "Unlock with PIN",
              onclick: () => import("/app.js").then((m) => m.openAdminUnlock()),
            }),
          ])
        );
        return;
      }

      const [settings, members, health] = await Promise.all([
        get("/api/settings"),
        get("/api/members"),
        get("/api/jobs/health").catch(() => null),
      ]);

      root.append(tickerCard(state, settings, refresh));
      root.append(numericCard(settings));
      root.append(memberCard(members, render));
      root.append(healthCard(health));
      root.append(
        el("div.card", {}, [
          el("p.section-title", { text: "Build" }),
          el("div.row", {}, [
            el("span.grow.muted", { text: "Running version" }),
            el("span.num.fixed", { text: state.build }),
          ]),
          el("button.btn.small", {
            type: "button",
            text: "Lock admin",
            style: { marginTop: "var(--s3)" },
            onclick: async () => {
              await post("/api/admin/lock", {});
              await refresh();
              toast("Admin locked");
              render();
            },
          }),
        ])
      );
    };

    await render();
    return () => {};
  },
});

function numericCard(settings) {
  const card = el("div.card", {}, [el("p.section-title", { text: "Thresholds" })]);
  for (const f of NUMERIC) {
    const input = el("input.input", {
      type: "number",
      step: "any",
      value: settings[f.key] ?? "",
      inputmode: "decimal",
    });
    input.addEventListener("change", async () => {
      try {
        await put("/api/settings", { [f.key]: input.value });
        toast("Saved", "green");
      } catch (err) {
        toast(err.message, "red");
      }
    });
    card.append(
      el("div.field", { style: { marginTop: "var(--s3)" } }, [
        el("label", { text: `${f.label} (${f.unit})` }),
        input,
        el("span.dim", { style: { fontSize: "12px" }, text: f.hint }),
      ])
    );
  }
  return card;
}

function tickerCard(state, settings, refresh) {
  const card = el("div.card", {}, [el("p.section-title", { text: "Maintenance intervals" })]);

  // Honesty about seeded values: these were placeholders until somebody who
  // actually services the machines sets them.
  if (settings.ticker_intervals_are_defaults === "1") {
    card.append(
      el("p.muted.prose", {
        style: { marginTop: 0 },
        text: "These intervals are placeholders picked at build time. Set them to the real service intervals — the banner clears once you save any of them.",
      })
    );
  }

  const body = el("div", { style: { display: "flex", flexDirection: "column", gap: "var(--s3)" } });
  card.append(body);

  const load = async () => {
    clear(body);
    const tickers = await get("/api/tickers").catch(() => []);
    if (!tickers.length) {
      body.append(el("p.dim", { text: "No tickers configured." }));
      return;
    }
    for (const t of tickers) {
      const input = el("input.input", {
        type: "number",
        min: "1",
        step: "1",
        value: t.interval_days ?? "",
        placeholder: "no deadline",
        style: { maxWidth: "120px" },
      });
      input.addEventListener("change", async () => {
        try {
          await patch(`/api/tickers/${t.id}`, {
            interval_days: input.value === "" ? null : Number(input.value),
          });
          await put("/api/settings", { ticker_intervals_are_defaults: "0" });
          toast("Saved", "green");
          await refresh();
        } catch (err) {
          toast(err.message, "red");
        }
      });
      body.append(
        el("div.row", {}, [
          el("span.grow.truncate", { text: t.label }),
          el("span.fixed", {}, [input]),
          el("span.fixed.dim", { style: { fontSize: "12px" }, text: "days" }),
        ])
      );
    }
  };
  load();
  return card;
}

function memberCard(members, rerender) {
  const card = el("div.card", {}, [el("p.section-title", { text: "Crew" })]);

  for (const m of members) {
    card.append(
      el("div.row", { style: { marginTop: "var(--s2)" } }, [
        el("span.grow.truncate", {
          text: m.name,
          style: { opacity: m.active ? "1" : "0.5" },
        }),
        el("span.chip.fixed", { text: m.role === "admin" ? "admin" : "crew" }),
        el("button.btn.small.fixed", {
          type: "button",
          text: m.active ? "Remove" : "Restore",
          onclick: async () => {
            await patch("/api/members", { id: m.id, active: !m.active });
            toast(m.active ? `${m.name} removed` : `${m.name} restored`);
            rerender();
          },
        }),
      ])
    );
  }

  const nameInput = el("input.input", { type: "text", placeholder: "Name", maxlength: "40" });
  card.append(
    el("div.field", { style: { marginTop: "var(--s4)" } }, [
      el("label", { text: "Add crew member" }),
      el("div.row", {}, [
        el("span.grow", {}, [nameInput]),
        el("button.btn.primary.fixed", {
          type: "button",
          text: "Add",
          onclick: async () => {
            const name = nameInput.value.trim();
            if (!name) return;
            await post("/api/members/add", { name });
            nameInput.value = "";
            toast(`${name} added`, "green");
            rerender();
          },
        }),
      ]),
      el("span.dim", {
        style: { fontSize: "12px" },
        text: "Crew can also add themselves the first time they open the app.",
      }),
    ])
  );
  return card;
}

function healthCard(health) {
  const card = el("div.card", {}, [el("p.section-title", { text: "Scheduled jobs" })]);
  if (!health || !health.length) {
    // The weather pull died silently for ten sessions in the old app. An empty
    // health card says so out loud instead of showing nothing.
    card.append(
      el("p.dim.prose", {
        text: "No job has reported a run yet. If this stays empty after the next morning pull, the cron is not firing.",
      })
    );
    return card;
  }
  for (const j of health) {
    const tone = !j.ok ? "red" : Date.now() - j.ran_at > 36 * 3600e3 ? "amber" : "green";
    card.append(
      el("div.row", { style: { marginTop: "var(--s2)" } }, [
        el("span.grow.truncate", { text: j.job }),
        el("span.fixed.num.dim", { style: { fontSize: "12px" }, text: stamp(j.ran_at) }),
        el(`span.chip.fixed.${tone}`, { text: j.ok ? ago(j.ran_at) : "failed" }),
      ])
    );
  }
  return card;
}
