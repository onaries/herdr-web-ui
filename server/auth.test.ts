import { afterAll, afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { authClient, forgetAuthAttempts, handleAuthRequest, isSecureRequest, presentedToken, recordPresentedTokenFailure } from "./auth.ts";
import { sameOrigin } from "./machine-security.ts";

const dir = mkdtempSync(join(tmpdir(), "herdr-auth-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => forgetAuthAttempts());

const TOKEN = "a-token-long-enough-to-be-a-real-one";
const offer = (token: string, ip: string): Promise<Response> => handleAuthRequest(
  new Request("http://192.168.0.10:7317/api/auth", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) }),
  TOKEN,
  ip,
);

describe("POST /api/auth", () => {
  // a held answer is a wait of one second: the clock stands still, so a slow run cannot outlast it
  beforeEach(() => { setSystemTime(Date.now()); });
  afterEach(() => { setSystemTime(); });
  it("answers a wrong token, and a right one, as it always did", async () => {
    expect((await offer("wrong", "10.0.0.1")).status).toBe(401);
    expect((await offer(TOKEN, "10.0.0.2")).status).toBe(204);
  });

  it("holds a run of wrong tokens back, one address at a time, and a right token spends the wait", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) expect((await offer("wrong", "10.0.0.9")).status).toBe(401);
    // the sixth ask never reaches the comparison: the address is inside its wait
    const held = await offer(TOKEN, "10.0.0.9");
    expect(held.status).toBe(429);
    expect(Number(held.headers.get("retry-after"))).toBeGreaterThan(0);
    // another address is untouched, and the correct token spends the budget
    expect((await offer(TOKEN, "10.0.0.8")).status).toBe(204);
    forgetAuthAttempts();
    for (let attempt = 0; attempt < 4; attempt += 1) expect((await offer("wrong", "10.0.0.7")).status).toBe(401);
    expect((await offer(TOKEN, "10.0.0.7")).status).toBe(204);
    // the run starts over after the success
    for (let attempt = 0; attempt < 4; attempt += 1) expect((await offer("wrong", "10.0.0.7")).status).toBe(401);
    expect((await offer("wrong", "10.0.0.7")).status).toBe(401);
    expect((await offer(TOKEN, "10.0.0.7")).status).toBe(429);
  });

  it("holds concurrent guesses back too: the budget is read again after the body arrives", async () => {
    const statuses = (await Promise.all(Array.from({ length: 12 }, () => offer("wrong", "10.0.0.11")))).map((response) => response.status);
    expect(statuses.filter((status) => status === 401).length).toBe(5);
    expect(statuses.filter((status) => status === 429).length).toBe(7);
  });

  it("gives a client that writes its own X-Forwarded-For a fresh address, but not a fresh share of its proxy's budget", async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const client = authClient("127.0.0.1", new Headers({ "x-forwarded-for": `claimed-${attempt}` }));
      statuses.push((await handleAuthRequest(new Request("http://h/api/auth", { method: "POST", body: JSON.stringify({ token: "wrong" }) }), TOKEN, client)).status);
    }
    expect(statuses.filter((status) => status === 401).length).toBe(50);
    expect(statuses.at(-1)).toBe(429);
  });

  it("keeps the shared budget on the real peer when the forwarded address itself says ' via '", async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const client = authClient("127.0.0.1", new Headers({ "x-forwarded-for": `claimed via ${attempt}` }));
      statuses.push((await handleAuthRequest(new Request("http://h/api/auth", { method: "POST", body: JSON.stringify({ token: "wrong" }) }), TOKEN, client)).status);
    }
    expect(statuses.filter((status) => status === 401).length).toBe(50);
    expect(statuses.at(-1)).toBe(429);
  });

  it("holds nobody back when the address is unknown, and stays open with no token set", async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      expect((await handleAuthRequest(new Request("http://h/api/auth", { method: "POST", body: "{}" }), TOKEN, null)).status).toBe(400);
    }
    expect((await handleAuthRequest(new Request("http://h/api/auth", { method: "POST", body: "{}" }), "", "10.0.0.5")).status).toBe(204);
  });
});

describe("authClient", () => {
  it("takes the address a proxy on this PC saw, and nobody else's word for it", () => {
    const via = (value: string): Headers => new Headers({ "x-forwarded-for": value });
    expect(authClient("127.0.0.1", via("100.64.0.9"))).toBe("100.64.0.9 via 127.0.0.1");
    // the proxy appends what it saw: an entry the client wrote in front of it is not believed
    expect(authClient("::1", via("1.2.3.4, 100.64.0.9"))).toBe("100.64.0.9 via ::1");
    expect(authClient("127.0.0.1", new Headers())).toBe("127.0.0.1");
    expect(authClient("192.168.0.20", via("100.64.0.9"))).toBe("192.168.0.20");
    expect(authClient(null, via("100.64.0.9"))).toBeNull();
  });
});

describe("the budget visitors behind one proxy share", () => {
  const cookie = (value: string): Request => new Request("http://h/api/health", { headers: { cookie: `herdr_web_token=${value}` } });
  const ask = (value: string, client: string): ReturnType<typeof presentedToken> => {
    const answer = presentedToken(cookie(value), TOKEN, client);
    if (answer === "wrong") recordPresentedTokenFailure(client);
    return answer;
  };

  it("is never filled by one browser left polling with an old cookie", () => {
    const start = Date.now();
    try {
      // a locked page polls /api/health every 5 s for three hours with the token it had before
      for (let second = 0; second <= 3 * 3600; second += 5) {
        setSystemTime(start + second * 1000);
        ask("old-token", "100.64.0.9 via 127.0.0.1");
        if (second % 600 === 0) expect(presentedToken(cookie(TOKEN), TOKEN, `100.64.1.${second / 600} via 127.0.0.1`)).toBe("match");
      }
    } finally { setSystemTime(); }
  });

  it("holds new addresses while it is full, never one that got in lately, and empties on its own", () => {
    const start = Date.now();
    try {
      setSystemTime(start);
      expect(ask(TOKEN, "100.64.0.30 via 127.0.0.1")).toBe("match");
      for (let attempt = 0; attempt < 60; attempt += 1) ask("guess", `rotated-${attempt} via 127.0.0.1`);
      expect(presentedToken(cookie(TOKEN), TOKEN, "100.64.0.31 via 127.0.0.1")).toBe("held");
      expect(presentedToken(cookie(TOKEN), TOKEN, "100.64.0.30 via 127.0.0.1")).toBe("match");
      setSystemTime(start + 10 * 60_000 + 1000);
      expect(presentedToken(cookie(TOKEN), TOKEN, "100.64.0.31 via 127.0.0.1")).toBe("match");
    } finally { setSystemTime(); }
  });
});

describe("isSecureRequest", () => {
  it("marks a cookie Secure only for a request that arrived over https", () => {
    expect(isSecureRequest(new Request("https://host/api/auth"))).toBe(true);
    expect(isSecureRequest(new Request("https://host/api/auth", { headers: { "x-forwarded-proto": "https" } }))).toBe(true);
    expect(isSecureRequest(new Request("http://host/api/auth"))).toBe(false);
    expect(isSecureRequest(new Request("http://host/api/auth", { headers: { "x-forwarded-proto": "http" } }))).toBe(false);
  });
});

describe("sameOrigin", () => {
  it("trusts a stated same-origin and refuses a stated cross-site one", () => {
    expect(sameOrigin(new Request("http://host/api/pane/close", { headers: { origin: "http://host" } }))).toBe(true);
    expect(sameOrigin(new Request("http://host/api/pane/close", { headers: { origin: "https://evil.invalid", "x-herdr-machine": "1" } }))).toBe(false);
    expect(sameOrigin(new Request("http://host/api/pane/close", { headers: { "sec-fetch-site": "cross-site", "x-herdr-machine": "1" } }))).toBe(false);
  });

  it("lets a request with no Origin through, so a CLI client can use the custom mutation header", () => {
    expect(sameOrigin(new Request("http://host/api/pane/close", { headers: { "x-herdr-machine": "1" } }))).toBe(true);
  });

  it("reads a session cookie with no Origin as cross-site, except the paths such a client must use", () => {
    const session = { cookie: "herdr_web_token=abc; herdr_web_device=def" };
    // the origin check is not a complete control until these are refused
    expect(sameOrigin(new Request("http://host/api/pane/close", { method: "POST", headers: session }))).toBe(false);
    expect(sameOrigin(new Request("http://host/api/workspace/create", { method: "POST", headers: session }))).toBe(false);
    expect(sameOrigin(new Request("http://host/api/machines/local/workspace/create", { method: "POST", headers: session }))).toBe(false);
    // either cookie alone marks it session-bearing
    expect(sameOrigin(new Request("http://host/api/pane/close", { method: "POST", headers: { cookie: "herdr_web_device=def" } }))).toBe(false);
    expect(sameOrigin(new Request("http://host/api/pane/close", { method: "POST", headers: { cookie: "herdr_web_token=abc" } }))).toBe(false);
    // the custom mutation header is the non-browser client's proof
    expect(sameOrigin(new Request("http://host/api/pane/close", { method: "POST", headers: { ...session, "x-herdr-machine": "1" } }))).toBe(true);
    expect(sameOrigin(new Request("http://host/api/updates/check", { method: "POST", headers: { ...session, "x-herdr-update": "1" } }))).toBe(true);
    // these carry no header in the cases that need them: the WS handshake (a GET) a
    // browser cannot add one to, and the two endpoints that manage the sender's own session
    expect(sameOrigin(new Request("http://host/ws", { headers: session }))).toBe(true);
    expect(sameOrigin(new Request("http://host/api/auth", { method: "DELETE", headers: session }))).toBe(true);
    expect(sameOrigin(new Request("http://host/api/push/subscribe", { method: "POST", headers: session }))).toBe(true);
    // the exemption is the path, not the method: another mutation on a neighbouring path is refused
    expect(sameOrigin(new Request("http://host/api/push/test", { method: "POST", headers: session }))).toBe(false);
  });

  it("lets a same-origin read through with no Origin, which a browser leaves off its own GET", () => {
    // EventSource("/api/machines/events") can add no header, and a same-origin GET states no Origin
    const page = { cookie: "herdr_web_token=abc; herdr_web_device=def", "sec-fetch-site": "same-origin" };
    expect(sameOrigin(new Request("http://host/api/machines/events", { headers: page }))).toBe(true);
    expect(sameOrigin(new Request("http://host/api/machines/local/session", { headers: page }))).toBe(true);
    expect(sameOrigin(new Request("http://host/api/machines/local/session", { method: "HEAD", headers: page }))).toBe(true);
    // a mutation from the same page states its Origin; one that does not is still refused
    expect(sameOrigin(new Request("http://host/api/machines/local/workspace/create", { method: "POST", headers: page }))).toBe(false);
  });

});