import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import type { Machine } from "../shared/machines.ts";
import { herdrRpc, type WorkspaceCreateResult, paneRead, paneSendKeys, paneSendText, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";

/** how long a resize that should not happen gets to show up */
const NO_RESIZE_WAIT_MS = 400;

type Frame = { dir: "in" | "out"; type: string; keep_size?: boolean };
const framesOf = (page: Page) => page.evaluate(() => (window as unknown as { frames_: Frame[] }).frames_);

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
async function openRecording(browser: Browser, contexts: BrowserContext[], origin: string, paneId: string, options: Parameters<Browser["newContext"]>[0], settings: object): Promise<Page> {
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
  const page = await context.newPage();
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

/**
 * A tab the user is not in leaves the shared terminal's size alone. A desktop window left open
 * behind another app (herdr's own TUI in a terminal) turned visible when the screen woke, or
 * reconnected, reloaded or moved on to the next pane in the background, and fitted the pane to
 * itself: a phone or herdr's TUI in use then showed the pane at that window's size, cut off at its
 * own edge. The window takes the grid back when it takes the focus.
 */
export async function checkBackgroundTabKeepsTerminalSize(browser: Browser, origin: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-background-size-"));
  const contexts: BrowserContext[] = [];
  const workspaces: string[] = [];
  try {
    const cwd = join(root, "pane");
    mkdirSync(cwd);
    const created = await workspaceCreate({ cwd, label: "herdr-web-ui-test-background-size" });
    workspaces.push(created.workspace.workspace_id);
    const paneId = created.root_pane.pane_id;
    // the pane the app moves on to once the first one closes: herdr's focused one
    const nextCwd = join(root, "next");
    mkdirSync(nextCwd);
    const next = await herdrRpc<WorkspaceCreateResult>("workspace.create", { cwd: nextCwd, label: "herdr-web-ui-test-background-size-next", focus: true });
    workspaces.push(next.workspace.workspace_id);
    const nextPane = next.root_pane.pane_id;
    const size = shellSize(paneId);
    const nextSize = shellSize(nextPane);
    const open = (options: Parameters<Browser["newContext"]>[0], settings: object = {}) => openRecording(browser, contexts, origin, paneId, options, { language: "en", defaultView: "terminal", ...settings });
    // what the page sent that sizes the grid: attaches and resizes
    const sizing = async (page: Page) => (await framesOf(page)).filter((f) => f.dir === "out" && (f.type === "attach" || f.type === "resize"));

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

    // it reconnects in the background: the attach adopts the grid instead of taking it
    const reconnecting = (await sizing(desktop)).length;
    await desktop.evaluate(() => (window as unknown as { socket_: WebSocket }).socket_.close());
    await attached(desktop, 2);
    await Bun.sleep(NO_RESIZE_WAIT_MS);
    assert.deepEqual((await sizing(desktop)).slice(reconnecting), [{ dir: "out", type: "attach", keep_size: true }], "a background reconnect attaches without resizing");
    assert.equal(await size(), phoneSize, "a background reconnect leaves the phone's grid");
    console.log("PASS a desktop window reconnecting in the background leaves the shared grid");

    // it reloads in the background: the first attach adopts the grid too, and so does the chosen
    // font loading after it
    await desktop.context().addInitScript(() => Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false }));
    await desktop.reload();
    await desktop.locator(".conn-live").waitFor();
    await attached(desktop);
    await Bun.sleep(NO_RESIZE_WAIT_MS);
    assert.deepEqual(await sizing(desktop), [{ dir: "out", type: "attach", keep_size: true }], "a background reload attaches without resizing");
    assert.equal(await size(), phoneSize, "a background reload leaves the phone's grid");
    console.log("PASS a desktop window reloading in the background leaves the shared grid");

    // the pane closes in herdr and the window moves on to the focused one in the background: that
    // pane keeps the size it has. The phone goes first, or it would take the next pane itself
    await phone.context().close();
    const nextBefore = await nextSize();
    assert.notEqual(nextBefore, desktopSize, "the next pane starts at a size the window would change");
    const switching = (await sizing(desktop)).length;
    const closing = (await framesOf(desktop)).length;
    await workspaceClose(created.workspace.workspace_id);
    // the next pane's attach and the server's answer to it (the phone leaving answered the old one)
    await desktop.waitForFunction((from) => {
      const frames = (window as unknown as { frames_: { dir: string; type: string }[] }).frames_;
      const at = frames.findIndex((f, i) => i >= from && f.dir === "out" && f.type === "attach");
      return at >= 0 && frames.slice(at).some((f) => f.dir === "in" && f.type === "input-ready");
    }, closing, { timeout: 15_000 });
    await Bun.sleep(NO_RESIZE_WAIT_MS);
    assert.deepEqual((await sizing(desktop)).slice(switching), [{ dir: "out", type: "attach", keep_size: true }], "a background move to the next pane attaches without resizing");
    assert.equal(await nextSize(), nextBefore, "a background move to the next pane leaves its grid");
    console.log(`PASS a desktop window moving on to the next pane in the background leaves its grid at ${nextBefore}`);

    // the user comes back to it: the window takes the focus, and the grid
    await desktop.evaluate(() => {
      delete (document as unknown as { hasFocus?: unknown }).hasFocus;
      window.dispatchEvent(new Event("focus"));
    });
    const back = Date.now() + 10_000;
    let current = nextBefore;
    while (current !== desktopSize && Date.now() < back) current = await nextSize();
    assert.equal(current, desktopSize, "the focused window fits the grid to itself again");
    console.log(`PASS the desktop window takes the grid back at ${desktopSize} when it takes the focus`);
  } finally {
    for (const context of contexts) await context.close().catch(() => undefined);
    for (const id of workspaces) await workspaceClose(id).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}
