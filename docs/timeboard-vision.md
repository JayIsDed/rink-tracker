# Timeboard — UI vision

Visual layout: dual-rink timeboard with color-coded event bars.

## Core concept

A gauge-style clock where the bars ARE the events, sized proportionally to
their duration. The current time runs across both rinks as a needle/cursor.

## Event bar behavior

- **In progress:** The bar drains color from left to right as time passes —
  vibrant color bleeds into flat gray (or background color) with a ripple
  effect at the drain edge. The unconsumed portion stays vibrant.
- **Upcoming:** Full vibrant color, sized by duration.
- **Passed:** Fully drained to gray/background.

The drain is proportional — a 90-minute event at the 45-minute mark is half
vibrant, half gray, with the ripple sitting at the midpoint.

## Gaps (maintenance windows)

Gaps between events get their own visual countdown bar. These are the windows
where the crew does maintenance, so a timer until the next event starts is the
actionable data: "you have 12 minutes before IPH gets on."

## Data source

`GET /api/schedule/cuts` — per-rink cuts with flanking events, gaps, countdown.
`GET /api/schedule/day` — full day chronological, both rinks.

Both endpoints support `?date=YYYY-MM-DD&rink=U|L`.

## Open questions

- Color palette per event type (booking vs freestyle vs hockey vs public skate)
- Whether the gauge is linear (timeline) or radial (clock face)
- Mobile layout: stacked rinks or swipe between them
