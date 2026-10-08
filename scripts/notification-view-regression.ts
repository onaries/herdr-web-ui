import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";

/** A tapped pane alert shows an agent pane's chat once: the lens the pane remembered stays its own, and a shell keeps its terminal. */
export async function checkNotificationView(browser: Browser, origin: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-alert-view-"));
  const workspaces: string[] = [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  try {
    const panes: string[] = [];
    for (const name of ["agent", "shell"]) {
      const cwd = join(root, name);
      mkdirSync(cwd);
      const created = await workspaceCreate({ cwd, label: `herdr-web-ui-test-alert-view-${name}` });
      workspaces.push(created.workspace.workspace_id);
      panes.push(created.root_pane.pane_id);
    }
    const [agent, shell] = panes as [string, string];
    await herdrRpc("pane.report_agent", { pane_id: agent, source: "manual", agent: "claude", state: "idle" });
    await context.addInitScript((pane) => {
      if (localStorage.getItem("herdr-web-ui:settings") !== null) return;
      localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" }));
      localStorage.setItem(`herdr-web-ui:view:${pane}`, "terminal"); // the agent pane remembered the terminal
    }, agent);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const saved = () => page.evaluate((pane) => localStorage.getItem(`herdr-web-ui:view:${pane}`), agent);
    /** the selected row and the lens drawn with it, both from the page: the stored selection is written before the render */
    const shows = (pane: string, lens: "Chat transcript" | "Live terminal") => page.waitForFunction(([id, title]) =>
      document.querySelector(".pane-select[aria-current='true']")?.getAttribute("title")?.startsWith(`${id} —`) === true
      && document.querySelector(".view-switch button[aria-pressed='true']")?.getAttribute("title")?.startsWith(title!) === true, [pane, lens]);
    /** what public/sw.js posts to an open window when a pane's alert is tapped */
    const tapAlert = (pane: string) => page.evaluate((id) => {
      navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data: { type: "select-pane", machine_id: "local", pane_id: id, view: "chat" } }));
    }, pane);
    const row = (pane: string) => page.locator(`.pane-select[title^="${pane} —"]`);

    // a closed app opens on the alert's address
    await page.goto(`${origin}/?pane=${encodeURIComponent(agent)}&view=chat`);
    await page.locator(".conn-live").waitFor();
    await shows(agent, "Chat transcript");
    assert.equal(await saved(), "terminal", "an alert does not replace the lens the pane remembered");
    assert.equal(await page.evaluate(() => window.location.search), "", "the alert's address is taken off once read");
    if (process.env.UI_EVIDENCE_DIR) {
      mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "notification-chat-one-shot.png") });
    }
    // picking the pane by hand ends the alert's turn: its own lens is back without a reload
    await row(agent).click();
    await shows(agent, "Live terminal");

    // an open window is told by the worker; a shell has no conversation, so its alert opens the terminal
    await tapAlert(shell);
    await shows(shell, "Live terminal");
    await tapAlert(agent);
    await shows(agent, "Chat transcript");
    assert.equal(await saved(), "terminal");
    await row(shell).click();
    await row(agent).click();
    await shows(agent, "Live terminal");
    assert.deepEqual(errors, []);
    console.log("PASS a tapped pane alert opens an agent's chat once, and a shell's terminal");
  } finally {
    await context.close();
    for (const workspace of workspaces) await workspaceClose(workspace).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}
