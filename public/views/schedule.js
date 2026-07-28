// Schedule — the pulled ice cuts. The adoption honeypot.
//
// The reason this surface exists: it is the one screen that gives the crew
// something they cannot get from the pen. Everything else in this app asks them
// to write something down; this hands them information they currently walk
// across the building to read off a printout. If anything makes a crew member
// open the app unprompted, it is this.
//
// The source labels ice cuts (`slotType:"maintenance"`, always 10 minutes), so
// nothing here guesses which slots are cuts — see docs/schedule-source.md.

import { register } from "/shared/views.js";
import { get } from "/shared/api.js";
import { el, clear, empty } from "/shared/ui.js";
import { clock12, ago } from "/shared/lib/dates.js";
import {
  groupByDay,
  nextIceCut,
  cutContext,
  dayLabel,
  until,
  pullFreshness,
} from "/shared/lib/schedule.js";

const WINDOW_DAYS = 7;
const RINK_NAME = { U: "Upper", L: "Lower" };

register({
  id: "schedule",
  path: "/schedule",
  title: "Schedule",
  label: "Sched",
  icon: "🗓",

  async mount({ root, state }) {
    // Both rinks by default: the value of this screen is seeing the whole
    // building's day at once. The global rink switcher is about where you are
    // working; the schedule is about what is coming.
    let rink = null;
    let cutsOnly = true;
    let timer = null;

    const heroWrap = el("div.card");
    const listWrap = el("div.card");
    root.append(heroWrap, listWrap);

    const load = async () => {
      const now = Date.now();
      const from = startOfToday(now);
      const [slots, health] = await Promise.all([
        get(`/api/schedule?from=${from}&to=${from + WINDOW_DAYS * 86400000}`),
        get("/api/jobs/health").catch(() => []),
      ]);
      const pull = health.find?.((h) => h.job === "schedule_pull") ?? null;
      renderHero(slots, pull, now);
      renderList(slots, now);
    };

    const renderHero = (slots, pull, now) => {
      const next = nextIceCut(slots, now, rink);
      const fresh = pullFreshness(pull?.ran_at ?? null, now);

      clear(heroWrap).append(
        el("div.row", {}, [
          el("p.section-title.grow", { style: { margin: 0 }, text: "Next ice cut" }),
          // Freshness is stated, not implied. A schedule that quietly went stale
          // looks exactly like a quiet day, and that ambiguity is how the
          // weather job stayed dead for two months.
          el(`span.chip.fixed.${fresh.tone === "green" ? "" : fresh.tone}`, { text: fresh.label }),
        ])
      );

      if (!next) {
        heroWrap.append(
          empty(
            "No more cuts scheduled",
            rink
              ? `Nothing further on the ${RINK_NAME[rink]} rink in the next ${WINDOW_DAYS} days.`
              : `Nothing in the next ${WINDOW_DAYS} days. In the off-season that is expected.`
          )
        );
      } else {
        const running = next.starts_at <= now;
        heroWrap.append(
          el("div", { style: { marginTop: "var(--s3)" } }, [
            el("div.row", {}, [
              el("span.num.grow", {
                style: { fontSize: "30px", fontWeight: "700", lineHeight: "1.1" },
                text: clock12(next.starts_at),
              }),
              el(`span.chip.fixed.${running ? "green" : soonTone(next.starts_at, now)}`, {
                text: running ? "on now" : until(next.starts_at, now),
              }),
            ]),
            el("div.dim", {
              style: { fontSize: "13px", marginTop: "var(--s1)" },
              text: `${RINK_NAME[next.rink_code] ?? next.rink_code} rink · ${dayLabel(
                isoOf(next.starts_at),
                now
              )}`,
            }),
          ])
        );
      }

      heroWrap.append(
        el("div.row", { style: { marginTop: "var(--s4)", gap: "var(--s2)" } }, [
          pill("Both", rink === null, () => setRink(null)),
          pill("Upper", rink === "U", () => setRink("U")),
          pill("Lower", rink === "L", () => setRink("L")),
        ]),
        el("div.row", { style: { marginTop: "var(--s2)", gap: "var(--s2)" } }, [
          pill(cutsOnly ? "Ice cuts only" : "Everything on the sheet", true, () => {
            cutsOnly = !cutsOnly;
            load().catch(() => {});
          }),
        ]),
        pull
          ? el("p.dim", {
              style: { fontSize: "12px", marginTop: "var(--s3)", marginBottom: 0 },
              text: `Pulled ${ago(pull.ran_at)} — ${pull.detail}`,
            })
          : null
      );
    };

    const renderList = (slots, now) => {
      const shown = slots
        .filter((s) => (rink ? s.rink_code === rink : true))
        .filter((s) => (cutsOnly ? s.kind === "ice_cut" : true));

      clear(listWrap).append(el("p.section-title", { text: "Coming up" }));

      const days = groupByDay(shown);
      if (!days.length) {
        listWrap.append(
          empty(
            cutsOnly ? "No ice cuts in the window" : "Nothing booked in the window",
            `The next ${WINDOW_DAYS} days are clear${rink ? ` on the ${RINK_NAME[rink]} rink` : ""}.`
          )
        );
        return;
      }

      for (const day of days) {
        listWrap.append(
          el("p.section-title", {
            style: { marginTop: "var(--s5)", opacity: "0.75" },
            text: `${dayLabel(day.date, now)} · ${day.slots.filter((s) => s.kind === "ice_cut").length} cut(s)`,
          })
        );

        for (const s of day.slots) {
          // In cuts-only mode every row is a cut, and a bare time tells you
          // nothing you can act on. Bracketing it with what comes off and what
          // goes on is the difference between "there is a cut at 3:00" and
          // "you're cutting between Freestyle and IPH".
          if (cutsOnly && s.kind === "ice_cut") {
            listWrap.append(cutBlock(s, slots, now));
          } else {
            listWrap.append(flatRow(s, now));
          }
        }
      }
    };

    const setRink = (r) => {
      rink = r;
      load().catch(() => {});
    };

    await load();

    // Minute-grained, because "in 12 min" is the whole value of the hero and a
    // countdown that lies is worse than no countdown.
    timer = setInterval(() => load().catch(() => {}), 60000);
    return () => clearInterval(timer);
  },
});

/**
 * A cut with the events on either side of it, on a rail:
 *
 *     │  Freestyle Figure Skating          off at 3:00 PM
 *     ▊  3:00 PM  Ice cut · Upper             [in 12 min]
 *     │  IPH                                   on at 3:10 PM
 *
 * The neighbours are deliberately quieter than the cut. They are context for a
 * decision, not things the crew has to do.
 */
function cutBlock(cut, allSlots, now) {
  const { before, after, gapBefore, gapAfter } = cutContext(allSlots, cut);
  const past = (cut.ends_at ?? cut.starts_at) < now;
  const running = cut.starts_at <= now && !past;

  return el(
    "div",
    {
      style: {
        marginTop: "var(--s3)",
        paddingLeft: "var(--s3)",
        borderLeft: `2px solid ${running ? "var(--green)" : "var(--border)"}`,
        opacity: past ? "0.45" : "1",
      },
    },
    [
      neighbourRow(before, "off at", before ? (before.ends_at ?? before.starts_at) : null, gapBefore),

      el("div.row", { style: { marginTop: "var(--s1)" } }, [
        el("span.num.fixed", {
          style: { fontSize: "15px", fontWeight: "700", minWidth: "78px" },
          text: clock12(cut.starts_at),
        }),
        el("span.grow", {}, [
          el("div", { style: { fontWeight: "650" }, text: "Ice cut" }),
          el("div.dim", {
            style: { fontSize: "12px" },
            text: `${RINK_NAME[cut.rink_code] ?? cut.rink_code}${
              cut.ends_at ? ` · 10 min, to ${clock12(cut.ends_at)}` : ""
            }`,
          }),
        ]),
        past
          ? null
          : el(`span.chip.fixed.${running ? "green" : soonTone(cut.starts_at, now)}`, {
              text: running ? "on now" : until(cut.starts_at, now),
            }),
      ]),

      neighbourRow(after, "on at", after ? after.starts_at : null, gapAfter),
    ]
  );
}

/**
 * One side of the sandwich. A null neighbour is stated rather than left blank —
 * "last cut of the day" is information; an empty line is a rendering bug the
 * reader has to interpret.
 */
function neighbourRow(slot, verb, ts, gapMins) {
  if (!slot) {
    return el("div.dim", {
      style: { fontSize: "12px", marginTop: "var(--s1)", fontStyle: "italic" },
      text: verb === "off at" ? "first on the sheet today" : "last cut of the day",
    });
  }
  // Time and gap are SEPARATE fixed children, not one string. `.fixed` is
  // `flex: 0 0 auto`, so a single span takes max-content and refuses to shrink
  // — at the 206px split floor (~142px inside a card) one combined label runs
  // straight past the right edge. Two short children wrap independently and
  // each fits. Same failure the due-pill hit in R2.
  return el("div.row", { style: { marginTop: "var(--s1)" } }, [
    el("span.grow.truncate.dim", { style: { fontSize: "13px" }, text: slot.title }),
    el("span.fixed.dim", { style: { fontSize: "12px" }, text: `${verb} ${clock12(ts)}` }),
    // A gap worth mentioning is one the crew can feel. Anything under a few
    // minutes is just the schedule abutting, which needs no commentary.
    gapMins != null && gapMins >= 5
      ? el("span.fixed.dim", { style: { fontSize: "12px", opacity: "0.75" }, text: gapWords(gapMins) })
      : null,
  ]);
}

/** "20 min gap" / "1h 50m gap" — minutes past an hour stop being readable. */
function gapWords(mins) {
  if (mins < 60) return `${mins} min gap`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m gap` : `${h}h gap`;
}

function flatRow(s, now) {
  const isCut = s.kind === "ice_cut";
  const past = (s.ends_at ?? s.starts_at) < now;
  return el("div.row", { style: { marginTop: "var(--s2)", opacity: past ? "0.45" : "1" } }, [
    el("span.num.fixed", {
      style: {
        fontSize: "13px",
        minWidth: "78px",
        color: isCut ? "var(--text)" : "var(--text-2)",
        fontWeight: isCut ? "650" : "500",
      },
      text: clock12(s.starts_at),
    }),
    el("span.grow", {}, [
      el("div.truncate", { style: { fontWeight: isCut ? "650" : "400" }, text: s.title }),
      el("div.dim", {
        style: { fontSize: "12px" },
        text: `${RINK_NAME[s.rink_code] ?? s.rink_code}${s.ends_at ? ` · until ${clock12(s.ends_at)}` : ""}`,
      }),
    ]),
    isCut ? el("span.chip.fixed", { text: "cut" }) : null,
  ]);
}

function pill(text, active, onclick) {
  return el(`button.btn.small.grow${active ? ".primary" : ""}`, { type: "button", text, onclick });
}

function soonTone(startsAt, now) {
  const mins = (startsAt - now) / 60000;
  if (mins <= 15) return "amber";
  return "";
}

function startOfToday(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function isoOf(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
