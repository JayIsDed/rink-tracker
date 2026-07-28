# Composition check — the brief

**This gates R7.** No flip until the parity table below exists and its port rows
are closed. Ordered by AMENDMENT 1 on [n-72][open-projects], 2026-07-28 14:2x.

## Why this exists

Jay walked the rebuild and found old-app interactions simply missing — **tap a
dot on the ice → pull-up with that point's detail and history**, and
**sparklines** where round one drew them. Neither was a decision. They were
never inventoried, so they died silently.

The root cause is a planning gap, not an implementation one: the runbook's
read-in used the old repo for carry PATTERNS, and n-71 inventoried **data and
drift, not UX**. Nothing in R0–R6 ever asked "what could you *do* in the old
app". A feature that existed only in round-one's code had no way to be noticed.

Jay's two items are **seeds, not the list.** A sweep that stops at them repeats
the same mistake at smaller scale.

## Read this cold

Whoever runs this check should read the OLD app first and form a model of it
**before** reading the rebuild. The failure mode this check exists to correct is
an inventory taken by someone already convinced the rebuild is complete — the
rebuild's own rulings are very persuasive from the inside. Read the old surface
on its own terms, write down what it does, and only then go looking for each
item in the new one.

## What to walk

Everything is still live and must **stay** live until the table is closed —
sunsetting either old app destroys the evidence this check reads.

| surface | where | note |
|---|---|---|
| old rink-tracker (round one) | `rink-tracker.pancake3d.com`, container `rink-tracker` | prod, running `f9afd03` |
| ice-tracker (the predecessor) | `ice-tracker.pancake3d.com`, `:3737` | counts if it carries surface the fork dropped |
| round-one code | branches `main` / `feat/ice-entry-mode` | `public/tabs/**` is where round one's UI lives |
| the rebuild | `rink-v2.pancake3d.com` | `feat/rink-rebuild`, `public/views/**` |

Round one's tabs were: Home · Heatmap · Issues · Maintenance · Work events ·
Shift handoff · Admin. The rebuild's views are: Home · Ice · Edger ·
Maintenance · Schedule · Settings. Those two lists do not map one-to-one, and
the gaps between them are the whole point of the exercise.

**Note `public/style.css`** — a 1,452-line orphan from round one, still in the
tree, nothing links it. It is a decent index of round-one components: a class
in there with no counterpart in `shared/theme.css` is a candidate surface.

## Deliverable

A parity table, stamped on [n-72] and drafted here:

| feature | old behaviour | rebuild state | ruling |
|---|---|---|---|
| | | present / absent / changed | port · drop WITH REASON · superseded |

Rules:
- **No old feature dies silently.** Every drop is a *ruled* drop with a reason.
- Ambiguous rows go to Jay rather than being decided in the table.
- Port rows get committed, and **pwa-debug reruns on every touched surface**.

## Known vague spots

- Round one's **"6 heatmap modes"** vs what R3 actually shipped.
- **Per-point interactions** on the ice surface (Jay's seed #1).
- **Sparklines** (Jay's seed #2) — round one drew them somewhere; find where.
- Anything living only in the **entry-mode branch** (`feat/ice-entry-mode`),
  which is what prod runs and is four commits past round-one `main`.

## Not parity items

Surfaces the rebuild added that have no old equivalent — do not write these up
as gaps:

- **Schedule** (`/schedule`) + the home ice-cut strip — pulled BondSports ice
  cuts with each cut bracketed by the bookings either side. New in R7.
- **Thin-spot strip** on the Ice surface.
- **Board** (cards), **tickers**, **propane**, **feed** — these replace round
  one's Issues/Maintenance model rather than porting it, per the runbook's
  one-card-type ruling. Behaviour *inside* them is still fair game.

---

# THE PARITY TABLE — closed 2026-07-28, Opus 5 executor seat

Walked: round-one code at `f9afd03` (`public/tabs/**`, 1,779-line heatmap +
657-line issues + `style.css`), the live old prod on `:3738`, ice-tracker on
`:3737`, and the rebuild on `feat/rink-rebuild`. Read cold in that order, per
the brief.

**Ruling counts:** 12 ported · 14 superseded · 11 dropped with reason ·
5 to Jay.

## Shell

| feature | old behaviour | rebuild | ruling |
|---|---|---|---|
| Rink switcher | Global Upper/Lower in the header, persisted, broadcast to every tab | **was dead** — `state.rink` had one writer that only ever set "U"; Edger's pills moved a shadowed local | **PORTED (as persistence)** — per-view controls supersede a header control that greys out 4 of 6 surfaces, but the Edger's pills now persist through the shell. This also made the "Lower isn't measured" screen reachable for the first time |
| Identity chip + picker | Header chip, dialog listing users, add-yourself | Same, as a sheet | superseded |
| Admin PIN sign-in | Name dropdown + PIN dialog | Same, as a sheet | superseded |
| 7 nav tabs, 5 of them stubs | Hash router, "coming soon" tabs | View registry — a tab exists on the commit that ships its surface | **superseded** — this is the whole point of the rebuild |

## Ice — reading the sheet

| feature | old behaviour | rebuild | ruling |
|---|---|---|---|
| **Tap a point → detail** | Sheet: grid col/row, depth, temp, headroom + low-headroom flag, weather block, all-time stats, sparkline, 60 recent readings | **was one line of text** | **PORTED** — Jay's seed #1 |
| **Sparkline** | Canvas, depth over time | absent | **PORTED** — Jay's seed #2, now a pure module |
| Recent readings list | 60 rows: date, depth, temp | absent | **PORTED** (24 rows) |
| Per-point all-time stats | mean / min + date / max / samples | absent | **PORTED**, plus trend/wk |
| Weather in point detail | temp range + mean, WMO conditions, cloud, precip/snow, wind, Δ outside-vs-ice | only an `outside XX°F` chip | **PORTED** as a one-line summary + thermal load |
| Legend | Gradient bar + lo/hi labels, per mode | absent | **PORTED** |
| Confidence mesh | IDW confidence modulates cell alpha; toggle | `conf` computed and thrown away | **PORTED as always-on.** The "off" position only made the map look more certain than the data — dropped with reason |
| Concrete mode | Headroom map, current − all-time min | absent | **→ JAY** (headroom itself is now on the point sheet) |
| Plan mode | Cut-depth slider, max safe cut, risk zones, flood priority | absent | **→ JAY** |
| Anomaly mode | z-score map + outlier list, trailing 30d | absent as a mode | **superseded** by the thin-spot strip. R3's calibration is the reason: pt 27 reads 0.83–1.19" *every* session, so a per-point z-score calls the sheet's worst point perfectly normal |
| Delta vs a chosen date | `vs.` picker, any two sessions | "Change" = vs previous session only | **→ JAY** |
| Status chips | date, N/35, avg, thinnest (colour-coded), outside, sky | thinnest / average / thickest / N / outside | superseded — sky moved into the point sheet |
| Desktop hover highlight | mousemove re-render | absent | **dropped** — touch-first surface, and the tap sheet is the interaction now |
| Point value labels | Number inside every dot | Value below the dot at ≥520px | superseded |
| **ZAM door marker** | Bar + label on the bottom boards | absent | **PORTED** — the sheet's only asymmetric feature, so the only thing telling you which end you're at |
| Lower-rink empty state | "sand-floored, no thickness measurements" | present but unreachable | **PORTED** (made reachable — see Shell) |
| Bottom-sheet peek handle | "tap a point ▴" / "N anomalies ▴" | absent | superseded by the house sheet + a permanent cue line |

## Ice — entry mode

| feature | old behaviour | rebuild | ruling |
|---|---|---|---|
| **Last reading + delta** | `last: 3.42" (2026-07-07) +0.15"` under the depth field | absent | **PORTED** — cheapest anomaly check there is |
| **Walk-order toggle** | ↻ mid-session, keeps you on your point | `setOrder()` existed, tested, and no UI called it | **PORTED** |
| New Session vs Edit | Two entry points; guard: "already has N readings — switch to Edit" | One path, hydrates existing, resumes at the first gap | superseded |
| Draft in localStorage + resume prompt | Draft per rink+date, "Resume draft?" | Per-point POST + outbox + server hydrate | **superseded** — a value is durable when typed, not at Save |
| Save Session (batch at end) | One commit for 35 points | Per-point immediate write | superseded |
| Live baseline anomaly flag | "↓2.3σ off baseline… double-check" as you type | Neighbour/thin/wild flags at Finish; statistical version server-side | superseded, *and* the last-reading port covers the live half |
| Skip / mark unmeasurable | Explicit skipped state, X on the dot | absent | **dropped** — it was client-only. `commitSession` did `if (e.skipped) continue`, so a skip never reached the database; it only changed a local counter. "Next" does the same thing |
| End-of-session summary | entered/skipped/untouched, avg, thinnest, flags | Finish sheet: stats, durability, flags with Go buttons | superseded (better — flags are tappable) |
| Prev / Next / tap-to-jump | ✓ | ✓ | present |
| Enter advances depth→temp→next | Two-step | Enter on either advances to the next point | superseded |
| Arrow keys / Escape | Desktop power-user nav | absent | **dropped** — gloves-on rinkside surface |
| Pulse ring on current point | rAF animation | Static accent ring | **dropped** — a rAF loop repainting the sheet forever to animate one ring, on a phone, in a cold building |
| Progress + queued badge | `Done N/35`, "N queued" | `N/35 measured`, `N saved · M sending`, offline banner | superseded (says what's *durable*, which round one couldn't) |

## Board (was Issues)

| feature | old behaviour | rebuild | ruling |
|---|---|---|---|
| **Photos** | Camera capture, multi, previews, thumbs on cards, full view, admin delete, add-to-existing | **absent — table and `photo_count` shipped, no routes, no UI** | **PORTED end to end.** Not a parity drop: R2 scope the runbook's data model specified and nobody built |
| **Timeline / revisions** | Per-issue history: opened, status, severity, edits, photos, comments | `audit_log` written, never surfaced | **PORTED** from the audit log. Found en route: `spawnCard` never audited, so maintenance-spawned cards had blank histories |
| **Archived cards** | Open / Resolved / All filter | auto-archive with `?archived=1` and no UI to ask for it | **PORTED** |
| Comments | Comment box + threaded into the timeline | absent | **→ JAY** — needs a table; the runbook's data model doesn't list one |
| Location pin | Tap the rink, snap to a point within 12ft, or free pin | absent | **→ JAY** |
| Rink scoping | Issues were per-rink and filtered | `rink_code` column the create sheet never sets | **→ JAY** |
| Severity | Low/Med/High, admin to change | 1/2/3, tier 3 admin-only, glows the card | superseded |
| Status | open / in_progress / resolved | noticed / doing / done via the claim primitive | superseded |
| FAB | Floating + button | "+ New" in the board header | superseded |
| Card row | thumb, severity pill, status pill, location, title, author, age | thumb, severity colour + glow, claim state, due pill, author, age | superseded |
| Issue counter | "N issues" | absent | **dropped** — the list is right there |
| Permission model | members edit own, admins edit all | severity-3 / archive / delete are admin | superseded |

## ice-tracker (`:3737`)

| feature | old behaviour | rebuild | ruling |
|---|---|---|---|
| Grid entry dialog | All 35 rows in one dialog | point-by-point | superseded |
| **"Fill from latest"** | Prefill all 35 from the previous session | absent | **dropped** — it manufactures 35 readings that look measured and were not. The legitimate need (knowing last week's number) is the last-reading hint, which shows it without writing it |
| Everything else | strict subset of round one's heatmap | — | n/a |

## Not parity items, listed so they aren't re-flagged

`/api/issues/by-point` existed server-side in round one with **no UI caller** —
dead on arrival, nothing to port. Schedule, thin-spot strip, tickers, propane,
board and feed are new or ruled replacements per the brief.

## The five for Jay

1. **Concrete + Plan modes** — the cut-planning pair. "How much can I shave
   before I'm into the concrete" is a real question; headroom now answers it
   per point, but there's no sheet-wide map and no max-safe-cut. Rebuild, or
   retire? Only you know if the crew used it.
2. **Delta vs an arbitrary date** — you can ask "since last session" but not
   "since the season started".
3. **Card comments** — round one had a thread per issue. Needs a table.
4. **Card location pin** — "the crack" is easier to point at than describe.
   Photos now cover a lot of this.
5. **Card rink scoping** — two-rink facility, and a card can't say which rink.

## Receipts

- **294 tests**, up from 231. New: `spark`, `weather`, `point-detail`,
  `photos`, `gridOf`, card history, ZAM.
- **pwa-debug pass tier + desktop: 189/189 PASS** — s24u · s24u-short · a36 ·
  split-206 · iphone-15 · x1c-half · x1c-4k · qhd-2560 · uw-3440, each on
  live / overflow / empty.
- **V1 re-verified** on a fresh carry: 2566 / 35 / 2 / 64, checksums equal.
- Two defects the port work surfaced and fixed, neither a parity item:
  unreserved photo boxes, and home painting six empty cards before its data
  landed (0.172 → 0.00004 on x1c-half; **pre-existing at 0.154**, and green in
  R6 only because the probe ran against a board too thin to provoke it).

---

## State when this brief was written

R0–R6 complete, R7 half done: v2 is deployed alongside and soaking at
`rink-v2.pancake3d.com`. V1 and V5 passed. 231 tests. The flip and step Z are
both parked behind this check. `docs/deploy.md` holds the cutover procedure and
its sharp edges.
