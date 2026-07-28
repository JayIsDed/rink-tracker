# Deployment — R7 plan

Same shape as the existing deploy (stack-root compose on docker-vm, git-deploy
remote, Traefik label), with three deltas. The law from the runbook holds:
**alongside, then flip. Never in place.**

## What stays the same

- Host: **docker-vm (VM 202, 192.168.8.112)**, stack at `/opt/stacks/rink-tracker/`
- Push to the `deploy` remote (`ssh://docker-services/opt/stacks/rink-tracker/src`)
- Traefik label routing, `cloudflare` certresolver, `proxy-tier` network
- `./data:/app/data` bind mount, plain `.env` (not Infisical-synced — the admin
  PIN is rink-staff convenience, not security-grade)

## Delta 1 — BUILD_SHA build arg (footgun 2)

The service worker keys its cache on `BUILD_SHA`. The image has no `.git`, so
`git rev-parse` cannot run inside it — the sha has to be passed in at build
time or the key silently falls back to `dev` and never busts.

```dockerfile
ARG BUILD_SHA=dev
ENV BUILD_SHA=$BUILD_SHA
```

```yaml
build:
  context: .
  args:
    BUILD_SHA: ${BUILD_SHA:-dev}
```

The deploy hook supplies it: `BUILD_SHA=$(git rev-parse --short HEAD) docker compose up -d --build`.

**Verify (V5):** restart the container without changing code — clients must
keep their cache. Then deploy a real commit — clients must drop it.

## Delta 2 — env var rename

The old app read `ADMIN_PINS`. The rebuild reads **`RINK_ADMIN_PINS`** (same
`name:pin,name:pin` format). Also available:

| var | default | purpose |
|---|---|---|
| `RINK_ADMIN_PINS` | — | seeds admin members at boot |
| `RINK_DB` | `data/rink.db` | database path |
| `RINK_SESSION_SECRET` | auto-generated, persisted in `settings` | admin cookie HMAC |
| `RINK_SCHEDULE_URL` | Champions page | schedule source |
| `RINK_LAT` / `RINK_LON` | 41.8 / -73.12 | open-meteo location |
| `RINK_CRON_HOUR` | `7` | morning job hour, local |
| `RINK_DISABLE_CRON` | — | set `1` to disable the in-process cron |

## Delta 3 — alongside on a fresh port

1. Second stack at `/opt/stacks/rink-tracker-v2/`, host port **3740**, **no
   Traefik router yet** (or a temporary hostname).
2. Seed its data dir from a **`VACUUM INTO` snapshot** of prod — never a bare
   `cp rink.db`. Prod's `.db` file is months stale; everything recent lives in
   the `-wal`. `scripts/carry-data.ts` refuses a source with a non-empty WAL
   beside it, which is the guard rail here.
3. Run the carry: `bun scripts/carry-data.ts --from <snapshot> --to data/rink.db`
   → **V1** parity receipt must print PASSED.
4. Soak it. Both apps are live; the old one is still authoritative.
5. **V7** — re-verify parity against a fresh prod snapshot immediately before
   the flip, because prod keeps taking writes while v2 soaks.
6. Move the Traefik labels from the old stack to v2, `docker compose up -d` both.
7. Stop the old container. Keep its data dir until the next backup cycle.

## Then — ice-tracker sunset (step Z)

n-71 verified ice-tracker's DB is frozen at 2,216 measurements and is a strict
subset of rink-tracker's 2,566. Nothing to merge.

- 302 `ice-tracker.pancake3d.com` → `rink-tracker.pancake3d.com`
- Archive the repo, kill the `:3737` container and its stack
- Drop the CF DNS record once the redirect has been in place a while

## Do not

- `git push deploy main:main` before checking what prod is actually on. That
  trap has already fired once here — prod ran four commits ahead of GitHub main
  for weeks. It is reconciled now, but the habit of checking is the fix.
- Flip Traefik before V7. Prod takes writes during the soak.
