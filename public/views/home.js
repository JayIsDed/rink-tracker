// Home — the trust surface.
//
// Ruled 07-28: maintenance tickers + propane + the project board + the activity
// feed, all up front. Detail logs live behind. The n-71 IA fork is closed —
// summary here, depth in the tabs.
//
// The audience fact that shapes every choice below: Art, the General Manager,
// reads this on a desktop. Legible cold, credible half-empty, no stubs.

import { register } from "/shared/views.js";
import { get, post, patch, del, upload } from "/shared/api.js";
import { el, clear, empty, openSheet, closeSheet, toast, tick } from "/shared/ui.js";
import { ago, stamp, dueLabel, clock12 } from "/shared/lib/dates.js";
import { nextIceCut, iceCutsOn, cutContext, until } from "/shared/lib/schedule.js";

const SEVERITY_LABEL = { 1: "normal", 2: "elevated", 3: "urgent" };

register({
  id: "home",
  path: "/",
  title: "Rink Tracker",
  label: "Home",
  icon: "◆",
  alsoOwns: ["/board", "/log/propane"],

  async mount({ root, url, state, navigate }) {
    let timer = null;

    const tickerWrap = el("div.card");
    const propaneWrap = el("div.card");
    const boardWrap = el("div.card");
    const feedWrap = el("div.card");
    const iceWrap = el("div.card");
    const cutWrap = el("div.card");

    // Desktop reads side by side; phone stacks. Same DOM, one grid class.
    // The cut strip leads the left column: on a phone it is the first thing
    // under the fold-line, which is the point — it is the only block here that
    // tells you something you did not already know.
    root.append(
      el("div.grid-read", {}, [
        el("div", { style: { display: "flex", flexDirection: "column", gap: "var(--s4)" } }, [
          cutWrap,
          boardWrap,
          iceWrap,
        ]),
        el("div", { style: { display: "flex", flexDirection: "column", gap: "var(--s4)" } }, [
          tickerWrap,
          propaneWrap,
          feedWrap,
        ]),
      ])
    );

    const reload = async () => {
      const now = Date.now();
      const dayStart = new Date(now).setHours(0, 0, 0, 0);
      const [overview, cards, feed, sessions, slots] = await Promise.all([
        get("/api/overview"),
        get("/api/cards"),
        get(`/api/feed?since=${lastSeen()}&limit=25`),
        get("/api/sessions?limit=3"),
        // Two days: today's list plus enough runway that the "next cut" line
        // doesn't go blank at 9pm when the next one is tomorrow morning.
        get(`/api/schedule?from=${dayStart}&to=${dayStart + 2 * 86400000}`).catch(() => []),
      ]);
      renderTickers(tickerWrap, overview.tickers, state, reload);
      renderPropane(propaneWrap, overview.propane, state, reload);
      renderBoard(boardWrap, cards, state, reload);
      renderFeed(feedWrap, feed);
      renderIce(iceWrap, sessions, navigate, Number(state.settings?.thin_spot_in ?? 2) || 2);
      renderCuts(cutWrap, slots, navigate, now);
    };

    await reload();

    // A deep link from an NFC tag lands here with the form already open.
    if (url.pathname === "/log/propane") {
      const rink = url.searchParams.get("rink");
      const side = url.searchParams.get("side");
      if ((rink === "U" || rink === "L") && (side === "L" || side === "R")) {
        const slots = (await get("/api/propane")).filter((s) => s.rink_code === rink && s.side === side);
        if (slots[0]) openPropaneSheet(slots[0], reload);
      }
    }

    // Slow refresh — tickers are day-grained, so anything faster is noise.
    timer = setInterval(() => reload().catch(() => {}), 60000);
    return () => clearInterval(timer);
  },
});

// ── Since-marker ──────────────────────────────────────────────────────
// Per-device, held client-side. The feed is a query; "new" is a comparison.

function lastSeen() {
  return Number(localStorage.getItem("rt:lastSeen") || 0);
}
function markSeen(at) {
  if (at) localStorage.setItem("rt:lastSeen", String(at));
}

// ── Tickers ───────────────────────────────────────────────────────────

function renderTickers(wrap, tickers, state, reload) {
  clear(wrap).append(el("p.section-title", { text: "Maintenance" }));
  if (!tickers.length) {
    wrap.append(empty("No tickers configured", "Add them in Settings."));
    return;
  }

  for (const t of tickers) {
    const tone = t.state;
    const when = t.never ? "never done" : ago(t.last_done_at);
    const detail = t.never
      ? "no record yet"
      : t.due_in_days == null
        ? `by ${t.last_done_by ?? "—"}`
        : t.due_in_days >= 0
          ? `due in ${t.due_in_days}d`
          : `${Math.abs(t.due_in_days)}d overdue`;

    wrap.append(
      el("div.row", { style: { marginTop: "var(--s3)" } }, [
        el("span.grow", {}, [
          el("div.truncate", { text: t.label }),
          el("div.dim", {
            style: { fontSize: "12px" },
            text: `${when}${t.nudged ? " · nudged" : ""} · ${detail}`,
          }),
        ]),
        el(`span.chip.fixed.${tone}`, { text: tone === "red" ? "due" : tone === "amber" ? "soon" : "ok" }),
        el("button.btn.small.fixed", {
          type: "button",
          text: "Log",
          onclick: () => openCompleteSheet(t, reload),
        }),
      ])
    );
  }

  wrap.append(
    el("p.dim", {
      style: { fontSize: "12px", marginTop: "var(--s4)", marginBottom: 0 },
      text: "Noticed something between services? Long-press a ticker to nudge it.",
    })
  );

  // Nudge on long-press — anyone can push a ticker amber.
  for (const row of wrap.querySelectorAll(".row")) {
    let held = null;
    const idx = [...wrap.querySelectorAll(".row")].indexOf(row);
    const t = tickers[idx];
    if (!t) continue;
    const start = () => {
      held = setTimeout(async () => {
        try {
          await post(`/api/tickers/${t.id}/nudge`, {});
          tick(20);
          toast(`${t.label} nudged`, "amber");
          reload();
        } catch (err) {
          toast(err.message, "red");
        }
      }, 550);
    };
    const cancel = () => clearTimeout(held);
    row.addEventListener("pointerdown", start);
    row.addEventListener("pointerup", cancel);
    row.addEventListener("pointerleave", cancel);
    row.addEventListener("pointercancel", cancel);
  }
}

function openCompleteSheet(t, reload) {
  const notes = el("textarea.input", { placeholder: "Anything worth writing down (optional)" });
  const status = el("div.dim", { text: "" });

  const submit = async (outcome) => {
    try {
      const res = await post(`/api/tickers/${t.id}/complete`, { outcome, notes: notes.value });
      closeSheet();
      if (res.spawned_card) {
        toast("Logged — and a card is on the board", "amber");
      } else {
        toast("Logged", "green");
      }
      reload();
    } catch (err) {
      status.textContent = err.message;
      status.style.color = "var(--red)";
    }
  };

  openSheet(t.label, [
    el("p.muted.prose", { text: "How did it go?" }),
    el("div", { style: { display: "flex", flexDirection: "column", gap: "var(--s2)" } }, [
      el("button.btn.primary", { type: "button", text: "Went well", onclick: () => submit("went_well") }),
      el("button.btn", { type: "button", text: "Had issues", onclick: () => submit("had_issues") }),
      // The third option is the one that feeds the board.
      el("button.btn.danger", {
        type: "button",
        text: "Something else is wrong",
        onclick: () => submit("something_wrong"),
      }),
    ]),
    el("p.dim", {
      style: { fontSize: "12px" },
      text: "“Something else is wrong” puts a card on the board for you, with your name and this note on it.",
    }),
    el("div.field", {}, [el("label", { text: "Notes" }), notes]),
    status,
  ]);
}

// ── Propane ───────────────────────────────────────────────────────────

function renderPropane(wrap, slots, state, reload) {
  clear(wrap).append(el("p.section-title", { text: "Propane" }));

  const byMachine = new Map();
  for (const s of slots) {
    if (!byMachine.has(s.machine_id)) byMachine.set(s.machine_id, []);
    byMachine.get(s.machine_id).push(s);
  }

  for (const [, sides] of byMachine) {
    wrap.append(
      el("div", { style: { marginTop: "var(--s3)" } }, [
        el("div.row", {}, [
          el("span.grow.truncate", { text: sides[0].machine_name }),
          el("span.chip.fixed", { text: sides[0].rink_code === "U" ? "Upper" : "Lower" }),
        ]),
        el(
          "div.row",
          { style: { marginTop: "var(--s2)", gap: "var(--s2)" } },
          sides.map((s) =>
            el(
              "button.btn.small.grow",
              {
                type: "button",
                style: { flexDirection: "column", alignItems: "flex-start", minHeight: "52px", gap: "0" },
                onclick: () => openPropaneSheet(s, reload),
              },
              [
                el("span", { style: { fontWeight: "700" }, text: `${s.side} tank` }),
                // No deadline — propane is time-since only, so this never
                // turns red for being old. It just says how long it has been.
                el("span.num.dim", {
                  style: { fontSize: "12px", fontWeight: "500" },
                  text: s.swapped_at ? ago(s.swapped_at) : "no swaps logged",
                }),
              ]
            )
          )
        ),
      ])
    );
  }
}

function openPropaneSheet(slot, reload) {
  const notes = el("input.input", { type: "text", placeholder: "Notes (optional)", maxlength: "200" });
  const status = el("div.dim", { text: "" });

  openSheet(`${slot.machine_name} — ${slot.side} tank`, [
    el("p.muted.prose", {
      text: slot.swapped_at
        ? `Last swapped ${ago(slot.swapped_at)} by ${slot.swapped_by} — ${stamp(slot.swapped_at)}.`
        : "No swap has been logged for this tank yet.",
    }),
    el("div.field", {}, [el("label", { text: "Notes" }), notes]),
    el("button.btn.primary", {
      type: "button",
      text: "Log a swap now",
      onclick: async () => {
        try {
          await post("/api/propane", {
            machine_id: slot.machine_id,
            side: slot.side,
            notes: notes.value,
          });
          closeSheet();
          tick();
          toast("Swap logged", "green");
          reload();
        } catch (err) {
          status.textContent = err.message;
          status.style.color = "var(--red)";
        }
      },
    }),
    el("p.dim", { style: { fontSize: "12px" }, text: `${slot.swap_count} swap(s) on record for this side.` }),
    status,
  ]);
}

// ── Board ─────────────────────────────────────────────────────────────

function renderBoard(wrap, cards, state, reload) {
  clear(wrap).append(
    el("div.row", {}, [
      el("p.section-title.grow", { style: { margin: "0" }, text: "Board" }),
      el("button.btn.small.fixed", { type: "button", text: "+ New", onclick: () => openCardSheet(null, state, reload) }),
    ])
  );

  const open = cards.filter((c) => c.status !== "done");
  const done = cards.filter((c) => c.status === "done");

  if (!cards.length) {
    wrap.append(
      empty("Nothing on the board", "Anything that needs doing goes here — tap New, or log it off a maintenance check.")
    );
    return;
  }

  for (const c of open) wrap.append(cardRow(c, state, reload));
  if (done.length) {
    wrap.append(
      el("p.section-title", { style: { marginTop: "var(--s5)" }, text: `Done (${done.length})` })
    );
    for (const c of done) wrap.append(cardRow(c, state, reload));
  }
}

function cardRow(c, state, reload) {
  const due = dueLabel(c, Date.now());
  const isDone = c.status === "done";

  // Severity rides the font and, at the top tier, glows the card — the pad's
  // own grammar, crew-side. The surface stays glass.
  const glow = c.severity === 3 && !isDone;

  const node = el(
    "div",
    {
      style: {
        marginTop: "var(--s3)",
        padding: "var(--s3)",
        borderRadius: "var(--r-md)",
        border: "1px solid var(--border)",
        background: "rgba(255,255,255,0.02)",
        opacity: isDone ? "0.55" : "1",
        boxShadow: glow ? "var(--glow-red)" : "none",
      },
    },
    [
      el("div.row", { style: { gap: "var(--s3)" } }, [
        // A photo on the row is the whole reason the crew would rather log a
        // card than say it out loud — "that crack" is one glance, not a
        // paragraph. 44px keeps the row height honest on a phone.
        c.photos?.length
          ? el("span.fixed", { style: { position: "relative" } }, [
              el("img", {
                src: c.photos[0].thumb_url,
                alt: "",
                loading: "lazy",
                style: {
                  width: "44px",
                  height: "44px",
                  objectFit: "cover",
                  borderRadius: "var(--r-sm)",
                  border: "1px solid var(--border)",
                  display: "block",
                },
              }),
              c.photos.length > 1
                ? el("span.dim", {
                    style: { position: "absolute", right: "2px", bottom: "0", fontSize: "10px", fontWeight: "700" },
                    text: `+${c.photos.length - 1}`,
                  })
                : null,
            ])
          : null,
        el("span.grow", {}, [
          el("div", {
            style: {
              fontWeight: "650",
              color: c.severity === 3 ? "var(--sev-3)" : c.severity === 2 ? "var(--sev-2)" : "var(--text)",
              textDecoration: isDone ? "line-through" : "none",
            },
            text: c.title,
          }),
          el("div.dim", {
            style: { fontSize: "12px" },
            text: isDone
              ? `done by ${c.done_by} · ${ago(c.done_at)}`
              : c.claimed_by
                ? `${c.claimed_by} is on it · ${ago(c.claimed_at)}`
                : `raised by ${c.created_by} · ${ago(c.created_at)}`,
          }),
        ]),
        due ? el(`span.chip.fixed.${due.tone === "neutral" ? "" : due.tone}`, { text: due.label }) : null,
      ]),
      el("div.row", { style: { marginTop: "var(--s2)", gap: "var(--s2)" } }, [
        isDone
          ? el("button.btn.small", { type: "button", text: "Reopen", onclick: () => act(c, "reopen", reload) })
          : c.claimed_by
            ? el("button.btn.small.primary", { type: "button", text: "Done", onclick: () => act(c, "done", reload) })
            : // The claim primitive: one tap, name and timestamp, same verb everywhere.
              el("button.btn.small.primary", { type: "button", text: "I'll take it", onclick: () => act(c, "claim", reload) }),
        !isDone && c.claimed_by === state.who
          ? el("button.btn.small", { type: "button", text: "Drop", onclick: () => act(c, "unclaim", reload) })
          : null,
        el("button.btn.small", { type: "button", text: "Details", onclick: () => openCardSheet(c, state, reload) }),
      ]),
    ]
  );
  return node;
}

async function act(card, action, reload) {
  try {
    await post(`/api/cards/${card.id}/${action}`, {});
    tick();
    reload();
  } catch (err) {
    toast(err.message, "red");
  }
}

/**
 * Photos on a card. Existing ones are links to the full image; pending ones are
 * local File objects held until the card exists, because a photo needs a
 * card_id and a brand-new card doesn't have one yet.
 */
function photoBlock(card, state, { pending, onChanged }) {
  const wrap = el("div.field");

  const fileInput = el("input", {
    type: "file",
    accept: "image/*",
    // `capture` opens the camera directly on a phone, which is the whole point
    // — the crew is standing in front of the thing they are logging.
    capture: "environment",
    multiple: true,
    style: { display: "none" },
  });

  const strip = el("div.row", { style: { flexWrap: "wrap", gap: "var(--s2)", marginTop: "var(--s2)" } });
  const status = el("div.dim", { style: { fontSize: "12px", minHeight: "16px" } });

  function thumb(src, { onRemove, href } = {}) {
    const img = el("img", {
      src,
      alt: "",
      loading: "lazy",
      style: {
        width: "72px",
        height: "72px",
        objectFit: "cover",
        borderRadius: "var(--r-sm)",
        border: "1px solid var(--border)",
        display: "block",
      },
    });
    return el("span.fixed", { style: { position: "relative" } }, [
      href ? el("a", { href, target: "_blank", rel: "noopener" }, [img]) : img,
      onRemove
        ? el("button.btn.small", {
            type: "button",
            "aria-label": "Remove photo",
            text: "×",
            onclick: onRemove,
            style: { position: "absolute", top: "-6px", right: "-6px", minWidth: "28px", padding: "0 8px" },
          })
        : null,
    ]);
  }

  function render() {
    clear(strip);
    for (const p of card?.photos ?? []) {
      strip.append(
        thumb(p.thumb_url, {
          href: p.url,
          // Deleting a photo is destructive and unrecoverable, so it stays an
          // admin lever — same tier as deleting the card itself.
          onRemove: state.isAdmin
            ? async () => {
                if (!confirm("Delete this photo? That can't be undone.")) return;
                try {
                  await del(`/api/cards/${card.id}/photos/${p.id}`);
                  card.photos = card.photos.filter((x) => x.id !== p.id);
                  render();
                  onChanged?.();
                } catch (err) {
                  status.textContent = err.message;
                  status.style.color = "var(--red)";
                }
              }
            : null,
        })
      );
    }
    for (const [i, file] of pending.entries()) {
      strip.append(
        thumb(URL.createObjectURL(file), {
          onRemove: () => {
            pending.splice(i, 1);
            render();
          },
        })
      );
    }
    const n = (card?.photos?.length ?? 0) + pending.length;
    status.textContent = pending.length ? `${pending.length} to upload when you save` : "";
    status.style.color = "";
    wrap.querySelector("label").textContent = n ? `Photos (${n})` : "Photos";
  }

  fileInput.addEventListener("change", () => {
    pending.push(...[...fileInput.files]);
    // Reset so picking the same file twice in a row still fires `change`.
    fileInput.value = "";
    render();
  });

  wrap.append(
    el("label", { text: "Photos" }),
    el("div.row", {}, [
      el("button.btn.grow", {
        type: "button",
        text: "Add a photo",
        onclick: () => fileInput.click(),
      }),
    ]),
    fileInput,
    strip,
    status
  );
  render();
  return wrap;
}

/** Upload whatever is pending against a card that now exists. */
async function flushPhotos(cardId, pending) {
  if (!pending.length) return;
  const fd = new FormData();
  for (const f of pending) fd.append("photos", f, f.name || "photo.jpg");
  await upload(`/api/cards/${cardId}/photos`, fd);
  pending.length = 0;
}

function openCardSheet(card, state, reload) {
  const isNew = !card;
  const pending = [];
  const title = el("input.input", { type: "text", maxlength: "160", value: card?.title ?? "", placeholder: "What needs doing?" });
  const body = el("textarea.input", { placeholder: "Any detail (optional)", value: card?.body ?? "" });
  const status = el("div.dim", { text: "" });

  const severity = el(
    "select.input",
    {},
    [1, 2, 3].map((s) =>
      el("option", { value: String(s), text: SEVERITY_LABEL[s], selected: (card?.severity ?? 1) === s })
    )
  );
  if (!state.isAdmin) {
    // Tier 3 is an admin lever; show why rather than hiding the control.
    severity.querySelector('option[value="3"]').disabled = true;
  }

  const dueKind = el(
    "select.input",
    {},
    [
      el("option", { value: "none", text: "No date", selected: (card?.due_kind ?? "none") === "none" }),
      el("option", { value: "at", text: "By a date", selected: card?.due_kind === "at" }),
      el("option", { value: "before", text: "Before something", selected: card?.due_kind === "before" }),
    ]
  );
  const dueAt = el("input.input", {
    type: "date",
    value: card?.due_at ? new Date(card.due_at).toISOString().slice(0, 10) : "",
  });
  const dueText = el("input.input", {
    type: "text",
    maxlength: "120",
    placeholder: "e.g. the tournament",
    value: card?.due_text ?? "",
  });
  const dueAtField = el("div.field", {}, [el("label", { text: "Date" }), dueAt]);
  const dueTextField = el("div.field", {}, [el("label", { text: "Before what?" }), dueText]);

  const syncDue = () => {
    dueAtField.hidden = dueKind.value !== "at";
    dueTextField.hidden = dueKind.value !== "before";
  };
  dueKind.addEventListener("change", syncDue);
  syncDue();

  const payload = () => {
    const p = {
      title: title.value.trim(),
      body: body.value.trim(),
      severity: Number(severity.value),
      due_kind: dueKind.value,
    };
    if (dueKind.value === "at") p.due_at = dueAt.value ? new Date(dueAt.value + "T12:00:00").getTime() : null;
    if (dueKind.value === "before") p.due_text = dueText.value.trim();
    return p;
  };

  const save = async (claim) => {
    if (!title.value.trim()) {
      status.textContent = "Give it a title.";
      status.style.color = "var(--red)";
      return;
    }
    try {
      // The card has to exist before a photo can reference it, so a new card is
      // written first and the pending files follow.
      const saved = isNew ? await post("/api/cards", { ...payload(), claim }) : await patch(`/api/cards/${card.id}`, payload());
      if (pending.length) {
        status.textContent = `Uploading ${pending.length} photo${pending.length === 1 ? "" : "s"}…`;
        status.style.color = "";
        try {
          await flushPhotos(saved.id, pending);
        } catch (err) {
          // The card is already saved. Say exactly that, and leave the sheet
          // open holding the files — closing here would look like success and
          // lose the picture.
          status.textContent = `Card saved, but the photos didn't upload: ${err.message}`;
          status.style.color = "var(--red)";
          reload();
          return;
        }
      }
      closeSheet();
      toast(isNew ? "On the board" : "Saved", "green");
      reload();
    } catch (err) {
      status.textContent = err.message;
      status.style.color = "var(--red)";
    }
  };

  openSheet(isNew ? "New card" : "Card", [
    el("div.field", {}, [el("label", { text: "Title" }), title]),
    el("div.field", {}, [el("label", { text: "Detail" }), body]),
    el("div.field", {}, [
      el("label", { text: state.isAdmin ? "Severity" : "Severity (urgent is admin-only)" }),
      severity,
    ]),
    el("div.field", {}, [el("label", { text: "Due" }), dueKind]),
    dueAtField,
    dueTextField,
    photoBlock(card, state, { pending, onChanged: reload }),
    status,
    el("div.row", { style: { gap: "var(--s2)" } }, [
      el("button.btn.primary.grow", { type: "button", text: isNew ? "Add to board" : "Save", onclick: () => save(false) }),
      isNew
        ? el("button.btn.grow", { type: "button", text: "Add + I'll take it", onclick: () => save(true) })
        : null,
    ]),
    card && !isNew
      ? el("p.dim", {
          style: { fontSize: "12px" },
          text: `Raised by ${card.created_by} · ${stamp(card.created_at)}`,
        })
      : null,
  ]);
}

// ── Feed + ice strip ──────────────────────────────────────────────────

const FEED_VERB = {
  card_created: "raised",
  card_claimed: "took",
  card_done: "finished",
  maintenance: "logged",
  propane: "swapped",
  edger: "ran",
  nudge: "flagged",
};

function renderFeed(wrap, feed) {
  clear(wrap).append(
    el("div.row", {}, [
      el("p.section-title.grow", { style: { margin: 0 }, text: "Activity" }),
      feed.unseen > 0 ? el("span.chip.fixed.amber", { text: `${feed.unseen} new` }) : null,
    ])
  );

  if (!feed.events.length) {
    wrap.append(empty("Nothing logged yet", "Anything anyone does shows up here."));
    return;
  }

  for (const e of feed.events.slice(0, 12)) {
    wrap.append(
      el("div.row", { style: { marginTop: "var(--s2)" } }, [
        el("span.grow", {}, [
          el("div.truncate", { text: `${e.actor ?? "someone"} ${FEED_VERB[e.kind] ?? "did"} ${e.summary}` }),
          el("div.dim", { style: { fontSize: "12px" }, text: ago(e.at) }),
        ]),
      ])
    );
  }
  markSeen(feed.events[0].at);
}

// ── Ice-cut strip ─────────────────────────────────────────────────────
//
// Runbook R2. The only block on this page that tells the reader something they
// did not already know — everything else here is a summary of what the crew
// themselves wrote down. That asymmetry is why it leads the column.

function renderCuts(wrap, slots, navigate, now) {
  clear(wrap).append(
    el("div.row", {}, [
      el("p.section-title.grow", { style: { margin: 0 }, text: "Ice cuts" }),
      el("button.btn.small.fixed", {
        type: "button",
        text: "All",
        onclick: () => navigate("/schedule"),
      }),
    ])
  );

  if (!Array.isArray(slots) || !slots.length) {
    // Distinguishable from "the pull failed" — the Schedule screen states
    // freshness outright, and this points there rather than guessing here.
    wrap.append(empty("No cuts scheduled today", "Tap All to check the week."));
    return;
  }

  const next = nextIceCut(slots, now);
  const todays = iceCutsOn(slots, isoLocal(now));

  if (next) {
    const running = next.starts_at <= now;
    const { before, after } = cutContext(slots, next);
    wrap.append(
      el("div.row", { style: { marginTop: "var(--s3)" } }, [
        el("span.grow", {}, [
          el("div", {
            style: { fontWeight: "650" },
            text: `${clock12(next.starts_at)} · ${next.rink_code === "U" ? "Upper" : "Lower"}`,
          }),
          // What the cut sits between, in one line. This is the whole reason a
          // crew member would rather glance here than walk to the printout.
          el("div.dim.truncate", {
            style: { fontSize: "12px" },
            text:
              before && after
                ? `after ${before.title} · then ${after.title}`
                : before
                  ? `after ${before.title} · last cut of the day`
                  : after
                    ? `first on the sheet · then ${after.title}`
                    : "next cut",
          }),
        ]),
        el(`span.chip.fixed.${running ? "green" : (next.starts_at - now) / 60000 <= 15 ? "amber" : ""}`, {
          text: running ? "on now" : until(next.starts_at, now),
        }),
      ])
    );
  }

  if (todays.length) {
    wrap.append(
      el("p.dim", {
        style: { fontSize: "12px", marginTop: "var(--s3)", marginBottom: "var(--s1)" },
        text: `Today · ${todays.length} cut(s)`,
      }),
      el(
        "div.row",
        { style: { flexWrap: "wrap", gap: "var(--s2)" } },
        todays.map((c) =>
          el("span.chip", {
            style: { opacity: (c.ends_at ?? c.starts_at) < now ? "0.45" : "1" },
            text: `${clock12(c.starts_at)} ${c.rink_code}`,
          })
        )
      )
    );
  } else if (next) {
    wrap.append(
      el("p.dim", { style: { fontSize: "12px", marginTop: "var(--s3)", marginBottom: 0 }, text: "Nothing further today." })
    );
  }
}

function isoLocal(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function renderIce(wrap, sessions, navigate, thinAt = 2) {
  clear(wrap).append(el("p.section-title", { text: "Ice" }));
  if (!sessions.length) {
    wrap.append(empty("No measurements yet", "Sessions logged on the Ice tab land here."));
    return;
  }
  for (const s of sessions) {
    wrap.append(
      el("div.row", {
        // Making the row tappable is what put it under the 44px cold-hands
        // floor — it measured 39px as a plain readout, which was fine when it
        // was not a target.
        style: { marginTop: "var(--s2)", cursor: "pointer", minHeight: "44px" },
        role: "button",
        tabindex: "0",
        onclick: () => navigate(`/ice?date=${s.measure_date}`),
        onkeydown: (e) => (e.key === "Enter" || e.key === " ") && navigate(`/ice?date=${s.measure_date}`),
      }, [
        el("span.grow", {}, [
          el("div", { text: `${s.rink_code === "U" ? "Upper" : "Lower"} · ${s.measure_date}` }),
          el("div.dim", { style: { fontSize: "12px" }, text: `${s.depth_count} points measured` }),
        ]),
        el("span.num.fixed", {
          // Threshold comes from settings, not a literal — the same number the
          // Ice surface calls thin has to be the number this strip reddens on,
          // or the front page and the detail screen disagree in front of the GM.
          style: { color: s.min_depth != null && s.min_depth <= thinAt ? "var(--red)" : "var(--text-2)" },
          text: s.min_depth != null ? `min ${s.min_depth.toFixed(2)}"` : "—",
        }),
      ])
    );
  }
}
