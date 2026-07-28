# probe · latest

- target: `http://localhost:3739`
- tier: **quick** · 2 render(s) · started 2026-07-28T14:33:59.740Z
- verdict: **PASS**

## 1 · Verdict

```
┌──────────┬───────┬────┬───────┬───────┬───────┬──────┬──────┬──────┬───────┬──────┬───────┬───────┬───────┬─────────┐
│ device   │ state │ th │ cls-i │ cls-s │ xflow │ clip │ taps │ corr │ stack │ safe │ contr │ sheet │ dock  │ verdict │
├──────────┼───────┼────┼───────┼───────┼───────┼──────┼──────┼──────┼───────┼──────┼───────┼───────┼───────┼─────────┤
│ s24u     │ live  │ dk │ 0.000 │ 0.000 │ ok    │ ok   │ ok   │ ok   │ ok    │ ok   │ ok    │ ✓·✓   │ float │ PASS    │
│ x1c-half │ live  │ dk │ 0.001 │ 0.000 │ ok    │ ok   │ ok   │ ok   │ ok    │ ok   │ ok    │ ✓·✓   │ float │ PASS    │
└──────────┴───────┴────┴───────┴───────┴───────┴──────┴──────┴──────┴───────┴──────┴───────┴───────┴───────┴─────────┘
```

## 2 · Drift (advisory — not a gate)

_measured on s24u · live · dark · 25 elements_

**Spectra** — a design system is a small set of values used often. A long tail is drift.

- **spacing** — 8 distinct  top: `16px`×27 `8px`×15 `12px`×13 `4px`×8 `15px`×4
  used once (likely accidents): `46px` `48px` `24px`
- **font-size** — 4 distinct  top: `15px`×19 `16px`×2 `13px`×2 `12px`×2
- **font-weight** — 4 distinct  top: `400`×16 `600`×6 `700`×2 `650`×1
  used once (likely accidents): `650`
- **radius** — 3 distinct  top: `10px`×6 `22px`×2 `16px`×1
  used once (likely accidents): `16px`
- **color** — 12 distinct  top: `rgb(232, 240, 248)`×31 `rgb(20, 29, 40)`×4 `rgba(150, 180, 210, 0.28)`×4 `rgb(116, 135, 156)`×4 `rgb(159, 178, 198)`×4
  used once (likely accidents): `rgba(4, 7, 11, 0.62)` `rgb(14, 20, 28)`

**Alignment rails** — edges that nearly agree. 1–6px is the gap the eye reads as sloppy and the mouth cannot name.

- right edge: `317px` vs `318.5px` — **Δ1.5px** across 3 blocks

**Token conformance**

- clean — every colour resolves to one of 18 token values

_5 contrast reading(s) are approximate — the element sits on translucent glass or a backdrop-filter, so the effective background is inferred, not known. These never gate a verdict._

## 3 · Look at these

- `sheet__cross-device.png` — contact sheet — live render across every device
- `s24u__live__dark__overlay-rails.png` — s24u/live/dark — overlay-rails overlay, findings present
- `x1c-half__live__dark__overlay-rails.png` — x1c-half/live/dark — overlay-rails overlay, findings present

## Notes

- s24u/live: trigger click failed: click: Timeout 5000ms exceeded.
- x1c-half/live: trigger click failed: click: Timeout 5000ms exceeded.

---

_Headless Chromium is not a phone. Touch is synthesised (no long-press, multi-touch or palm rejection), standalone mode is the CSS branch forced rather than a real WebAPK, and safe-area insets are derived approximations rewritten into the source. A clean run is a strong filter, not a substitute for holding the device._