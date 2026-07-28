// The morning run. In-process rather than a system crontab so the job ships
// with the container and cannot be left behind by a deploy — which is one of
// the ways the old weather pull went missing.
//
// Fires at 07:00 America/New_York. The interval is recomputed after every fire
// from the wall clock in that zone, so DST transitions do not drift it.

import { pullSchedule } from "./schedule-pull";
import { backfillWeather } from "./weather";
import { lastRun } from "./runs";

const HOUR = Number(process.env.RINK_CRON_HOUR ?? 7);
const TZ = "America/New_York";

/** ms until the next HOUR:00 local. */
export function msUntilNext(now = Date.now(), hour = HOUR, tz = TZ): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(now))
      .map((p) => [p.type, p.value])
  ) as Record<string, string>;

  const h = Number(parts.hour) % 24;
  const m = Number(parts.minute);
  const s = Number(parts.second);
  const secondsNow = h * 3600 + m * 60 + s;
  const target = hour * 3600;
  let delta = target - secondsNow;
  if (delta <= 0) delta += 86400;
  return delta * 1000;
}

export async function runMorningJobs(): Promise<void> {
  // Schedule first: if it throws, the weather backfill still runs. Two
  // independent jobs should not share a failure.
  try {
    await pullSchedule();
  } catch (err) {
    console.error("[cron] schedule pull threw", err);
  }
  try {
    await backfillWeather();
  } catch (err) {
    console.error("[cron] weather backfill threw", err);
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;

export function startScheduler(): void {
  if (process.env.RINK_DISABLE_CRON === "1") {
    console.log("[cron] disabled by RINK_DISABLE_CRON");
    return;
  }

  const arm = () => {
    const wait = msUntilNext();
    timer = setTimeout(async () => {
      await runMorningJobs();
      arm();
    }, wait);
    // Bun keeps the process alive for pending timers; the server is already
    // holding it open, so this is only about not blocking a clean shutdown.
    timer.unref?.();
    console.log(`[cron] next run in ${Math.round(wait / 60000)} min`);
  };

  arm();

  // If the container has been down across a morning, catch up on boot rather
  // than waiting a full day. A restart at 09:00 should not mean no schedule.
  const last = lastRun("schedule_pull");
  const stale = !last || Date.now() - last.ran_at > 26 * 3600e3;
  if (stale) {
    console.log("[cron] no recent run on boot — catching up");
    setTimeout(() => runMorningJobs(), 5000).unref?.();
  }
}

export function stopScheduler(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}
