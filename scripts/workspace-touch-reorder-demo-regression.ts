import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type CDPSession, type Page } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";

// A finger reorders the sidebar's workspaces (src/lib/touchReorder.ts), on the unmodified app over
// the demo's fixture transport at a phone's size with touch: a long press lifts a row, a drag drops
// it where the line shows, a quick stroke only scrolls, and the row menu's Move up moves it a step.
// All files and HTTP traffic stay in this disposable, loopback-only app; no herdr session is opened.
const app = mkdtempSync(join(tmpdir(), "herdr-touch-reorder-demo-"));

/** the top-level rows, in the order the sidebar draws them */
const topRows = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".machine-workspaces .sidebar-list > .workspace-list > .workspace-group")].map((row) => row.dataset.workspace ?? ""));
const serverOrder = (page: Page) => page.evaluate(async () => ((await (await fetch("/api/session")).json()).snapshot as { workspaces: { workspace_id: string }[] }).workspaces.map((workspace) => workspace.workspace_id));
const centerOf = async (page: Page, id: string) => {
  const box = await page.locator(`.workspace-group[data-workspace="${id}"] > .workspace-header .workspace-select`).boundingBox();
  assert.ok(box, `row ${id} is on screen`);
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
};
const touch = (cdp: CDPSession, type: "touchStart" | "touchMove" | "touchEnd", point?: { x: number; y: number }) =>
  cdp.send("Input.dispatchTouchEvent", { type, touchPoints: point ? [{ x: point.x, y: point.y }] : [] });

/** a finger from `from` to `to` in small steps, after resting `holdMs` */
async function stroke(page: Page, cdp: CDPSession, from: { x: number; y: number }, to: { x: number; y: number }, holdMs: number, during?: () => Promise<void>): Promise<void> {
  await touch(cdp, "touchStart", from);
  if (holdMs > 0) await page.waitForTimeout(holdMs);
  const steps = 12;
  for (let step = 1; step <= steps; step += 1) {
    await touch(cdp, "touchMove", { x: Math.round(from.x + (to.x - from.x) * step / steps), y: Math.round(from.y + (to.y - from.y) * step / steps) });
    await page.waitForTimeout(16);
  }
  await during?.();
  await touch(cdp, "touchEnd");
}

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  writeFileSync(index, html.replace(/<script type="module"/, '<script src="./demo-transport.js"></script>\n    <script type="module"'));

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/herdr-web-ui/demo/app/")) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice("/herdr-web-ui/demo/app/".length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return (await body.exists()) ? new Response(body) : new Response("not found", { status: 404 });
  } });

  try {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
      await context.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" })));
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/`);
      await page.locator(".conn-live").waitFor({ state: "attached" });
      await page.locator('button[aria-controls="workspace-drawer"]').click();
      await page.locator(".machine-workspaces .workspace-group").first().waitFor();
      await page.waitForTimeout(500);
      const cdp = await context.newCDPSession(page);

      assert.equal(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), true, "the phone context has a coarse pointer");
      assert.equal(await page.locator(".machine-workspaces .workspace-select").first().getAttribute("draggable"), "false",
        "on a touch screen the browser's own drag is off, so iOS lifts no drag preview that drops nothing");

      const before = await topRows(page);
      assert.ok(before.length >= 3, `the demo has three top-level workspaces: ${JSON.stringify(before)}`);
      assert.deepEqual((await serverOrder(page)).filter((id) => before.includes(id)), before, "the sidebar draws herdr's order");

      // a quick stroke is a scroll, not a lift
      await stroke(page, cdp, await centerOf(page, before[0]!), await centerOf(page, before[2]!), 0, async () => {
        assert.equal(await page.locator(".workspace.is-lifted").count(), 0, "a stroke that moves at once lifts nothing");
      });
      await page.waitForTimeout(300);
      assert.deepEqual(await topRows(page), before, "a quick stroke moves nothing");

      // a long press lifts the first row; dragged past the third and let go, it lands after it
      const target = await centerOf(page, before[2]!);
      await stroke(page, cdp, await centerOf(page, before[0]!), { x: target.x, y: target.y + 4 }, 600, async () => {
        assert.equal(await page.locator(`.workspace-group.is-lifted[data-workspace="${before[0]}"]`).count(), 1, "the held row is lifted");
        assert.ok(await page.locator(`.machine-workspaces [data-drop="after"]`).count() === 1, "a line shows where it lands");
        assert.notEqual(await page.locator(`.workspace-group[data-workspace="${before[0]}"]`).evaluate((row) => row.style.transform), "", "the row follows the finger");
      });
      const expected = [before[1]!, before[2]!, before[0]!, ...before.slice(3)];
      await page.waitForFunction((want) => [...document.querySelectorAll<HTMLElement>(".machine-workspaces .sidebar-list > .workspace-list > .workspace-group")].map((row) => row.dataset.workspace).join() === want.join(),
        expected, { timeout: 5_000 });
      assert.deepEqual((await serverOrder(page)).filter((id) => before.includes(id)), expected, "herdr got the move");
      assert.equal(await page.locator(".workspace.is-lifted, [data-drop]").count(), 0, "nothing stays lifted or marked");
      assert.equal(await page.locator(`.workspace-group[data-workspace="${before[0]}"]`).evaluate((row) => row.style.transform), "", "the dropped row sits in the list");
      assert.equal(await page.locator('button[aria-controls="workspace-drawer"]').getAttribute("aria-expanded"), "true", "the drag left the drawer open");
      console.log("PASS a long press lifts a workspace row on a touch screen, and a drag drops it where the line shows");

      // the row menu moves it one step back up
      const moved = before[0]!;
      await page.locator(`.workspace-group[data-workspace="${moved}"] .row-menu-toggle`).click();
      await page.getByRole("button", { name: "Move up" }).or(page.getByRole("menuitem", { name: "Move up" })).first().click();
      const stepped = [before[1]!, before[0]!, before[2]!, ...before.slice(3)];
      await page.waitForFunction((want) => [...document.querySelectorAll<HTMLElement>(".machine-workspaces .sidebar-list > .workspace-list > .workspace-group")].map((row) => row.dataset.workspace).join() === want.join(),
        stepped, { timeout: 5_000 });
      console.log("PASS the row menu's Move up moves a workspace one step");

      assert.deepEqual(errors, []);
      await context.close();
    } finally {
      await browser.close();
    }
  } finally {
    server.stop(true);
  }
} finally {
  rmSync(app, { recursive: true, force: true });
}
