import { afterAll, beforeAll, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UsageLoginStarted } from "../shared/usage-login.ts";
import { createServer } from "./index.ts";
import { paneClose, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import * as herdr from "./herdr/client.ts";
import * as collector from "./collector.ts";
import { isJsonObject } from "./http.ts";
import { UsageLoginService } from "./usage-login.ts";
import { UsageService, USAGE_PROVIDERS, type UsageContext } from "./usage.ts";

const root = mkdtempSync(join(tmpdir(), "usage-login-'quoted-"));
const bin = join(root, "bin");
let workspaceId: string;
let server: ReturnType<typeof createServer>;
const openedPanes: string[] = [];
const missedExit = Promise.withResolvers<string>();
const ctx: UsageContext = {
  home: root, env: {}, platform: "linux", now: Date.now,
  fetch: async () => Response.json({ five_hour: { utilization: 20 }, plan_type: "plus", rate_limit: {} }),
  run: async () => null, keychain: async () => ({ status: "missing" }),
};
beforeAll(async () => {
  mkdirSync(bin);
  for (const provider of ["claude", "codex", "agent", "gh", "grok", "opencode"]) {
    writeFileSync(join(bin, provider), `#!${process.execPath}
import { renameSync } from "node:fs";
import { join } from "node:path";
const provider = ${JSON.stringify(provider)};
if (process.argv.includes("--help")) { console.log(provider === "claude" || process.env.TEST_LOGIN_NO_DEVICE ? "login" : "--device-auth"); process.exit(0); }
const home = process.env[provider === "claude" ? "CLAUDE_CONFIG_DIR" : provider === "codex" ? "CODEX_HOME" : "HOME"];
if (provider === "claude") {
  await Bun.write(join(home, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fixture-local-token" } }));
  await Bun.write(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "local-work", emailAddress: "work@example.test" } }));
} else if (provider === "codex") {
  const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/profile": { email: "codex@example.test" } })).toString("base64url");
  await Bun.write(join(home, "auth.json"), JSON.stringify({ tokens: { access_token: "header." + claims + ".signature" } }));
}
const receipt = join(${JSON.stringify(root)}, provider + "-receipt.json");
await Bun.write(receipt + ".tmp", JSON.stringify({ argv: process.argv.slice(2), home,
  ...(provider === "agent" ? { noOpenBrowser: process.env.NO_OPEN_BROWSER } : {}),
  ...(["gh", "opencode"].includes(provider) ? { configHome: process.env[provider === "gh" ? "XDG_CONFIG_HOME" : "XDG_DATA_HOME"] } : {}) }));
renameSync(receipt + ".tmp", receipt);
console.log("Signed in to the isolated fixture.");
`, { mode: 0o755 });
  }
  workspaceId = (await workspaceCreate({ cwd: root, label: "usage-login-test" })).workspace.workspace_id;
  // Force the first login to finish before the collector's lifecycle connection starts.
  // The probe observes the real exit, but does not deliver it to the server; the replacement
  // subscribes only afterwards, just like a slow initial connection (or a reconnect gap).
  const subscribe = herdr.subscribeEvents;
  const startCollector = collector.startStatusCollector;
  const probeReady = Promise.withResolvers<void>();
  const delayed = spyOn(collector, "startStatusCollector").mockImplementation((handlers, overrides) => startCollector(handlers, {
    ...overrides,
    subscribe: (subscriptions, handlers, socketPath) => {
      if (!subscriptions.some((subscription) => subscription.type === "pane.exited")) {
        return subscribe(subscriptions, handlers, socketPath);
      }
      let live: ReturnType<typeof subscribe> | undefined;
      const probe = subscribe(subscriptions, {
        onStarted: () => probeReady.resolve(),
        onEvent: (frame) => {
          if (frame.data?.["type"] === "pane_exited" && typeof frame.data["pane_id"] === "string") {
            missedExit.resolve(frame.data["pane_id"]);
            probe.close();
            live = subscribe(subscriptions, handlers, socketPath);
          }
        },
        onError: handlers.onError,
      }, socketPath);
      return { close: () => { probe.close(); live?.close(); } };
    },
  }));
  try {
    server = createServer({
      port: 0, stateDir: mkdtempSync(join(root, "state-")), machines: false, registerBridge: false,
      sidecar: false, terminalAttach: false, usageLogin: new UsageLoginService(root, {
        ...process.env, PATH: bin, XDG_CONFIG_HOME: join(root, "xdg-config"), XDG_DATA_HOME: join(root, "xdg-data"),
      }, ctx),
      usage: new UsageService(ctx, USAGE_PROVIDERS.filter((provider) => provider.id === "claude" || provider.id === "codex")),
    });
  } finally { delayed.mockRestore(); }
  await probeReady.promise;
});
afterAll(async () => {
  server?.stop();
  for (const pane of openedPanes) await paneClose(pane).catch(() => undefined);
  await workspaceClose(workspaceId);
  rmSync(root, { recursive: true, force: true });
});
const start = (body: unknown) => fetch(`http://127.0.0.1:${server.port}/api/usage/login`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

for (const provider of ["claude", "codex"] as const) {
  it(`starts ${provider} in an isolated credential home when the account name is valid`, async () => {
    // Given: subscribe before starting; the fake publishes its receipt atomically after writing credentials.
    const receipt = `${provider}-receipt.json`;
    const signal = Promise.withResolvers<void>();
    const connected = Promise.withResolvers<void>();
    const ended = Promise.withResolvers<void>();
    const exits = new Set<string>();
    let opened: UsageLoginStarted | null = null;
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    socket.onopen = () => connected.resolve();
    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      const frame: unknown = JSON.parse(event.data);
      if (isJsonObject(frame) && frame["type"] === "pane-exited" && typeof frame["pane_id"] === "string") {
        exits.add(frame["pane_id"]);
        if (frame["pane_id"] === opened?.pane_id) ended.resolve();
      }
    };
    const watcher = watch(root, (_event, filename) => { if (filename === receipt) signal.resolve(); });
    const timer = setTimeout(async () => {
      // Say which signal never came and what the pane showed, so a CI failure tells a CLI that
      // never started from one whose receipt or exit went unseen (#1260).
      const screen = opened
        ? await herdr.paneRead({ paneId: opened.pane_id, source: "visible", format: "text" }).then((read) => read.text.trimEnd(), (error: unknown) => `unreadable: ${String(error)}`)
        : "no pane was opened";
      const error = new Error(`login did not finish: receipt ${existsSync(join(root, receipt)) ? "written" : "missing"}, pane ${opened && exits.has(opened.pane_id) ? "exited" : "not exited"}; the pane shows:\n${screen}`);
      signal.reject(error); ended.reject(error); connected.reject(error);
      if (provider === "claude") missedExit.reject(error);
    }, 10_000);
    try {
      await connected.promise;
      // Cache the empty discovery too: completion must invalidate it, not wait five minutes.
      await fetch(`http://127.0.0.1:${server.port}/api/usage`);
      // When
      const response = await start({ provider, name: "work" });
      expect(response.status).toBe(200);
      opened = await response.json();
      if (!opened) throw new Error("login response missing");
      openedPanes.push(opened.pane_id);
      await signal.promise;
      if (provider === "claude") expect(await missedExit.promise).toBe(opened.pane_id);
      if (!exits.has(opened.pane_id)) await ended.promise;
      // Then: real herdr ran the quoted executable with exactly the official argv and isolated env.
      expect(opened.pane_id).toBeString();
      expect(JSON.parse(readFileSync(join(root, receipt), "utf8"))).toEqual({
        argv: provider === "claude" ? ["auth", "login"] : ["login", "--device-auth"],
        home: join(root, `.${provider}-work`),
      });
      const usage: { providers: { account: string }[] } = await (await fetch(`http://127.0.0.1:${server.port}/api/usage`)).json();
      expect(usage.providers.map((entry) => entry.account)).toContain(provider === "claude" ? "work@example.test" : "codex@example.test");
    } finally { clearTimeout(timer); watcher.close(); socket.close(); }
  });
}

it("rejects shell syntax and traversal when an account name is not a short slug", async () => {
  // Given
  const before = readdirSync(root);
  // When
  const responses = await Promise.all(["../escape", "x;touch bad", "$(id)", "a'b", "UPPER", "", "a".repeat(33)].map((name) => start({ provider: "claude", name })));
  // Then
  expect(responses.map((response) => response.status)).toEqual(Array(7).fill(400));
  expect(readdirSync(root)).toEqual(before);
});

it("rejects an existing credential home when its name is reused", async () => {
  // Given
  mkdirSync(join(root, ".claude-existing"));
  // When
  const response = await start({ provider: "claude", name: "existing" });
  // Then
  expect(response.status).toBe(409);
});

for (const provider of ["claude", "codex"] as const) {
  it(`allows retrying ${provider} with the same name when creating the sign-in tab fails`, async () => {
    // Given: the official CLI is a fake and the credential home is disposable.
    const home = mkdtempSync(join(root, "retry-"));
    const local = new UsageLoginService(home, { PATH: bin }, { ...ctx, home });
    const request = () => new Request("http://localhost/api/usage/login", {
      method: "POST", body: JSON.stringify({ provider, name: "retry" }),
    });
    const create = spyOn(herdr, "tabCreate").mockRejectedValueOnce(new Error("fixture tab creation failed"));
    let failed: Response;
    try {
      // When
      failed = await local.handle(request());
    } finally { create.mockRestore(); }
    // Then: the failed launch does not reserve the name.
    expect(failed.status).toBe(500);
    expect(existsSync(join(home, `.${provider}-retry`))).toBe(false);
    const retried = await local.handle(request());
    expect(retried.status).toBe(200);
    const opened: UsageLoginStarted = await retried.json();
    openedPanes.push(opened.pane_id);
  });
}

it("preserves credentials written before a sign-in launch fails", async () => {
  // Given
  const home = mkdtempSync(join(root, "preserve-"));
  const credentials = join(home, ".claude-preserve", ".credentials.json");
  const local = new UsageLoginService(home, { PATH: bin }, { ...ctx, home });
  const create = spyOn(herdr, "tabCreate").mockImplementationOnce(async () => {
    writeFileSync(credentials, "fixture-existing-credentials");
    throw new Error("fixture tab creation failed after credentials were written");
  });
  try {
    // When
    const response = await local.handle(new Request("http://localhost/api/usage/login", {
      method: "POST", body: JSON.stringify({ provider: "claude", name: "preserve" }),
    }));
    // Then: cleanup must not delete a nonempty home or replace the launch error.
    expect(response.status).toBe(500);
    expect(readFileSync(credentials, "utf8")).toBe("fixture-existing-credentials");
  } finally { create.mockRestore(); }
});

for (const [provider, cli, argv] of [
  ["cursor", "agent", ["login"]],
  ["copilot", "gh", ["auth", "login", "--hostname", "github.com"]],
  ["grok", "grok", ["login", "--device-auth"]],
  ["opencode", "opencode", ["auth", "login"]],
] as const) {
  it(`starts ${provider} with official argv and the discovery home when no named homes are supported`, async () => {
    // Given: watch before the native tab runs the disposable CLI.
    const receipt = `${cli}-receipt.json`;
    const signal = Promise.withResolvers<void>();
    const watcher = watch(root, (_event, filename) => { if (filename === receipt) signal.resolve(); });
    const timer = setTimeout(() => signal.reject(new Error("login did not produce a receipt")), 10_000);
    try {
      // When
      const response = await start({ provider });
      expect(response.status).toBe(200);
      const opened: UsageLoginStarted = await response.json();
      openedPanes.push(opened.pane_id);
      await signal.promise;
      // Then
      expect(opened.device_auth).toBe(provider === "grok");
      expect(JSON.parse(readFileSync(join(root, receipt), "utf8"))).toEqual({
        argv, home: root,
        ...(provider === "cursor" ? { noOpenBrowser: "1" } : {}),
        ...(provider === "copilot" ? { configHome: join(root, "xdg-config") } : provider === "opencode" ? { configHome: join(root, "xdg-data") } : {}),
      });
      expect(readdirSync(root).some((name) => name.startsWith(`.${provider}-`))).toBe(false);
    } finally { clearTimeout(timer); watcher.close(); }
  });
}

it("lists every provider in discovery order without requesting upstream usage", async () => {
  // Given
  const local = new UsageLoginService(root, { PATH: bin }, { ...ctx, fetch: async () => { throw new Error("upstream usage requested"); } });
  // When
  const response = await local.handle(new Request("http://localhost/api/usage/login"));
  const result = await response.json();
  // Then
  expect(result.providers.map((provider: { id: string }) => provider.id)).toEqual(["claude", "codex", "cursor", "copilot", "grok", "antigravity", "opencode"]);
  expect(result.providers.filter((provider: { separate_home: boolean }) => provider.separate_home).map((provider: { id: string }) => provider.id)).toEqual(["claude", "codex"]);
});

it("reports an unavailable CLI instead of opening a dead sign-in tab", async () => {
  // Given
  const local = new UsageLoginService(root, { PATH: "" }, ctx);
  // When
  const response = await local.handle(new Request("http://localhost/api/usage/login", {
    method: "POST", body: JSON.stringify({ provider: "cursor" }),
  }));
  // Then
  expect(response.status).toBe(409);
  expect((await response.json()).error.code).toBe("cli_unavailable");
});

it("omits device auth when the installed Grok help does not list it", async () => {
  // Given
  const local = new UsageLoginService(root, { PATH: bin, TEST_LOGIN_NO_DEVICE: "1" }, ctx);
  const signal = Promise.withResolvers<void>();
  const watcher = watch(root, (_event, filename) => { if (filename === "grok-receipt.json") signal.resolve(); });
  const timer = setTimeout(() => signal.reject(new Error("login receipt missing")), 10000);
  try {
    // When
    const response = await local.handle(new Request("http://localhost/api/usage/login", {
      method: "POST", body: JSON.stringify({ provider: "grok" }),
    }));
    // Then
    expect(response.status).toBe(200);
    const opened: UsageLoginStarted = await response.json();
    openedPanes.push(opened.pane_id);
    await signal.promise;
    expect(opened.device_auth).toBe(false);
    expect(JSON.parse(readFileSync(join(root, "grok-receipt.json"), "utf8")).argv).toEqual(["login"]);
  } finally { clearTimeout(timer); watcher.close(); }
});

it("rejects unknown providers and names for single-home providers before launching a tab", async () => {
  // Given
  const bodies = [{ provider: "unknown" }, { provider: "constructor" }, { provider: "grok;id" },
    ...["cursor", "copilot", "grok", "opencode"].flatMap((provider) => ["work", "../escape", "$(id)"].map((name) => ({ provider, name })))];
  // When
  const responses = await Promise.all(bodies.map(start));
  // Then
  expect(responses.map((response) => response.status)).toEqual(bodies.map(() => 400));
});

it("requires explicit replacement when a single-home sign-in exists", async () => {
  // Given
  const home = mkdtempSync(join(root, "existing-"));
  const dir = join(home, ".local", "share", "opencode");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ "opencode-go": { type: "api", key: "fixture-go" } }));
  const local = new UsageLoginService(home, { PATH: bin }, { ...ctx, home });
  // When
  const response = await local.handle(new Request("http://localhost/api/usage/login", {
    method: "POST", body: JSON.stringify({ provider: "opencode" }),
  }));
  // Then
  expect(response.status).toBe(409);
  expect((await response.json()).error.code).toBe("account_confirmation_required");
});

it("lists an existing sign-in without returning its key or fetching provider usage", async () => {
  // Given
  const home = mkdtempSync(join(root, "metadata-"));
  const dir = join(home, ".local", "share", "opencode");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ "opencode-go": { type: "api", key: "fixture-secret-metadata" } }));
  const local = new UsageLoginService(home, { PATH: bin }, { ...ctx, home, fetch: async () => { throw new Error("upstream usage requested"); } });
  // When
  const response = await local.handle(new Request("http://localhost/api/usage/login?provider=opencode"));
  // Then
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ accounts: [null] });
});

it("opens the sign-in tab when replacement was explicitly confirmed", async () => {
  // Given
  const home = mkdtempSync(join(root, "confirmed-"));
  const dir = join(home, ".local", "share", "opencode");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ "opencode-go": { type: "api", key: "fixture-go" } }));
  const local = new UsageLoginService(home, { PATH: bin }, { ...ctx, home });
  // When
  const response = await local.handle(new Request("http://localhost/api/usage/login", {
    method: "POST", body: JSON.stringify({ provider: "opencode", replace: true }),
  }));
  // Then
  expect(response.status).toBe(200);
  const opened: UsageLoginStarted = await response.json();
  openedPanes.push(opened.pane_id);
});

it("rejects Antigravity login when no standalone command is supported", async () => {
  // Given / When
  const response = await start({ provider: "antigravity" });
  // Then
  expect(response.status).toBe(409);
  expect((await response.json()).error.code).toBe("login_not_supported");
});
