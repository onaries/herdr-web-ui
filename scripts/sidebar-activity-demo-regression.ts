import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

// Settings → Agents order (Activity) and the Agents list's pins, on the unmodified app over the
// demo's fixture transport, whose agents carry herdr's state_change_seq and bump it on every state
// change. The demo's Claude pane finishes by itself 4.5s in (site/demo/transport.ts), and a message
// sent from a chat runs for 2.4s and then finishes. All files and HTTP traffic stay in this
// disposable, loopback-only app; no herdr session is opened.
const app = mkdtempSync(join(tmpdir(), "herdr-sidebar-activity-demo-"));

const API = "Idempotent payments";        // claude, working, finishes by itself
const WEB = "Guard the export button";    // codex, blocked
const INFRA = "Why did the backup fail?"; // idle: the agent a message is sent from
const AGENTS_HERDR_ORDER = [API, WEB, INFRA, "Proofread the guide", "Ship the retry flag"];

const agents = (page: Page) => page.locator(".agents-sidebar .agent-item");
const agentTitles = (page: Page) => agents(page).locator(".agent-title").allTextContents();
const agent = (page: Page, title: string) => agents(page).filter({ has: page.locator(".agent-title", { hasText: title }) });
const agentStatus = (page: Page, title: string) => agent(page, title).locator(".sidebar-status").getAttribute("data-status");
const waitStatus = (page: Page, title: string, status: string) => agent(page, title).locator(`.sidebar-status[data-status="${status}"]`).waitFor({ timeout: 10_000 });
const waitAgentAt = (page: Page, index: number, title: string) => page.waitForFunction(([at, name]) =>
  [...document.querySelectorAll(".agents-sidebar .agent-item .agent-title")][at as number]?.textContent === name, [index, title] as const, { timeout: 5_000 });

async function withPage(browser: Browser, settings: object, run: (page: Page) => Promise<void>, mobile = false): Promise<void> {
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    isMobile: mobile, hasTouch: mobile, locale: "en-US",
  });
  try {
    await context.addInitScript((stored) => {
      localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", defaultView: "chat", ...stored }));
    }, settings);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // the shell pane is on screen, so the demo's own finish happens out of sight
    await page.goto(`${url}?pane=${encodeURIComponent(panes.shell)}`);
    await page.locator(".conn-live").waitFor({ state: "attached" });
    await agents(page).first().waitFor({ state: "attached" });
    await run(page);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

let url = "";
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
  url = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/`;

  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      // Workspace menus no longer mix in pane operations; header More keeps pane movement.
      // herdr's order in a flat list, each row naming its own workspace, with its row and its ⋯
      await withPage(browser, {}, async (page) => {
        assert.deepEqual(await agentTitles(page), AGENTS_HERDR_ORDER);
        assert.match(await agent(page, API).locator(".agent-context").textContent() ?? "", /checkout-api/, "a row names its workspace");
        // a desktop draws no row ⋯: a right-click or the context-menu key opens the menu
        assert.equal(await agent(page, API).getByRole("button").count(), 1, "a desktop row is its selector alone");
        assert.equal(await page.locator(".row-menu-toggle:visible").count(), 0, "no row ⋯ on a desktop");
        assert.equal(await page.locator(".agents-sidebar .agent-list-pinned, .agents-sidebar .sidebar-pin-mark").count(), 0, "no pinned list without pins");
      });
      console.log("PASS the Agents list is flat, in herdr's order, each row a selector with no ⋯ on a desktop");

      // a pane's plan: the composer's chip shows how far it got and opens its steps, as the background
      // tasks do; the header carries no plan of its own
      for (const mobile of [false, true]) {
        await withPage(browser, {}, async (page) => {
          await page.goto(`${url}?pane=${encodeURIComponent(panes.api)}`);
          await page.locator(".conn-live").waitFor({ state: "attached" });
          const chip = page.locator(".composer .bg-tasks-toggle");
          await chip.waitFor();
          assert.match(await chip.getAttribute("aria-label") ?? "", /^Plan: 1 of \d+ done/, "the chip names the plan's progress");
          assert.match((await chip.locator(".bg-tasks-plan").textContent())?.trim() ?? "", /^1\/\d+$/);
          assert.equal(await page.locator(".plan-button").count(), 0, "no plan button in the header");
          await chip.click();
          const list = page.getByRole("dialog", { name: /^Plan/ });
          await list.locator(".bg-step").first().waitFor();
          assert.equal(await list.locator(".bg-step.is-in_progress").count(), 1, "the running step is marked");
          assert.equal(await list.locator(".plan-node, .plan-view-switch").count(), 0, "no flow of boxes");
          await page.keyboard.press("Escape");
          await list.waitFor({ state: "detached" });
        }, mobile);
      }
      console.log("PASS a pane's plan opens from the composer's chip, as a list of steps, on a desktop and a phone");

      // herdr's order before and after a finish; a right-click pins an agent, an opened DONE keeps herdr's dot
      await withPage(browser, {}, async (page) => {
        const selected = await page.evaluate(() => sessionStorage.getItem("herdr-web-ui:selection"));
        await page.locator(".header-more-button").focus();
        const workspace = page.locator(`.workspace-select[data-pane="${panes.api}"]`);
        const bounds = (await workspace.boundingBox())!;
        await workspace.click({ button: "right", position: { x: 32, y: bounds.height / 2 } });
        const menu = page.getByRole("menu", { name: "checkout-api", exact: true });
        await menu.waitFor();
        assert.deepEqual(await menu.getByRole("menuitem").allTextContents(), ["Pin workspace", "Rename workspace", "Close workspace", "New worktree", "Open worktree…"], "right-click uses native workspace scope");
        const opened = (await menu.boundingBox())!;
        assert.ok(Math.abs(opened.x - bounds.x - 32) <= 1 && Math.abs(opened.y - bounds.y - bounds.height / 2) <= 1, "the menu opens at the pointer");
        assert.equal(await page.evaluate(() => sessionStorage.getItem("herdr-web-ui:selection")), selected, "right-click leaves the selected pane alone");
        await page.keyboard.press("Escape");
        assert.equal(await page.locator(".header-more-button").evaluate((button) => document.activeElement === button), true, "dismissal returns the prior keyboard focus");
        await workspace.focus();
        await page.keyboard.press("Shift+F10");
        await menu.waitFor();
        assert.deepEqual(await menu.getByRole("menuitem").allTextContents(), ["Pin workspace", "Rename workspace", "Close workspace", "New worktree", "Open worktree…"], "the context-menu key and right-click have identical items");
        await page.keyboard.press("Escape");
        const pins = () => page.evaluate(() => JSON.parse(localStorage.getItem("herdr-web-ui:sidebar-agent-pins") ?? "[]") as string[]);
        // a pinned workspace leaves its place for a card at the top of its PC's list, and returns unpinned
        const workspaceTitles = () => page.locator(".machine-workspaces .workspace-name").allTextContents();
        const herdrOrder = await workspaceTitles();
        const infraWorkspace = page.locator(`.workspace-select[data-pane="${panes.infra}"]`);
        await infraWorkspace.click({ button: "right" });
        const infraMenu = page.getByRole("menu");
        await infraMenu.getByRole("menuitem", { name: "Pin workspace", exact: true }).click();
        const pinnedWorkspaces = page.getByRole("list", { name: "Pinned", exact: true }).filter({ has: page.locator(".workspace-group") });
        await pinnedWorkspaces.waitFor();
        const infraName = await infraWorkspace.locator(".workspace-name").textContent();
        assert.deepEqual(await pinnedWorkspaces.locator(".workspace-name").allTextContents(), [infraName], "the pinned workspace stands in the card");
        assert.deepEqual(await workspaceTitles(), [infraName, ...herdrOrder.filter((title) => title !== infraName)], "the rest keep herdr's order");
        assert.equal(await pinnedWorkspaces.locator(".sidebar-pin-mark").count(), 1, "a pinned workspace carries its pin");
        assert.equal(await infraWorkspace.getAttribute("draggable"), "false", "a pinned workspace is not dragged");
        assert.ok((await pins()).includes(`local:workspace:${await infraWorkspace.evaluate((row) => row.closest(".workspace-group")?.getAttribute("data-workspace"))}`), "the pin is saved with the agents'");
        await infraWorkspace.click({ button: "right" });
        await infraMenu.getByRole("menuitem", { name: "Unpin workspace", exact: true }).click();
        await pinnedWorkspaces.waitFor({ state: "detached" });
        assert.deepEqual(await workspaceTitles(), herdrOrder, "unpinned, it returns to herdr's order");
        const agentRow = agent(page, API);
        const agentSelect = agentRow.locator(".agent-select");
        // pin an agent that is not first from its right-click menu: it moves to the top, and nothing is selected
        const infraSelect = agent(page, INFRA).locator(".agent-select");
        await page.locator(".header-more-button").focus();
        await infraSelect.click({ button: "right" });
        const agentMenu = page.getByRole("menu", { name: INFRA, exact: true });
        await agentMenu.waitFor();
        assert.deepEqual(await agentMenu.getByRole("menuitem").allTextContents(), ["Pin agent"], "an agent's right-click menu offers its pin");
        await agentMenu.getByRole("menuitem", { name: "Pin agent" }).click();
        await page.waitForFunction((key) => JSON.parse(localStorage.getItem("herdr-web-ui:sidebar-agent-pins") ?? "[]").includes(key), `local:${panes.infra}`);
        assert.deepEqual(await agentTitles(page), [INFRA, ...AGENTS_HERDR_ORDER.filter((title) => title !== INFRA)], "a pinned agent moves to the top, the rest keep herdr's order");
        assert.equal(await page.evaluate(() => sessionStorage.getItem("herdr-web-ui:selection")), selected, "pinning does not select the agent");
        assert.equal(await page.locator(".header-more-button").evaluate((button) => document.activeElement === button), true, "the menu hands focus back where it was");
        await page.reload();
        await page.locator(".conn-live").waitFor({ state: "attached" });
        await agents(page).first().waitFor({ state: "attached" });
        assert.equal((await agentTitles(page))[0], INFRA, "the pin survives a reload");
        // the keyboard's context-menu key opens the same menu, now with Unpin
        await infraSelect.focus();
        await page.keyboard.press("Shift+F10");
        await agentMenu.waitFor();
        assert.deepEqual(await agentMenu.getByRole("menuitem").allTextContents(), ["Unpin agent"], "a pinned agent's menu offers Unpin");
        // the menu focuses its first item on the next frame: Enter goes to it once it has the focus
        await page.waitForFunction(() => document.activeElement?.textContent === "Unpin agent", undefined, { timeout: 5_000 });
        await page.keyboard.press("Enter");
        await page.waitForFunction(() => JSON.parse(localStorage.getItem("herdr-web-ui:sidebar-agent-pins") ?? "[]").length === 0);
        assert.deepEqual(await pins(), []);
        assert.deepEqual(await agentTitles(page), AGENTS_HERDR_ORDER, "unpin restores the source order");
        assert.equal(await infraSelect.evaluate((button) => document.activeElement === button), true, "focus returns to the row as it moves back");
        assert.equal(await page.locator(".row-menu, .row-sheet").count(), 0, "the menu closes after its item runs");
        // pinned, an agent stands first with a pin, in a list named Pinned under the Agents head alone
        await agentSelect.click({ button: "right" });
        const apiMenu = page.getByRole("menu", { name: API, exact: true });
        await apiMenu.waitFor();
        await apiMenu.getByRole("menuitem", { name: "Pin agent" }).click();
        await page.waitForFunction((key) => JSON.parse(localStorage.getItem("herdr-web-ui:sidebar-agent-pins") ?? "[]").includes(key), `local:${panes.api}`);
        assert.equal(await page.getByRole("list", { name: "Pinned", exact: true }).count(), 1, "the pinned list is named Pinned");
        assert.deepEqual(await page.locator(".agents-sidebar .agent-list-pinned .agent-title").allTextContents(), [API], "the pinned list holds the pinned agent");
        assert.equal(await agent(page, API).locator(".sidebar-pin-mark").count(), 1, "a pinned row carries its pin");
        assert.equal(await page.locator(".agents-sidebar .sidebar-pin-mark").count(), 1, "an unpinned row carries none");
        await agentSelect.click({ button: "right" });
        await apiMenu.getByRole("menuitem", { name: "Unpin agent" }).click();
        await page.waitForFunction(() => JSON.parse(localStorage.getItem("herdr-web-ui:sidebar-agent-pins") ?? "[]").length === 0);
        assert.equal(await page.locator(".agents-sidebar .agent-list-pinned, .agents-sidebar .sidebar-pin-mark").count(), 0, "the pinned list goes with the last pin");
        assert.deepEqual(await agentTitles(page), AGENTS_HERDR_ORDER);
        console.log("PASS workspace right-click scope, pointer anchor and focus; the context-menu key opens the same menu; a workspace pins into a card and returns to herdr's order; an agent pins and unpins from its right-click menu and the key, marked with a pin");
        await waitStatus(page, API, "done");
        assert.deepEqual(await agentTitles(page), AGENTS_HERDR_ORDER, "a finish does not move an agent");
        await agentSelect.click();
        await page.waitForFunction((paneId) => JSON.parse(sessionStorage.getItem("herdr-web-ui:selection") ?? "{}").pane_id === paneId, panes.api, { timeout: 5_000 });
        assert.equal(await agentSelect.getAttribute("aria-current"), "true", "ordinary click still selects the agent");
        assert.equal(await page.locator(".row-menu, .row-sheet").count(), 0, "selecting the agent does not open a menu");
        assert.equal(await agentStatus(page, API), "done", "herdr's DONE stands until herdr itself shows the pane");
      });
      console.log("PASS the Agents list keeps herdr's order through a finish, and an opened DONE keeps its dot");

      await withPage(browser, {}, async (page) => {
        const drawerToggle = page.locator('button[aria-controls="workspace-drawer"]');
        await drawerToggle.tap();
        const agentToggle = page.locator(".agents-sidebar .agent-section-toggle");
        assert.equal(await agentToggle.getAttribute("aria-expanded"), "false", "the phone's Agents section still starts folded");
        await agentToggle.tap();
        const agentRow = agent(page, API);
        const agentSelect = agentRow.locator(".agent-select");
        await agentSelect.waitFor();
        // the ⋯ shows on touch, where a long press opens no menu: its sheet pins the agent
        const more = agentRow.getByRole("button", { name: `More for ${API}`, exact: true });
        assert.ok(await more.isVisible(), "the ⋯ is visible on touch");
        await more.tap();
        const sheet = page.getByRole("dialog", { name: API, exact: true });
        await sheet.waitFor();
        await sheet.getByRole("button", { name: "Pin agent" }).tap();
        await page.waitForFunction((key) => JSON.parse(localStorage.getItem("herdr-web-ui:sidebar-agent-pins") ?? "[]").includes(key), `local:${panes.api}`);
        await sheet.waitFor({ state: "detached" });
        assert.equal(await agentRow.locator(".sidebar-pin-mark").count(), 1, "the pinned row carries its pin");
        await agentSelect.tap();
        await page.waitForFunction((paneId) => JSON.parse(sessionStorage.getItem("herdr-web-ui:selection") ?? "{}").pane_id === paneId, panes.api, { timeout: 5_000 });
        assert.equal(await agentSelect.getAttribute("aria-current"), "true", "a tap still selects the agent");
        assert.equal(await page.locator(".row-menu, .row-sheet").count(), 0, "a tap opens no agent action sheet");
        assert.equal(await drawerToggle.getAttribute("aria-expanded"), "false", "selecting an agent closes the phone drawer");
      }, true);
      console.log("PASS on a phone the ⋯ pins an agent from its sheet; a tap on the row selects it and opens no menu");

      await withPage(browser, { agentOrder: "activity" }, async (page) => {
        assert.equal((await agentTitles(page))[0], WEB, "the blocked agent is pinned on top");
        assert.match(await agent(page, WEB).locator(".agent-context").textContent() ?? "", /web-dashboard/, "a row names its workspace");

        // the demo's Claude pane finishes out of sight: it rises under the blocked one, and keeps its dot
        await waitStatus(page, API, "done");
        await waitAgentAt(page, 1, API);

        // a message sent from an agent takes it to the top while it runs ...
        await agent(page, INFRA).locator(".agent-select").click();
        await page.locator(".composer-text").fill("Check the backup again");
        await page.locator(".composer-text").press("Enter");
        await waitStatus(page, INFRA, "working");
        await waitAgentAt(page, 1, INFRA);
        // ... and keeps it there when it finishes while another pane is open, with its dot
        await page.locator(".machine-workspaces .workspace-select", { hasText: "release" }).first().click();
        await waitStatus(page, INFRA, "done");
        assert.equal((await agentTitles(page))[1], INFRA, "the agent just worked in stays on top after it finishes");

        // opening it here leaves herdr's DONE as it is
        await agent(page, INFRA).locator(".agent-select").click();
        await page.waitForFunction((paneId) => JSON.parse(sessionStorage.getItem("herdr-web-ui:selection") ?? "{}").pane_id === paneId, panes.infra, { timeout: 5_000 });
        assert.equal(await agentStatus(page, INFRA), "done", "an opened DONE keeps its dot");
      });
      console.log("PASS Activity pins blocked and follows recency; an opened DONE keeps its dot");

      // the demo keeps its agent template after its last agent closes (#529 review): a workspace
      // made in an emptied demo still lists its agent with herdr's counter
      await withPage(browser, { agentOrder: "activity" }, async (page) => {
        const made = await page.evaluate(async () => {
          const post = (path: string, body: object) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
          const session = async () => (await (await fetch("/api/session")).json()).snapshot as { workspaces: { workspace_id: string }[]; agents: { pane_id: string; state_change_seq?: number }[] };
          for (const { workspace_id } of (await session()).workspaces) await post("/api/workspace/close", { workspace_id, close_group: true });
          const created = await (await post("/api/workspace/create", { cwd: "/home/demo/fresh", agent: { kind: "claude" } })).json() as { pane_id: string };
          return { created: created.pane_id, agents: (await session()).agents };
        });
        const entry = made.agents.find((candidate) => candidate.pane_id === made.created);
        assert.ok(entry && Number.isSafeInteger(entry.state_change_seq), `the new agent carries a counter: ${JSON.stringify(made)}`);
        await agent(page, "fresh").waitFor();
      });
      console.log("PASS a workspace made after the demo's last agent closed is listed with herdr's counter");
    } finally {
      await browser.close();
    }
  } finally {
    server.stop(true);
  }
} finally {
  rmSync(app, { recursive: true, force: true });
}
