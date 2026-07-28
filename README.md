# Rink Tracker

Operations tool for the ice-rink crew — maintenance tickers, propane swaps, a
problem/project board, ice thickness measurement and analysis, edger runs, and
the pulled ice-cut schedule.

Rebuilt 2026-07-28 (`feat/rink-rebuild`). Round one shipped five "coming soon"
tabs and lost the crew; the rebuild's governing law is **no stubs** — a tab
exists on the commit that ships its surface and not before. The dock is
generated from a view registry, so there is no longer a place to put a stub.

**The thesis:** the incumbent is pen, paper, and words between crew members. The
app wins by making every gesture cheaper than the pen, or it dies like round one
did.

## Scope

- **Both rinks** — Upper (concrete, 35-point thickness grid) + Lower (sand
  floor: everything except heatmap/measurements — L has never held a measurement
  row and never will)
- **Screens:** Home · Ice · Edger · Maintenance · Schedule · Settings
- **One card type.** Problem = unclaimed card, project = claimed card.
  `noticed → doing → done`, one create flow, one detail sheet.
- **One claim primitive** app-wide: name + auto-timestamp. Adopt a ticker, claim
  a card, log an edger run — same verb, same storage shape.
- **Identity:** pick-your-name once per device (long-lived cookie). A PIN guards
  admin only (severity, delete, settings). Claiming is always one tap.
- **Desktop is first-class** — a reading layout (board + ice + maintenance +
  propane + feed in a real grid), not a stretched phone. The GM reads it there.

## Stack

- **Server:** Bun + TypeScript, `bun:sqlite` (WAL), `user_version` migrations
- **Frontend:** vanilla ESM + Canvas2D, house design tokens, PWA shell
- **Feed** is a SQL VIEW over the event-shaped tables — no events table, no
  dual-write. "Since you were here" is a per-device last-seen timestamp.
- **Photos:** sharp pipeline, on disk under `data/photos/YYYY-MM-DD/`

## Local development

```bash
cp .env.example .env          # set RINK_ADMIN_PINS=yourname:1234
bun server/server.ts          # → http://localhost:3737
bun test                      # 205 tests
```

The pure layer (`rink-geom`, `field`, `scales`, `dates`, `entry`, `render`) has
no DOM, no fetch and no timers, which is the whole reason it is testable —
round one's entry mode failed because it was a 1,779-line closure, not because
the arithmetic was wrong.

### UI verification

The shared `pwa-debug` harness, run from the repo root (it finds
`probe.config.json` by walking up). Serve the app on the port in that config
first:

```bash
H=~/.claude/skills/pwa-debug/harness
~/.bun/bin/bun $H/probe.ts --tier pass --label pre-commit
~/.bun/bin/bun $H/probe.ts --tier full --desktop
~/.bun/bin/bun $H/probe.ts --profiles ipad-820
```

The loop is write → render → probe → iterate. A UI change is not done until the
harness passes on the device matrix.

## Environment

| var | default | purpose |
|---|---|---|
| `RINK_ADMIN_PINS` | — | seeds admin members at boot (`name:pin,name:pin`) |
| `RINK_DB` | `data/rink.db` | database path |
| `RINK_SESSION_SECRET` | auto-generated, persisted | admin cookie HMAC |
| `RINK_SCHEDULE_URL` | Champions page | schedule source |
| `RINK_LAT` / `RINK_LON` | 41.8 / -73.12 | open-meteo location |
| `RINK_CRON_HOUR` | `7` | morning job hour, local |
| `RINK_DISABLE_CRON` | — | set `1` to disable the in-process cron |

`BUILD_SHA` is a **build arg**, not a runtime env var — see `docs/deploy.md`.

## Deployment

`https://rink-tracker.pancake3d.com` — docker-vm (VM 202, 192.168.8.112),
Traefik + wildcard cert. Full procedure and footguns: **`docs/deploy.md`**.

```bash
git push deploy HEAD:main
ssh docker-services "cd /opt/stacks/rink-tracker && \
  BUILD_SHA=\$(cd src && git rev-parse --short HEAD) docker compose up -d --build"
```

Never `git push deploy main:main` without checking what prod is actually on.
That trap has fired here once already.

## Docs

- `docs/deploy.md` — deploy procedure, cutover, footguns
- `docs/nfc-tags.md` — the six NDEF tag URLs and what a tap does
- `docs/schedule-source.md` — the BondSports scrape ruling and space-id mapping

## Relationship to ice-tracker

`ice-tracker` was the heatmap-only predecessor. Its database is frozen at 2,216
measurements and is a verified strict subset of this one's 2,566 — nothing to
merge. It is sunset at the cutover: 302 → rink-tracker, container and stack
killed, repo archived.
