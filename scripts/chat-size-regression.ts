import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import type { Machine } from "../shared/machines.ts";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { PtySession } from "../server/pty/session.ts";
import { herdrRpc, herdrSocketPath, type WorkspaceCreateResult, paneRead, paneSendKeys, paneSendText, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";

/** how long a resize that should not happen gets to show up */
const NO_RESIZE_WAIT_MS = 400;

type Frame = { dir: "in" | "out"; type: string; keep_size?: boolean };
const framesOf = (page: Page) => page.evaluate(() => (window as unknown as { frames_: Frame[] }).frames_);

async function stopHolder(holder: PtySession): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("attach holder did not exit")), 10_000);
  });
  try {
    holder.kill();
    await Promise.race([holder.exited, deadline]);
  } finally { clearTimeout(timer); }
}

/** The size the pane's own shell reports (`stty size`), not what a browser thinks. */
function shellSize(paneId: string): () => Promise<string> {
  let asked = 0;
  return async () => {
    const marker = `size-${++asked}`;
    await paneSendText(paneId, `echo ${marker} $(stty size)`);
    await paneSendKeys(paneId, ["Enter"]);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const text = (await paneRead({ paneId, source: "recent", lines: 80, stripAnsi: true })).text;
      const found = [...text.matchAll(new RegExp(`^${marker} (\\d+ \\d+)\\s*$`, "gm"))].at(-1);
      if (found) return found[1]!;
      await Bun.sleep(100);
    }
    throw new Error(`no ${marker} answer from the pane`);
  };
}

/** A page on `paneId` that records every frame its socket sends and receives (`frames_`), its socket in `socket_`. */
async function openRecording(browser: Browser, contexts: BrowserContext[], origin: string, paneId: string, options: Parameters<Browser["newContext"]>[0], settings: object, away = false, setup?: (page: Page) => Promise<void>): Promise<Page> {
  const context = await browser.newContext({ locale: "en-US", ...options });
  contexts.push(context);
  await context.addInitScript((stored) => {
    localStorage.setItem("herdr-web-ui:settings", JSON.stringify(stored));
    // every frame this page's socket sends and receives, to wait on the server's answers
    const frames: { dir: "in" | "out"; type: string; keep_size?: boolean }[] = [];
    (window as unknown as { frames_: typeof frames }).frames_ = frames;
    const Native = window.WebSocket;
    class Recording extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        (window as unknown as { socket_: WebSocket }).socket_ = this;
        this.addEventListener("message", (event) => { try { frames.push({ dir: "in", type: JSON.parse(String(event.data)).type }); } catch {} });
      }
      override send(data: string): void { try { const frame = JSON.parse(data); frames.push({ dir: "out", type: frame.type, keep_size: frame.keep_size }); } catch {} super.send(data); }
    }
    Object.assign(window, { WebSocket: Recording });
  }, settings);
  if (away) await context.addInitScript(() => {
    Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
  });
  const page = await context.newPage();
  await setup?.(page);
  await page.goto(`${origin}/?pane=${encodeURIComponent(paneId)}`);
  await page.locator(".conn-live").waitFor();
  return page;
}

/**
 * The roster pages are handed names the pane's agent. A page opened before that takes the pane for
 * a shell: with chat as its lens for every pane it still opens the terminal there, and attaching in
 * the terminal lens fits the shared grid to that page, which is what these checks say does not happen.
 */
async function agentListed(origin: string, paneId: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const roster = await (await fetch(`${origin}/api/machines`)).json() as { machines: Machine[] };
    if (roster.machines.some((machine) => machine.snapshot?.panes.some((pane) => pane.pane_id === paneId && pane.agent === "claude"))) return;
    await Bun.sleep(50);
  }
  throw new Error(`the roster never named the agent in ${paneId}`);
}

// the server answers an attach with input-ready, and resizes in the same step: once the
// `nth` one is in, that attach has done whatever it does to the grid
const attached = (page: Page, nth = 1) => page.waitForFunction((count) => (window as unknown as { frames_: { dir: string; type: string }[] }).frames_.filter((f) => f.dir === "in" && f.type === "input-ready").length >= count, nth, { timeout: 15_000 });

/**
 * The chat lens leaves the shared terminal's size alone (#361): a desktop tab drives a pane's grid
 * from its terminal lens, a phone opens the same pane in the chat lens, and the program in the pane
 * still sees the desktop's size. Switching the phone to its terminal lens fits the grid to the phone.
 * The size is the one the pane's own shell reports (`stty size`), not what either browser thinks.
 */
export async function checkChatKeepsTerminalSize(browser: Browser, origin: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-chat-size-"));
  const cwd = join(root, "pane");
  mkdirSync(cwd);
  const created = await workspaceCreate({ cwd, label: "herdr-web-ui-test-chat-size" });
  const paneId = created.root_pane.pane_id;
  const contexts: BrowserContext[] = [];
  try {
    // an agent pane opens in the chat lens on a phone; the shell under it answers `stty size`
    await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "claude", state: "idle" });
    await agentListed(origin, paneId);
    const size = shellSize(paneId);
    const open = (options: Parameters<Browser["newContext"]>[0], settings: object) => openRecording(browser, contexts, origin, paneId, options, settings);
    const sent = (page: Page) => page.evaluate(() => (window as unknown as { frames_: { dir: string; type: string; keep_size?: boolean }[] }).frames_.filter((f) => f.dir === "out" && (f.type === "attach" || f.type === "resize")));

    const desktop = await open({ viewport: { width: 1280, height: 800 } }, { language: "en", defaultView: "terminal" });
    await attached(desktop);
    const desktopSize = await size();

    const phone = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, { language: "en", defaultView: "chat" });
    await phone.locator(".terminal-stack.is-chat").waitFor({ state: "attached" });
    await attached(phone);
    // the chat lens attaches without driving the grid, and sends no resize of its own
    assert.deepEqual(await sent(phone), [{ dir: "out", type: "attach", keep_size: true }]);
    assert.equal(await size(), desktopSize, "the phone's chat lens leaves the desktop's grid");
    if (process.env.UI_EVIDENCE_DIR) await desktop.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "chat-size-desktop.png") });
    console.log(`PASS a phone's chat lens leaves the shared grid at the desktop's ${desktopSize}`);

    // the phone's terminal lens fits the grid to the phone: the shell sees it change
    // on a phone the lens switch shows no label: the button is known by its title
    await phone.locator('button[title^="Live terminal"]').tap();
    await phone.waitForFunction(() => (window as unknown as { frames_: { dir: string; type: string }[] }).frames_.some((f) => f.dir === "out" && f.type === "resize"), undefined, { timeout: 10_000 });
    const deadline = Date.now() + 10_000;
    let phoneSize = desktopSize;
    while (phoneSize === desktopSize && Date.now() < deadline) phoneSize = await size();
    assert.notEqual(phoneSize, desktopSize, "the phone's terminal lens fits the grid to the phone");
    assert.ok(Number(phoneSize.split(" ")[1]) < Number(desktopSize.split(" ")[1]), `phone ${phoneSize} narrower than desktop ${desktopSize}`);
    console.log(`PASS the phone's terminal lens fits the grid to ${phoneSize}`);

    // the desktop's terminal lens ignored that resize: it drives the grid itself. Entering the chat
    // lens, its hidden screen takes the grid the pty has now, since what the chat reads there (a
    // masked prompt) is drawn for the phone's grid. xterm's DOM renderer keeps one element a row.
    const hiddenRows = () => desktop.locator(".pane-terminal .xterm-rows > div").count();
    const phoneRows = Number(phoneSize.split(" ")[0]);
    assert.notEqual(await hiddenRows(), phoneRows, "the desktop's terminal lens kept its own grid");
    await desktop.getByTitle("Chat transcript (⌘⇧J)", { exact: true }).click();
    await desktop.locator(".terminal-stack.is-chat").waitFor({ state: "attached" });
    const adopted = Date.now() + 10_000;
    while (await hiddenRows() !== phoneRows && Date.now() < adopted) await Bun.sleep(100);
    assert.equal(await hiddenRows(), phoneRows, "the desktop's chat lens draws its hidden screen for the shared grid");
    assert.equal(await size(), phoneSize, "entering the chat lens resizes nothing");
    console.log(`PASS the desktop's chat lens draws its hidden screen for the shared grid of ${phoneSize}`);
  } finally {
    for (const context of contexts) await context.close();
    await workspaceClose(created.workspace.workspace_id).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Picking a pane whose lens is chat, from a pane whose lens is the terminal, leaves the shared
 * terminal's size alone too: the lens is the picked pane's by the time its terminal attaches.
 * A desktop drives an agent pane's grid; a smaller window sits on a shell pane (terminal lens)
 * and picks the agent pane (chat lens there) from the sidebar.
 */
export async function checkPaneSwitchKeepsTerminalSize(browser: Browser, origin: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-chat-switch-"));
  const contexts: BrowserContext[] = [];
  const workspaces: string[] = [];
  try {
    const panes: string[] = [];
    for (const name of ["agent", "shell"]) {
      const cwd = join(root, name);
      mkdirSync(cwd);
      const created = await workspaceCreate({ cwd, label: `herdr-web-ui-test-chat-switch-${name}` });
      workspaces.push(created.workspace.workspace_id);
      panes.push(created.root_pane.pane_id);
    }
    const [agentPane, shellPane] = panes as [string, string];
    await herdrRpc("pane.report_agent", { pane_id: agentPane, source: "manual", agent: "claude", state: "idle" });
    await agentListed(origin, agentPane);
    const size = shellSize(agentPane);

    const desktop = await openRecording(browser, contexts, origin, agentPane, { viewport: { width: 1280, height: 800 } }, { language: "en", defaultView: "terminal" });
    await attached(desktop);
    const desktopSize = await size();

    // with chat as the lens for every pane, a shell still opens in the terminal: it has no conversation
    const other = await openRecording(browser, contexts, origin, shellPane, { viewport: { width: 900, height: 600 } }, { language: "en", defaultView: "chat" });
    await other.locator(".terminal-stack:not(.is-chat)").waitFor({ state: "attached" });
    await attached(other);
    const before = (await framesOf(other)).length;
    await other.locator(`.pane-select[title^="${agentPane} — "]`).click();
    await other.locator(".terminal-stack.is-chat").waitFor({ state: "attached" });
    await attached(other, 2);
    // a resize that should not happen gets this long to show up: the grid's ResizeObserver waits 120 ms
    await Bun.sleep(NO_RESIZE_WAIT_MS);
    const sent = (await framesOf(other)).slice(before).filter((f) => f.dir === "out" && (f.type === "attach" || f.type === "resize"));
    assert.deepEqual(sent, [{ dir: "out", type: "attach", keep_size: true }], "the picked pane attaches in its own lens");
    assert.equal(await size(), desktopSize, "picking a chat-lens pane leaves the desktop's grid");
    console.log(`PASS picking a chat-lens pane from a terminal-lens pane leaves the shared grid at ${desktopSize}`);
  } finally {
    for (const context of contexts) await context.close();
    for (const id of workspaces) await workspaceClose(id).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

/** Whether this bridge holds herdr's attach on the terminal: herdr gives a pane back to its own TUI only once none does. */
function attachRunning(terminalId: string): boolean {
  return Bun.spawnSync(["ps", "-axo", "command"]).stdout.toString().split("\n").some((line) => line.includes(`terminal attach ${terminalId}`));
}

/**
 * A tab the user is not in leaves the shared terminal's size alone, and lets go of the pane. A
 * desktop window left open behind another app (herdr's own TUI in a terminal) turned visible when
 * the screen woke, or reconnected, reloaded or moved on to the next pane in the background, and
 * fitted the pane to itself. And for as long as the bridge's attach stayed, herdr held the pane at
 * that window's size: its TUI drew the pane cut off at its split's edge, the bottom rows out of
 * reach. Out of use, the window detaches, the attach ends with the pane's last client, and herdr
 * gives the pane back to its TUI. The window attaches again, at its own size, when it takes the
 * focus.
 */
export async function checkBackgroundTabKeepsTerminalSize(browser: Browser, origin: string): Promise<void> {
  await checkInactiveAttachLifecycle(browser, origin);
  const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-background-size-"));
  const contexts: BrowserContext[] = [];
  const workspaces: string[] = [];
  try {
    const cwd = join(root, "pane");
    mkdirSync(cwd);
    const created = await workspaceCreate({ cwd, label: "herdr-web-ui-test-background-size" });
    workspaces.push(created.workspace.workspace_id);
    const paneId = created.root_pane.pane_id;
    const terminalId = created.root_pane.terminal_id;
    // the pane the app moves on to once the first one closes: herdr's focused one
    const nextCwd = join(root, "next");
    mkdirSync(nextCwd);
    const next = await herdrRpc<WorkspaceCreateResult>("workspace.create", { cwd: nextCwd, label: "herdr-web-ui-test-background-size-next", focus: true });
    workspaces.push(next.workspace.workspace_id);
    const nextPane = next.root_pane.pane_id;
    const size = shellSize(paneId);
    const nextSize = shellSize(nextPane);
    // the pause in another window is a setting this check turns on; the first window below keeps the default
    const open = (options: Parameters<Browser["newContext"]>[0], settings: object = {}) => openRecording(browser, contexts, origin, paneId, options, { language: "en", defaultView: "terminal", releasePaneAway: true, ...settings });
    // what the page sent that sizes the grid: attaches and resizes
    const sizing = async (page: Page) => (await framesOf(page)).filter((f) => f.dir === "out" && (f.type === "attach" || f.type === "resize"));
    // a window that let go of its pane still shows it, read-only, through the server's watch
    const viewOnly = (page: Page) => page.locator(".terminal-banner", { hasText: "View only while you use another window" });
    const watchFrames = async (page: Page) => (await framesOf(page)).filter((f) => f.dir === "in" && f.type === "watch-data").length;

    // by default a window out of use keeps its pane: no detach, no paused banner, and the pane's output still arrives
    const keeping = await openRecording(browser, contexts, origin, paneId, { viewport: { width: 1280, height: 800 } }, { language: "en", defaultView: "terminal" });
    await attached(keeping);
    // freeze timers after the real attach; only the release delay is advanced below
    await keeping.clock.install();
    await keeping.clock.pauseAt(new Date());
    await keeping.evaluate(() => {
      Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
      window.dispatchEvent(new Event("blur"));
    });
    // past the moment a window that pauses lets go of its pane
    await keeping.clock.runFor(2_000);
    assert.ok(!(await framesOf(keeping)).some((f) => f.dir === "out" && f.type === "detach"), "a window out of use keeps its pane by default");
    assert.equal(await viewOnly(keeping).count(), 0, "a window out of use is not view only by default");
    await keeping.clock.resume();
    const outputCount = async () => (await framesOf(keeping)).filter((f) => f.dir === "in" && f.type === "pty-data").length;
    const output = await outputCount();
    await size();
    const arrives = Date.now() + 10_000;
    while (await outputCount() <= output && Date.now() < arrives) await Bun.sleep(100);
    assert.ok(await outputCount() > output, "a window out of use still gets the pane's output by default");
    await keeping.context().close();
    console.log("PASS by default a desktop window out of use keeps its pane and its output");

    // a font the user chose loads after every attach and refits the grid: one no device has falls
    // back to the built-in fonts, so the grid keeps its size
    const desktop = await open({ viewport: { width: 1280, height: 800 } }, { terminalFontFamily: "herdr-web-ui-test-no-such-font" });
    await attached(desktop);
    const desktopSize = await size();
    const phone = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await attached(phone);
    const deadline = Date.now() + 10_000;
    let phoneSize = desktopSize;
    while (phoneSize === desktopSize && Date.now() < deadline) phoneSize = await size();
    assert.notEqual(phoneSize, desktopSize, "the phone's terminal lens fits the grid to the phone");

    // the desktop's window turns visible behind another app: shown, without the focus
    const shown = (await sizing(desktop)).length;
    await desktop.evaluate(() => {
      Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await Bun.sleep(NO_RESIZE_WAIT_MS);
    assert.deepEqual((await sizing(desktop)).slice(shown), [], "a window shown without the focus sends no resize");
    assert.equal(await size(), phoneSize, "a window shown without the focus leaves the phone's grid");
    console.log(`PASS a desktop window shown without the focus leaves the shared grid at the phone's ${phoneSize}`);

    // a moment later it lets go of the pane and watches it instead, and says so; the phone keeps it
    await desktop.waitForFunction(() => (window as unknown as { frames_: { dir: string; type: string }[] }).frames_.some((f) => f.dir === "out" && f.type === "detach"), undefined, { timeout: 10_000 });
    await viewOnly(desktop).waitFor({ timeout: 10_000 });
    assert.ok((await framesOf(desktop)).some((f) => f.dir === "out" && f.type === "watch"), "the window watches the pane it let go of");
    assert.equal(await size(), phoneSize, "the window letting go leaves the phone's grid");
    console.log("PASS a desktop window out of use lets go of the pane, watches it, and says it is view only");

    // it reconnects in the background: a pane it let go of is not attached again
    const reconnecting = (await sizing(desktop)).length;
    const snapshots = (await framesOf(desktop)).filter((f) => f.dir === "in" && f.type === "snapshot").length;
    await desktop.evaluate(() => (window as unknown as { socket_: WebSocket }).socket_.close());
    await desktop.waitForFunction((count) => (window as unknown as { frames_: { dir: string; type: string }[] }).frames_.filter((f) => f.dir === "in" && f.type === "snapshot").length > count, snapshots, { timeout: 15_000 });
    await Bun.sleep(NO_RESIZE_WAIT_MS);
    assert.deepEqual((await sizing(desktop)).slice(reconnecting), [], "a background reconnect attaches nothing");
    assert.equal(await size(), phoneSize, "a background reconnect leaves the phone's grid");
    console.log("PASS a desktop window reconnecting in the background does not take the pane again");

    // it reloads in the background: the first attach adopts the grid, and so does the chosen font
    // loading after it; a moment later it lets go of the pane again
    await desktop.context().addInitScript(() => Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false }));
    await desktop.reload();
    await desktop.locator(".conn-live").waitFor();
    await attached(desktop);
    await Bun.sleep(NO_RESIZE_WAIT_MS);
    assert.deepEqual(await sizing(desktop), [{ dir: "out", type: "attach", keep_size: true }], "a background reload attaches without resizing");
    assert.equal(await size(), phoneSize, "a background reload leaves the phone's grid");
    await desktop.waitForFunction(() => (window as unknown as { frames_: { dir: string; type: string }[] }).frames_.some((f) => f.dir === "out" && f.type === "detach"), undefined, { timeout: 10_000 });
    await viewOnly(desktop).waitFor({ timeout: 10_000 });
    console.log("PASS a desktop window reloading in the background leaves the shared grid, then lets go of the pane");

    // the phone leaves too: no tab uses the pane, and the bridge lets go of herdr's attach,
    // which is what gives the pane back to herdr's own TUI
    assert.ok(attachRunning(terminalId), "the phone still holds the attach");
    await phone.context().close();
    const gone = Date.now() + 10_000;
    while (attachRunning(terminalId) && Date.now() < gone) await Bun.sleep(100);
    assert.ok(!attachRunning(terminalId), "no tab in use holds herdr's attach on the pane");
    console.log("PASS with no tab in use, the bridge holds no attach on the pane");

    // the window it let go of still shows the pane: its output arrives through the watch, with no attach
    const watched = await watchFrames(desktop);
    await size();
    const shows = Date.now() + 10_000;
    while (await watchFrames(desktop) <= watched && Date.now() < shows) await Bun.sleep(100);
    assert.ok(await watchFrames(desktop) > watched, "the watched pane's output reaches the window");
    assert.ok(!attachRunning(terminalId), "watching holds no attach on the pane");
    console.log("PASS a window out of use keeps showing the pane's output with no attach on it");

    // the pane closes in herdr and the window moves on to the focused one in the background: having
    // let go, it attaches nothing until the user is back, and that pane keeps the size it has
    const nextBefore = await nextSize();
    assert.notEqual(nextBefore, desktopSize, "the next pane starts at a size the window would change");
    const switching = (await sizing(desktop)).length;
    await workspaceClose(created.workspace.workspace_id);
    await desktop.locator(`.terminal-stack[data-pane-owner="${nextPane}"]`).waitFor({ state: "attached", timeout: 15_000 });
    await Bun.sleep(NO_RESIZE_WAIT_MS);
    assert.deepEqual((await sizing(desktop)).slice(switching), [], "a background move to the next pane attaches nothing");
    assert.equal(await nextSize(), nextBefore, "a background move to the next pane leaves its grid");
    assert.equal(await viewOnly(desktop).count(), 1, "the window on the next pane is still view only");
    console.log(`PASS a desktop window moving on to the next pane in the background leaves its grid at ${nextBefore}`);

    // the user comes back to it: the window takes the focus, attaches, and takes the grid
    const returning = (await sizing(desktop)).length;
    await desktop.evaluate(() => {
      delete (document as unknown as { hasFocus?: unknown }).hasFocus;
      window.dispatchEvent(new Event("focus"));
    });
    await attached(desktop, 2);
    assert.deepEqual((await sizing(desktop)).slice(returning).map((f) => ({ type: f.type, keep_size: f.keep_size ?? false })), [{ type: "attach", keep_size: false }], "the focused window attaches at its own size");
    const back = Date.now() + 10_000;
    let current = nextBefore;
    while (current !== desktopSize && Date.now() < back) current = await nextSize();
    assert.equal(current, desktopSize, "the focused window fits the grid to itself again");
    assert.equal(await viewOnly(desktop).count(), 0, "the window back in use is not view only");
    console.log(`PASS the desktop window attaches again at ${desktopSize} when it takes the focus`);
  } finally {
    for (const context of contexts) await context.close().catch(() => undefined);
    for (const id of workspaces) await workspaceClose(id).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

/** Drive the real component and assert the attach/resize frames, not the paused notice alone. */
export async function checkInactiveAttachLifecycle(browser: Browser, origin: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-inactive-"));
  const contexts: BrowserContext[] = [];
  const workspaces: string[] = [];
  const failures: string[] = [];
  try {
    const panes: string[] = [];
    let heldTerminal: string | null = null;
    for (const name of ["first", "next", "held"]) {
      const cwd = join(root, name);
      mkdirSync(cwd);
      const created = await workspaceCreate({ cwd, label: `herdr-web-ui-test-inactive-${name}` });
      panes.push(created.root_pane.pane_id);
      if (name === "held") heldTerminal = created.root_pane.terminal_id;
      workspaces.push(created.workspace.workspace_id);
    }
    const first = panes[0]!;
    const next = panes[1]!;
    const waitDetach = (page: Page, count = 1) => page.waitForFunction((n) =>
      (window as unknown as { frames_: Frame[] }).frames_.filter((f) => f.dir === "out" && f.type === "detach").length >= n,
    count, { timeout: 10_000 });
    const sent = async (page: Page, start = 0) => (await framesOf(page)).slice(start)
      .filter((f) => f.dir === "out" && (f.type === "attach" || f.type === "resize"));
    const scenarios = ["mount", "switch", "resume", "toggles", "held", "queue-switch", "queue-inflight", "writes"] as const;
    assert.ok(!process.env.CHAT_SIZE_CASE || scenarios.some((scenario) => scenario === process.env.CHAT_SIZE_CASE), "unknown CHAT_SIZE_CASE");
    for (const scenario of scenarios) {
      if (process.env.CHAT_SIZE_CASE && process.env.CHAT_SIZE_CASE !== scenario) continue;
      let holder: PtySession | undefined;
      let page: Page | undefined;
      const heldPane = panes[2]!;
      try {
        const queueScenario = scenario.startsWith("queue-");
        if (queueScenario) {
          await herdrRpc("pane.report_agent", { pane_id: first, source: "manual", agent: "claude", state: "working" });
          await agentListed(origin, first);
        }
        let releaseSubmit: (() => void) | undefined;
        let acceptedQueue = false;
        let holdOutput = false;
        let injectOutput: (() => void) | undefined;
        const heldOutput: Array<() => void> = [];
        const wire: Frame[] = [];
        const listeners = new Set<() => void>();
        const record = (raw: string | Buffer, dir: "in" | "out"): void => {
          const frame = JSON.parse(String(raw));
          wire.push({ dir, type: frame.type, ...(dir === "out" ? { keep_size: frame.keep_size } : {}) });
          for (const listener of listeners) listener();
        };
        const waitWire = (dir: "in" | "out", type: string, count = 1): Promise<void> => new Promise((resolve, reject) => {
          const timeout = setTimeout(() => { listeners.delete(check); reject(new Error(`no ${count} ${dir} ${type} frames`)); }, 15_000);
          const check = (): void => {
            if (wire.filter((frame) => frame.dir === dir && frame.type === type).length < count) return;
            clearTimeout(timeout); listeners.delete(check); resolve();
          };
          listeners.add(check); check();
        });
        const routed = queueScenario || scenario === "writes";
        const recorded = async (): Promise<Frame[]> => {
          if (routed) return [...wire];
          assert.ok(page);
          return framesOf(page);
        };
        const setup = async (recording: Page): Promise<void> => {
          await recording.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
            injectOutput = () => {
              for (const data of ["\x1b[2J\x1b[H", "STALE-SUBSCRIPTION"]) {
                socket.send(JSON.stringify({ type: "pty-data", pane_id: first, data }));
              }
            };
            const upstream = socket.connectToServer();
            upstream.onMessage((raw) => {
              const frame = JSON.parse(String(raw));
              if (frame.type === "submit-result") acceptedQueue = Boolean(frame.ok && frame.pending);
              record(raw, "in");
              if (holdOutput && frame.type === "pty-data") heldOutput.push(() => socket.send(raw));
              else socket.send(raw);
            });
            socket.onMessage((raw) => {
              const frame = JSON.parse(String(raw));
              record(raw, "out");
              if (queueScenario && frame.type === "submit" && frame.delivery === "queue") {
                if (scenario === "queue-switch") {
                  // The component receives the real pending protocol; backend queue behavior has contract tests.
                  const receipt = JSON.stringify({ type: "submit-result", id: frame.id, pane_id: first, ok: true,
                    pending: { id: "lifecycle-queue", request_id: frame.id, text: frame.text, state: "queued", created_at: new Date().toISOString() } });
                  record(receipt, "in"); socket.send(receipt);
                } else releaseSubmit = () => upstream.send(raw); // validation/acceptance still runs on the real server
              } else upstream.send(raw);
            });
          });
        };
        if (scenario === "held") {
          assert.ok(heldTerminal);
          const ready = Promise.withResolvers<void>();
          const deadline = setTimeout(() => ready.reject(new Error("holder produced no attach stream")), 15_000);
          holder = new PtySession({
            command: process.env.HERDR_WEB_HERDR_BIN ?? "herdr", args: ["terminal", "attach", heldTerminal],
            cols: 80, rows: 24, env: { HERDR_SOCKET_PATH: herdrSocketPath() },
            onData: () => ready.resolve(), onExit: () => ready.reject(new Error("holder ended before the test")),
          });
          try { await ready.promise; } finally { clearTimeout(deadline); }
        }
        page = await openRecording(browser, contexts, origin, scenario === "held" ? heldPane : first,
          { viewport: { width: 1000, height: 700 } }, { language: "en", defaultView: queueScenario ? "chat" : "terminal", releasePaneAway: true },
          scenario === "mount", queueScenario || scenario === "writes" ? setup : undefined);
        if (scenario === "held") {
          await page.getByText("Another app has this pane open.", { exact: false }).waitFor();
          await page.clock.install();
          await page.clock.pauseAt(new Date());
          await page.evaluate(() => {
            Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
            window.dispatchEvent(new Event("blur"));
          });
          await page.clock.runFor(1000);
          await waitDetach(page);
          await page.locator(".terminal-banner", { hasText: "View only while you use another window" }).waitFor();
          assert.ok(holder);
          await stopHolder(holder);
          await page.evaluate(() => {
            Object.defineProperty(document, "hasFocus", { configurable: true, value: () => true });
            window.dispatchEvent(new Event("focus"));
          });
          await attached(page);
          assert.equal((await framesOf(page)).filter((f) => f.dir === "in" && f.type === "attach-resumed").length, 0,
            "the fresh attach succeeds without a held retry");
          assert.equal(await page.getByText("Another app has this pane open.", { exact: false }).count(), 0,
            "a fresh resume must clear the previous attach's held state");
          await page.clock.resume();
          await page.locator(".xterm-helper-textarea").focus();
          await page.keyboard.type("z");
          await page.waitForFunction(() => (window as unknown as { frames_: Frame[] }).frames_
            .some((f) => f.dir === "out" && f.type === "input"), undefined, { timeout: 10_000 });
          console.log("PASS inactive attach lifecycle: held");
          continue;
        }
        await (routed ? waitWire("in", "input-ready") : attached(page));
        if (queueScenario) {
          await page.locator('.composer-status[data-status="working"]').waitFor();
          await page.locator(".composer-text").fill("lifecycle follow-up");
          assert.equal(await page.locator(".composer-text").inputValue(), "lifecycle follow-up");
          await page.locator(".composer-text").press("Enter");
          await waitWire("out", "submit");
          if (scenario === "queue-switch") await page.locator('.pending-message[data-state="queued"]').waitFor();
        }
        if (scenario === "mount") {
          // No blur or visibility transition occurs after this out-of-use mount.
          await waitDetach(page);
          assert.deepEqual(await sent(page), [{ dir: "out", type: "attach", keep_size: true }]);
        } else {
          // Freeze timers after the real first attach; only the release delay is advanced below.
          await page.clock.install();
          await page.clock.pauseAt(new Date());
          if (scenario === "writes") {
            await page.clock.runFor(50);
            holdOutput = true;
          }
          await page.evaluate(() => {
            Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
            window.dispatchEvent(new Event("blur"));
          });
          if (queueScenario) {
            await page.clock.runFor(1000);
            assert.equal((await recorded()).filter((f) => f.dir === "out" && f.type === "detach").length, 0,
              "a queued or unacknowledged follow-up holds its originating attach");
            if (scenario === "queue-switch") {
              await page.locator(`.pane-select[title^="${next} — "]`).evaluate((button: HTMLElement) => button.click());
              await waitWire("out", "attach", 2);
              await page.locator(`.terminal-stack[data-pane-owner="${next}"]`).waitFor({ state: "attached" });
              await page.clock.runFor(0);
              assert.equal((await recorded()).filter((f) => f.dir === "out" && f.type === "detach").length, 1,
                "pane B gets its own release delay, not pane A's queue-held state");
              await waitWire("in", "input-ready", 2);
              await page.clock.runFor(900);
              await page.evaluate(() => {
                Object.defineProperty(document, "hasFocus", { configurable: true, value: () => true });
                window.dispatchEvent(new Event("focus"));
                Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
                window.dispatchEvent(new Event("blur"));
              });
              await page.clock.runFor(100);
              assert.equal((await recorded()).filter((f) => f.dir === "out" && f.type === "detach").length, 1,
                "pane A's orphaned timer cannot shorten pane B's new delay");
              await page.clock.runFor(900);
              await waitWire("out", "detach", 2);
            } else {
              assert.ok(releaseSubmit, "the explicit Send is waiting at the server boundary");
              releaseSubmit();
              await waitWire("in", "submit-result");
              if (acceptedQueue) {
                const queued = page.locator('.pending-message[data-state="queued"]');
                await queued.waitFor();
                // An accepted follow-up still owns its lease until the user discards it.
                await queued.getByRole("button", { name: "Discard", exact: true }).evaluate((button: HTMLElement) => button.click());
                await waitWire("out", "pending-action");
              }
              await waitWire("out", "detach");
            }
          } else if (scenario === "writes") {
            await page.clock.runFor(999);
            await page.evaluate(() => {
              const scheduled: Array<() => void> = [];
              const timers: Pick<Window, "setTimeout"> = window;
              const schedule = timers.setTimeout;
              timers.setTimeout = (handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
                if (timeout === undefined && typeof handler === "function") {
                  scheduled.push(() => handler(...args));
                  return 0;
                }
                return schedule(handler, timeout, ...args);
              };
              Object.assign(window, { parseHeld_: scheduled, restoreParserTimer_: () => { timers.setTimeout = schedule; } });
            });
            assert.ok(injectOutput);
            injectOutput();
            await page.waitForFunction(() => (window as unknown as { parseHeld_: Array<() => void> }).parseHeld_.length > 0,
              undefined, { timeout: 10_000 });
            await page.evaluate(() => (window as unknown as { restoreParserTimer_: () => void }).restoreParserTimer_());
            await page.clock.runFor(1);
            await waitWire("out", "detach");
            await page.evaluate(() => {
              Object.defineProperty(document, "hasFocus", { configurable: true, value: () => true });
              window.dispatchEvent(new Event("focus"));
              for (const parse of (window as unknown as { parseHeld_: Array<() => void> }).parseHeld_) parse();
            });
            await waitWire("in", "input-ready", 2);
            await page.clock.runFor(50);
            assert.equal((await page.locator(".xterm-rows").textContent() ?? "").includes("STALE-SUBSCRIPTION"), false,
              "resume resets after pending writes, before the new attachment stream");
            holdOutput = false;
            for (const deliver of heldOutput) deliver();
          } else if (scenario === "switch") {
            const before = (await framesOf(page)).length;
            // Programmatic click deliberately does not focus the window.
            await page.locator(`.pane-select[title^="${next} — "]`).evaluate((button: HTMLElement) => button.click());
            await attached(page, 2);
            assert.deepEqual(await sent(page, before), [{ dir: "out", type: "attach", keep_size: true }]);
            await page.clock.runFor(1000);
            await waitDetach(page, 2); // old-pane cleanup plus new-pane release
          } else if (scenario === "resume") {
            await page.clock.runFor(1000);
            await waitDetach(page);
            await page.locator(".terminal-banner", { hasText: "View only while you use another window" }).waitFor();
            const before = (await framesOf(page)).length;
            await page.evaluate(() => window.dispatchEvent(new Event("pointerdown")));
            await attached(page, 2);
            assert.deepEqual(await sent(page, before), [{ dir: "out", type: "attach", keep_size: true }],
              "an inactive pointer resume must not resize the shared grid");
            await page.clock.runFor(1000);
            await waitDetach(page, 2);
          } else {
            // Returning before the delay cancels release, including repeated interruptions.
            await page.evaluate(() => {
              for (let i = 0; i < 5; i++) {
                Object.defineProperty(document, "hasFocus", { configurable: true, value: () => true });
                window.dispatchEvent(new Event("focus"));
                Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
                window.dispatchEvent(new Event("blur"));
              }
              Object.defineProperty(document, "hasFocus", { configurable: true, value: () => true });
              window.dispatchEvent(new Event("focus"));
            });
            await page.clock.runFor(1000);
            let frames = await framesOf(page);
            assert.equal(frames.filter((f) => f.dir === "out" && f.type === "detach").length, 0);
            assert.equal(frames.filter((f) => f.dir === "out" && f.type === "attach").length, 1);
            await page.evaluate(() => {
              Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
              window.dispatchEvent(new Event("blur"));
            });
            await page.clock.runFor(1000);
            await waitDetach(page);
            await page.locator(".terminal-banner", { hasText: "View only while you use another window" }).waitFor();
            await page.evaluate(() => {
              Object.defineProperty(document, "hasFocus", { configurable: true, value: () => true });
              window.dispatchEvent(new Event("focus"));
            });
            await attached(page, 2);
            await page.clock.runFor(1000);
            frames = await framesOf(page);
            assert.equal(frames.filter((f) => f.dir === "out" && f.type === "attach").length, 2);
            assert.equal(frames.filter((f) => f.dir === "out" && f.type === "detach").length, 1);
          }
        }
        console.log(`PASS inactive attach lifecycle: ${scenario}`);
      } catch (error) {
        failures.push(`${scenario}: ${String(error)}`);
        console.error(`FAIL inactive attach lifecycle: ${scenario}: ${String(error)}`);
        if (error instanceof Error) console.error(error.stack);
      } finally {
        if (holder) await stopHolder(holder);
        await page?.context().close();
      }
    }
    assert.deepEqual(failures, [], "inactive attach lifecycle scenarios");
  } finally {
    for (const context of contexts) await context.close().catch(() => undefined);
    for (const id of workspaces) await workspaceClose(id).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

// This file is also the focused manual-QA entry point; imports from ui-regression do not run it.
if (import.meta.main) {
  await import("./test-herdr.ts");
  const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-chat-size-run-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state") });
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox", "--accept-lang=en-US"] });
    const origin = `http://127.0.0.1:${server.port}`;
    if (process.env.CHAT_SIZE_CASE) await checkInactiveAttachLifecycle(browser, origin);
    else {
      await checkChatKeepsTerminalSize(browser, origin);
      await checkPaneSwitchKeepsTerminalSize(browser, origin);
      await checkBackgroundTabKeepsTerminalSize(browser, origin);
    }
  } finally {
    await browser?.close();
    server.stop();
    rmSync(root, { recursive: true, force: true });
  }
}
