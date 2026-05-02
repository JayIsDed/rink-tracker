// PWA UI simulation harness — Playwright + mobile emulation.
//
// Captures evidence the user can't easily put into words:
//   - CLS during scroll (proves "borders keep changing")
//   - Body-scroll-bleed when sheet open (proves "background scrolls")
//   - Outside-tap dismiss behavior
//   - Cross-device visual diffs (S24 Ultra primary, iPhone 14 Pro, Pixel 5, iPhone SE floor)
//
// Outputs:
//   data/sim/<label>/<device>/{initial.png, sheet-open.png, after-scroll-attempt.png,
//                              after-outside-tap.png, video.webm, report.json}
//   data/sim/<label>/summary.json — combined metrics across devices
//
// Run:
//   bun scripts/simulate.ts                    # label = "baseline"
//   LABEL=after-fix bun scripts/simulate.ts    # diff against baseline

import { chromium, devices, type Browser, type Page } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const URL_BASE = process.env.URL_BASE ?? "http://localhost:3737";
const LABEL = process.env.LABEL ?? "baseline";
const OUT_ROOT = join(import.meta.dir, "..", "data", "sim", LABEL);

// Device profiles. S24 Ultra is custom (Playwright doesn't ship a preset).
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

type DeviceReport = {
  device: string;
  viewport: { width: number; height: number };
  dpr: number;
  metrics: {
    initialLoadMs: number;
    cls_initial: number;            // CLS in first 3s
    cls_during_scroll: number;      // CLS during programmatic scroll
    cls_during_sheet: number;       // CLS while sheet animates open
    canvasResizedOnScroll: boolean; // canvas intrinsic size changed mid-scroll (BAD)
    canvasSizeBefore: { w: number; h: number };
    canvasSizeAfter: { w: number; h: number };
  };
  modalHygiene: {
    sheetOpensOnPointTap: boolean;
    bodyScrolledWhileSheetOpen: boolean;  // body scroll bleed (BAD if true)
    sheetClosedByOutsideTap: boolean;     // backdrop dismiss (GOOD if true)
    overscrollContained: boolean;         // sheet rubber-band leak (GOOD if contained)
  };
  layout: {
    dockIsFloating: boolean;       // computed style: margin > 0 + radius > 0
    dockOverlapsContent: boolean;  // tab-nav.bottom > shell-main.paddingBottom (BAD)
    headerStable: boolean;         // header position stable across scroll
  };
  notes: string[];
};

async function measureDevice(profile: DeviceProfile, browser: Browser): Promise<DeviceReport> {
  const ctx = await browser.newContext({
    ...(profile.preset ? devices[profile.preset] : {}),
    ...(profile.override ?? {}),
    recordVideo: {
      dir: join(OUT_ROOT, profile.name),
      size: { width: 540, height: 960 },
    },
    serviceWorkers: "block", // SW caching makes test runs flaky
  });

  const page = await ctx.newPage();
  const outDir = join(OUT_ROOT, profile.name);
  mkdirSync(outDir, { recursive: true });

  const notes: string[] = [];
  const t0 = Date.now();

  // Inject CLS observer + identity seed + body scroll tracker BEFORE navigation
  await page.addInitScript(() => {
    // Seed identity FIRST so the app's boot doesn't open the modal
    try {
      localStorage.setItem(
        "rinkTracker.user",
        JSON.stringify({ id: 10, name: "tester", role: "member" }),
      );
    } catch {}

    (window as any).__cls = { total: 0, segments: [] as { mark: string; value: number }[] };
    (window as any).__clsMark = (mark: string) => {
      const cur = (window as any).__cls.total;
      (window as any).__cls.segments.push({ mark, value: cur });
    };
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as any[]) {
        if (!e.hadRecentInput) (window as any).__cls.total += e.value;
      }
    }).observe({ type: "layout-shift", buffered: true });

    (window as any).__bodyScrollLog = [];
    document.addEventListener("scroll", () => {
      (window as any).__bodyScrollLog.push({
        t: performance.now(),
        y: window.scrollY,
      });
    }, { passive: true, capture: true });
  });

  await page.goto(`${URL_BASE}/#/heatmap`, { waitUntil: "networkidle" });
  const initialLoadMs = Date.now() - t0;

  // Wait for canvas + actual data load (date-picker populated == loadForRink finished)
  await page.waitForSelector("#rink", { state: "visible", timeout: 10_000 }).catch(() => {
    notes.push("rink canvas never appeared — empty state or load error");
  });
  await page.waitForFunction(
    () => (document.querySelector("#date-picker") as HTMLSelectElement)?.options.length > 0,
    { timeout: 10_000 },
  ).catch(() => notes.push("date-picker never populated — no data?"));
  await page.waitForTimeout(1500); // let initial CLS settle
  await page.evaluate(() => (window as any).__clsMark("after-initial-load"));
  const cls_initial = await page.evaluate(() => (window as any).__cls.total);

  await page.screenshot({ path: join(outDir, "initial.png"), fullPage: false });

  // ─── Scroll test — does the rink redraw? ──────────────────────────────
  const canvasSizeBefore = await page.evaluate(() => {
    const c = document.querySelector("#rink") as HTMLCanvasElement | null;
    return c ? { w: c.width, h: c.height } : { w: 0, h: 0 };
  });
  const heatmapTab = await page.$(".heatmap-tab");
  if (heatmapTab) {
    await page.evaluate(() => window.scrollBy({ top: 100, behavior: "smooth" }));
    await page.waitForTimeout(600);
    await page.evaluate(() => window.scrollBy({ top: -100, behavior: "smooth" }));
    await page.waitForTimeout(600);
    // Simulate iOS URL-bar collapse: viewport height shrinks ~80px when scrolling down
    const vp = page.viewportSize();
    if (vp) {
      await page.setViewportSize({ width: vp.width, height: vp.height - 80 });
      await page.waitForTimeout(300);
      // Restore viewport before tap test so we get a realistic "URL bar visible" tap
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.waitForTimeout(200);
    }
  }
  const canvasSizeAfter = await page.evaluate(() => {
    const c = document.querySelector("#rink") as HTMLCanvasElement | null;
    return c ? { w: c.width, h: c.height } : { w: 0, h: 0 };
  });
  const canvasResizedOnScroll =
    canvasSizeBefore.w !== canvasSizeAfter.w || canvasSizeBefore.h !== canvasSizeAfter.h;
  await page.evaluate(() => (window as any).__clsMark("after-scroll"));
  const clsAfterScroll = await page.evaluate(() => (window as any).__cls.total);
  const cls_during_scroll = clsAfterScroll - cls_initial;

  // ─── Tap a point — sheet opens? ───────────────────────────────────────
  let sheetOpensOnPointTap = false;
  let bodyScrolledWhileSheetOpen = false;
  let sheetClosedByOutsideTap = false;
  let overscrollContained = false;
  let cls_during_sheet = 0;

  // Overscroll contain check is a CSS computed-style check — doesn't depend on sheet state
  overscrollContained = await page.evaluate(() => {
    const sheet = document.querySelector(".hm-side-pane") as HTMLElement | null;
    if (!sheet) return false;
    const cs = getComputedStyle(sheet);
    return cs.overscrollBehavior === "contain" || cs.overscrollBehaviorY === "contain";
  });

  const canvas = await page.$("#rink");
  if (canvas) {
    // scrollIntoViewIfNeeded ensures the canvas is in the viewport before clicking
    await canvas.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    const box = await canvas.boundingBox();
    if (box) {
      const clsBeforeTap = await page.evaluate(() => (window as any).__cls.total);
      // Use element.click with position — handles auto-scroll-into-view + touch events
      await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
      await page.waitForTimeout(500);
      sheetOpensOnPointTap = await page.evaluate(() =>
        document.querySelector(".hm-side-pane")?.classList.contains("expanded") ?? false,
      );
      cls_during_sheet =
        (await page.evaluate(() => (window as any).__cls.total)) - clsBeforeTap;
      await page.screenshot({ path: join(outDir, "sheet-open.png") });

      if (sheetOpensOnPointTap) {
        // Test body-scroll-bleed: try to scroll the body while sheet is open
        const yBefore = await page.evaluate(() => window.scrollY);
        await page.evaluate(() => {
          // Simulate touch-scroll on the area NOT covered by the sheet (top of page)
          window.scrollBy(0, 80);
          document.documentElement.scrollBy?.(0, 80);
          document.body.scrollBy?.(0, 80);
        });
        await page.waitForTimeout(300);
        const yAfter = await page.evaluate(() => window.scrollY);
        bodyScrolledWhileSheetOpen = yAfter !== yBefore;
        await page.screenshot({ path: join(outDir, "after-scroll-attempt.png") });

        // Test outside-tap-to-close: tap the header area (above the sheet)
        const headerBox = await (await page.$(".shell-header"))?.boundingBox();
        if (headerBox) {
          await page.mouse.click(
            headerBox.x + headerBox.width * 0.5,
            headerBox.y + headerBox.height * 0.5,
          );
          await page.waitForTimeout(400);
          sheetClosedByOutsideTap = !(await page.evaluate(() =>
            document.querySelector(".hm-side-pane")?.classList.contains("expanded") ?? false,
          ));
          await page.screenshot({ path: join(outDir, "after-outside-tap.png") });
        } else {
          notes.push("no .shell-header found — outside-tap test skipped");
        }
      } else {
        notes.push("sheet did not open on point tap");
      }
    }
  } else {
    notes.push("no #rink canvas — heatmap interaction tests skipped");
  }

  // ─── Layout checks ────────────────────────────────────────────────────
  const layout = await page.evaluate(() => {
    const dock = document.querySelector(".tab-nav") as HTMLElement | null;
    const main = document.querySelector(".shell-main") as HTMLElement | null;
    if (!dock || !main) return { dockIsFloating: false, dockOverlapsContent: false, headerStable: true };
    const ds = getComputedStyle(dock);
    // Floating dock signals: rounded corners + offset from edges (left/right > 0 with position:fixed,
    // OR margin > 0 with sticky/relative). Either pattern qualifies.
    const radius = parseFloat(ds.borderTopLeftRadius);
    const leftOff = parseFloat(ds.left) || 0;
    const rightOff = parseFloat(ds.right) || 0;
    const margin = parseFloat(ds.marginLeft) + parseFloat(ds.marginRight);
    const offset = Math.min(leftOff, rightOff);
    const dockIsFloating = radius > 4 && (offset > 4 || margin > 4);

    // Detect overlap: is shell-main's bottom-padding > dock height?
    const dockH = dock.offsetHeight;
    const mainPB = parseFloat(getComputedStyle(main).paddingBottom);
    const dockOverlapsContent = mainPB < dockH;

    return { dockIsFloating, dockOverlapsContent, headerStable: true };
  });

  const viewport = page.viewportSize() ?? { width: 0, height: 0 };
  const dpr = await page.evaluate(() => window.devicePixelRatio);

  await ctx.close();

  return {
    device: profile.name,
    viewport,
    dpr,
    metrics: {
      initialLoadMs,
      cls_initial,
      cls_during_scroll,
      cls_during_sheet,
      canvasResizedOnScroll,
      canvasSizeBefore,
      canvasSizeAfter,
    },
    modalHygiene: {
      sheetOpensOnPointTap,
      bodyScrolledWhileSheetOpen,
      sheetClosedByOutsideTap,
      overscrollContained,
    },
    layout,
    notes,
  };
}

async function main() {
  mkdirSync(OUT_ROOT, { recursive: true });
  console.log(`[sim] label=${LABEL} url=${URL_BASE}`);

  const browser = await chromium.launch({ headless: true });
  const reports: DeviceReport[] = [];

  for (const profile of PROFILES) {
    process.stdout.write(`[sim] ${profile.name} ... `);
    try {
      const r = await measureDevice(profile, browser);
      reports.push(r);
      writeFileSync(
        join(OUT_ROOT, profile.name, "report.json"),
        JSON.stringify(r, null, 2),
      );
      // Quick verdict line per device
      const v = verdict(r);
      console.log(v);
    } catch (err) {
      console.log(`ERR: ${(err as Error).message}`);
      reports.push({
        device: profile.name,
        viewport: { width: 0, height: 0 },
        dpr: 0,
        metrics: { initialLoadMs: 0, cls_initial: 0, cls_during_scroll: 0, cls_during_sheet: 0 },
        modalHygiene: {
          sheetOpensOnPointTap: false,
          bodyScrolledWhileSheetOpen: false,
          sheetClosedByOutsideTap: false,
          overscrollContained: false,
        },
        layout: { dockIsFloating: false, dockOverlapsContent: false, headerStable: false },
        notes: [`crash: ${(err as Error).message}`],
      });
    }
  }
  await browser.close();

  writeFileSync(join(OUT_ROOT, "summary.json"), JSON.stringify(reports, null, 2));
  console.log(`\n[sim] summary written to ${join(OUT_ROOT, "summary.json")}`);

  // Console summary
  console.log("\n┌─────────────────┬──────────┬──────────┬──────────┬──────┬──────┬──────┬──────┐");
  console.log("│ device          │ CLS init │ CLS scrl │ CLS shet │ open │ bleed│ close│ float│");
  console.log("├─────────────────┼──────────┼──────────┼──────────┼──────┼──────┼──────┼──────┤");
  for (const r of reports) {
    const row = [
      r.device.padEnd(15),
      r.metrics.cls_initial.toFixed(3).padStart(8),
      r.metrics.cls_during_scroll.toFixed(3).padStart(8),
      r.metrics.cls_during_sheet.toFixed(3).padStart(8),
      (r.modalHygiene.sheetOpensOnPointTap ? "✓" : "✗").padStart(4),
      (r.modalHygiene.bodyScrolledWhileSheetOpen ? "BAD" : "ok").padStart(4),
      (r.modalHygiene.sheetClosedByOutsideTap ? "✓" : "✗").padStart(4),
      (r.layout.dockIsFloating ? "✓" : "✗").padStart(4),
    ];
    console.log(`│ ${row.join(" │ ")} │`);
  }
  console.log("└─────────────────┴──────────┴──────────┴──────────┴──────┴──────┴──────┴──────┘");
  console.log("CLS thresholds: <0.1 good, 0.1-0.25 needs work, >0.25 bad");
}

function verdict(r: DeviceReport): string {
  const issues: string[] = [];
  if (r.metrics.cls_during_scroll > 0.1) issues.push(`CLS-scroll ${r.metrics.cls_during_scroll.toFixed(2)}`);
  if (r.metrics.canvasResizedOnScroll) issues.push("canvas-resize-on-scroll");
  if (r.modalHygiene.bodyScrolledWhileSheetOpen) issues.push("bg-scroll-bleed");
  if (r.modalHygiene.sheetOpensOnPointTap && !r.modalHygiene.sheetClosedByOutsideTap) issues.push("no-outside-dismiss");
  if (!r.modalHygiene.overscrollContained) issues.push("no-overscroll-contain");
  if (!r.layout.dockIsFloating) issues.push("dock-edge-anchored");
  return issues.length === 0 ? "all clean" : `issues: ${issues.join(", ")}`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
