// Pure parsing for the facility schedule page. No database, no network — so it
// is testable without booting anything, and the pull job stays a thin wrapper
// around IO.
//
// Rationale for this shape: docs/schedule-source.md (R0 probe).

// Verified 2026-07-28. Matching on id, not on a name substring: the names carry
// a trailing space and a rename would silently drop the whole rink.
export const SPACE_TO_RINK: Record<number, "U" | "L"> = {
  2553: "U",
  2552: "L",
};

export type Slot = {
  id: number;
  title: string;
  slotType: string;
  startDate: string;
  startTime: string;
  endTime: string | null;
  spaceId: number;
};

/**
 * Extract slot objects from the RSC flight payload. The JSON sits inside JS
 * string literals, so it is unescaped one level and then brace-matched — a
 * plain regex cannot handle the nesting, and the nested `space` / `event`
 * objects would truncate the parent.
 */
export function parseSlots(html: string): Slot[] {
  const s = html.replace(/\\"/g, '"');
  const out = new Map<number, Slot>();
  const re = /\{"id":\d+,"reservationId"/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(s))) {
    const start = m.index;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < Math.min(start + 20000, s.length); i++) {
      const c = s[i];
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          try {
            const o = JSON.parse(s.slice(start, i + 1));
            if (o && o.startDate && o.startTime) out.set(o.id, o as Slot);
          } catch {
            /* a chunk that will not parse is not a slot */
          }
          break;
        }
      }
    }
  }
  return [...out.values()];
}

/** How far `tz` is from UTC at a given instant, in ms. */
function tzOffset(utcMs: number, tz: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    })
      .formatToParts(new Date(utcMs))
      .map((p) => [p.type, p.value])
  ) as Record<string, string>;
  const asUTC = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second)
  );
  return asUTC - utcMs;
}

/**
 * `startDate` is a UTC-midnight stamp and `startTime` is a LOCAL wall clock
 * with `timezone: null` — combining them naively as UTC shifts every row by the
 * offset, which in winter would file a 07:30 ice cut at 02:30.
 *
 * Interpret the pair as local wall-clock, then correct for the offset that
 * actually applies at the resulting instant. The second pass is what gets DST
 * transition days right.
 */
export function toEpoch(startDate: string, time: string, tz = "America/New_York"): number | null {
  const day = startDate.slice(0, 10);
  const [y, mo, d] = day.split("-").map(Number);
  const [hh, mm, ss] = (time || "00:00:00").split(":").map(Number);
  if (![y, mo, d, hh, mm].every(Number.isFinite)) return null;

  const naive = Date.UTC(y, mo - 1, d, hh, mm, ss || 0);
  const first = tzOffset(naive, tz);
  let epoch = naive - first;
  const second = tzOffset(epoch, tz);
  if (second !== first) epoch = naive - second;
  return epoch;
}

/** Ice cuts are labelled at the source; we never infer them from booking gaps. */
export function slotKind(s: Slot): "ice_cut" | "booking" {
  return s.slotType === "maintenance" || /ice cut/i.test(s.title ?? "") ? "ice_cut" : "booking";
}
