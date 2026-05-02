# Rink Tracker

All-in-one operations hub for the rink. Replaces M1Encompass for the high-friction
manual logs (issues, zamboni maintenance, work events, shift handoffs) and bundles
the upper-rink thickness/temperature heatmap analytics from the legacy `ice-tracker`
project under one roof.

## Scope

- **Both rinks** — Upper (concrete, 35-point thickness grid) + Lower (sand, no thickness data)
- **Tabs:** Home / Heatmap / Issues / Maintenance / Work Events / Shift Handoff / Admin
- **Tiered access:** member (default, picked from dropdown, stored in localStorage)
  + admin (env-seeded PIN, gates priority/date edits + audit log)
- **PWA** — offline-tolerant, installable on phones, photo upload from rink floor

## Stack

- **Server:** Bun + TypeScript, `bun:sqlite` (WAL)
- **Frontend:** vanilla JS + Canvas2D, hash-routed SPA shell with lazy-loaded tab modules
- **Photos:** stored on disk under `data/photos/YYYY-MM-DD/`, thumbnails generated via sharp

## Local development

```bash
cp .env.example .env
# edit .env: ADMIN_PINS=yourname:1234

bun server/server.ts
# → http://localhost:3737
```

## Production deployment

`https://rink-tracker.pancake3d.com` — LXC 112, Traefik + Let's Encrypt.

```bash
ssh docker-services "cd /opt/stacks/rink-tracker && docker compose up -d --build"
```

## Relationship to ice-tracker

`ice-tracker` (heatmap-only PWA) is being deprecated. Rink-tracker reads the same
SQLite database and ports the heatmap UI under `#/heatmap`. Once feature parity is
verified, ice-tracker.pancake3d.com will 302 → rink-tracker.pancake3d.com#/heatmap
and the legacy container/repo gets archived.
