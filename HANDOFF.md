# Rink Tracker — Handoff

_Last updated: 2026-07-28 · branch `feat/rink-rebuild`_

The rebuild. The contract is the pad tile **[n-72][open-projects]**
(`claude-runbook-rink-rebuild.md`) — laws, rulings, work packages and the V1–V9
verify list all live there and are not restated here. Findings that produced it
are [n-71]; the original order is [n-23].

Everything below is state, not plan.

---

## Where it stands

**R0–R6 complete. R7 is half done: v2 is deployed alongside and soaking.**

| WP | what | state |
|---|---|---|
| R0 | recon, git reconcile, Forgejo remote, BondSports probe | done |
| R1 | schema, carry, identity, shell, test scaffold | done — V1 |
| R2 | home surface: tickers, propane, board, feed, settings | done — V8 |
| R3 | ice: entry mode, heatmap, thin-spot strip, outbox | done |
| R4 | edger + maintenance detail | done |
| R5 | 7am cron, weather backfill, NFC routes | done — V4, V9 |
| R6 | device matrix, icons, SW build-sha | done — V6 |
| R7 | **cutover** | **alongside up, flip pending** |

**Tests:** 205 pass. **Probe:** 180/180 renders green across five device classes.

## Live right now

| | URL | serving |
|---|---|---|
| incumbent (authoritative) | `rink-tracker.pancake3d.com` | old app, `f9afd03` |
| **rebuild (soaking)** | **`rink-v2.pancake3d.com`** | `feat/rink-rebuild` |
| predecessor (to be sunset) | `ice-tracker.pancake3d.com` | frozen, subset |

Soak stack: `/opt/stacks/rink-tracker-v2/`, port 3740, deploy remote
`deploy-v2`. Procedure and receipts: `docs/deploy.md`.

## What is left

1. **Jay's soak** — real use on laptop + S24U. The only thing gating the flip.
2. **V7 + Traefik flip** — fresh prod snapshot, re-carry, parity, move the
   labels, stop the old container. `docs/deploy.md` has the sharp edges,
   including which of v2's data a re-carry destroys.
3. **Step Z — ice-tracker sunset.** 302 → rink-tracker, kill `:3737` and its
   stack, archive the repo, drop the CF record after the redirect soaks.
4. **V3 — physical NFC taps.** Six tags per `docs/nfc-tags.md`, on the S24U
   *and* a crew iPhone; the cross-platform claim is the whole point. Blocked on
   tags being to hand. The routes ship regardless — they are live and V2 passed
   on a cold device.

## Still needs Jay

- **Real ticker intervals** (oil/blade per machine). Seeded values are
  placeholders and the settings screen says so in words — they are not dressed
  up as measured.
- **Crew member names** for seeding.
- **Tag placement** once tags exist.
- **12h vs 24h.** 12h AM/PM assumed — general crew audience, not Jay's personal
  24h preference. One word overrules it.

## Known loose ends

- `public/style.css` is a **1,452-line orphan** from round one. Nothing links
  it; `shared/theme.css` is the live stylesheet. Deliberately not deleted
  mid-rebuild — delete it after the flip, when a regression would be
  attributable.
- Schedule source header claims 1,311 events against 1,285 parsed. The gap is
  logged every run so a *widening* gap is visible. Not a defect yet.
- v2's data files are root-owned (the container runs as root, and the carry
  created them). Consistent, but host-side tooling needs sudo to read them.
