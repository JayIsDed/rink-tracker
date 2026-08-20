// Hourly schedule pull + daily weather backfill. In-process rather than a
// system crontab so the jobs ship with the container and cannot be left behind
// by a deploy — which is one of the ways the old weather pull went missing.

import { pullSchedule } from "./schedule-pull";
import { backfillWeather } from "./weather";
import { lastRun } from "./runs";

const SCHEDULE_INTERVAL_MS = Number(process.env.RINK_SCHEDULE_INTERVAL_MS ?? 3600000); // 1h
const WEATHER_HOUR = Number(process.env.RINK_CRON_HOUR ?? 7);
const TZ = "America/New_York";

/** ms until the next HOUR:00 local — used for the daily weather job. */
export function msUntilNext(now = Date.now(), hour = WEATHER_HOUR, tz = TZ): number {
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

export async function runSchedulePull(): Promise<void> {
  try {
    await pullSchedule();
  } catch (err) {
    console.error("[cron] schedule pull threw", err);
  }
}

export async function runWeatherBackfill(): Promise<void> {
  try {
    await backfillWeather();
  } catch (err) {
    console.error("[cron] weather backfill threw", err);
  }
}

export async function runMorningJobs(): Promise<void> {
  await runSchedulePull();
  await runWeatherBackfill();
}

let scheduleTimer: ReturnType<typeof setTimeout> | null = null;
let weatherTimer: ReturnType<typeof setTimeout> | null = null;

export function startScheduler(): void {
  if (process.env.RINK_DISABLE_CRON === "1") {
    console.log("[cron] disabled by RINK_DISABLE_CRON");
    return;
  }

  // Schedule pull: hourly interval
  const armSchedule = () => {
    scheduleTimer = setTimeout(async () => {
      await runSchedulePull();
      armSchedule();
    }, SCHEDULE_INTERVAL_MS);
    scheduleTimer.unref?.();
    console.log(`[cron] next schedule pull in ${Math.round(SCHEDULE_INTERVAL_MS / 60000)} min`);
  };

  // Weather backfill: daily at WEATHER_HOUR:00
  const armWeather = () => {
    const wait = msUntilNext();
    weatherTimer = setTimeout(async () => {
      await runWeatherBackfill();
      armWeather();
    }, wait);
    weatherTimer.unref?.();
    console.log(`[cron] next weather backfill in ${Math.round(wait / 60000)} min`);
  };

  armSchedule();
  armWeather();

  // Catch up on boot if stale — a restart should not mean waiting a full cycle.
  const last = lastRun("schedule_pull");
  const stale = !last || Date.now() - last.ran_at > SCHEDULE_INTERVAL_MS * 1.5;
  if (stale) {
    console.log("[cron] schedule stale on boot — catching up");
    setTimeout(() => runSchedulePull(), 5000).unref?.();
  }

  const lastWeather = lastRun("weather_backfill");
  const weatherStale = !lastWeather || Date.now() - lastWeather.ran_at > 26 * 3600e3;
  if (weatherStale) {
    console.log("[cron] weather stale on boot — catching up");
    setTimeout(() => runWeatherBackfill(), 6000).unref?.();
  }
}

export function stopScheduler(): void {
  if (scheduleTimer) clearTimeout(scheduleTimer);
  if (weatherTimer) clearTimeout(weatherTimer);
  scheduleTimer = null;
  weatherTimer = null;
}
