import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";

// All PCs deliberately reuse every herdr ID. Only this disposable demo fixture rewrites its
// roster; the app and its bound APIs are the production client. No live session is read.
const app = mkdtempSync(join(tmpdir(), "herdr-palette-machines-"));
const patch = `(() => {
  const fetchDemo = window.fetch.bind(window), EventSourceDemo = window.EventSource;
  const calls = window.paletteMachineCalls = { branches: [], plugins: [], focus: [], runs: [], closes: [] };
  let last = null, offline = false, missing = false;
  const sources = new Set();
  const json = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  const roster = (original) => ["local", "remote", "offline"].map((id) => {
    const machine = structuredClone(original.find((item) => item.id === "local"));
    machine.id = id; machine.kind = id === "local" ? "local" : "ssh";
    machine.name = id === "local" ? "Laptop" : id === "remote" ? "Build PC" : "Old PC";
    machine.state = id === "offline" || (id === "remote" && offline) ? "disconnected" : "connected";
    if (id === "remote") machine.snapshot.panes.find((pane) => pane.pane_id === ${JSON.stringify(panes.api)}).label = "Remote migration";
    const workspace = machine.snapshot.workspaces[0];
    workspace.worktree = { repo_key: "repo", repo_name: "project", repo_root: "/tmp/project", checkout_path: "/tmp/project/linked", is_linked_worktree: true };
    if (id === "remote" && missing) machine.snapshot.panes = machine.snapshot.panes.filter((pane) => pane.pane_id !== ${JSON.stringify(panes.api)});
    return machine;
  });
  window.setPaletteRemoteState = (gone, removed = false) => {
    offline = gone; missing = removed;
    for (const source of sources) source.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "machines", machines: roster(last) }) }));
  };
  window.EventSource = class extends EventTarget {
    constructor(url, options) {
      super(); this.inner = new EventSourceDemo(url, options); this.readyState = 1; sources.add(this);
      this.inner.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "machines") { last = message.machines; message.machines = roster(last); }
        this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(message) }));
      };
      this.inner.onerror = (event) => this.onerror?.(event);
      this.inner.onopen = (event) => this.onopen?.(event);
    }
    close() { sources.delete(this); this.inner.close(); this.readyState = 2; }
  };
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    if (url.pathname === "/api/machines") { const value = await (await fetchDemo(input, init)).json(); last = value.machines; return json({ machines: roster(last) }); }
    const match = url.pathname.match(/^\\/api\\/machines\\/([^/]+)(\\/.*)$/);
    const machine = match ? decodeURIComponent(match[1]) : "local";
    const path = match ? "/api" + match[2] : url.pathname;
    if (path === "/api/worktree/list") {
      calls.branches.push(machine);
      const id = url.searchParams.get("workspace_id");
      return json({ source: { repo_key: "repo", source_workspace_id: id }, worktrees: [{ path: "/tmp/project/linked", branch: machine === "remote" ? "feature/remote-branch" : "feature/local-branch", is_detached: false, open_workspace_id: id }] });
    }
    if (path === "/api/tab/close") { calls.closes.push({ machine, tab: JSON.parse(init.body).tab_id }); return json({ ok: true }); }
    if (path === "/api/plugins/actions") calls.plugins.push(machine);
    if (path === "/api/plugin/action" && init?.method === "POST") calls.runs.push(machine);
    if (path === "/api/pane/focus") { calls.focus.push({ machine, pane: JSON.parse(init.body).pane_id }); return json({ ok: true }); }
    if (match && path === "/api/session") return json({ snapshot: roster(last).find((item) => item.id === machine).snapshot });
    if (match) return fetchDemo(path + url.search, init);
    return fetchDemo(input, init);
  };
})();`;

try {
  await buildDemoApp(app);
  writeFileSync(join(app, "palette-machines.js"), patch);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, '<script src="./demo-transport.js"></script><script src="./palette-machines.js"></script><script type="module"'));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    let file: string;
    try { file = decodeURIComponent(path.slice(1)); } catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
  } });
  try {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
      try {
        await context.addInitScript((paneId) => {
          localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" }));
          for (const id of ["local", "remote", "offline"]) localStorage.setItem(`herdr-web-ui:pc-collapsed:${id}`, "1");
          localStorage.setItem("herdr-web-ui:recent-panes:remote", JSON.stringify([paneId]));
        }, panes.api);
        const page = await context.newPage(); const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(panes.api)}`);
        await page.locator(".conn-live").waitFor({ state: "attached" });
        const palette = page.getByRole("dialog", { name: "Command palette", exact: true });
        const search = palette.getByRole("searchbox", { name: "Search panes and actions", exact: true });
        const open = async () => { await page.keyboard.press("ControlOrMeta+Shift+K"); await palette.waitFor(); };
        const rows = palette.locator(".palette-pane");
        await open();
        await page.waitForFunction(() => {
          const calls = (window as any).paletteMachineCalls;
          return calls.branches.includes("local") && calls.branches.includes("remote");
        });
        assert.equal(await palette.locator('.palette-section[data-section="recent"] .palette-pane[data-machine="remote"]').count(), 1, "legacy remote history appears in the global Recent section");
        assert.equal(await palette.locator('.palette-pane[data-machine="offline"]').count(), 0);
        assert.equal(await palette.locator('.palette-pane[aria-current="true"]').count(), 1, "same remote pane ID is not selected");
        assert.equal(await palette.locator('.palette-section[data-machine="remote"] .palette-section-machine').first().textContent(), "Build PC");
        await search.fill("remote-branch");
        await rows.first().waitFor();
        assert.deepEqual(await rows.evaluateAll((entries) => [...new Set(entries.map((entry) => entry.getAttribute("data-machine")))]), ["remote"]);
        await search.fill("Build PC"); await rows.first().waitFor();
        assert.ok(await rows.count() > 0);
        assert.deepEqual(await rows.evaluateAll((entries) => [...new Set(entries.map((entry) => entry.getAttribute("data-machine")))]), ["remote"]);
        console.log("PASS global search distinguishes duplicate IDs, searches machine/branch names and migrates remote history");

        // The palette may open over a confirmation. Identical native IDs on the destination
        // PC must never retarget the first PC's destructive dialog to that new machine.
        await page.keyboard.press("Escape"); await palette.waitFor({ state: "hidden" });
        const selectedTab = page.locator('.tab-strip-tab[aria-selected="true"]');
        assert.equal(await page.locator('.tab-strip-tab').count(), 1, "the selected workspace owns only this tab");
        const localTabId = await selectedTab.getAttribute("data-tab-id");
        await selectedTab.focus(); await selectedTab.press("Delete");
        const closeConfirm = page.getByRole("alertdialog", { name: /^Close tab / });
        await closeConfirm.waitFor();
        assert.match(await closeConfirm.textContent() ?? "", /It is the last tab/);
        await open();
        assert.equal(await closeConfirm.isVisible(), true, "opening the palette leaves the confirmation beneath it until a target is chosen");
        await search.fill("Remote migration"); await rows.first().waitFor();
        await search.press("Enter"); await palette.waitFor({ state: "hidden" });
        await closeConfirm.waitFor({ state: "detached" });
        assert.equal(await selectedTab.getAttribute("data-tab-id"), localTabId, "the remote PC deliberately has the same tab ID");
        assert.deepEqual(await page.evaluate(() => (window as any).paletteMachineCalls.closes), [], "a PC switch neither preserves nor submits the previous PC's close confirmation");
        console.log("PASS switching PCs through the palette dismisses an old close confirmation even when tab IDs match");
        await page.waitForFunction(() => JSON.parse(sessionStorage.getItem("herdr-web-ui:selection") ?? "{}").machine_id === "remote");
        const calls = await page.evaluate(() => (window as any).paletteMachineCalls);
        // a pick is the browser's alone: herdr's focus on either PC stays where it is
        assert.deepEqual(calls.focus.filter((call: { machine: string }) => call.machine === "remote"), [], "selection leaves the remote PC's herdr focus alone");
        await open();
        await page.waitForFunction(() => (window as any).paletteMachineCalls.plugins.includes("remote"));
        assert.equal(await palette.locator('.palette-section[data-section="plugins"] .palette-section-machine').textContent(), "Build PC", "plugin actions keep the selected PC owner");
        await palette.getByRole("option", { name: /Save layout/ }).click();
        await palette.waitFor({ state: "hidden" });
        assert.deepEqual(await page.evaluate(() => (window as any).paletteMachineCalls.runs), ["remote"], "the selected remote PC owns plugin execution");
        await open();
        await search.fill("Laptop"); await rows.first().click(); await palette.waitFor({ state: "hidden" });
        await open();
        await search.fill("Remote migration"); await rows.first().waitFor();
        await page.evaluate(() => (window as any).setPaletteRemoteState(true));
        await palette.locator('.palette-pane[data-machine="remote"]').waitFor({ state: "hidden" });
        assert.equal(await rows.count(), 0, "offline retained snapshots disappear from search");
        await page.evaluate(() => (window as any).setPaletteRemoteState(false, true));
        assert.equal(await rows.count(), 0, "a removed pane cannot be activated from history");
        await page.keyboard.press("Escape");
        assert.deepEqual(errors, []);
        console.log("PASS cross-PC selection stays bound; plugin actions follow the current PC; offline/removed panes are excluded");
      } finally { await context.close(); }
    } finally { await browser.close(); }
  } finally { server.stop(); }
} finally { rmSync(app, { recursive: true, force: true }); }
