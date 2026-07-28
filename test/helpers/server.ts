// Spin up a real server process for a test file.
//
// WHY A SUBPROCESS. `server/server.ts` and `server/db.ts` both do their work at
// module scope — the Database is constructed on import, Bun.serve is called on
// import. Bun runs every test file in one process and shares the module cache,
// so a second file that imports the server does NOT get a second server. It
// gets the first file's instance, bound to the first file's database, and
// stopped by the first file's afterAll. Tests then fail with ConnectionRefused
// on port 0, which points nowhere near the actual cause.
//
// That landmine was invisible while exactly one file imported the server. Rather
// than keep it and remember not to step on it, every server-driven test file now
// spawns its own process with its own RINK_DB. It costs a couple hundred
// milliseconds per file and buys real isolation — plus it exercises the actual
// boot path (migrations, admin bootstrap, seeding, scheduler) instead of a
// module import that happens to look like one.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type TestServer = {
  base: string;
  /** Cookie jar, so identity survives across calls the way a device would. */
  call: (path: string, init?: RequestInit) => Promise<{ status: number; body: any; headers: Headers }>;
  /** Readable and writable so a test can forge or drop a cookie deliberately. */
  cookies: string;
  stop: () => void;
};

const LISTENING = /listening on (http:\/\/localhost:\d+)/;

export async function startServer(
  label: string,
  env: Record<string, string> = {}
): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), `rink-${label}-`));

  const proc = Bun.spawn(["bun", "server/server.ts"], {
    cwd: new URL("../../", import.meta.url).pathname,
    env: {
      ...process.env,
      RINK_DB: join(dir, "test.db"),
      PORT: "0",
      RINK_ADMIN_PINS: "Boss:9999",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  // Read stdout until the server announces its port. Bun picks a free one for
  // PORT=0, so parsing the banner is how we learn it — no port guessing, no
  // races between parallel test files.
  const base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`[${label}] server did not start in 15s`)), 15000);
    (async () => {
      const decoder = new TextDecoder();
      let buf = "";
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        const m = LISTENING.exec(buf);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]);
          return;
        }
      }
      clearTimeout(timer);
      reject(new Error(`[${label}] server exited before listening:\n${buf}`));
    })().catch(reject);
  });

  let cookies = "";

  async function call(path: string, init: RequestInit = {}) {
    const res = await fetch(base + path, {
      ...init,
      headers: { "content-type": "application/json", cookie: cookies, ...(init.headers ?? {}) },
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      // One cookie per response in this app; keep both names in the jar.
      const first = setCookie.split(";")[0];
      const name = first.split("=")[0];
      const kept = cookies
        .split("; ")
        .filter((c) => c && !c.startsWith(`${name}=`))
        .concat(first);
      cookies = kept.join("; ");
    }
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.status, body, headers: res.headers };
  }

  return {
    base,
    call,
    get cookies() {
      return cookies;
    },
    set cookies(v: string) {
      cookies = v;
    },
    stop() {
      proc.kill();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
