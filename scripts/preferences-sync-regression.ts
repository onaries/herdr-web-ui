/**
 * Two browsers of one server keep the shared settings and pins the same (lib/preferencesSync.ts):
 * a theme changed in one shows in the other at once, the other's terminal font (this device's)
 * does not move and is never sent, the first browser to share carries its pins along and pins
 * written elsewhere reach an open page, a change from elsewhere that lands while one of this
 * browser's is on its way is kept, a page whose GET fails still catches up from the event stream,
 * and opening a page on an empty server sends nothing. No herdr session is opened.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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

async function until(check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, label);
    await Bun.sleep(50);
  }
}

interface Opened { context: BrowserContext; page: Page; puts: { settings: Record<string, unknown>; pins?: string[] }[] }

/** a browser of its own with `own` in its settings and `pins` pinned; `puts` collects what it sends to /api/preferences */
async function browserAt(browser: Awaited<ReturnType<typeof chromium.launch>>, own: Record<string, unknown> = {}, pins: string[] = [], before?: (context: BrowserContext) => Promise<void>): Promise<Opened> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: "en-US" });
  await context.addInitScript(([own, pins]) => {
    if (!localStorage.getItem("herdr-web-ui:settings")) localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", theme: "dark", terminalFontSize: 13, ...own }));
    if (!localStorage.getItem("herdr-web-ui:sidebar-agent-pins")) localStorage.setItem("herdr-web-ui:sidebar-agent-pins", JSON.stringify(pins));
  }, [own, pins] as const);
  await before?.(context);
  const puts: Opened["puts"] = [];
  const page = await context.newPage();
  page.on("request", (request) => { if (request.method() === "PUT" && request.url().endsWith("/api/preferences")) puts.push(request.postDataJSON()); });
  await page.goto(origin);
  await page.locator(".conn-live").waitFor({ state: "attached" });
  return { context, page, puts };
}

const theme = (page: Page) => page.evaluate(() => document.documentElement.dataset["theme"]);
const stored = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem("herdr-web-ui:settings") ?? "{}") as Record<string, unknown>);
const storedPins = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem("herdr-web-ui:sidebar-agent-pins") ?? "[]") as string[]);
const held = async () => await (await fetch(`${origin}/api/preferences`)).json() as { revision: number; settings: Record<string, unknown>; pins?: string[] };
const write = (page: Page, body: object) => page.evaluate(async (body) => (await fetch("/api/preferences", { method: "PUT", headers: { "content-type": "application/json" }, body })).status, JSON.stringify(body));

try {
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  try {
    // A has pinned an agent before this release; B has not. The pane need not exist here: a pin of a
    // pane this page cannot see stays in the list (a PC still loading would look the same)
    const a = await browserAt(browser, {}, ["local:w1:pa"]);
    const b = await browserAt(browser);
    await Bun.sleep(1_500);
    assert.deepEqual([...a.puts, ...b.puts], [], "opening a page on an empty server sends nothing");
    assert.deepEqual(await held(), { revision: 0, settings: {} }, "the server holds nothing, pins included");

    // A turns light: B follows while open, only the shared setting went out, and A's pins went with
    // the first change since the server held none
    await a.page.goto(`${origin}/?settings=appearance`);
    await a.page.getByRole("group", { name: "Theme", exact: true }).getByRole("button", { name: "Light", exact: true }).click();
    await until(async () => await theme(b.page) === "light", "B takes A's theme without a reload");
    assert.deepEqual(a.puts.map((body) => Object.keys(body.settings)), [["theme"]], "only the setting that changed is sent");
    assert.deepEqual(a.puts[0]?.pins, ["local:w1:pa"], "the first change carries this browser's pins");
    await until(async () => JSON.stringify(await storedPins(b.page)) === JSON.stringify(["local:w1:pa"]), "B takes A's pins");

    // A's terminal font is A's own: B keeps 13
    await a.page.goto(`${origin}/?settings=terminal`);
    await a.page.getByRole("button", { name: "Increase terminal font size", exact: true }).click();
    await until(async () => (await stored(a.page))["terminalFontSize"] === 14, "A keeps its new font");
    await Bun.sleep(1_500);
    assert.equal(a.puts.length, 1, "a device setting is never sent");
    assert.equal((await stored(b.page))["terminalFontSize"], 13, "B's terminal font does not move");

    // pins written by another browser reach an open page, and stay (the last write wins now)
    assert.equal(await write(b.page, { settings: {}, pins: ["local:w9:p1"] }), 200);
    await until(async () => JSON.stringify(await storedPins(a.page)) === JSON.stringify(["local:w9:p1"]), "A takes the pins written elsewhere");

    // a change from elsewhere that lands while A's own is on its way is kept, and A's still arrives
    await a.page.route("**/api/preferences", async (route) => {
      if (route.request().method() === "PUT") await Bun.sleep(1_500);
      await route.continue();
    });
    await a.page.goto(`${origin}/?settings=appearance`);
    await a.page.getByRole("group", { name: "Theme", exact: true }).getByRole("button", { name: "Dark", exact: true }).click();
    await Bun.sleep(900);
    assert.equal(a.puts.length, 2, "A's theme is on its way");
    assert.equal(await write(b.page, { settings: { palette: "forest" } }), 200);
    await until(async () => (await stored(a.page))["palette"] === "forest", "A takes B's palette while its own change is in flight");
    await until(async () => { const now = await held(); return now.settings["theme"] === "dark" && now.settings["palette"] === "forest"; }, "the server holds both changes");
    assert.equal((await stored(a.page))["theme"], "dark", "A keeps its own change");
    await until(async () => await theme(b.page) === "dark", "B takes A's theme");
    await Bun.sleep(1_500);
    assert.equal(a.puts.length, 2, "A sends nothing back for what it took");
    await a.page.unrouteAll({ behavior: "wait" });

    // a page opened later starts from what the server holds, and keeps a shared setting nobody changed
    const c = await browserAt(browser, { showThinking: false });
    await until(async () => await theme(c.page) === "dark" && (await stored(c.page))["palette"] === "forest", "a new page takes the shared theme and palette");
    assert.equal((await stored(c.page))["terminalFontSize"], 13, "and keeps its own terminal font");
    assert.equal((await stored(c.page))["showThinking"], false, "and a shared setting nobody changed stays its own");
    assert.deepEqual(await storedPins(c.page), ["local:w9:p1"], "and takes the shared pins");

    // a page whose GET fails catches up from the event stream, which opens with the document
    const d = await browserAt(browser, {}, [], async (context) => {
      await context.route("**/api/preferences", async (route) => {
        if (route.request().method() === "GET") await route.abort();
        else await route.continue();
      });
    });
    await until(async () => (await stored(d.page))["palette"] === "forest", "a page without the GET takes the document from the event stream");
    await Bun.sleep(1_500);
    assert.deepEqual([...c.puts, ...d.puts], [], "pages opened later send nothing");
    for (const opened of [a, b, c, d]) await opened.context.close();
    console.log("PASS shared settings and pins follow across browsers, device settings stay, concurrent changes both land, an empty server is never written on load");
  } finally {
    await browser.close();
  }
} finally {
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
}
