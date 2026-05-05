// Focused screenshot harness for entry mode (and read-mode + issues for compare).
// Runs all 4 device profiles, drives the UI into entry mode, captures evidence.
//
// Run:
//   URL_BASE=https://rink-tracker.pancake3d.com LABEL=entry-baseline bun scripts/screenshot-entry-mode.ts
//
// Outputs:
//   data/sim/<label>/<device>/{
//     heatmap-read.png,        // baseline read-mode for design comparison
//     issues.png,              // issues tab — established polish reference
//     start-dialog.png,        // start-session dialog (date + order)
//     entry-initial.png,       // entry mode immediately after Begin
//     entry-with-data.png,     // entry mode after entering depth/temp on a point
//     summary.png,             // end-of-session summary dialog
//   }

import { chromium, devices, type Browser } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const URL_BASE = process.env.URL_BASE ?? "http://localhost:3737";
const LABEL = process.env.LABEL ?? "entry-baseline";
const OUT_ROOT = join(import.meta.dir, "..", "data", "sim", LABEL);

type DeviceProfile = {
  name: string;
  preset?: keyof typeof devices;
  override?: Partial<Parameters<Browser["newContext"]>[0]>;
};

const PROFILES: DeviceProfile[] = [
  {
    name: "s24-ultra",
    override: {
      viewport: { width: 412, height: 915 },
      deviceScaleFactor: 3.5,
      isMobile: true,
      hasTouch: true,
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; SM-S928U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
    },
  },
  { name: "iphone-14-pro", preset: "iPhone 14 Pro" },
  { name: "pixel-5", preset: "Pixel 5" },
  { name: "iphone-se", preset: "iPhone SE" },
];

async function captureDevice(profile: DeviceProfile, browser: Browser) {
  const ctx = await browser.newContext({
    ...(profile.preset ? devices[profile.preset] : {}),
    ...(profile.override ?? {}),
    serviceWorkers: "block",
  });

  const page = await ctx.newPage();
  const outDir = join(OUT_ROOT, profile.name);
  mkdirSync(outDir, { recursive: true });

  const notes: string[] = [];

  await page.addInitScript(() => {
    try {
      localStorage.setItem(
        "rinkTracker.user",
        JSON.stringify({ id: 10, name: "tester", role: "member" }),
      );
    } catch {}
  });

  // ── 1. Heatmap read-mode (reference) ────────────────────────────────────
  await page.goto(`${URL_BASE}/#/heatmap`, { waitUntil: "networkidle" });
  await page.waitForSelector("#rink", { state: "visible", timeout: 10_000 }).catch(() => {
    notes.push("rink canvas missing");
  });
  // Wait for date-picker populated == data loaded
  await page
    .waitForFunction(
      () => (document.querySelector("#date-picker") as HTMLSelectElement)?.options.length > 0,
      { timeout: 10_000 },
    )
    .catch(() => notes.push("date-picker never populated"));
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(outDir, "heatmap-read.png"), fullPage: false });

  // ── 2. Issues tab (established polish reference) ────────────────────────
  await page.goto(`${URL_BASE}/#/issues`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(outDir, "issues.png"), fullPage: false });

  // ── 3. Back to heatmap → click "+ New Session" → start dialog ──────────
  await page.goto(`${URL_BASE}/#/heatmap`, { waitUntil: "networkidle" });
  await page
    .waitForFunction(
      () => (document.querySelector("#date-picker") as HTMLSelectElement)?.options.length > 0,
      { timeout: 10_000 },
    )
    .catch(() => notes.push("date-picker never populated (2nd time)"));
  await page.waitForTimeout(500);

  const newSessionBtn = await page.$("#new-session-btn");
  if (!newSessionBtn) {
    notes.push("no #new-session-btn found");
  } else {
    await newSessionBtn.click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(outDir, "start-dialog.png"), fullPage: false });

    // Pick a future date (so it doesn't collide with real data)
    await page.evaluate(() => {
      const d = document.querySelector("#start-session-date") as HTMLInputElement | null;
      if (d) {
        d.value = "2099-06-01";
        d.dispatchEvent(new Event("input", { bubbles: true }));
        d.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    await page.waitForTimeout(200);

    // Submit
    const goBtn = await page.$("#start-session-go");
    if (goBtn) {
      await goBtn.click();
    } else {
      notes.push("no #start-session-go");
    }

    // Wait for entry-mode to become visible
    await page
      .waitForFunction(
        () => {
          const el = document.querySelector("#entry-mode") as HTMLElement | null;
          return el && !el.hidden;
        },
        { timeout: 5_000 },
      )
      .catch(() => notes.push("entry-mode never became visible"));

    await page.waitForTimeout(800);
    await page.screenshot({ path: join(outDir, "entry-initial.png"), fullPage: false });

    // ── 4. Type a depth + temp value to capture the "with data" state ───
    const depth = await page.$("#entry-depth");
    const temp = await page.$("#entry-temp");
    if (depth && temp) {
      await depth.click();
      await depth.fill("1.25");
      await temp.click();
      await temp.fill("28");
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(outDir, "entry-with-data.png"), fullPage: false });
    } else {
      notes.push("entry-depth/temp inputs missing");
    }

    // ── 5. Trigger the summary dialog ───────────────────────────────────
    const finishBtn = await page.$("#entry-finish");
    if (finishBtn) {
      await finishBtn.click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(outDir, "summary.png"), fullPage: false });
    } else {
      notes.push("no #entry-finish");
    }
  }

  await ctx.close();

  return { device: profile.name, notes };
}

async function main() {
  mkdirSync(OUT_ROOT, { recursive: true });
  console.log(`[entry-shot] label=${LABEL} url=${URL_BASE}`);

  const browser = await chromium.launch({ headless: true });
  const reports: { device: string; notes: string[] }[] = [];

  for (const profile of PROFILES) {
    process.stdout.write(`[entry-shot] ${profile.name} ... `);
    try {
      const r = await captureDevice(profile, browser);
      reports.push(r);
      console.log(r.notes.length === 0 ? "ok" : `notes: ${r.notes.join("; ")}`);
    } catch (err) {
      console.log(`ERR: ${(err as Error).message}`);
      reports.push({ device: profile.name, notes: [`crash: ${(err as Error).message}`] });
    }
  }
  await browser.close();

  writeFileSync(join(OUT_ROOT, "summary.json"), JSON.stringify(reports, null, 2));
  console.log(`[entry-shot] summary: ${join(OUT_ROOT, "summary.json")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
