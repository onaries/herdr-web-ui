import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { runMoreItem } from "./header-more.ts";

// Settings → Agents order (Activity) and Quiet opened finishes, on the unmodified app over the
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
const workspaceStatus = (page: Page, label: string) => page.locator(".machine-workspaces .workspace.pane-item", { has: page.locator(`.workspace-select:has-text("${label}")`) }).first().locator(".sidebar-status").first().getAttribute("data-status");
const waitStatus = (page: Page, title: string, status: string) => agent(page, title).locator(`.sidebar-status[data-status="${status}"]`).waitFor({ timeout: 10_000 });
const waitAgentAt = (page: Page, index: number, title: string) => page.waitForFunction(([at, name]) =>
  [...document.querySelectorAll(".agents-sidebar .agent-item .agent-title")][at as number]?.textContent === name, [index, title] as const, { timeout: 5_000 });

/**
 * `seen`: a record already in this browser, so first-use seeding does not run. Seeding counts what
 * is open at the first roster as opened, and a page slower than the demo's 4.5s self-finish would
 * count that finish too (#529 review): a record there already makes the run independent of load time.
 */
async function withPage(browser: Browser, settings: object, run: (page: Page) => Promise<void>, seen?: Record<string, number>, mobile = false): Promise<void> {
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    isMobile: mobile, hasTouch: mobile, locale: "en-US",
  });
  try {
    await context.addInitScript(([stored, record]) => {
      localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", defaultView: "chat", ...stored }));
      if (record && localStorage.getItem("herdr-web-ui:seen:local") === null) localStorage.setItem("herdr-web-ui:seen:local", JSON.stringify(record));
    }, [settings, seen] as const);
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
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
    try {
      // Workspace menus no longer mix in pane operations; header More keeps pane movement.
      await withPage(browser, {}, async (page) => {
        await runMoreItem(page, "Move pane to…");
        const move = page.getByRole("menu", { name: /^Move .* to$/ });
        await move.waitFor();
        assert.equal(await move.getByRole("menuitem", { name: "New tab", exact: true }).count(), 1);
        const previousTab = await page.locator('.tab-strip-tab[aria-selected="true"]').getAttribute("data-tab-id");
        await move.getByRole("menuitem", { name: "New tab", exact: true }).click();
        await page.waitForFunction((previous) => {
          const active = document.querySelector('.tab-strip-tab[aria-selected="true"]');
          return active !== null && active.getAttribute("data-tab-id") !== previous;
        }, previousTab);
        assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem("herdr-web-ui:selection") ?? "{}").pane_id), panes.shell, "header More moves the selected pane");
        const movedTab = await page.evaluate(async (paneId) => {
          const { snapshot } = await (await fetch("/api/session")).json();
          return snapshot.panes.find((pane: { pane_id: string }) => pane.pane_id === paneId)?.tab_id;
        }, panes.shell);
        assert.equal(await page.locator('.tab-strip-tab[aria-selected="true"]').getAttribute("data-tab-id"), movedTab);
        // A stale menu must disappear if another client closes its target.
        await runMoreItem(page, "Move pane to…");
        await move.waitFor();
        await page.evaluate(async (paneId) => {
          const response = await fetch("/api/pane/close", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pane_id: paneId }) });
          if (!response.ok) throw new Error(`Close fixture failed: ${response.status}`);
        }, panes.shell);
        await move.waitFor({ state: "detached" });
      });
      console.log("PASS header More moves the selected pane and closes stale targets");

      // Default: herdr's order before and after a finish, and an opened DONE keeps herdr's dot
      await withPage(browser, {}, async (page) => {
        const selected = await page.evaluate(() => sessionStorage.getItem("herdr-web-ui:selection"));
        await page.locator(".header-more-button").focus();
        const workspace = page.locator(`.workspace-select[data-pane="${panes.api}"]`);
        const bounds = (await workspace.boundingBox())!;
        await workspace.click({ button: "right", position: { x: 32, y: bounds.height / 2 } });
        const menu = page.getByRole("menu", { name: "checkout-api", exact: true });
        await menu.waitFor();
        assert.deepEqual(await menu.getByRole("menuitem").allTextContents(), ["Rename workspace", "Close workspace", "New worktree", "Open worktree…"], "right-click uses native workspace scope");
        const opened = (await menu.boundingBox())!;
        assert.ok(Math.abs(opened.x - bounds.x - 32) <= 1 && Math.abs(opened.y - bounds.y - bounds.height / 2) <= 1, "the menu opens at the pointer");
        assert.equal(await page.evaluate(() => sessionStorage.getItem("herdr-web-ui:selection")), selected, "right-click leaves the selected pane alone");
        await page.keyboard.press("Escape");
        assert.equal(await page.locator(".header-more-button").evaluate((button) => document.activeElement === button), true, "dismissal returns the prior keyboard focus");
        await workspace.locator("..").locator(".row-menu-toggle").click();
        await menu.waitFor();
        assert.deepEqual(await menu.getByRole("menuitem").allTextContents(), ["Rename workspace", "Close workspace", "New worktree", "Open worktree…"], "the ⋯ button and right-click have identical items");
        await page.keyboard.press("Escape");
        const agentRow = agent(page, API);
        const agentSelect = agentRow.locator(".agent-select");
        await agentRow.hover();
        assert.equal(await agentRow.getByRole("button").count(), 1, "hover leaves only the agent selection button");
        assert.equal(await agentRow.locator('.agent-actions, .row-menu-toggle, [aria-haspopup="menu"]').count(), 0, "hover exposes no agent menu trigger");
        await agentSelect.focus();
        assert.equal(await agentRow.getByRole("button").count(), 1, "keyboard focus exposes no agent menu trigger");
        await page.keyboard.press("Shift+F10");
        assert.equal(await page.locator(".row-menu, .row-sheet").count(), 0, "the agent has no keyboard context menu");
        await page.keyboard.press("Escape");
        await agentSelect.click({ button: "right" });
        assert.equal(await page.locator(".row-menu, .row-sheet").count(), 0, "agent right-click has no custom menu");
        assert.equal(await page.evaluate(() => sessionStorage.getItem("herdr-web-ui:selection")), selected, "agent right-click does not select the agent");
        await page.keyboard.press("Escape");
        console.log("PASS workspace right-click scope, pointer anchor and focus; matching ⋯ menu and existing sidebar layout retained");
        assert.deepEqual(await agentTitles(page), AGENTS_HERDR_ORDER);
        await waitStatus(page, API, "done");
        assert.deepEqual(await agentTitles(page), AGENTS_HERDR_ORDER, "a finish does not move an agent");
        await agentSelect.click();
        await page.waitForFunction((paneId) => JSON.parse(sessionStorage.getItem("herdr-web-ui:selection") ?? "{}").pane_id === paneId, panes.api, { timeout: 5_000 });
        assert.equal(await agentSelect.getAttribute("aria-current"), "true", "ordinary click still selects the agent");
        assert.equal(await page.locator(".row-menu, .row-sheet").count(), 0, "selecting the agent does not open a menu");
        assert.equal(await agentStatus(page, API), "done", "herdr's DONE stands until herdr itself shows the pane");
      });
      console.log("PASS by default the Agents list keeps herdr's order, and an opened DONE keeps its dot");

      await withPage(browser, {}, async (page) => {
        const drawerToggle = page.locator('button[aria-controls="workspace-drawer"]');
        await drawerToggle.tap();
        const agentToggle = page.locator(".agents-sidebar .agent-section-toggle");
        assert.equal(await agentToggle.getAttribute("aria-expanded"), "false", "the phone's Agents section still starts folded");
        await agentToggle.tap();
        const agentRow = agent(page, API);
        const agentSelect = agentRow.locator(".agent-select");
        await agentSelect.waitFor();
        assert.equal(await agentRow.getByRole("button").count(), 1, "touch rows have only an agent selection button");
        assert.equal(await agents(page).locator('.agent-actions, .row-menu-toggle, [aria-haspopup="menu"]').count(), 0, "touch does not expose an agent menu trigger");
        await agentSelect.tap();
        await page.waitForFunction((paneId) => JSON.parse(sessionStorage.getItem("herdr-web-ui:selection") ?? "{}").pane_id === paneId, panes.api, { timeout: 5_000 });
        assert.equal(await agentSelect.getAttribute("aria-current"), "true", "a tap still selects the agent");
        assert.equal(await page.locator(".row-menu, .row-sheet").count(), 0, "a tap opens no agent action sheet");
        assert.equal(await drawerToggle.getAttribute("aria-expanded"), "false", "selecting an agent closes the phone drawer");
      }, undefined, true);
      console.log("PASS Agents has no hover, focus, right-click or touch menu; click and tap still select");

      await withPage(browser, { agentOrder: "activity", quietOpenedDone: true }, async (page) => {
        assert.equal((await agentTitles(page))[0], WEB, "the blocked agent is pinned on top");

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

        // opening it quiets its DONE in both lists; one never opened keeps its dot
        await agent(page, INFRA).locator(".agent-select").click();
        await waitStatus(page, INFRA, "idle");
        assert.equal(await workspaceStatus(page, "infra"), "idle", "its workspace row reads ready too");
        assert.equal(await agentStatus(page, API), "done", "a finish never opened keeps its dot");
        // the run starts from an empty record: the opened finish is in it at herdr's counter for that
        // finish (a look made at a stand-in is saved once a roster read brings the counter), the
        // unopened one is not
        const finishSeq = await page.evaluate(async (paneId) => {
          const { snapshot } = await (await fetch("/api/session")).json() as { snapshot: { agents: { pane_id: string; state_change_seq?: number }[] } };
          return snapshot.agents.find((entry) => entry.pane_id === paneId)?.state_change_seq;
        }, panes.infra);
        assert.ok(Number.isSafeInteger(finishSeq), `the finished agent carries a counter: ${finishSeq}`);
        await page.waitForFunction(([paneId, seq]) => (JSON.parse(localStorage.getItem("herdr-web-ui:seen:local") ?? "{}") as Record<string, number>)[paneId] === seq,
          [panes.infra, finishSeq!] as const, { timeout: 10_000 });
        const record = JSON.parse(await page.evaluate(() => localStorage.getItem("herdr-web-ui:seen:local") ?? "{}")) as Record<string, number>;
        assert.equal(record[panes.api], undefined, `the unopened finish is not recorded: ${JSON.stringify(record)}`);

        // a finish watched on screen stays quiet after another pane is opened before the roster
        // read brings herdr's counter for it (#529 review): the look follows the counter. Roster
        // reads are held for that window, so the statuses come by push alone, as they do between reads
        await page.evaluate(() => {
          const page = window as unknown as { holdRoster: boolean; releaseRoster: () => void };
          const inner = window.fetch.bind(window);
          const waiting: Array<() => void> = [];
          page.holdRoster = true;
          page.releaseRoster = () => { page.holdRoster = false; for (const resume of waiting.splice(0)) resume(); };
          window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            if (page.holdRoster && /\/api\/(machines|session)\b/.test(target)) await new Promise<void>((resume) => waiting.push(resume));
            return inner(input, init);
          }) as typeof fetch;
        });
        await page.locator(".composer-text").fill("And once more");
        await page.locator(".composer-text").press("Enter");
        await waitStatus(page, INFRA, "working");
        await waitStatus(page, INFRA, "idle");
        await page.locator(".machine-workspaces .workspace-select", { hasText: "release" }).first().click();
        // the held reads go through, and a visibility change asks for one more: herdr's counter arrives
        await page.evaluate(() => {
          (window as unknown as { releaseRoster: () => void }).releaseRoster();
          document.dispatchEvent(new Event("visibilitychange"));
        });
        for (const deadline = Date.now() + 2_000; Date.now() < deadline;) {
          assert.equal(await agentStatus(page, INFRA), "idle", "a finish watched on screen does not get its dot back");
          await page.waitForTimeout(100);
        }
      }, {});
      console.log("PASS Activity pins blocked and follows recency; an opened DONE reads as ready in both lists, an unopened one keeps its dot");

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
