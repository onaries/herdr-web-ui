/// <reference types="bun" />
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type CDPSession, type Page } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

// A finger reorders the sidebar's workspaces (src/lib/touchReorder.ts), on the unmodified app over
// the demo's fixture transport at a phone's size with touch: a long press lifts a row, a drag drops
// it where the line shows, a quick stroke only scrolls, and Alt+Up moves it a step without pane actions in the workspace menu.
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

/** A finger moves after the row lifts, or immediately for a quick scroll stroke. */
async function stroke(page: Page, cdp: CDPSession, from: { x: number; y: number }, to: { x: number; y: number }, holdMs: number, during?: () => Promise<void>): Promise<void> {
  await touch(cdp, "touchStart", from);
  if (holdMs > 0) await page.locator(".workspace.is-lifted").waitFor({ timeout: 5_000 });
  const steps = 12;
  for (let step = 1; step <= steps; step += 1) {
    await touch(cdp, "touchMove", { x: Math.round(from.x + (to.x - from.x) * step / steps), y: Math.round(from.y + (to.y - from.y) * step / steps) });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  }
  await during?.();
  await touch(cdp, "touchEnd");
}

const pinnedRows = (page: Page) => page.locator(".workspace-list-pinned > .workspace-group").evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.workspace));

/** Both input methods change saved pins, never the transport's workspace roster. */
async function checkPinned(page: Page, cdp?: CDPSession): Promise<void> {
  const before = await topRows(page);
  const ids = before.slice(0, 2);
  assert.equal(ids.length, 2);
  const child = await page.evaluate(async (workspaceId) => {
    const response = await fetch("/api/worktree/create", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace_id: workspaceId, branch: "pinned-reorder-child" }),
    });
    if (!response.ok) throw new Error(`create demo worktree: ${response.status}`);
    return (await response.json() as { workspace_id: string }).workspace_id;
  }, ids[0]);
  await page.locator(`.worktree-children .workspace-group[data-workspace="${child}"]`).waitFor();
  const serverBefore = await serverOrder(page);
  const row = (id: string) => page.locator(`.workspace-group[data-workspace="${id}"] > .workspace-header .workspace-select`);
  for (const id of ids) {
    if (cdp) await page.locator(`.workspace-group[data-workspace="${id}"] > .workspace-header .row-menu-toggle`).click();
    else await row(id!).click({ button: "right" });
    await page.getByRole(cdp ? "button" : "menuitem", { name: "Pin workspace", exact: true }).click();
  }
  assert.deepEqual(await pinnedRows(page), ids);
  const restRows = () => page.locator(".machine-workspaces .sidebar-list > .workspace-list:not(.workspace-list-pinned) > .workspace-group").evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.workspace));
  const restBefore = await restRows();
  const drag = async (source: string, target: string) => {
    if (cdp) await stroke(page, cdp, await centerOf(page, source), await centerOf(page, target), 1);
    else await row(source).dragTo(row(target));
  };
  await drag(ids[0]!, ids[1]!);
  const expected = [ids[1], ids[0]];
  assert.deepEqual(await pinnedRows(page), expected, "drag changes the pinned card order");
  assert.equal(await page.locator(".workspace-list-pinned .worktree-children").count(), 0, "pinned repository rows do not carry their worktrees into the card");
  const childRow = row(child);
  assert.equal(await childRow.evaluate((element) => element.closest(".sidebar-pinned, .worktree-children") === null), true, "the unpinned worktree stands alone outside the card");
  assert.equal(await childRow.getAttribute("draggable"), "false", "the unpinned worktree stays fixed");
  assert.deepEqual(await restRows(), restBefore, "reordering the pinned repository leaves its worktree at the original rest-list position");
  await row(ids[0]!).focus();
  await page.keyboard.press("Alt+ArrowUp");
  assert.deepEqual(await pinnedRows(page), ids, "Alt+Up reorders pinned rows within the card");
  await page.keyboard.press("Alt+ArrowDown");
  assert.deepEqual(await pinnedRows(page), expected, "Alt+Down restores the pinned order");
  await childRow.focus();
  await page.keyboard.press("Alt+ArrowDown");
  assert.deepEqual(await restRows(), restBefore, "Alt+Down cannot move the repository's unpinned worktree");
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("herdr-web-ui:sidebar-agent-pins") ?? "[]") as string[]);
  assert.deepEqual(stored.filter((key) => key.includes(":workspace:")).map((key) => key.split(":workspace:")[1]), expected, "the pin list holds the new order");
  const unpinned = before[2]!;
  await drag(ids[0]!, unpinned);
  await drag(unpinned, ids[0]!);
  assert.deepEqual(await pinnedRows(page), expected, "neither direction crosses the pin boundary");
  await drag(ids[0]!, child);
  assert.deepEqual(await pinnedRows(page), expected, "dropping onto the repository's own worktree cannot cross the card edge");
  assert.deepEqual(await restRows(), restBefore, "cross-card drops leave the rest list unchanged");
  assert.deepEqual(await serverOrder(page), serverBefore, "pinned drags never move herdr workspaces");
  const evidence = process.env["UI_EVIDENCE_DIR"];
  if (evidence) {
    mkdirSync(evidence, { recursive: true });
    await page.screenshot({ path: join(evidence, `pinned-reorder-${cdp ? "phone" : "desktop"}.png`) });
  }
  await page.reload();
  await page.locator(".conn-live").waitFor({ state: "attached" });
  const toggle = page.locator('button[aria-controls="workspace-drawer"]');
  if (cdp && await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  await page.locator(".workspace-list-pinned").waitFor();
  assert.deepEqual(await pinnedRows(page), expected, "pin order survives reload");
  console.log(`PASS ${cdp ? "touch long press" : "desktop drag"} and Alt+Up/Down reorder saved pins within the card, keep unpinned worktrees fixed outside, preserve herdr order and survive reload`);
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
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
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

      // The phone's explicit menu has the same workspace scope as desktop right-click.
      const moved = before[0]!;
      const movedRow = page.locator(`.workspace-group[data-workspace="${moved}"]`);
      await movedRow.locator(".row-menu-toggle").click();
      const workspaceSheet = page.locator(".row-sheet");
      await workspaceSheet.waitFor();
      assert.deepEqual(await workspaceSheet.locator(".row-sheet-item").allTextContents(), ["Pin workspace", "Rename workspace", "Close workspace", "New worktree", "Open worktree…"],
        "the touch menu contains native workspace actions, with no pane or reorder actions");
      await workspaceSheet.getByRole("button", { name: "Cancel", exact: true }).click();
      await workspaceSheet.waitFor({ state: "detached" });
      // Keyboard reordering remains available on the row itself.
      await movedRow.locator(".workspace-select").focus();
      await page.keyboard.press("Alt+ArrowUp");
      const stepped = [before[1]!, before[0]!, before[2]!, ...before.slice(3)];
      await page.waitForFunction((want) => [...document.querySelectorAll<HTMLElement>(".machine-workspaces .sidebar-list > .workspace-list > .workspace-group")].map((row) => row.dataset.workspace).join() === want.join(),
        stepped, { timeout: 5_000 });
      assert.deepEqual((await serverOrder(page)).filter((id) => before.includes(id)), stepped, "herdr got the keyboard move");
      console.log("PASS the touch menu keeps workspace scope and Alt+Up still moves a workspace one step");

      await checkPinned(page, cdp);
      assert.deepEqual(errors, []);
      await context.close();
      const desktop = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "en-US" });
      await desktop.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" })));
      const desktopPage = await desktop.newPage();
      await desktopPage.goto(`http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/`);
      await desktopPage.locator(".conn-live").waitFor({ state: "attached" });
      await desktopPage.locator(".machine-workspaces .workspace-group").first().waitFor();
      await checkPinned(desktopPage);
      await desktop.close();
    } finally {
      await browser.close();
    }
  } finally {
    server.stop(true);
  }
} finally {
  rmSync(app, { recursive: true, force: true });
}
