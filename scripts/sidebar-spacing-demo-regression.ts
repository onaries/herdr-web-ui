/**
 * Purpose: verify sidebar spacing when PC groups fold in a real browser.
 * Tags: sidebar, spacing, responsive, browser, regression.
 * Usage: bun scripts/sidebar-spacing-demo-regression.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";

const app = mkdtempSync(join(tmpdir(), "herdr-sidebar-spacing-demo-"));
const spacing = 16;

/**
 * Closes every demo workspace that runs an agent, through the demo's own API, so the Agents list
 * says "No agents running" while the shell workspace keeps the PC's own list in place.
 */
const closeAgentWorkspaces = (page: Page) => page.evaluate(async () => {
  for (let closed = 0; closed < 32; closed++) {
    const { snapshot } = await (await fetch("/api/session")).json() as { snapshot: { panes: Array<{ pane_id: string; workspace_id: string; agent: string | null }>; agents: Array<{ pane_id: string }> } };
    const agentPanes = new Set(snapshot.agents.map((agent) => agent.pane_id));
    const pane = snapshot.panes.find((candidate) => agentPanes.has(candidate.pane_id) || (candidate.agent ?? "").trim() !== "");
    if (!pane) return closed;
    const response = await fetch("/api/workspace/close", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspace_id: pane.workspace_id, close_group: true }) });
    if (!response.ok) throw new Error(`closing workspace ${pane.workspace_id} answered ${response.status}`);
  }
  throw new Error("the demo still lists an agent workspace after 32 closes");
});

let server: ReturnType<typeof Bun.serve> | undefined;
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, '<script src="./demo-transport.js"></script>\n    <script type="module"'));
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    const prefix = "/app/";
    if (!path.startsWith(prefix)) return new Response("not found", { status: 404 });
    let file = decodeURIComponent(path.slice(prefix.length));
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
  } });

  for (const [mobile, empty] of [[false, false], [true, false], [false, true], [true, true]] as const) {
    const label = `${mobile ? "390px" : "desktop"}${empty ? " with no agents" : ""}`;
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
    try {
      const context = await browser.newContext({
        viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
        isMobile: mobile,
        hasTouch: mobile,
        locale: "en-US",
      });
      await context.addInitScript(() => localStorage.removeItem("ovis:pc-collapsed:local"));
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${server.port}/app/`);
      await page.locator(".conn-live").waitFor({ state: "attached" });
      // before the drawer opens: the selection leaves with its workspace, and a new one closes the drawer
      if (empty) assert.ok(await closeAgentWorkspaces(page) > 0, `${label} closed the demo's agent workspaces`);
      if (mobile) await page.locator(".drawer-toggle").tap();
      const machineToggle = page.locator(".machine-toggle").first();
      const agentToggle = page.locator(".agents-sidebar .agent-section-toggle");
      await machineToggle.waitFor();
      if (empty) await page.locator(".agents-sidebar.is-empty .agent-empty").waitFor({ state: "attached" });
      if (await agentToggle.getAttribute("aria-expanded") !== "true") await agentToggle.click();
      const before = await page.locator(".agents-sidebar .agent-title").allTextContents();
      assert.equal(before.length > 0, !empty, `${label} ${empty ? "has no agent rows" : "has agent rows"} before folding`);
      assert.equal(await machineToggle.getAttribute("aria-expanded"), "true");

      await machineToggle.click();
      await page.waitForFunction(() => !document.querySelector(".machine-workspaces"));
      const metrics = await page.evaluate(() => {
        const box = (selector: string) => document.querySelector<HTMLElement>(selector)?.getBoundingClientRect();
        const shell = box(".sidebar-shell")!;
        const machine = box(".machine-group")!;
        const list = box(".machine-list")!;
        const agents = box(".agents-sidebar")!;
        const contents = document.querySelector<HTMLElement>(".agent-list-contents")!;
        const footer = box(".sidebar-footer")!;
        return {
          shellHeight: shell.height,
          machineBottom: machine.bottom,
          listBottom: list.bottom,
          agentsTop: agents.top,
          agentsHeight: agents.height,
          contentsOverflow: getComputedStyle(contents).overflowY,
          footerBottom: footer.bottom,
          shellBottom: shell.bottom,
        };
      });
      assert.ok(metrics.agentsTop - metrics.machineBottom <= spacing, `${label} folded PC gap is ${metrics.agentsTop - metrics.machineBottom}px`);
      assert.ok(metrics.listBottom - metrics.machineBottom <= spacing, `${label} folded list padding is ${metrics.listBottom - metrics.machineBottom}px`);
      assert.ok(metrics.agentsHeight <= metrics.shellHeight / 2 + 1, `${label} Agents keeps its half-sidebar cap`);
      assert.equal(metrics.contentsOverflow, "auto", `${label} Agents keeps scroll ownership`);
      assert.equal(Math.round(metrics.footerBottom), Math.round(metrics.shellBottom), `${label} footer stays at the bottom`);
      assert.deepEqual(await page.locator(".agents-sidebar .agent-title").allTextContents(), before, `${label} agent order is unchanged`);

      await agentToggle.click();
      assert.equal(await agentToggle.getAttribute("aria-expanded"), "false");
      assert.equal(await page.locator(".agent-list-contents").getAttribute("hidden"), "");
      console.log(`PASS ${label} sidebar spacing after folding the PC section`);
      await context.close();
    } finally {
      await browser.close();
    }
  }
} finally {
  server?.stop(true);
  rmSync(app, { recursive: true, force: true });
}
