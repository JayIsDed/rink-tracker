// isSecure decides the Secure flag on the admin session cookie. Bun 1.4 joins a request header
// sent twice into one "https, https" value, where 1.3 did not, so the whole-value compare lost
// Secure under 1.4. fetch() folds repeated headers before sending, so these requests are
// written to the socket by hand. Importing ../server/auth opens data/rink.db (gitignored).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { connect } from "node:net";
import { isSecure } from "../server/auth";

let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => new Response(isSecure(req) ? "secure" : "plain"),
  });
});

afterAll(() => server.stop(true));

function rawGet(headerLines: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect(server.port, "127.0.0.1", () => {
      sock.write(["GET / HTTP/1.1", "Host: localhost", "Connection: close", ...headerLines, "", ""].join("\r\n"));
    });
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk) => (buf += chunk));
    sock.on("end", () => resolve(buf.slice(buf.indexOf("\r\n\r\n") + 4)));
    sock.on("error", reject);
  });
}

test("X-Forwarded-Proto sent twice keeps Secure", async () => {
  expect(await rawGet(["X-Forwarded-Proto: https", "X-Forwarded-Proto: https"])).toBe("secure");
});

test("the first hop of a list decides", async () => {
  expect(await rawGet(["X-Forwarded-Proto: https, http"])).toBe("secure");
  expect(await rawGet(["X-Forwarded-Proto: http, https"])).toBe("plain");
});

test("a single header still decides, any case", async () => {
  expect(await rawGet(["X-Forwarded-Proto: HTTPS"])).toBe("secure");
  expect(await rawGet(["X-Forwarded-Proto: http"])).toBe("plain");
});

test("no header falls back to the request URL", async () => {
  expect(await rawGet([])).toBe("plain");
});
