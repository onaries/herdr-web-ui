/**
 * The session list and Resume (#1314) over a fictional bridge, in the real React components: the
 * workspace menu's item, newest-first rows, one tab/create per Resume however often the button is
 * clicked (the body carries the row's argv), no second Resume in the window before herdr reports the
 * resumed pane's session (App's RecentResume record), a session a pane already shows selected instead of
 * started, a row without a verified resume listed with no button, the keyboard along the rows,
 * and a PC whose bridge answers 404 for the route, whose menu has no item. No herdr pane is
 * touched; every request stays on this loopback server.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import type { SessionHistoryResponse, TabCreated } from "../shared/protocol.ts";
import type {} from "./session-history-fixture.tsx";
import { OLDER_SESSION, SESSION_ROWS } from "./session-history-fixture-data.ts";
import { chromePath } from "./chrome-path.ts";
import { contextMenuKey } from "./context-menu-key.ts";
const repo = join(import.meta.dir, "..");
const root = mkdtempSync(join(tmpdir(), "herdr-session-history-browser-"));
const evidence = join(process.env.UI_EVIDENCE_DIR || join(repo, "evidence"), "session-history");
mkdirSync(evidence, { recursive: true });
let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
/** every POST tab/create body the page sent, in order */
const tabCreates: Array<Record<string, unknown>> = [];
let holdTabCreate = false;
const releases: Array<() => void> = [];
const probes: string[] = [];
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const refusal = (code: string, message: string, status: number) => json({ error: { code, message } }, status);
/** every bounded animation (the sheet's rise) over, then two frames; a looping one (a breathing status dot) never finishes and is not waited for */
const settled = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations().filter((animation) => animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => undefined))).then(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))));
try {
  const build = await Bun.build({ entrypoints: ["scripts/session-history-fixture.tsx"], outdir: root, target: "browser", define: { "process.env.NODE_ENV": '"development"' } });
  assert.ok(build.success, String(build.logs));
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/ws") return new Response(null, { status: 404 });
    if (path === "/api/connection-diagnostics") return new Response(null, { status: 204 });
    // another PC's bridge, from before the route: the local server passes its not_found through
    if (path.startsWith("/api/machines/old-pc/")) {
      if (path.endsWith("/sessions/history")) probes.push(url.search);
      return refusal("not_found", `unknown endpoint ${path}`, 404);
    }
    if (path === "/api/sessions/history") {
      if (!url.searchParams.get("workspace_id")) return refusal("missing_workspace_id", "workspace_id is required", 400);
      const agent = url.searchParams.get("agent") ?? "";
      const workspaceId = url.searchParams.get("workspace_id")!;
      const answer: SessionHistoryResponse = { workspace_id: workspaceId, agent: agent as SessionHistoryResponse["agent"], cwd: `/fixture/${workspaceId}`, sessions: agent === "codex" ? SESSION_ROWS : [] };
      return json(answer);
    }
    if (path === "/api/agents") return json({ agents: [{ kind: "codex", label: "Codex", installed: true }, { kind: "claude", label: "Claude Code", installed: true }] });
    if (path === "/api/worktree/list") return refusal("not_a_repository", "no git repository here", 409);
    if (path === "/api/tab/create") {
      const body = await request.json() as Record<string, unknown>;
      tabCreates.push(body);
      if (holdTabCreate) await new Promise<void>((resolve) => releases.push(resolve));
      return json({ workspace_id: String(body["workspace_id"]), pane_id: `p-new-${tabCreates.length}`, agent_started: true } satisfies TabCreated);
    }
    if (path.startsWith("/api/")) return refusal("not_found", `unknown endpoint ${path}`, 404);
    if (path === "/") return new Response('<html><head><link rel="stylesheet" href="/session-history-fixture.css"></head><body><div id="root"></div><script type="module" src="/session-history-fixture.js"></script></body></html>', { headers: { "Content-Type": "text/html" } });
    const file = Bun.file(join(root, path.slice(1)));
    return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
  } });
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => { errors.push(error.message); console.error(error.stack); });
  await page.goto(`http://127.0.0.1:${server.port}/`);
  const row = (workspaceId: string) => page.locator(`.workspace-group[data-workspace="${workspaceId}"] .workspace-select`);
  await row("w1").waitFor();
  const openMenu = async (workspaceId: string) => {
    await row(workspaceId).click({ button: "right" });
    const menu = page.getByRole("menu");
    await menu.waitFor();
    return menu;
  };
  const dialog = page.getByRole("dialog", { name: /^Earlier sessions/ });
  const openHistory = async (workspaceId: string) => {
    const menu = await openMenu(workspaceId);
    await menu.getByRole("menuitem", { name: "Earlier sessions…", exact: true }).click();
    await dialog.waitFor();
    await dialog.locator(".session-row").first().waitFor();
    await settled(page);
  };
  // the workspace menu lists the item beside Rename workspace, and it opens the folder's sessions newest first
  const menu = await openMenu("w1");
  assert.deepEqual(await menu.getByRole("menuitem").allTextContents(), ["Pin workspace", "Rename workspace", "Earlier sessions…", "Close workspace"]);
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  await openHistory("w1");
  assert.equal(await dialog.locator(".session-agent select").inputValue(), "codex", "the row's agent is listed first");
  assert.deepEqual(await dialog.locator(".session-title").allTextContents(), ["Retry budget for the payment client", "Flaky export test", "A session whose resume syntax is not verified."], "newest first; a row without a title shows its first prompt");
  assert.equal(await dialog.getByRole("button", { name: /^Resume / }).count(), 2, "a row without a verified resume has no Resume button");
  assert.equal(await dialog.locator(".session-row").nth(2).locator("button").count(), 0);
  await page.screenshot({ path: join(evidence, "happy-list.png") });
  console.log("PASS workspace menu item, newest-first rows, no button without a verified resume");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  // the keyboard alone: the row's context-menu key, the item, the first row's button focused, arrows
  // along the rows, Tab inside, Escape closing with the focus back on the row
  await row("w1").focus();
  await contextMenuKey(page);
  const keyMenu = page.getByRole("menu");
  await keyMenu.waitFor();
  await keyMenu.getByRole("menuitem", { name: "Earlier sessions…", exact: true }).focus();
  await page.keyboard.press("Enter");
  await dialog.waitFor();
  await dialog.locator(".session-row").first().waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Resume Retry budget for the payment client");
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Resume Flaky export test");
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Resume Flaky export test", "the last row holds the focus");
  await page.keyboard.press("ArrowUp");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Resume Retry budget for the payment client");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Resume Flaky export test");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  await page.waitForFunction(() => document.activeElement?.closest('.workspace-group[data-workspace="w1"]') !== null);
  console.log("PASS arrows move along the rows, Tab stays inside, Escape closes and the focus returns to the row");
  // Resume the older one: exactly one tab/create however often the button is clicked while it is in flight
  await openHistory("w1");
  // the roster lags the answer, as it does until load() brings the new pane: the next scenario needs that window
  await page.evaluate(() => { window.qa.holdRoster = true; });
  holdTabCreate = true;
  const resume = dialog.getByRole("button", { name: "Resume Flaky export test", exact: true });
  await resume.dblclick();
  await page.waitForFunction(() => document.querySelector(".session-row.is-pending") !== null);
  await resume.click({ force: true }).catch(() => undefined);
  await page.getByRole("status").filter({ hasText: "Resuming…" }).waitFor();
  assert.equal(await dialog.getByRole("button", { name: /^Resume / }).evaluateAll((buttons) => buttons.every((button) => (button as HTMLButtonElement).disabled)), true, "every Resume is disabled while one is in flight");
  await settled(page);
  await page.screenshot({ path: join(evidence, "happy-pending.png") });
  assert.equal(tabCreates.length, 1, `a double click sends one tab/create, not ${tabCreates.length}`);
  assert.deepEqual(tabCreates[0], { workspace_id: "w1", cwd: "/fixture/w1", label: null, agent: { kind: "codex", args: ["resume", OLDER_SESSION] } });
  holdTabCreate = false;
  releases.splice(0).forEach((release) => release());
  await dialog.waitFor({ state: "detached" });
  await page.waitForFunction(() => window.qa.resumed.length === 1);
  assert.deepEqual(await page.evaluate(() => window.qa.resumed), [{ workspace_id: "w1", pane_id: "p-new-1", agent_started: true }]);
  assert.equal(tabCreates.length, 1, "nothing more was sent once the first answer came");
  console.log("PASS Resume sends one tab/create with the row's argv; a double click sends no second one");
  // the reopen window (T31-AV-1): the list opened again before herdr has reported the new pane's session, even
  // before the roster lists the pane, offers no second Resume; once the pane is listed, Open selects it, and once
  // herdr reports the session the pane's own report says it; the pane closed, the session can be resumed again
  await openHistory("w1");
  const older = dialog.locator(".session-row").nth(1);
  await older.locator(".pill", { hasText: "Already open" }).waitFor();
  assert.equal(await older.getByRole("button", { name: /^Resume / }).count(), 0, "no second Resume while the record stands");
  assert.equal(await older.getByRole("button", { name: "Open the pane showing Flaky export test", exact: true }).isDisabled(), true, "nothing to open until the roster lists the new pane");
  assert.equal(await dialog.getByRole("button", { name: /^Resume / }).count(), 1, "the other row still offers Resume");
  await page.evaluate(() => { window.qa.holdRoster = false; window.qa.rosterCatchUp(); });
  await older.getByRole("button", { name: "Open the pane showing Flaky export test", exact: true, disabled: false }).waitFor();
  await settled(page);
  await page.screenshot({ path: join(evidence, "reopen-window.png") });
  await older.getByRole("button", { name: "Open the pane showing Flaky export test", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  await page.waitForFunction(() => window.qa.selected === "p-new-1");
  assert.equal(tabCreates.length, 1, "reopening the list and Open start nothing");
  await page.evaluate((id) => window.qa.reportSession("p-new-1", id), OLDER_SESSION);
  await openHistory("w1");
  await older.locator(".pill", { hasText: "Already open" }).waitFor();
  assert.equal(await older.getByRole("button", { name: /^Resume / }).count(), 0, "the pane's own report keeps Open");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  await page.evaluate(() => window.qa.closePane("p-new-1"));
  await openHistory("w1");
  await older.getByRole("button", { name: "Resume Flaky export test", exact: true }).waitFor();
  assert.equal(await older.locator(".pill").count(), 0, "a closed pane shows nothing: Resume is back");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  assert.equal(tabCreates.length, 1);
  console.log("PASS the list reopened before herdr reports the new pane's session offers Open, not Resume; Resume returns once the pane closes");
  // a session a pane of the workspace already shows: Open selects that pane, nothing is started
  await openHistory("w2");
  const shown = dialog.locator(".session-row").first();
  await shown.locator(".pill", { hasText: "Already open" }).waitFor();
  assert.equal(await shown.getByRole("button", { name: /^Resume / }).count(), 0);
  await page.screenshot({ path: join(evidence, "already-open.png") });
  await shown.getByRole("button", { name: "Open the pane showing Retry budget for the payment client", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  await page.waitForFunction(() => window.qa.selected === "p2");
  assert.equal(tabCreates.length, 1, "selecting the pane that shows the session creates no tab");
  console.log("PASS a session already shown by a pane is opened by selecting that pane");
  // another agent: its (empty) list, said in words
  await openHistory("w1");
  await dialog.locator(".session-agent select").selectOption("claude");
  await dialog.locator(".session-empty").waitFor();
  assert.equal(await dialog.locator(".session-empty").textContent(), "No earlier Claude Code sessions in this folder.");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  console.log("PASS the agent field lists another agent's sessions; an empty store is said in words");
  // a PC whose bridge is from before the route: asked once without listing anything, and the item stays away
  const probed = page.waitForResponse((response) => response.url().includes("/api/machines/old-pc/sessions/history"));
  await page.evaluate(() => window.qa.machine("old-pc"));
  await probed;
  await row("w1").waitFor();
  // StrictMode mounts the sidebar's effect twice in this development bundle: each probe is query-less
  assert.ok(probes.length >= 1 && probes.every((query) => query === ""), `the probe carries no workspace and lists no session: ${JSON.stringify(probes)}`);
  const remoteMenu = await openMenu("w1");
  assert.deepEqual(await remoteMenu.getByRole("menuitem").allTextContents(), ["Pin workspace", "Rename workspace", "Close workspace"], "no Earlier sessions on a PC whose bridge cannot list them");
  await settled(page);
  await page.screenshot({ path: join(evidence, "remote-404.png") });
  await page.keyboard.press("Escape");
  console.log("PASS a bridge answering 404 hides the menu item");
  // a device that only watches is refused the list on its own PC too: the menu does not offer it
  await page.evaluate(() => { window.qa.machine("local"); window.qa.watch(true); });
  await row("w1").waitFor();
  const watchMenu = await openMenu("w1");
  assert.ok(!(await watchMenu.getByRole("menuitem").allTextContents()).includes("Earlier sessions…"), "no Earlier sessions for a device that only watches");
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.qa.watch(false));
  console.log("PASS a device that only watches is not offered the list");
  writeFileSync(join(evidence, "request-log.txt"), [
    "POST /api/tab/create bodies, in order (the double click on Resume sent the one below):",
    ...tabCreates.map((body, index) => `${index + 1}. ${JSON.stringify(body)}`),
    `old-pc probes: ${JSON.stringify(probes)}`,
  ].join("\n") + "\n");
  assert.deepEqual(errors, []);
  console.log("PASS no browser errors");
} finally {
  releases.forEach((release) => release());
  await browser?.close();
  server?.stop(true);
  rmSync(root, { recursive: true, force: true });
}
