# NFC tags — content spec

**These are NDEF URL records, not Web NFC.** Ruled 07-28. The tag carries a
plain deep link, so the phone's operating system opens it directly: works on
iPhone and Android, no app install, no browser permission prompt, nothing to
grant. The Web NFC API would have been Android-Chrome only and would have
needed the app already open — the opposite of what a tag is for.

Tag hardware: **NTAG215 — confirmed in hand, 2026-07-28. No order needed.**
215s carry 504 bytes of user memory against the longest URL below at ~60
characters, so they are wildly oversized for this and that is fine. NTAG213
(144 bytes) would also have been ample if more are ever needed.

Six tags required, seven with the optional measurement-station one.

## The tags

Six tags. Write the URL exactly as shown, including the scheme.

| # | Where it goes | URL |
|---|---|---|
| 1 | Zamboni 546, **left** tank | `https://rink-tracker.pancake3d.com/log/propane?rink=U&side=L` |
| 2 | Zamboni 546, **right** tank | `https://rink-tracker.pancake3d.com/log/propane?rink=U&side=R` |
| 3 | Olympia, **left** tank | `https://rink-tracker.pancake3d.com/log/propane?rink=L&side=L` |
| 4 | Olympia, **right** tank | `https://rink-tracker.pancake3d.com/log/propane?rink=L&side=R` |
| 5 | Upper rink edger | `https://rink-tracker.pancake3d.com/log/edger?rink=U` |
| 6 | Lower rink edger | `https://rink-tracker.pancake3d.com/log/edger?rink=L` |

Optional seventh, at the measurement station:
`https://rink-tracker.pancake3d.com/ice/entry`

Note `rink=L&side=L` on tag 3 is not a typo — the first is the **rink** (Lower)
and the second is the **tank side** (Left). They are independent.

## Writing them

Any NDEF writer app will do (NFC Tools on Android is the usual one). Choose
**URL / URI record**, paste the string, write, then **lock the tag** if the app
offers it — a locked tag cannot be silently rewritten by a passing phone.

Label the physical sticker in plain text too. A tag that has come loose from an
unlabelled machine is landfill.

## What happens on a tap

1. The phone opens the URL.
2. If this device has **already picked a name**, it lands directly on the
   prefilled form — the right machine, the right side, one button to confirm.
3. If the device has **never picked a name**, the app opens the name picker
   *holding the destination*, and lands on the prefilled form immediately after
   the name is chosen. The query parameters survive the detour.

Step 3 is the whole trick, and it is the part that would silently regress: a
naive redirect to `/` after identity would drop `?rink=U&side=L` and dump a
cold phone on the home screen. **V2** covers exactly this.

## Verification

- **V2** — deep link survives the identity flow on a device that has never
  opened the app. Clear site data, tap, check you land on the prefilled form.
- **V3** — a physical tap works on Jay's S24U **and on one crew iPhone**. The
  cross-platform claim is the entire reason this is an NDEF URL and not Web
  NFC, so testing only Android would verify nothing.

Both are open until the tags are in hand.
