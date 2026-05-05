// Focused harness: entry-mode visual audit + cross-reference vs heatmap/issues.
// Captures all 3 surfaces on 4 device profiles, returns CLS + structural verdicts.
import { chromium, devices, type Browser } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const URL_BASE = process.env.URL_BASE ?? "https://rink-tracker.pancake3d.com";
const LABEL = process.env.LABEL ?? "baseline";
const OUT_ROOT = join(import.meta.dir, "..", "data", "sim", LABEL);

const PROFILES: Array<{ name: string; preset?: keyof typeof devices; override?: any }> = [
  {
    name: "s24-ultra",
    override: {
      viewport: { width: 412, height: 915 },
      deviceScaleFactor: 3.5,
      isMobile: true, hasTouch: true,
      userAgent: "Mozilla/5.0 (Linux; Android 14; SM-S928U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
    },
  },
  { name: "iphone-14-pro", preset: "iPhone 14 Pro" },
  { name: "pixel-5", preset: "Pixel 5" },
  { name: "iphone-se", preset: "iPhone SE" },
];

async function captureSurfaces(profile: any, browser: Browser) {
  const ctx = await browser.newContext({
    ...(profile.preset ? devices[profile.preset] : {}),
    ...(profile.override ?? {}),
    serviceWorkers: "block",
  });
  const page = await ctx.newPage();
  const dir = join(OUT_ROOT, profile.name);
  mkdirSync(dir, { recursive: true });
  const notes: string[] = [];

  await page.addInitScript(() => {
    try {
      localStorage.setItem("rinkTracker.user", JSON.stringify({ id: 1, name: "tester", role: "member" }));
      localStorage.setItem("rinkTracker.rink", "U");
    } catch {}
  });

  // 1) Heatmap read mode
  await page.goto(`${URL_BASE}/#/heatmap`, { waitUntil: "networkidle" });
  await page.evaluate(() => document.querySelectorAll("dialog[open]").forEach((d: any) => { if (d.id === "identity-dialog") d.close(); }));
  await page.waitForSelector("#new-session-btn", { state: "visible", timeout: 8000 }).catch(() => notes.push("new-session-btn never visible"));
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(dir, "1-heatmap-read.png"), fullPage: false });

  // 2) Issues tab (for cross-reference of established polish)
  await page.goto(`${URL_BASE}/#/issues`, { waitUntil: "networkidle" });
  await page.evaluate(() => document.querySelectorAll("dialog[open]").forEach((d: any) => { if (d.id === "identity-dialog") d.close(); }));
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(dir, "2-issues.png"), fullPage: false });

  // 3) Entry mode — back to heatmap, click new session
  await page.goto(`${URL_BASE}/#/heatmap`, { waitUntil: "networkidle" });
  await page.evaluate(() => document.querySelectorAll("dialog[open]").forEach((d: any) => { if (d.id === "identity-dialog") d.close(); }));
  await page.waitForSelector("#new-session-btn", { state: "visible" });
  await page.click("#new-session-btn");
  await page.waitForSelector("#start-session-dialog[open]", { timeout: 3000 });
  await page.screenshot({ path: join(dir, "3-start-dialog.png"), fullPage: false });
  await page.fill("#start-session-date", "2099-06-01");
  await page.dispatchEvent("#start-session-date", "input");
  await page.waitForTimeout(150);
  await page.click("#start-session-go");
  await page.waitForSelector("#entry-mode:not([hidden])", { timeout: 3000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(dir, "4-entry-blank.png"), fullPage: false });

  // Type a value to trigger the flag-card
  await page.fill("#entry-depth", "10.5");
  await page.dispatchEvent("#entry-depth", "input");
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(dir, "5-entry-typed.png"), fullPage: false });

  // 6) Walk forward to see "edited" point + a normal value
  await page.click("#entry-next");
  await page.fill("#entry-depth", "2.4");
  await page.dispatchEvent("#entry-depth", "input");
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(dir, "6-entry-walked.png"), fullPage: false });

  // 7) Save Session → summary
  await page.click("#entry-finish");
  await page.waitForSelector("#entry-summary-dialog[open]", { timeout: 2000 }).catch(() => notes.push("summary did not open"));
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(dir, "7-summary.png"), fullPage: false });

  // 8) Layout structural metrics
  const layout = await page.evaluate(() => {
    const bar = document.querySelector(".hm-entry-bar") as HTMLElement | null;
    const sheet = document.querySelector(".hm-entry-sheet") as HTMLElement | null;
    const wrap = document.querySelector(".hm-entry-canvas-wrap") as HTMLElement | null;
    const prog = document.querySelector(".hm-entry-progress") as HTMLElement | null;
    const nav = document.querySelector(".hm-entry-nav") as HTMLElement | null;
    const dateNode = document.querySelector("#entry-mode-date") as HTMLElement | null;
    const tag = document.querySelector(".hm-entry-mode-tag") as HTMLElement | null;
    const sumNode = (node: HTMLElement | null) => {
      if (!node) return null;
      const cs = getComputedStyle(node);
      return {
        backdropFilter: cs.backdropFilter || cs.webkitBackdropFilter || "none",
        background: cs.backgroundColor,
        border: cs.border,
        borderRadius: cs.borderRadius,
        boxShadow: cs.boxShadow,
        padding: cs.padding,
        font: cs.font,
        rect: node.getBoundingClientRect().toJSON(),
      };
    };
    return {
      bar: sumNode(bar),
      wrap: sumNode(wrap),
      sheet: sumNode(sheet),
      prog: sumNode(prog),
      nav: sumNode(nav),
      dateRect: dateNode?.getBoundingClientRect().toJSON(),
      tagRect: tag?.getBoundingClientRect().toJSON(),
      dateLines: dateNode ? Math.round(dateNode.getBoundingClientRect().height / parseFloat(getComputedStyle(dateNode).lineHeight || "16")) : null,
    };
  });

  await ctx.close();
  return { device: profile.name, layout, notes };
}

async function main() {
  mkdirSync(OUT_ROOT, { recursive: true });
  console.log(`[sim-entry] label=${LABEL} url=${URL_BASE}`);
  const browser = await chromium.launch({ headless: true });
  const reports: any[] = [];
  for (const p of PROFILES) {
    process.stdout.write(`[sim-entry] ${p.name} ... `);
    try {
      const r = await captureSurfaces(p, browser);
      reports.push(r);
      console.log(r.notes.length ? `notes: ${r.notes.join(", ")}` : "ok");
    } catch (e) {
      console.log(`ERR: ${(e as Error).message}`);
      reports.push({ device: p.name, error: (e as Error).message });
    }
  }
  await browser.close();
  writeFileSync(join(OUT_ROOT, "summary.json"), JSON.stringify(reports, null, 2));
  console.log(`\n[sim-entry] summary: ${join(OUT_ROOT, "summary.json")}`);
}
main().catch(e => { console.error(e); process.exit(1); });
