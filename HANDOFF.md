# Rink Tracker — Handoff

_Last updated: 2026-05-02 11:30 EDT_

AIO operational hub for the rink. Replaces ice-tracker (which becomes a
deprecation candidate) and absorbs the M1Encompass-friction manual logs.

## Quick start

```bash
cd ~/git/rink-tracker
cp .env.example .env
# Edit ADMIN_PINS=yourname:1234
bun server/server.ts
# → http://localhost:3737
```

## State of the world

### Step A — scaffold (in progress 2026-05-02)
- Repo scaffolded at `~/git/rink-tracker/`
- Bun + TS server, single SQLite file at `data/rink.db` (will be the moved-over
  `ice_tracker.db` once step B happens)
- `server/db.ts` — schema bootstrap (legacy ice-tracker tables + auth/audit tables),
  shared `db` instance, `SW_VERSION` (git-sha or boot timestamp), `json()` helper
- `server/auth.ts` — clean module: identity resolution, session cookies (X-Forwarded-Proto
  aware), audit helper, admin PIN seeding from env, all 5 auth/identity endpoints
- `server/server.ts` — main router, static serving, sw.js version injection
- Public shell + tab placeholders pending — being written next in the same session
- Dockerfile + compose + .env scaffolded but **not deployed yet**
- Direct port: `192.168.8.112:3738:3737` (one above ice-tracker so they coexist
  during the transition window)

### Step B — heatmap port (queued)
- Move `/opt/stacks/ice-tracker/data/ice_tracker.db` →
  `/opt/stacks/rink-tracker/data/rink.db` (or symlink, TBD)
- Port ice-tracker's `app.js` (canvas + 6 modes + IDW + entry form + outbox) into
  `public/tabs/heatmap/` and `public/shared/rink-canvas.js`
- Port endpoints: `/api/measurements` (GET/POST), `/api/points`, `/api/dates`,
  `/api/concrete-profile`, `/api/stats`, `/api/anomalies`, `/api/timeseries/:pt`,
  `/api/weather` (GET + by date)
- Port `scripts/ingest.py` + `scripts/backfill_weather.py`

### Steps 3–8 (queued)
3. Issues + photos (cross-link to rink schematic)
4. Maintenance log + recurring schedule
5. Work events + zone polygons (pre-defined rink zones)
6. Dashboard summary (`/api/dashboard/summary`) + Home tab
7. Shift handoff
8. UI polish pass — shelf-dashboard quality, ice/rink aesthetic

### Step Z — sunset ice-tracker (queued)
- Deprecation banner in ice-tracker UI
- 302 redirect at traefik level: `ice-tracker.pancake3d.com` → `rink-tracker.pancake3d.com#/heatmap`
- Archive ice-tracker repo on GitHub
- Stop ice-tracker container, remove from `/opt/stacks/`

## Architecture

### Tab layout (hash-routed SPA)
| route | tab | scope |
|---|---|---|
| `#/` | Home | dashboard summary — open issues, due maintenance, today's work, last handoff |
| `#/heatmap` | Heatmap | depth/temp/concrete/delta/plan/anomaly modes, Upper only |
| `#/issues` | Issues | photo-first log, pinned to rink schematic |
| `#/maintenance` | Maintenance | zamboni oil/blade/grease + due/overdue |
| `#/work` | Work events | flood/cut/edge with pre-defined zone picker |
| `#/handoff` | Shift handoff | morning/night transitions, no more ambiguity |
| `#/admin` | Admin | priorities, dates, audit log (cookie-gated) |

Rink switcher (Upper / Lower) lives in shell header — sticks across tabs.

### Identity model
- **member** — pick name once → localStorage. Stamped on writes via `X-User-Id`. Frictionless.
- **admin** — env `ADMIN_PINS=name:pin,name:pin` seeded at boot. Login → server cookie
  (httpOnly, SameSite=Lax, 12h). Admin gates editing other people's entries, altering
  priorities, audit-log access.

### Tables (in `data/rink.db`)
**Legacy (ported from ice-tracker):** `rinks`, `points`, `measurements`, `weather`, `idempotency_keys`
**AIO (new):** `users`, `sessions`, `audit_log`, then in later steps: `issues`,
`issue_photos`, `issue_revisions`, `maintenance_log`, `maintenance_schedule`,
`work_events`, `work_event_zones`, `shift_handoffs`

All AIO tables that aren't auth carry a `rink_code` FK so Upper/Lower filter cleanly.

## Important context
- **The rink is the user's WORK rink.** Daily ops use by rink staff (mostly mobile),
  not a personal project. Get the mobile UX right.
- **Frictionless logging is the prime directive.** "oh shit I found this, let me put
  it in" — never a chore.
- **AQ is out of scope** — corporate M1 tracks CO2/NO2/CO via separate health-and-safety
  system. Rink-tracker doesn't touch it.
- **Both rinks.** Most features apply to Upper + Lower. Heatmap tab is Upper-only.

## Ports
| Where | URL | Status |
|---|---|---|
| Local dev | `http://localhost:3737` | scaffolding |
| Container LAN | `http://192.168.8.112:3738` | not deployed yet |
| Production | `https://rink-tracker.pancake3d.com` | not deployed yet |
| GitHub | (private repo, to create) | pending |
