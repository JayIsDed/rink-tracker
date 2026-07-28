# Ice-cut schedule source — R0 probe result

**Ruled: scrape the public schedule page. No BondSports API key needed.**

Probed 2026-07-28 against
`https://schedule.bondsports.co/schedule/Champions-Skating-Center-Schedule`
(the facility's own published page, supplied by Jay).

## Why the scrape wins

The page looks like a Next.js SPA, and the visible DOM says only
"Loading schedule…". It is not a client-fetch app: the **entire schedule is
server-rendered into the RSC flight payload**, ~2.7 MB of it, as escaped JSON.
One unauthenticated GET returns everything.

That removes the key-vs-scrape tradeoff the order left open. There is no
credential to obtain, store in Infisical, rotate, or have revoked, and no
rate-limited third-party dependency in the morning cron. The failure mode is a
markup change, which is loud (parse yields zero slots) rather than quiet.

No `api.bondsports.co` or equivalent host is referenced anywhere in the
document, so there is no cleaner JSON endpoint sitting behind this one to
prefer.

## What comes back

Parsed 1,213 unique slots from the 2026-07-28 pull, spanning
**2026-07-28 → 2026-08-26** (30 distinct days — a rolling ~30-day forward
window).

The page header claims 1,308 events against our 1,213 parsed. The gap is not
yet explained; the puller must log both numbers so a widening gap is visible
rather than assumed benign.

### The space mapping is exact — this is the load-bearing find

| `spaceId` | `spaceName` | our `rink_code` |
|---|---|---|
| 2553 | `Cromwell Upper Rink - Champions Skating Center` | **U** |
| 2552 | `Cromwell Lower Rink - Champions Skating Center` | **L** |

`facilityId` 339. Non-ice spaces also appear in the feed (Pool, Group Fitness
Room, Upper Viewing Area, Personal Training, Party Room, Film Room) and must be
filtered out — match on `spaceId`, not on a name substring, because the names
carry a trailing space and the facility could rename a room.

### Ice cuts are explicit, not inferred

**382 rows** carry `title: "Ice Cut"` with `slotType: "maintenance"` and
`maintenanceTiming: "2"`. Every one is exactly 10 minutes. We do not have to
guess a resurface from gaps in the booking grid — the source labels it.

Slot-type breakdown: `internal` 657 · `maintenance` 382 · `external` 174.
Durations cluster at 30 min (526), 10 min (382 — the cuts), 60 min (182).

Busiest titles: Freestyle Figure Skating (562), **Ice Cut (382)**, CHL Summer
2026 (45).

### Fields worth carrying

`id` (slot id — the natural `ext_id`), `reservationId`, `eventId`, `title`,
`slotType`, `maintenanceTiming`, `startDate`, `startTime`, `endDate`,
`endTime`, `spaceId`, `spaceName`, `facilityId`, `programName`, `sessionName`,
`approvalStatus`.

Note `startDate` is a UTC-midnight timestamp and `startTime` is a **local**
wall-clock string with `timezone: null`. Do not naively combine them as UTC —
compose the instant in `America/New_York`.

## Still open — update cadence

The order asked which source is stabler and when it refreshes. The scrape is
the only viable source, so "which" is settled; "when it updates" cannot be
answered from a single pull.

A fingerprint of the 2026-07-28 10:39 ET pull is recorded at
`data/carry/bond-fingerprint-260728.txt` (payload sha256 `efd9cc0964099266`,
764 ice-cut mentions). The R5 cron logs slot counts and a payload hash on every
run into `job_runs`, so the cadence answers itself within a few days of running
rather than being guessed now.

## Consequences for R5

- Single GET, no auth, no secret. Nothing goes to Infisical.
- Parse = unescape one level, brace-match objects prefixed `{"id":N,"reservationId"`,
  dedupe by slot id (children repeat).
- Filter to `spaceId IN (2552, 2553)`; map to L/U.
- Upsert on `(source, ext_id)` — the schema's unique index already covers it.
- Log parsed-count, header-count and payload hash to `job_runs` every run. A
  parse that yields zero slots is a failure, not an empty schedule.
