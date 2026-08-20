// Schedule API — shaped for external consumers.
//
// Two endpoints:
//   GET /api/schedule/cuts  — ice cuts with flanking events, gaps, countdowns
//   GET /api/schedule/day   — full day chronological, both rinks

import { db, json } from "../db";

const TZ = "America/New_York";

type Row = {
  id: number;
  rink_code: string;
  starts_at: number;
  ends_at: number | null;
  title: string | null;
  kind: string;
  pulled_at: number | null;
};

function isoDate(ts: number, tz = TZ): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ts));
  const get = (t: string) => parts.find((p) => p.type === t)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function dayBounds(date: string, tz = TZ): { from: number; to: number } {
  const [y, mo, d] = date.split("-").map(Number);
  const naive = Date.UTC(y, mo - 1, d, 12, 0, 0);

  const offset = (() => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour12: false,
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
      })
        .formatToParts(new Date(naive))
        .map((p) => [p.type, p.value])
    ) as Record<string, string>;
    const asUTC = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour) % 24, Number(parts.minute), Number(parts.second)
    );
    return asUTC - naive;
  })();

  const midnight = Date.UTC(y, mo - 1, d, 0, 0, 0) - offset;
  return { from: midnight, to: midnight + 86400000 };
}

function queryDay(date: string, rink: string | null): Row[] {
  const { from, to } = dayBounds(date);
  return db
    .query<Row, { $from: number; $to: number; $rink: string | null }>(
      `SELECT id, rink_code, starts_at, ends_at, title, kind, pulled_at
       FROM schedule
       WHERE starts_at >= $from AND starts_at < $to
         AND ($rink IS NULL OR rink_code = $rink)
       ORDER BY starts_at`
    )
    .all({ $from: from, $to: to, $rink: rink });
}

type CutEntry = {
  cut: Row;
  before: Row | null;
  after: Row | null;
  gapBefore: number | null;
  gapAfter: number | null;
  countdown: number | null;
};

function buildCutContext(slots: Row[], cut: Row, now: number): CutEntry {
  const cutEnds = cut.ends_at ?? cut.starts_at;

  const pool = slots.filter(
    (s) =>
      s.kind !== "ice_cut" &&
      s.rink_code === cut.rink_code
  );

  const before =
    pool
      .filter((s) => (s.ends_at ?? s.starts_at) <= cut.starts_at)
      .sort((a, b) => (b.ends_at ?? b.starts_at) - (a.ends_at ?? a.starts_at))[0] ?? null;

  const after =
    pool.filter((s) => s.starts_at >= cutEnds).sort((a, b) => a.starts_at - b.starts_at)[0] ?? null;

  const countdown = cut.starts_at > now ? Math.round((cut.starts_at - now) / 1000) : null;

  return {
    cut,
    before,
    after,
    gapBefore: before ? Math.round((cut.starts_at - (before.ends_at ?? before.starts_at)) / 60000) : null,
    gapAfter: after ? Math.round((after.starts_at - cutEnds) / 60000) : null,
    countdown,
  };
}

export function handleCuts(url: URL): Response {
  const now = Date.now();
  const date = url.searchParams.get("date") || isoDate(now);
  const rinkParam = url.searchParams.get("rink");
  const rink = rinkParam === "U" || rinkParam === "L" ? rinkParam : null;

  const allSlots = queryDay(date, null);
  const cuts = allSlots.filter((s) => s.kind === "ice_cut");

  // BondSports emits duplicate slots for the same cut with different IDs.
  // Dedup by (rink, start time) so consumers don't double-count.
  const seen = new Set<string>();
  const dedupedCuts = cuts.filter((c) => {
    const key = `${c.rink_code}:${c.starts_at}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const rinkCuts = rink ? dedupedCuts.filter((c) => c.rink_code === rink) : dedupedCuts;

  const shaped = rinkCuts.map((cut) => buildCutContext(allSlots, cut, now));

  const nextUpper = dedupedCuts
    .filter((c) => c.rink_code === "U" && (c.ends_at ?? c.starts_at) >= now)
    .sort((a, b) => a.starts_at - b.starts_at)[0] ?? null;
  const nextLower = dedupedCuts
    .filter((c) => c.rink_code === "L" && (c.ends_at ?? c.starts_at) >= now)
    .sort((a, b) => a.starts_at - b.starts_at)[0] ?? null;

  return json({
    date,
    rink,
    now,
    nextCut: {
      upper: nextUpper
        ? { id: nextUpper.id, starts_at: nextUpper.starts_at, countdown: Math.round((nextUpper.starts_at - now) / 1000) }
        : null,
      lower: nextLower
        ? { id: nextLower.id, starts_at: nextLower.starts_at, countdown: Math.round((nextLower.starts_at - now) / 1000) }
        : null,
    },
    cuts: shaped,
  });
}

export function handleDay(url: URL): Response {
  const now = Date.now();
  const date = url.searchParams.get("date") || isoDate(now);
  const rinkParam = url.searchParams.get("rink");
  const rink = rinkParam === "U" || rinkParam === "L" ? rinkParam : null;

  const raw = queryDay(date, rink);

  // Dedup: BondSports can emit multiple slot IDs for the same event window.
  const seen = new Set<string>();
  const slots = raw.filter((s) => {
    const key = `${s.rink_code}:${s.starts_at}:${s.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const byRink: Record<string, Row[]> = { U: [], L: [] };
  for (const s of slots) {
    byRink[s.rink_code]?.push(s);
  }

  return json({
    date,
    rink,
    now,
    upper: byRink.U,
    lower: byRink.L,
    total: slots.length,
  });
}
