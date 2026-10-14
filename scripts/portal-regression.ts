import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

import "./test-herdr.ts"; // check run gives the server its own herdr session, not the user's
import { DEVICE_COOKIE } from "../server/auth.ts";
import { createServer, type ServerInstance } from "../server/index.ts";
import { PortalService } from "../server/portal.ts";
import { UsageService } from "../server/usage.ts";
import type { RemoteAccess } from "../shared/protocol.ts";
import { openSettingsPage } from "./settings-page.ts";

const dist = join(import.meta.dir, "..", "dist", "index.html");
assert.ok(existsSync(dist), "dist/index.html is missing: run `bun run build` first");

const root = mkdtempSync(join(tmpdir(), "herdr-portal-browser-"));
const portalBin = join(root, "portal");
const portalAddress = "https://herdr-portal-test-0123.relay.example";
const token = "portal-browser-test-token";
const watchToken = randomBytes(32).toString("hex");
const relayRequests: string[] = [];
const relayFetch: typeof fetch = async (input) => {
  const url = input instanceof Request ? input.url : String(input);
  relayRequests.push(url);
  if (url === "https://unavailable.relay.example/sdk/domain") return new Response(null, { status: 503 });
  if (url !== "https://relay.example/sdk/domain") throw new Error(`Unexpected Portal fixture request: ${url}`);
  return Response.json({ data: { release_version: "v2.6.1" } });
};
const remoteAccess = {
  port: 443,
  tailscale: { state: "missing", dns_name: null, serving_url: null, serve_command: null, serve_url: null },
} satisfies RemoteAccess;
const portalFetchPage = async (context: BrowserContext): Promise<void> => {
  await context.route("**/api/access", (route) => route.fulfill({ json: remoteAccess }));
};
const openPhoneSettings = async (page: Page): Promise<void> => {
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  await page.locator(".settings-dialog").waitFor({ timeout: 10_000 });
  await openSettingsPage(page, "Phone & devices");
};
const settingsOf = (page: Page) => page.locator(".settings-dialog");

const servers: ServerInstance[] = [];
const portals: PortalService[] = [];
const contexts: BrowserContext[] = [];
let browser: Browser | undefined;

try {
  writeFileSync(portalBin, [
    "#!/bin/sh",
    'case "$1" in',
    "  version) printf '%s\\n' 'v2.6.1' ;;",
    "  expose)",
    "    trap 'exit 0' TERM",
    `    printf '%s\\n' 'INF service ready at ${portalAddress}:443'`,
    "    while :; do sleep 0.05; done ;;",
    "  *) exit 2 ;;",
    "esac",
    "",
  ].join("\n"), { mode: 0o700 });
  chmodSync(portalBin, 0o755);

  const stateDir = join(root, "token-server");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "devices.json"), JSON.stringify({
    gate_closed_at: new Date().toISOString(),
    devices: [{
      id: "0123456789abcdef",
      label: "Portal watch fixture",
      role: "watch",
      token_hash: createHash("sha256").update(watchToken).digest("hex"),
      created_at: new Date().toISOString(),
      last_seen_at: null,
    }],
  }), { mode: 0o600 });
  const portal = new PortalService({ stateDir, bin: portalBin, fetch: relayFetch, readyTimeoutMs: 5_000, stopGraceMs: 1_000 });
  portals.push(portal);
  const server = createServer({
    port: 0,
    hostname: "127.0.0.1",
    stateDir,
    token,
    tailscaleOwner: null,
    tailscaleServeOnly: false,
    portal,
    usage: new UsageService(undefined, []),
    registerBridge: false,
  });
  servers.push(server);
  const origin = `http://127.0.0.1:${server.port}`;

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
  const ownerContext = await browser.newContext({ viewport: { width: 1100, height: 800 }, locale: "en-US" });
  contexts.push(ownerContext);
  await ownerContext.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" })));
  await portalFetchPage(ownerContext);
  const ownerPage = await ownerContext.newPage();
  ownerPage.setDefaultTimeout(10_000);
  const pageErrors: string[] = [];
  ownerPage.on("pageerror", (error) => pageErrors.push(error.message));
  await ownerPage.goto(origin, { waitUntil: "domcontentloaded" });
  await ownerPage.getByTestId("token-gate").waitFor({ timeout: 10_000 });
  assert.equal(await ownerPage.evaluate(async () => (await fetch("/api/portal")).status), 401, "Portal status is gated until token login");
  await ownerPage.getByText("Have an access token instead?", { exact: true }).click();
  await ownerPage.getByLabel("Access token", { exact: true }).fill(token);
  await ownerPage.getByRole("button", { name: "Unlock", exact: true }).click();
  await ownerPage.locator(".conn-live").waitFor({ state: "attached", timeout: 15_000 });
  const ownerAuth = await ownerPage.evaluate(async () => (await (await fetch("/api/health?scope=bridge")).json()).auth);
  assert.deepEqual(ownerAuth, { required: false, authenticated: true, via: "token", role: "drive" }, "the UI token login receives the owner role");

  await openPhoneSettings(ownerPage);
  const ownerSettings = settingsOf(ownerPage);
  const ownerRelay = ownerSettings.locator("#portal-relay");
  const start = ownerSettings.getByRole("button", { name: "Start", exact: true });
  await ownerRelay.waitFor({ timeout: 10_000 });
  assert.equal(await start.isDisabled(), true, "Start is disabled until a relay is entered");
  await ownerRelay.fill("relay.example");
  assert.equal(await start.isEnabled(), true, "a supported, usable Portal offers Start");
  await start.click();
  const address = ownerSettings.getByRole("link", { name: portalAddress, exact: true });
  await address.waitFor({ timeout: 15_000 });
  assert.equal(await address.getAttribute("href"), portalAddress, "the ready address is shown as the public link");
  assert.deepEqual(relayRequests, ["https://relay.example/sdk/domain"], "only the synthetic relay was checked");

  const watchContext = await browser.newContext({ viewport: { width: 1100, height: 800 }, locale: "en-US" });
  contexts.push(watchContext);
  await watchContext.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" })));
  await watchContext.addCookies([{ name: DEVICE_COOKIE, value: watchToken, url: origin, httpOnly: true, sameSite: "Strict" }]);
  await portalFetchPage(watchContext);
  const watchPage = await watchContext.newPage();
  watchPage.setDefaultTimeout(10_000);
  watchPage.on("pageerror", (error) => pageErrors.push(error.message));
  await watchPage.goto(origin, { waitUntil: "domcontentloaded" });
  await watchPage.locator(".conn-live").waitFor({ state: "attached", timeout: 15_000 });
  const watchAuth = await watchPage.evaluate(async () => (await (await fetch("/api/health?scope=bridge")).json()).auth);
  assert.deepEqual(watchAuth, { required: false, authenticated: true, via: "device", role: "watch" }, "the fixture cookie is authenticated as watch-only");
  await openPhoneSettings(watchPage);
  const watchSettings = settingsOf(watchPage);
  const watchStop = watchSettings.getByRole("button", { name: "Stop", exact: true });
  await watchStop.waitFor({ timeout: 10_000 });
  assert.equal(await watchStop.isDisabled(), true, "a watch-only device cannot stop a running Portal");

  await ownerSettings.getByRole("button", { name: "Stop", exact: true }).click();
  await start.waitFor({ timeout: 10_000 });
  await address.waitFor({ state: "detached", timeout: 10_000 });
  await watchSettings.getByRole("button", { name: "Close settings", exact: true }).click();
  await watchPage.locator(".settings-dialog").waitFor({ state: "detached", timeout: 10_000 });
  await openPhoneSettings(watchPage);
  const idleWatchSettings = settingsOf(watchPage);
  const watchRelay = idleWatchSettings.locator("#portal-relay");
  const watchStart = idleWatchSettings.getByRole("button", { name: "Start", exact: true });
  await watchRelay.waitFor({ timeout: 10_000 });
  assert.equal(await watchRelay.isDisabled(), true, "a watch-only device cannot edit the relay");
  assert.equal(await watchStart.isDisabled(), true, "a watch-only device cannot start Portal");

  const failingRelay = "unavailable.relay.example";
  await ownerRelay.fill(failingRelay);
  await start.click();
  const failure = ownerSettings.getByRole("alert").filter({ hasText: failingRelay });
  await failure.waitFor({ timeout: 10_000 });
  const stopAfterError = ownerSettings.getByRole("button", { name: "Stop", exact: true });
  await stopAfterError.waitFor({ timeout: 10_000 });
  assert.match(await failure.innerText(), /did not answer as a Portal relay \(HTTP 503\)/);
  await stopAfterError.click();
  await start.waitFor({ timeout: 10_000 });
  await failure.waitFor({ state: "detached", timeout: 10_000 });
  assert.equal(await start.isEnabled(), true, "Start is available again after stopping the failed Portal");
  const finalPhase = await ownerPage.evaluate(async () => (await (await fetch("/api/portal")).json()).phase);
  assert.equal(finalPhase, "idle", "Stop clears the failed Portal state");
  assert.equal(await ownerRelay.inputValue(), failingRelay, "the failed relay remains editable after stopping");
  assert.deepEqual(relayRequests, [
    "https://relay.example/sdk/domain",
    "https://unavailable.relay.example/sdk/domain",
  ], "all relay checks use the injected fixture fetch");
  assert.deepEqual(pageErrors, [], "the Portal settings pages have no browser errors");
  console.log("PASS Portal browser flow: token login, ready/start/address/stop, error recovery, and watch-only controls");

  const blockedState = join(root, "no-token-server");
  mkdirSync(blockedState, { recursive: true });
  const blockedPortal = new PortalService({ stateDir: blockedState, bin: portalBin, fetch: relayFetch });
  portals.push(blockedPortal);
  const blockedServer = createServer({
    port: 0,
    hostname: "127.0.0.1",
    stateDir: blockedState,
    token: "",
    tailscaleOwner: null,
    tailscaleServeOnly: false,
    portal: blockedPortal,
    usage: new UsageService(undefined, []),
    registerBridge: false,
  });
  servers.push(blockedServer);
  const blockedContext = await browser.newContext({ viewport: { width: 1100, height: 800 }, locale: "en-US" });
  contexts.push(blockedContext);
  await blockedContext.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" })));
  await portalFetchPage(blockedContext);
  const blockedPage = await blockedContext.newPage();
  blockedPage.setDefaultTimeout(10_000);
  blockedPage.on("pageerror", (error) => pageErrors.push(error.message));
  await blockedPage.goto(`http://127.0.0.1:${blockedServer.port}`, { waitUntil: "domcontentloaded" });
  await blockedPage.locator(".conn-live").waitFor({ state: "attached", timeout: 15_000 });
  await openPhoneSettings(blockedPage);
  const blockedSettings = settingsOf(blockedPage);
  await blockedSettings.getByText("Set HERDR_WEB_TOKEN on this PC and restart the app to start Portal.", { exact: true }).waitFor({ timeout: 10_000 });
  assert.equal(await blockedSettings.getByRole("button", { name: "Start", exact: true }).count(), 0, "Portal Start is unavailable without a configured token");
  assert.deepEqual(pageErrors, [], "the token-required page has no browser errors");
  console.log("PASS Portal token-required UI: the relay cannot be started without a configured token");
} finally {
  await Promise.all(contexts.map((context) => context.close().catch(() => undefined)));
  for (const server of servers) server.stop();
  await Promise.all(portals.map((portal) => portal.shutdown().catch(() => undefined)));
  await browser?.close().catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
}
