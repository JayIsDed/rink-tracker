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

## State when this brief was written

R0–R6 complete, R7 half done: v2 is deployed alongside and soaking at
`rink-v2.pancake3d.com`. V1 and V5 passed. 231 tests. The flip and step Z are
both parked behind this check. `docs/deploy.md` holds the cutover procedure and
its sharp edges.
