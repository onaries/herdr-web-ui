/**
 * Real browser preferences sync against an isolated server. Storage events and request gates
 * observe completion; the browser clock advances send windows without fixed sleeps.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { chromePath } from "./chrome-path.ts";

await import("./test-herdr.ts");
const { createServer } = await import("../server/index.ts");
const { UsageService } = await import("../server/usage.ts");
const root = mkdtempSync(join(tmpdir(), "herdr-preferences-sync-"));
const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), usage: new UsageService(undefined, []) });
const origin = `http://127.0.0.1:${server.port}`;

interface Opened { context: BrowserContext; page: Page; puts: { settings: Record<string, unknown>; pins?: string[] }[] }
const mainKey = "herdr-web-ui:settings";
const qaDir = process.env["PREFERENCES_QA_DIR"];
if (qaDir) mkdirSync(qaDir, { recursive: true });

async function browserAt(browser: Awaited<ReturnType<typeof chromium.launch>>, own: Record<string, unknown> = {}, pins: string[] = [], before?: (context: BrowserContext) => Promise<void>): Promise<Opened> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  await context.addInitScript(([own, pins]) => {
    if (!localStorage.getItem("herdr-web-ui:settings")) localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", theme: "dark", terminalFontSize: 13, ...own }));
    if (!localStorage.getItem("herdr-web-ui:sidebar-agent-pins")) localStorage.setItem("herdr-web-ui:sidebar-agent-pins", JSON.stringify(pins));
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      setItem.call(this, key, value);
      window.dispatchEvent(new Event("preferences-test-storage"));
    };
  }, [own, pins] as const);
  await before?.(context);
  const puts: Opened["puts"] = [];
  const page = await context.newPage();
  await page.clock.install();
  page.on("request", (request) => { if (request.method() === "PUT" && request.url().endsWith("/api/preferences")) puts.push(request.postDataJSON()); });
  await page.goto(origin);
  await page.locator(".conn-live").waitFor({ state: "attached" });
  return { context, page, puts };
}

/** Subscribe to exactly the storage state the action must produce, with an initial-state check. */
function storageHolds(page: Page, key: string, expected: Record<string, unknown> | string[]): Promise<void> {
  return page.evaluate(({ key, expected }) => {
    // Keep the observed promise rooted while Chromium's virtual clock is paused.
    const waits: Set<Promise<void>> = Reflect.get(window, "__preferencesTestWaits") ?? new Set();
    Reflect.set(window, "__preferencesTestWaits", waits);
    const waiting = new Promise<void>((resolve, reject) => {
      const matches = () => {
        const value = JSON.parse(localStorage.getItem(key) ?? "null");
        return Array.isArray(expected) ? JSON.stringify(value) === JSON.stringify(expected)
          : value !== null && Object.entries(expected).every(([name, wanted]) => JSON.stringify(value[name]) === JSON.stringify(wanted));
      };
      const timer = setTimeout(() => { window.removeEventListener("preferences-test-storage", changed); reject(new Error(`storage never held ${JSON.stringify(expected)}`)); }, 10_000);
      function changed() {
        if (!matches()) return;
        clearTimeout(timer);
        window.removeEventListener("preferences-test-storage", changed);
        resolve();
      }
      window.addEventListener("preferences-test-storage", changed);
      changed();
    });
    waits.add(waiting);
    return waiting.finally(() => { waits.delete(waiting); });
  }, { key, expected });
}
const settingsHold = (page: Page, expected: Record<string, unknown>) => storageHolds(page, mainKey, expected);
const held = async () => await (await fetch(`${origin}/api/preferences`)).json() as { revision: number; settings: Record<string, unknown>; pins?: string[] };
const write = async (settings: Record<string, unknown>, pins?: string[]) => {
  const response = await fetch(`${origin}/api/preferences`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ settings, ...(pins ? { pins } : {}) }) });
  assert.equal(response.status, 200);
};
async function windows(opened: readonly Opened[], count = 3): Promise<void> {
  for (let index = 0; index < count; index++) for (const { page } of opened) await page.clock.runFor(600);
}
async function chooseMode(opened: Opened, mode: "Light" | "Dark"): Promise<void> {
  const answered = opened.page.waitForResponse((response) => response.url().endsWith("/api/preferences") && response.request().method() === "PUT");
  await opened.page.getByRole("group", { name: "Theme", exact: true }).getByRole("button", { name: mode, exact: true }).click();
  await opened.page.clock.runFor(600);
  assert.equal((await answered).status(), 200);
}

try {
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  try {
    // F3: these bytes are pinned to pre-change records, before the server holds any settings.
    for (const [index, [record, dark, light]] of ([
      [{ theme: "system", palette: "amber", paletteLight: "catppuccin", paletteDark: "charcoal" }, "charcoal", "catppuccin"],
      [{ theme: "dark", palette: "catppuccin", paletteDark: "charcoal" }, "catppuccin", "catppuccin"],
    ] as const).entries()) {
      const fixture = await browserAt(browser, record);
      await fixture.page.goto(`${origin}/?settings=appearance`);
      await fixture.page.locator(".settings-dialog").waitFor();
      await fixture.page.emulateMedia({ colorScheme: "dark" });
      await fixture.page.locator(`html[data-theme="dark"][data-palette="${dark}"]`).waitFor({ state: "attached" });
      if (qaDir) await fixture.page.screenshot({ path: join(qaDir, `f3-${index}-dark-desktop.png`) });
      if (record.theme === "system") {
        await fixture.page.emulateMedia({ colorScheme: "light" });
        await fixture.page.locator(`html[data-theme="light"][data-palette="${light}"]`).waitFor({ state: "attached" });
        if (qaDir) await fixture.page.screenshot({ path: join(qaDir, `f3-${index}-light-desktop.png`) });
      }
      await fixture.page.setViewportSize({ width: 390, height: 844 });
      await fixture.page.clock.runFor(600);
      if (qaDir) await fixture.page.screenshot({ path: join(qaDir, `f3-${index}-phone.png`) });
      console.log(`PASS F3 ${JSON.stringify(record)} -> dark ${dark} / light ${light}`);
      await fixture.context.close();
    }
    const anySide = await browserAt(browser, { theme: "light", lightTheme: "tokyo-night" });
    await anySide.page.goto(`${origin}/?settings=appearance`);
    await anySide.page.locator('html[data-theme="dark"][data-palette="tokyo-night"]').waitFor({ state: "attached" });
    assert.equal(await anySide.page.evaluate(() => document.documentElement.style.colorScheme), "dark");
    await anySide.page.locator(".settings-dialog").waitFor();
    if (qaDir) await anySide.page.screenshot({ path: join(qaDir, "any-side-desktop.png") });
    await anySide.page.setViewportSize({ width: 390, height: 844 });
    await anySide.page.clock.runFor(600);
    if (qaDir) await anySide.page.screenshot({ path: join(qaDir, "any-side-phone.png") });
    await anySide.context.close();
    console.log("PASS k Light mode with lightTheme=tokyo-night draws dark on desktop and phone");
    assert.equal((await held()).revision, 0);
    const a = await browserAt(browser, {}, ["local:w1:pa"]);
    const b = await browserAt(browser);
    console.log("QA empty server clients opened");
    await windows([a, b]);
    assert.deepEqual([...a.puts, ...b.puts], []);
    assert.deepEqual(await held(), { revision: 0, settings: {} });

    await a.page.goto(`${origin}/?settings=appearance`);
    const bLight = settingsHold(b.page, { theme: "light" });
    await chooseMode(a, "Light");
    await bLight;
    console.log("QA mode change reached second client");
    assert.deepEqual(a.puts.map((body) => Object.keys(body.settings)), [["theme"]]);
    assert.deepEqual(a.puts[0]?.pins, ["local:w1:pa"]);
    await storageHolds(b.page, "herdr-web-ui:sidebar-agent-pins", ["local:w1:pa"]);

    await a.page.goto(`${origin}/?settings=terminal`);
    await a.page.getByRole("button", { name: "Increase terminal font size", exact: true }).click();
    await settingsHold(a.page, { terminalFontSize: 14 });
    await windows([a, b]);
    assert.equal(a.puts.length, 1);
    await settingsHold(b.page, { terminalFontSize: 13 });
    const aPins = storageHolds(a.page, "herdr-web-ui:sidebar-agent-pins", ["local:w9:p1"]);
    await write({}, ["local:w9:p1"]);
    await aPins;
    console.log("QA device settings and pins verified");

    // Hold the actual PUT, subscribe before sending, and let the other write land first.
    const onWay = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await a.page.route("**/api/preferences", async (route) => {
      if (route.request().method() === "PUT") { onWay.resolve(); await release.promise; }
      await route.continue();
    });
    await a.page.goto(`${origin}/?settings=appearance`);
    const changed = chooseMode(a, "Dark");
    await onWay.promise;
    const aPalette = settingsHold(a.page, { lightTheme: "catppuccin", theme: "dark" });
    const bDark = settingsHold(b.page, { theme: "dark", lightTheme: "catppuccin" });
    await write({ palette: "catppuccin" });
    release.resolve();
    await changed;
    await Promise.all([aPalette, bDark]);
    console.log("QA concurrent changes settled");
    await windows([a, b]);
    assert.equal(a.puts.length, 2);
    assert.equal((await held()).settings.lightTheme, "catppuccin");
    await a.page.unrouteAll({ behavior: "wait" });

    const c = await browserAt(browser, { showThinking: false });
    await settingsHold(c.page, { theme: "dark", lightTheme: "catppuccin", terminalFontSize: 13, showThinking: false });
    const d = await browserAt(browser, {}, [], async (context) => {
      await context.route("**/api/preferences", async (route) => {
        if (route.request().method() === "GET") await route.abort();
        else await route.continue();
      });
    });
    await settingsHold(d.page, { lightTheme: "catppuccin" });

    // (i): a new-format change crosses two real browser clients through the event stream.
    const newChoice = settingsHold(b.page, { darkTheme: "tokyo-night", palette: "tokyo-night" });
    await write({ darkTheme: "tokyo-night" });
    await newChoice;
    const revision = (await held()).revision;
    await windows([a, b, c, d]);
    assert.equal((await held()).revision, revision, "receiving new sides never writes a corrected document");
    assert.deepEqual([...c.puts, ...d.puts], []);
    for (const opened of [a, b, c, d]) await opened.context.close();
    console.log("PASS shared settings and pins, device settings, gated concurrent writes, new theme sides, event-stream recovery and no correcting PUTs");
  } finally { await browser.close(); }
} finally {
  server.stop();
  rmSync(root, { recursive: true, force: true });
}
