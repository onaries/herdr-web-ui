import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { appFaces } from "./app-faces.ts";
import { herdrRpc, tabCreate, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";

type Box = { left: number; top: number; right: number; bottom: number; width: number; height: number };
type KeyboardQA = Window & { keyboardQA: (height: number | null) => void };

const TAB_LABELS = ["second", "a long tab name for review", "deploy", "docs"];

async function box(page: Page, selector: string): Promise<Box> {
  const found = await page.evaluate((selector) => {
    const node = document.querySelector(selector);
    if (!node) return null;
    const { left, top, right, bottom, width, height } = node.getBoundingClientRect();
    return { left, top, right, bottom, width, height };
  }, selector);
  assert.ok(found, `${selector} is on the page`);
  return found;
}

/** The header keeps the pane's title and the strip sits right under it, whatever the lens. */
async function assertShell(page: Page, label: string, titleRoom = 60): Promise<void> {
  assert.equal(await page.locator(".app-header").getByRole("button", { name: "New tab" }).count(), 0, `${label}: the header has no New tab button of its own`);
  assert.equal(await page.locator(".app-header .header-more-button").isVisible(), true, `${label}: New tab is an item of the header's More menu`);
  const title = await box(page, ".context-title-text");
  assert.ok(title.width >= titleRoom, `${label}: the pane's title keeps its room in the header (${title.width}px)`);
  const header = await box(page, ".app-header");
  const strip = await box(page, ".tab-strip");
  assert.ok(Math.abs(strip.top - header.bottom) <= 1, `${label}: the strip sits under the header (${strip.top} vs ${header.bottom})`);
  assert.ok(strip.height >= 40, `${label}: the strip is a touch target tall (${strip.height}px)`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${label}: nothing overflows sideways`);
}

/** The open tab and the + are both inside the strip's visible part, and the + is not over the tab. */
async function activeTabInView(page: Page, label: string): Promise<void> {
  await page.waitForFunction(() => {
    const strip = document.querySelector(".tab-strip")?.getBoundingClientRect();
    const active = document.querySelector(".tab-strip-item.is-active")?.getBoundingClientRect();
    const add = document.querySelector(".tab-strip-add")?.getBoundingClientRect();
    if (!strip || !active || !add) return false;
    return active.left >= strip.left - 1 && active.right <= add.left + 1 && add.right <= strip.right + 1;
  }, null, { timeout: 5_000 }).catch(async (cause) => {
    throw new Error(`${label}: expected the open tab and the + in view; observed ${JSON.stringify({
      strip: await box(page, ".tab-strip"), active: await box(page, ".tab-strip-item.is-active"), add: await box(page, ".tab-strip-add"),
    })}`, { cause });
  });
}

/** A phone's header and tab strip over a workspace with more tabs than fit the screen. */
export async function checkMobileTabs(browser: Browser, origin: string): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-web-ui-mobile-tabs-")));
  let workspaceId: string | null = null;
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
  try {
    const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-mobile-tabs" });
    workspaceId = created.workspace.workspace_id;
    const first = created.root_pane.pane_id;
    await herdrRpc("pane.split", { target_pane_id: first, direction: "right", focus: false });
    const panes: string[] = [];
    for (const label of TAB_LABELS) panes.push((await tabCreate({ workspaceId, cwd: root, label })).root_pane.pane_id);
    const last = panes.at(-1)!;
    await herdrRpc("pane.report_agent", { pane_id: first, source: "manual", agent: "claude", state: "idle" });

    await context.addInitScript(() => {
      if (localStorage.getItem("herdr-web-ui:settings") === null) localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" }));
      const viewport = window.visualViewport!;
      let height: number | null = null;
      Object.defineProperty(viewport, "height", { get: () => height ?? window.innerHeight });
      (window as unknown as KeyboardQA).keyboardQA = (value) => { height = value; viewport.dispatchEvent(new Event("resize")); };
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const evidence = process.env.UI_EVIDENCE_DIR;
    if (evidence) mkdirSync(evidence, { recursive: true });
    const screenshot = async (name: string): Promise<void> => {
      if (evidence) await page.screenshot({ path: join(evidence, `mobile-tabs-${name}.png`), animations: "disabled" });
    };

    await page.goto(`${origin}/?pane=${encodeURIComponent(first)}`);
    await page.locator(".conn-live").waitFor();
    await page.locator(".tab-strip").waitFor();
    await page.getByTitle("Chat transcript (⌘⇧J)", { exact: true }).click();
    const firstFrame = page.locator(`[data-layout-pane=${JSON.stringify(first)}]`);
    const composer = firstFrame.getByRole("textbox", { name: "Message", exact: true });
    await composer.waitFor();
    await assertShell(page, "chat");
    const chat = await box(page, ".chat-view");
    assert.ok(chat.top >= (await box(page, ".tab-strip")).bottom - 1, "the chat starts under the strip, not over it");
    await screenshot("chat");

    await composer.tap();
    await page.evaluate(() => (window as unknown as KeyboardQA).keyboardQA(480));
    await page.waitForFunction(() => document.documentElement.hasAttribute("data-keyboard") && Math.round(document.querySelector(".app")!.getBoundingClientRect().height) === 480);
    await assertShell(page, "chat with the keyboard up");
    assert.ok((await box(page, ".composer")).bottom <= 481, "the composer stays above the keyboard");
    await screenshot("chat-keyboard");
    await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); (window as unknown as KeyboardQA).keyboardQA(null); });
    await page.waitForFunction(() => !document.documentElement.hasAttribute("data-keyboard"));

    await page.getByTitle("Live terminal (⌘⇧J)", { exact: true }).click();
    await firstFrame.locator(".key-bar").waitFor();
    assert.equal(await page.locator(".pane-frame:visible").count(), 2, "the terminal lens retains both panes on a phone");
    await assertShell(page, "terminal");

    assert.equal(await page.locator(".tab-strip-close, .tab-strip-panes").count(), 0, "tabs have no close buttons or chevrons");
    assert.equal(await page.locator(".tab-strip-menu:visible").count(), 1, "only the active tab exposes a touch menu");
    const tab = await box(page, ".tab-strip-item.is-active .tab-strip-tab");
    const menu = await box(page, ".tab-strip-item.is-active .tab-strip-menu");
    assert.ok(menu.left >= tab.right - 0.5, `the tab's menu button is beside its name, not over it (${menu.left} vs ${tab.right})`);
    assert.ok(menu.width >= 40 && menu.height >= 40, "the tab menu button is a touch target");
    await activeTabInView(page, "the first tab");
    await screenshot("terminal");

    await page.goto(`${origin}/?pane=${encodeURIComponent(last)}`);
    await page.locator(".conn-live").waitFor();
    await page.locator('.tab-strip [role="tab"][aria-selected="true"]', { hasText: "docs" }).waitFor();
    await activeTabInView(page, "a pane opened from outside the strip");
    await assertShell(page, "the last tab");
    await screenshot("last-tab");

    await page.locator(".tab-strip").evaluate((node) => { node.scrollLeft = 0; });
    await page.getByRole("tab", { name: "Tab 1", exact: true }).tap();
    await page.locator('.tab-strip [role="tab"][aria-selected="true"]', { hasText: "Tab 1" }).waitFor();
    await activeTabInView(page, "the first tab, tapped");
    assert.equal(await page.locator(".tab-strip-menu:visible").count(), 1, "the menu button follows a tab selected by touch");
    await page.getByRole("button", { name: "Actions for Tab 1", exact: true }).tap();
    const tabSheet = page.getByRole("dialog", { name: "Tab 1", exact: true });
    await tabSheet.waitFor();
    assert.deepEqual(await tabSheet.locator(".row-sheet-item").allTextContents(), ["Move tab right", "New tab", "Rename tab", "Close tab"], "the first tab offers only its available adjacent move, with the same actions as right-click");
    await tabSheet.getByRole("button", { name: "Cancel", exact: true }).tap();
    await tabSheet.waitFor({ state: "detached" });

    await page.setViewportSize({ width: 320, height: 640 });
    await activeTabInView(page, "a 320px phone");
    await assertShell(page, "a 320px phone", 0);
    await screenshot("narrow");
    assert.deepEqual(errors, []);

    // The app's faces come after the first paint (src/fonts/fonts.css, font-display: swap) and
    // every tab's name is redrawn with them, wider or narrower: the strip that brought the open
    // tab into view in the fallback brings it into view again. The font files are held here until
    // the fallback drawing is seen; no service worker, so that nothing answers them from a cache.
    // A strip the user scrolled themselves, to look at other tabs, is left where they put it by a
    // face that comes after: the scroll below is not the strip's own, which is all the app can
    // know of a wheel or a drag. Opening a tab ends that.
    for (const scrolled of [false, true]) {
      const slow = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US", serviceWorkers: "block" });
      try {
        await slow.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" })));
        const late = await slow.newPage();
        const lateErrors: string[] = [];
        late.on("pageerror", (error) => lateErrors.push(error.message));
        let release = (): void => undefined;
        const released = new Promise<void>((done) => { release = done; });
        await late.route("**/*.woff2", async (route) => { await released; await route.continue().catch(() => undefined); });
        const strip = late.locator(".tab-strip");
        const openInView = (): Promise<boolean> => strip.evaluate((node) => {
          const item = node.querySelector(".tab-strip-item.is-active")!.getBoundingClientRect();
          return item.left >= node.getBoundingClientRect().left - 1 && item.right <= node.querySelector(".tab-strip-add")!.getBoundingClientRect().left + 1;
        });
        try {
          await late.goto(`${origin}/?pane=${encodeURIComponent(last)}`);
          await late.locator(".conn-live").waitFor();
          await late.locator('.tab-strip [role="tab"][aria-selected="true"]', { hasText: "docs" }).waitFor();
          assert.equal(await late.evaluate(() => [...document.fonts].filter((face) => face.family.replace(/["']/g, "") === "Pretendard Variable" && face.status === "loaded").length), 0, "the strip is first drawn before its face comes");
          await activeTabInView(late, "the last tab, before the faces came");
          if (scrolled) {
            await strip.evaluate((node) => { node.scrollLeft = 0; });
            await late.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
            assert.equal(await openInView(), false, "the user scrolled the strip away from the open tab");
          }
        } finally { release(); }
        await appFaces(late);
        if (scrolled) {
          assert.equal(await strip.evaluate((node) => node.scrollLeft), 0, "a strip the user scrolled is left there when the faces come");
          assert.equal(await openInView(), false);
          await late.getByRole("tab", { name: "Tab 1", exact: true }).tap();
          await late.locator('.tab-strip [role="tab"][aria-selected="true"]', { hasText: "Tab 1" }).waitFor();
          await activeTabInView(late, "a tab opened after the user's scroll");
        } else {
          await activeTabInView(late, "the last tab, after the faces came");
        }
        assert.deepEqual(lateErrors, []);
      } finally { await slow.close(); }
    }
    console.log("PASS a phone keeps the pane's title in the header and the open tab and the + in the strip, in both lenses and with the keyboard up");
  } finally {
    await context.close();
    if (workspaceId) await workspaceClose(workspaceId).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await import("./test-herdr.ts");
  const { chromium } = await import("playwright-core");
  const { createServer } = await import("../server/index.ts");
  const { UsageService } = await import("../server/usage.ts");
  const state = mkdtempSync(join(tmpdir(), "herdr-web-ui-mobile-tabs-state-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: state, usage: new UsageService(undefined, []) });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
  try {
    await checkMobileTabs(browser, `http://127.0.0.1:${server.port}`);
  } finally {
    await browser.close();
    server.stop();
    rmSync(state, { recursive: true, force: true });
  }
}
