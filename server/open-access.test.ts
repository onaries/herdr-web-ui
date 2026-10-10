import { afterAll, beforeAll, describe, expect, it, setSystemTime } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServer } from "./index.ts";
import { DeviceStore } from "./devices.ts";
import { forgetAuthAttempts } from "./auth.ts";

/**
 * The access gate at the HTTP seam: what this PC needs to reach, and what a watching
 * device does not. `decideAccess` itself (loopback, Tailscale, token, device, open mode)
 * is covered in server/access.test.ts, and pairing initiation in server/devices.test.ts.
 */

const root = mkdtempSync(join(tmpdir(), "herdr-open-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("this PC, with no token and no configuration", () => {
  let server: ReturnType<typeof createServer>;
  let base: string;
  let rejectionListeners = 0;
  beforeAll(() => {
    forgetAuthAttempts();
    rejectionListeners = process.listenerCount("unhandledRejection");
    server = createServer({ port: 0, stateDir: root });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => server.stop());

  it("leaves an unhandled rejection to Bun, which exits so the supervisor sees the crash", () => {
    expect(process.listenerCount("unhandledRejection")).toBe(rejectionListeners);
  });

  it("is let in with nothing set up: the local-dev path", async () => {
    expect((await fetch(`${base}/api/devices`)).status).toBe(200);
    const started = await fetch(`${base}/api/devices/pair/start`, { method: "POST", headers: { origin: base, "x-herdr-machine": "1" } });
    expect(started.status).toBe(200);
    expect((await started.json() as { code: string }).code).toMatch(/^\d{6}$/);
    // the gate is still open to strangers here: nothing is paired and no token exists,
    // which is why the address is refused outside this PC (server/access.ts)
    expect(new DeviceStore(root).gated).toBe(false);
  });
});

describe("a paired watch device", () => {
  let server: ReturnType<typeof createServer>;
  let base: string;
  let cookie: string;
  beforeAll(() => {
    // paired before the server starts, so its own store holds the device
    const devices = new DeviceStore(root);
    const paired = devices.pair(devices.startPairing().code, "Watch", "watch")!;
    cookie = `herdr_web_device=${encodeURIComponent(paired.token)}`;
    server = createServer({ port: 0, stateDir: root });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => server.stop());

  const asWatcher = (path: string, method = "GET") => fetch(`${base}${path}`, {
    method,
    headers: { cookie, origin: base, "x-herdr-machine": "1", ...(method === "POST" ? { "content-type": "application/json" } : {}) },
  });

  it("keeps the filesystem, the directory listing and push/test out of reach", async () => {
    // its own credentials are a preference of that device, so signing out keeps working
    expect((await asWatcher("/api/auth", "DELETE")).status).toBe(204);
    // the filesystem and the directory listing are shape the terminal never shows it
    expect((await asWatcher("/api/fs/file?path=/etc/hostname")).status).toBe(403);
    expect((await asWatcher("/api/workspace/directories?cwd=/tmp")).status).toBe(403);
    expect((await asWatcher("/api/machines/local/workspace/directories?cwd=/tmp")).status).toBe(403);
    // sending an alert is not a preference: it makes the server POST somewhere
    expect((await asWatcher("/api/push/test", "POST")).status).toBe(403);
    // watching is the role's whole point
    expect((await asWatcher("/api/devices")).status).toBe(200);
  });

  it("is refused a pane read outside the enums, and the route's own method check", async () => {
    const read = await asWatcher("/api/pane/read?pane_id=w9999:p9999&source=bogus");
    expect(read.status).toBe(400);
    expect((await read.json() as { error: { code: string } }).error.code).toBe("invalid_source");
    const format = await asWatcher("/api/pane/read?pane_id=w9999:p9999&format=markdown");
    expect((await format.json() as { error: { code: string } }).error.code).toBe("invalid_format");
    // the same check on this PC, where the method is the only thing wrong
    const posted = await fetch(`${base}/api/pane/read?pane_id=w9999:p9999&source=visible`, { method: "POST", headers: { origin: base, "x-herdr-machine": "1" } });
    expect(posted.status).toBe(400);
    expect((await posted.json() as { error: { code: string } }).error.code).toBe("method_not_allowed");
  });

  it("keeps its own session's paths open with no Origin, and refuses every other mutation that carries one", async () => {
    // A cookie-bearing client that cannot state an origin — a non-browser one, or a WS
    // handshake — keeps the endpoints its own session needs, while every other mutation is
    // now read as cross-site rather than same-origin.
    const read = () => fetch(`${base}/api/pane/read?pane_id=w9999:p9999&source=visible`, { method: "POST", headers: { cookie } });
    expect((await read()).status).toBe(403);
    expect((await (await read()).json() as { error: { code: string } }).error.code).toBe("invalid_origin");
    // the custom mutation header is that client's proof, and it still passes the origin gate:
    // what answers next is this device's own role, not the origin check
    const cli = await fetch(`${base}/api/pane/read?pane_id=w9999:p9999&source=visible`, { method: "POST", headers: { cookie, "x-herdr-machine": "1" } });
    expect(cli.status).toBe(403);
    expect((await cli.json() as { error: { code: string } }).error.code).toBe("read_only");
  });

});
describe("a token set: guessing it", () => {
  const TOKEN = "the-right-token-for-this-test";
  let server: ReturnType<typeof createServer>;
  let base: string;
  const stateDir = mkdtempSync(join(root, "token-"));
  let watchToken = "";
  beforeAll(() => {
    forgetAuthAttempts();
    // a held answer is a wait of one second: the clock stands still, so a slow run cannot outlast it
    setSystemTime(Date.now());
    // paired before the server starts, so its own store holds the device
    const store = new DeviceStore(stateDir);
    watchToken = store.pair(store.startPairing().code, "Watch", "watch")!.token;
    server = createServer({ port: 0, stateDir, token: TOKEN });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => { server.stop(); setSystemTime(); });
  const devices = (bearer: string, via?: string): Promise<Response> =>
    fetch(`${base}/api/devices`, { headers: { authorization: `Bearer ${bearer}`, ...(via ? { "x-forwarded-for": via } : {}) } });

  it("holds a run of wrong Bearer tokens back on every route, not only the sign-in form", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) expect((await devices(`wrong-${attempt}`, "100.64.0.1")).status).toBe(401);
    // inside the wait even the right token is not compared, so a guess learns nothing
    const held = await devices(TOKEN, "100.64.0.1");
    expect(held.status).toBe(429);
    expect(Number(held.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("counts guesses that arrive together", async () => {
    const statuses = (await Promise.all(Array.from({ length: 12 }, (_, attempt) => devices(`together-${attempt}`, "100.64.0.4")))).map((response) => response.status);
    expect(statuses.filter((status) => status === 401).length).toBe(5);
    expect(statuses.filter((status) => status === 429).length).toBe(7);
  });

  it("counts a paired watch device's guesses, so it cannot guess its way up to drive", async () => {
    const watcher = (bearer: string): Promise<Response> => fetch(`${base}/api/push/test`, {
      method: "POST",
      headers: { cookie: `herdr_web_device=${encodeURIComponent(watchToken)}`, authorization: `Bearer ${bearer}`, origin: base, "content-type": "application/json", "x-forwarded-for": "100.64.0.5" },
      body: "{}",
    });
    for (let attempt = 0; attempt < 5; attempt += 1) expect((await watcher(`guess-${attempt}`)).status).toBe(403);
    // inside its wait the right token is not compared: the device stays a watcher
    expect((await watcher(TOKEN)).status).toBe(403);
  });

  it("keeps each visitor behind a proxy on this PC apart, by the address the proxy saw", async () => {
    expect((await devices(TOKEN, "100.64.0.2")).status).toBe(200);
  });

  it("lets the owner sign in while their cookie's wait runs, and the sign-in spends it", async () => {
    const cookie = { cookie: "herdr_web_token=stale-token", "x-forwarded-for": "100.64.0.3" };
    for (let attempt = 0; attempt < 6; attempt += 1) await fetch(`${base}/api/health`, { headers: cookie });
    const signIn = await fetch(`${base}/api/auth`, { method: "POST", headers: { origin: base, "content-type": "application/json", "x-forwarded-for": "100.64.0.3" }, body: JSON.stringify({ token: TOKEN }) });
    expect(signIn.status).toBe(204);
    expect((await devices(TOKEN, "100.64.0.3")).status).toBe(200);
  });
});
