/** Search decoration and shared-history scrollbar against panes owned by this script. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import type { PaneFindResponse } from "../shared/protocol.ts";
import { createServer } from "../server/index.ts";
import { UsageService } from "../server/usage.ts";
import { herdrRpc, paneScrollInfo, workspaceCreate, workspaceClose } from "../server/herdr/client.ts";
const state = mkdtempSync(join(tmpdir(), "herdr-viewport-browser-"));
const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: state, usage: new UsageService(undefined, []) });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
let workspace: string | undefined;
async function until(check: () => Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, message);
    await Bun.sleep(25);
  }
}
try {
  const made = await workspaceCreate({ cwd: state, label: "herdr-web-ui-test-viewport" });
  workspace = made.workspace.workspace_id;
  const paneId = made.root_pane.pane_id;
  const ready = herdrRpc("pane.wait_for_output", { pane_id: paneId, source: "visible", match: { type: "substring", value: "viewport_ready" }, timeout_ms: 10000 }, undefined, 12000);
  await herdrRpc("pane.send_input", { pane_id: paneId, text: "for n in $(seq 1 180); do printf 'history %03d: record\\n' $n; if [ $n = 12 ] || [ $n = 90 ] || [ $n = 170 ]; then printf 'mark_%s tail mark_%s\\n' needle needle; fi; done; printf 'wide_%s%s%sZ\\n' '界' 'e' '́'; printf 'viewport_%s\\n' ready; exec cat", keys: ["enter"] });
  await ready;
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  await context.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", defaultView: "terminal", alertsOn: false })));
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  const searches: unknown[] = [];
  page.on("response", (response) => { if (response.url().endsWith("/api/pane/find")) void response.json().then((body) => { searches.push({ request: response.request().postDataJSON(), body }); }, () => {}); });
  const waitHighlight = async () => {
    try { await page.locator(".terminal-find-hit.is-current").first().waitFor(); }
    catch (error) {
      console.error("Search diagnostic", { searches: JSON.stringify([searches[0], ...searches.slice(-2)]), native: await paneScrollInfo(paneId), dom: await page.evaluate(() => ({ text: document.querySelector(".find-bar")?.textContent, hits: document.querySelectorAll(".terminal-find-hit").length, rows: document.querySelector(".xterm-rows")?.childElementCount, screen: document.querySelector(".xterm-rows")?.textContent })) });
      if (process.env.UI_EVIDENCE_DIR) { mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "terminal-search-failure.png") }); }
      throw error;
    }
  };
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(paneId)}`);
  const scrollbar = page.getByRole("scrollbar", { name: "Terminal scrollback", exact: true });
  await scrollbar.waitFor();
  const max = Number(await scrollbar.getAttribute("aria-valuemax"));
  assert.ok(max > 100, "the scrollbar reads herdr's full history");
  await scrollbar.focus();
  await page.keyboard.press("Home");
  await page.waitForFunction(() => document.querySelector('[role="scrollbar"]')?.getAttribute("aria-valuenow") === "0");
  await until(async () => (await paneScrollInfo(paneId))!.offset_from_bottom > 100, "Home moves native history to the top");
  await page.keyboard.press("End");
  await page.waitForFunction(() => { const bar = document.querySelector('[role="scrollbar"]'); return bar?.getAttribute("aria-valuenow") === bar?.getAttribute("aria-valuemax"); });
  await until(async () => (await paneScrollInfo(paneId))!.offset_from_bottom === 0, "End reaches native bottom");
  const box = (await scrollbar.boundingBox())!;
  const thumb = (await scrollbar.locator(".terminal-history-thumb").boundingBox())!;
  await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + thumb.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(() => Number(document.querySelector('[role="scrollbar"]')?.getAttribute("aria-valuenow")) < 3);
  await until(async () => (await paneScrollInfo(paneId))!.offset_from_bottom > 100, "thumb drag moves the actual shared pane");

  const beforeFindRows = (await paneScrollInfo(paneId))!.viewport_rows;
  await page.keyboard.press("ControlOrMeta+Shift+f");
  const find = page.getByRole("search", { name: "Find in terminal", exact: true });
  const input = find.getByRole("searchbox");
  // Opening Find changes the shared native grid. Search after that geometry reaches herdr,
  // as pane-find-regression does, rather than racing an attach resize with pane.scroll.
  await until(async () => {
    const native = await paneScrollInfo(paneId);
    return !!native && native.viewport_rows < beforeFindRows
      && native.viewport_rows === await page.locator(".xterm-rows > div").count();
  }, "the search bar's native geometry is ready");
  await input.fill("mark_needle");
  await input.press("Enter");
  await waitHighlight();
  assert.ok(await page.locator(".terminal-find-hit").count() >= 2, "all visible occurrences are marked without selecting them");
  if (process.env.UI_EVIDENCE_DIR) {
    mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "terminal-search.png") });
  }
  const count = await find.locator(".find-bar-count").textContent();
  const readonlySearch = page.waitForRequest((request) => request.url().endsWith("/api/pane/find") && request.postDataJSON()?.jump === false);
  await scrollbar.focus();
  await page.keyboard.press("End");
  await readonlySearch;
  await page.waitForFunction(() => { const bar = document.querySelector('[role="scrollbar"]'); return bar?.getAttribute("aria-valuenow") === bar?.getAttribute("aria-valuemax"); });
  assert.equal(await find.locator(".find-bar-count").textContent(), count, "scroll refresh does not advance the search ordinal");
  assert.equal((await paneScrollInfo(paneId))!.offset_from_bottom, 0, "background search refresh never moves the view");
  await input.fill("界éZ");
  await input.press("Enter");
  await waitHighlight();
  const hit = (await page.locator(".terminal-find-hit.is-current").first().boundingBox())!;
  const screen = (await page.locator(".xterm-screen").boundingBox())!;
  const wide = await page.evaluate(() => { const row = document.querySelector(".xterm-rows > div"); return row?.getBoundingClientRect().height ?? 0; });
  assert.ok(hit.width > 20 && hit.height > 0 && wide > 0 && hit.x >= screen.x, "wide and combining text has visible cell-aligned emphasis");
  // An older scrollbar write must finish before a newer explicit search moves the pane.
  // The fetch observer records dispatch synchronously; no timing sleep is needed to prove
  // Find is waiting while its UI already says Searching… and the POST is held below.
  await page.evaluate((owner) => {
    const original = window.fetch;
    const probe = { released: false, calls: [] as Array<{ path: string; released: boolean }>, restore: () => { window.fetch = original; } };
    (window as any).__viewportOrderProbe = probe;
    window.fetch = (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
      if (init?.method === "POST" && typeof init.body === "string") {
        const body = JSON.parse(init.body);
        if (body.pane_id === owner && (url.pathname.endsWith("/pane/scroll") || (url.pathname.endsWith("/pane/find") && body.jump !== false))) {
          probe.calls.push({ path: url.pathname, released: probe.released });
        }
      }
      return original.call(window, input, init);
    };
  }, paneId);
  const releaseScroll = Promise.withResolvers<void>();
  const intercepted = Promise.withResolvers<void>();
  let firstScroll = true;
  const holdScroll = async (route: import("playwright-core").Route) => {
    if (route.request().method() === "POST" && firstScroll) {
      firstScroll = false;
      intercepted.resolve();
      await releaseScroll.promise;
    }
    await route.continue();
  };
  await page.route("**/api/pane/scroll", holdScroll);
  try {
    await scrollbar.focus();
    await page.keyboard.press("Home");
    await Promise.race([intercepted.promise, new Promise<never>((_resolve, reject) => {
      const signal = AbortSignal.timeout(10000);
      signal.addEventListener("abort", () => reject(new Error("scroll POST was not intercepted")), { once: true });
    })]);
    // A second queued target is obsolete once the user asks Find to choose the viewport.
    await page.keyboard.press("PageDown");
    await input.fill("history 090: record");
    const explicitResponse = page.waitForResponse((response) => response.url().endsWith("/api/pane/find")
      && response.request().postDataJSON()?.query === "history 090: record" && response.request().postDataJSON()?.jump !== false);
    const refreshedResponse = page.waitForResponse((response) => response.url().endsWith("/api/pane/find")
      && response.request().postDataJSON()?.query === "history 090: record" && response.request().postDataJSON()?.jump === false);
    // These listeners still terminate quietly if an earlier assertion fails.
    void explicitResponse.catch(() => {}); void refreshedResponse.catch(() => {});
    await input.press("Enter");
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>(".find-bar input")?.readOnly === true);
    assert.equal(await page.evaluate(() => (window as any).__viewportOrderProbe.calls.filter((call: { path: string }) => call.path.endsWith("/pane/find")).length), 0,
      "explicit native search must wait for the previous scrollbar request");
    await page.evaluate(() => { (window as any).__viewportOrderProbe.released = true; });
    releaseScroll.resolve();
    const response = await explicitResponse;
    assert.equal(response.status(), 200);
    const result = await response.json() as PaneFindResponse;
    assert.ok(result.match && result.scroll);
    const expected = Math.max(0, result.scroll.max_offset_from_bottom - result.match.start.row);
    assert.equal(result.scroll.offset_from_bottom, expected);
    assert.ok(expected > 0 && expected < result.scroll.max_offset_from_bottom, "the search chooses a distinct middle viewport");
    await waitHighlight();
    assert.equal((await refreshedResponse).status(), 200);
    await until(async () => (await paneScrollInfo(paneId))!.offset_from_bottom === expected, "the newer search determines native history position");
    const ordering = await page.evaluate(() => (window as any).__viewportOrderProbe.calls) as Array<{ path: string; released: boolean }>;
    const findIndex = ordering.findIndex((call) => call.path.endsWith("/pane/find"));
    assert.ok(findIndex > 0 && ordering[findIndex]!.released);
    assert.equal(ordering.slice(findIndex + 1).filter((call) => call.path.endsWith("/pane/scroll")).length, 0,
      "an older queued scroll must not be dispatched after Find");
    const final = await paneScrollInfo(paneId);
    assert.equal(final!.offset_from_bottom, expected, "no late scroll overwrites the search result");
  } finally {
    releaseScroll.resolve();
    await page.unroute("**/api/pane/scroll", holdScroll);
    await page.evaluate(() => {
      (window as any).__viewportOrderProbe?.restore();
      delete (window as any).__viewportOrderProbe;
    });
  }

  await page.getByRole("button", { name: "Close search", exact: true }).click();
  await page.locator(".terminal-find-hit").waitFor({ state: "detached" });

  // Exercise an old bridge: no-jump refresh must never be sent if the response lacks fields.
  let automatic = 0;
  await page.route("**/api/pane/find", async (route) => {
    const body = route.request().postDataJSON();
    if (body.jump === false) automatic++;
    const response = await route.fetch();
    const result = await response.json(); delete result.matches; delete result.scroll;
    await route.fulfill({ response, json: result });
  });
  await page.keyboard.press("ControlOrMeta+Shift+f");
  await input.fill("mark_needle");
  await input.press("Enter");
  await find.locator(".find-bar-count").filter({ hasText: /of/ }).waitFor();
  const metricsRead = page.waitForResponse((response) => response.url().includes("/api/pane/scroll?") && response.request().method() === "GET");
  await metricsRead;
  assert.equal(automatic, 0, "older bridges are never sent an automatic search that could scroll");
  assert.deepEqual(errors, []);
  if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "terminal-viewport.png") });
  await context.close();
  console.log("PASS native history scrollbar, search highlights, wide cells, non-jumping refresh and old bridge compatibility");
} finally {
  await browser.close(); server.stop();
  if (workspace) await workspaceClose(workspace).catch(() => {});
  rmSync(state, { recursive: true, force: true });
}
