import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { herdrRpc, paneClose, paneFocus, paneSplit, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";

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
    const tapAlert = (pane: string, workspace?: string) => page.evaluate(([id, ws]) => {
      navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data: { type: "select-pane", machine_id: "local", pane_id: id, view: "chat", ...(ws ? { workspace_id: ws } : {}) } }));
    }, [pane, workspace] as const);
    const row = (pane: string) => page.locator(`.pane-select[title^="${pane} —"]`);

    // a closed app opens on the alert's address
    await page.goto(`${origin}/?pane=${encodeURIComponent(agent)}&view=chat`);
    await page.locator(".conn-live").waitFor();
    await shows(agent, "Chat transcript");
    assert.equal(await saved(), "terminal", "an alert does not replace the lens the pane remembered");
    // the address is a deep link like any other (lib/deepLink.ts): it names the pane and the lens shown
    await page.waitForFunction((id) => { const query = new URLSearchParams(window.location.search); return query.get("pane") === id && query.get("view") === "chat"; }, agent);
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

    // An ended pane's alert, which the worker names twice (before and after focus), while the
    // app still asks herdr whether the pane is gone: the second delivery must not strand the
    // first's lookup. The alert names the workspace the pane was in, so that workspace opens.
    await row(shell).click();
    await shows(shell, "Live terminal");
    let asked!: () => void;
    const lookup = new Promise<void>((resolve) => { asked = resolve; });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/session", async (route) => { asked(); await released; await route.continue(); });
    try {
      const ended = `${agent}-ended`;
      await tapAlert(ended, workspaces[0]);
      // a tap that no longer reads the session fails here instead of holding the lane
      let unasked: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([lookup, new Promise<never>((_, reject) => { unasked = setTimeout(() => reject(new Error("ended-pane tap never read /api/session")), 4000); })])
        .finally(() => clearTimeout(unasked));
      await tapAlert(ended, workspaces[0]);
      release();
      await page.locator(".context-title-text", { hasText: "That agent has closed: its workspace is open" }).waitFor({ timeout: 4000 });
    } finally {
      release();
      await page.unroute("**/api/session");
    }
    await page.waitForFunction((id) => document.querySelector(".pane-select[aria-current='true']")?.getAttribute("title")?.startsWith(`${id} —`) === true, agent);

    // A phone resumed from the background still lists the pane its alert names, so the tap
    // selects it at once; the pane is gone by the next roster. The alert's workspace still
    // decides where the app goes then, not herdr's focus in another workspace.
    const sibling = (await paneSplit(agent, "right", false)).pane_id;
    await paneFocus(shell);
    await row(shell).click();
    await shows(shell, "Live terminal");
    await tapAlert(agent, workspaces[0]);
    await shows(agent, "Chat transcript");
    await paneClose(agent);
    // a shell beside an agent has no sidebar row of its own: its frame is the one shown as current
    await page.locator(`.pane-frame.is-current[data-layout-pane="${sibling}"]`).waitFor({ timeout: 8000 });
    await page.locator(".context-title-text", { hasText: "That agent has closed: its workspace is open" }).waitFor({ timeout: 4000 });
    assert.deepEqual(errors, []);
    console.log("PASS a tapped pane alert opens an agent's chat once, and a shell's terminal; an ended pane's alert, delivered twice or tapped while still listed, opens its workspace");
  } finally {
    await context.close();
    for (const workspace of workspaces) await workspaceClose(workspace).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}
