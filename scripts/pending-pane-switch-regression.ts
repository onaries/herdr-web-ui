/** Connection-owned pending messages survive navigation, but never a lost connection. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type WebSocket as BrowserSocket, type WebSocketRoute } from "playwright-core";
import { createServer } from "../server/index.ts";
import { UsageService } from "../server/usage.ts";
import { herdrRpc, paneSplit, tabCreate, tabRename, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import type { ClientMessage, PendingMessage, ServerMessage } from "../shared/protocol.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-pending-switch-")));
const workspaces: string[] = [];
let server: ReturnType<typeof createServer> | undefined;
let browser: Browser | undefined;
async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, `timed out: ${label}`);
    await Bun.sleep(25);
  }
}
const paste = (text: string) => `\u001b[200~${text}\u001b[201~\r`;
try {
  const owner = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-pending-owner" });
  workspaces.push(owner.workspace.workspace_id);
  const away = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-pending-away" });
  workspaces.push(away.workspace.workspace_id);
  const pane = owner.root_pane.pane_id;
  await tabRename(owner.root_pane.tab_id, "Pending owner");
  const tab = await tabCreate({ workspaceId: owner.workspace.workspace_id, label: "Other tab" });
  const program = join(root, "claude");
  const script = join(root, "record.cjs");
  const log = join(root, "input.jsonl");
  copyFileSync(process.execPath, program); chmodSync(program, 0o755);
  writeFileSync(script, `const fs=require("node:fs");const out=process.argv[2];process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write("\\x1b[?2004h\\n› Message\\n",()=>fs.writeFileSync(out,""));process.stdin.on("data",c=>fs.appendFileSync(out,JSON.stringify(c.toString("utf8"))+"\\n"));`);
  await herdrRpc("pane.send_text", { pane_id: pane, text: `exec '${program}' '${script}' '${log}'\n` });
  await until(() => existsSync(log), "the owned foreground agent records input");
  const bytes = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string).join("");
  // An explicit observation interval, bounded and checked throughout, proves a negative:
  // no automatic delivery is permitted after the pane's native status becomes ready.
  const noBytes = async (expected: string, label: string): Promise<void> => {
    const deadline = Date.now() + 500;
    while (Date.now() < deadline) { assert.equal(bytes(), expected, label); await Bun.sleep(25); }
    assert.equal(bytes(), expected, label);
  };
  await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "claude", state: "working" });
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), usage: new UsageService(undefined, []) });
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox", "--accept-lang=en-US"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  await context.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", defaultView: "chat", alertsOn: false })));
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const sent: Array<{ socket: BrowserSocket; frame: ClientMessage }> = [];
  const received: Array<{ socket: BrowserSocket; frame: ServerMessage }> = [];
  const sockets: BrowserSocket[] = [];
  const ready = new Map<string, BrowserSocket>();
  const statuses = new Map<string, string>();
  let admit = true;
  let routed: WebSocketRoute | undefined;
  await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
    if (!admit) { void socket.close(); return; }
    socket.connectToServer(); routed = socket;
  });
  page.on("websocket", (socket) => {
    sockets.push(socket);
    socket.on("framesent", ({ payload }) => {
      const frame = JSON.parse(String(payload)) as ClientMessage;
      sent.push({ socket, frame });
      if (frame.type === "attach" || frame.type === "detach") ready.delete(frame.pane_id);
    });
    socket.on("framereceived", ({ payload }) => {
      const frame = JSON.parse(String(payload)) as ServerMessage;
      received.push({ socket, frame });
      if (frame.type === "snapshot") for (const item of frame.snapshot.panes) statuses.set(item.pane_id, item.agent_status);
      if (frame.type === "pane-status") statuses.set(frame.pane_id, frame.agent_status);
      if (frame.type === "input-ready") {
        if (frame.ready !== false) ready.set(frame.pane_id, socket); else ready.delete(frame.pane_id);
      }
    });
  });
  const frame = (id: string) => page.locator(`[data-layout-pane=${JSON.stringify(id)}]`);
  const current = (id: string) => frame(id).and(page.locator(".is-current"));
  const composer = () => current(pane).getByRole("textbox", { name: "Message", exact: true });
  const rows = () => current(pane).locator(".pending-message");
  const inputReady = (id: string) => until(() => {
    const connection = ready.get(id);
    return !!connection && !connection.isClosed();
  }, `${id} has its live input lease`);
  const selectWorkspace = async (id: string, selectedPane: string): Promise<void> => {
    await page.locator(`.workspace-group[data-workspace=${JSON.stringify(id)}] .pane-select`).click();
    await current(selectedPane).waitFor();
    await inputReady(selectedPane);
  };
  const report = async (state: "working" | "idle"): Promise<void> => {
    await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "claude", state });
    await until(() => state === "idle" ? ["idle", "done"].includes(statuses.get(pane) ?? "") : statuses.get(pane) === state, `the bridge reports ${state}`);
  };
  const queue = async (text: string): Promise<PendingMessage> => {
    await current(pane).locator('.composer-status[data-status="working"]').waitFor();
    await inputReady(pane);
    const after = received.length;
    await composer().fill(text);
    await current(pane).getByRole("button", { name: "Send message", exact: true }).click();
    await until(() => received.slice(after).some(({ frame }) => frame.type === "submit-result" && frame.pane_id === pane && frame.ok && frame.pending?.text === text), "the server accepts one pending ID");
    const result = received.slice(after).find(({ frame }) => frame.type === "submit-result" && frame.pane_id === pane && frame.pending?.text === text)!.frame;
    assert.ok(result.type === "submit-result" && result.pending);
    await rows().filter({ hasText: text }).waitFor();
    assert.equal(await rows().filter({ hasText: text }).getAttribute("data-state"), "queued");
    return result.pending;
  };
  const heldReceipt = (pending: PendingMessage, after: number) => until(() => received.slice(after).some(({ frame }) => frame.type === "pending-messages" && frame.pane_id === pane
    && frame.messages.some((item) => item.id === pending.id && item.state === "held")), "the original connection receives the held receipt while away");
  await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(pane)}`);
  await page.locator(".conn-live").waitFor();
  await current(pane).waitFor(); await inputReady(pane);
  const originalSocket = ready.get(pane)!;
  assert.equal(sockets.length, 1, "one PC uses one terminal connection");
  let delivered = "";
  for (const destination of ["tab", "workspace"] as const) {
    await report("working");
    const pending = await queue(`pending across ${destination}`);
    const leaveAt = received.length;
    const sentAt = sent.length;
    if (destination === "tab") {
      await page.getByRole("tab", { name: "Other tab", exact: true }).click();
      await current(tab.root_pane.pane_id).waitFor();
      await inputReady(tab.root_pane.pane_id);
    } else await selectWorkspace(away.workspace.workspace_id, away.root_pane.pane_id);
    await heldReceipt(pending, leaveAt);
    assert.ok(sent.slice(sentAt).some(({ socket, frame }) => socket === originalSocket && frame.type === "detach" && frame.pane_id === pane), "navigation gives up the old pane's input lease");
    assert.equal(originalSocket.isClosed(), false, "navigation keeps the receipt-owning connection alive");
    assert.equal(sockets.length, 1, "changing tabs and workspaces does not open another PC connection");
    await report("idle");
    await noBytes(delivered, "a ready agent cannot auto-send a held message while away");
    if (destination === "workspace") await selectWorkspace(owner.workspace.workspace_id, pane);
    else {
      await page.getByRole("tab", { name: "Pending owner", exact: true }).click();
      await current(pane).waitFor(); await inputReady(pane);
    }
    const row = rows().filter({ hasText: pending.text });
    await until(async () => await row.getAttribute("data-state") === "held", "the pending row returns as held, not uncertain");
    assert.equal(await row.getByRole("button", { name: /^Send now:/ }).isEnabled(), true);
    await noBytes(delivered, "returning to a ready agent does not resume automatic delivery");
    const actionAt = sent.length;
    await row.getByRole("button", { name: /^Send now:/ }).click();
    delivered += paste(pending.text);
    await until(() => bytes() === delivered, "Send now delivers the same pending ID exactly once");
    await row.waitFor({ state: "detached" });
    const actions = sent.slice(actionAt).filter(({ frame }) => frame.type === "pending-action");
    assert.equal(actions.length, 1);
    assert.deepEqual(actions.map(({ frame }) => frame.type === "pending-action" ? [frame.pane_id, frame.pending_id, frame.action] : []), [[pane, pending.id, "steer"]]);
    await report("working"); await report("idle");
    await noBytes(delivered, "a later ready turn never replays the completed pending ID");
  }
  console.log("PASS tab and workspace navigation retain pending ownership, release the old lease and permit one explicit Send now");

  // Visible split siblings keep their leases. They still share the same PC connection;
  // neither the other pane's input-ready nor its output can advance this agent's queue.
  const sibling = await paneSplit(pane, "right", false);
  await frame(sibling.pane_id).waitFor(); await inputReady(sibling.pane_id);
  assert.equal(ready.get(sibling.pane_id), originalSocket, "split panes share their PC connection");
  await report("working");
  const splitPending = await queue("pending while a sibling is selected");
  const splitSent = sent.length;
  await frame(sibling.pane_id).locator(".pane-frame-title").click();
  await current(sibling.pane_id).waitFor();
  assert.equal(sent.slice(splitSent).some(({ frame }) => frame.type === "detach" && frame.pane_id === pane), false, "selecting another visible split keeps the original pane attached");
  assert.equal(sockets.length, 1, "two visible panes use one PC connection");
  assert.equal(await current(sibling.pane_id).locator(".pending-message").count(), 0, "a sibling never shows the owner's pending message");
  await frame(pane).locator(".pane-frame-title").click(); await current(pane).waitFor();
  const splitRow = rows().filter({ hasText: splitPending.text });
  assert.equal(await splitRow.getAttribute("data-state"), "queued");
  await splitRow.getByRole("button", { name: "Discard", exact: true }).click();
  await splitRow.waitFor({ state: "detached" });
  assert.equal(bytes(), delivered);

  // A real lost WebSocket is different from component navigation: ownership must end.
  const disconnected = await queue("never replay after a lost connection");
  admit = false; await routed!.close();
  await page.locator(".conn-live").waitFor({ state: "hidden" });
  await until(async () => await rows().filter({ hasText: disconnected.text }).getAttribute("data-state") === "uncertain", "disconnect removes proof of the pending ID");
  admit = true;
  await page.locator(".conn-live").waitFor(); await inputReady(pane);
  const uncertain = rows().filter({ hasText: disconnected.text });
  assert.equal(await uncertain.locator(".pending-message-send").count(), 0, "an uncertain copy never offers Send now");
  await report("idle"); await noBytes(delivered, "reconnect and readiness never replay disconnected pending input");
  await uncertain.getByRole("button", { name: "Discard saved copy", exact: true }).click();
  await uncertain.waitFor({ state: "detached" });

  await report("working");
  const reloaded = await queue("never replay after reload");
  await page.reload(); await page.locator(".conn-live").waitFor(); await current(pane).waitFor(); await inputReady(pane);
  const saved = rows().filter({ hasText: reloaded.text });
  await saved.waitFor();
  assert.equal(await saved.getAttribute("data-state"), "uncertain", "reload restores text without connection proof");
  assert.equal(await saved.locator(".pending-message-send").count(), 0);
  await report("idle"); await noBytes(delivered, "reload and readiness never replay saved pending input");
  assert.deepEqual(errors, []);
  await context.close();
  console.log("PASS split panes share one connection; real disconnect and reload stay uncertain without automatic or explicit replay");
} finally {
  await browser?.close(); server?.stop();
  for (const workspace of workspaces) await workspaceClose(workspace).catch(() => {});
  rmSync(root, { recursive: true, force: true });
}
