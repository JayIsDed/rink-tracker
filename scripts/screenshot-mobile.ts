// Mobile-viewport screenshot of the ice-tracker UI.
import { mkdirSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "bun";

const URL_BASE = process.env.URL_BASE ?? "http://localhost:3737/";
const OUT_DIR = join(import.meta.dir, "..", "data");
mkdirSync(OUT_DIR, { recursive: true });

function findChromium(): string {
  const dirs = ["/home/jay/.cache/puppeteer", "/home/jay/.cache/ms-playwright"];
  for (const root of dirs) {
    if (!existsSync(root)) continue;
    const list = readdirSync(root).map(n => join(root, n)).reverse();
    for (const d of list) {
      const candidates = [
        join(d, "chrome-linux64", "chrome"),
        join(d, "chrome-linux", "chrome"),
        join(d, "chrome-headless-shell-linux64", "chrome-headless-shell"),
      ];
      for (const c of candidates) if (existsSync(c)) return c;
      try {
        for (const sub of readdirSync(d)) {
          for (const c of [
            join(d, sub, "chrome-linux64", "chrome"),
            join(d, sub, "chrome-linux", "chrome"),
            join(d, sub, "chrome-headless-shell-linux64", "chrome-headless-shell"),
            join(d, sub, "chrome"),
          ]) if (existsSync(c)) return c;
        }
      } catch {}
    }
  }
  throw new Error("no chromium binary found");
}

const chromium = findChromium();
const out = join(OUT_DIR, "rink-screenshot-mobile.png");

const proc = spawn({
  cmd: [
    chromium,
    "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
    "--virtual-time-budget=2000",
    // iPhone 14-ish portrait
    "--window-size=390,844",
    "--force-device-scale-factor=1",
    `--screenshot=${out}`,
    URL_BASE,
  ],
  stdout: "pipe", stderr: "pipe",
});
await proc.exited;
console.log("saved:", out);
