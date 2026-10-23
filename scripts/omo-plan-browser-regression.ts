/** Synthetic native OmO todo answers through the real bridge, sidebar and plan panel. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { omoSessionFolder } from "../server/omo.ts";
import { startShellAgent } from "../server/shell-agent.ts";
import { UsageService } from "../server/usage.ts";
import type { HerdrPane, ServerMessage } from "../shared/protocol.ts";

const root = mkdtempSync(join(tmpdir(), "omo-plan-browser-"));
const evidence = process.env.UI_EVIDENCE_DIR || join(root, "evidence");
mkdirSync(evidence, { recursive: true });
const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;
const id = "synthetic-omo-plan-session";
const store = join(root, "agent");
const sessions = join(store, "sessions", omoSessionFolder(root));
const readyDir = join(root, "ready");
mkdirSync(readyDir);
mkdirSync(sessions, { recursive: true });
const transcript = join(sessions, `2026-10-17T00-00-00-000Z_${id}.jsonl`);
const answer = "Overall: 1/3 done\n  Build:\n    - [X] Read the source\n    - [ ] Implement OmO plans (in progress)\n  Verify:\n    - [ ] Run isolated validation";
const records = [
  { type: "session", version: 3, id, cwd: root, timestamp: "2026-10-17T00:00:00.000Z" },
  { type: "message", id: "u1", parentId: null, message: { role: "user", content: [{ type: "text", text: "Show this synthetic plan" }] } },
  { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "t1", name: "todo", arguments: { op: "view" } }] } },
  { type: "message", id: "t1", parentId: "a1", timestamp: "2026-10-17T00:01:00.000Z", message: { role: "toolResult", toolName: "todo", toolCallId: "t1", content: [{ type: "text", text: answer }] } },
  { type: "message", id: "a2", parentId: "t1", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Synthetic plan ready" }] } },
];
writeFileSync(transcript, records.map((row) => JSON.stringify(row)).join("\n") + "\n");
const launcher = join(root, "omo-fixture.mjs");
writeFileSync(launcher, `import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { processStartedAt } from ${JSON.stringify(pathToFileURL(join(import.meta.dir, "../server/process-start.ts")).href)};
const dir = ${JSON.stringify(join(sessions, "session-holders", id))};
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, process.pid + ".json"), JSON.stringify({ pid: process.pid, processStartedAtMs: processStartedAt(process.pid), cwd: ${JSON.stringify(root)} }));
writeFileSync(${JSON.stringify(join(readyDir, "held"))}, "");
setInterval(() => {}, 1000);
`);

let workspaceId: string | undefined;
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let socket: WebSocket | undefined;
try {
  const created = await workspaceCreate({ cwd: root, label: "Synthetic OmO plan" });
  workspaceId = created.workspace.workspace_id;
  const paneId = created.root_pane.pane_id;
  // Subscribe before starting the fixture: the holder's publication is the readiness signal.
  const watcher = watch(readyDir);
  try {
    const ready = once(watcher, "change", { signal: AbortSignal.timeout(20_000) });
    await startShellAgent("omo", paneId, [], { command: `export OMO_CODING_AGENT_DIR=${quote(store)}; cd ${quote(root)} && exec ${quote(process.execPath)} ${quote(launcher)}` });
    await ready;
  } finally { watcher.close(); }
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), tailscaleOwner: null, usage: new UsageService(undefined, []) });
  const origin = `http://127.0.0.1:${server.port}`;
  // Plan polling pushes its exact changed state, so readiness needs no timing loop.
  await new Promise<void>((resolve, reject) => {
    const signal = AbortSignal.timeout(30_000);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    socket = new WebSocket(`ws://127.0.0.1:${server?.port}/ws`);
    socket.addEventListener("error", () => reject(new Error("Synthetic status socket failed")), { once: true });
    socket.addEventListener("message", (event) => {
      const frame: ServerMessage = JSON.parse(String(event.data));
      const snapshotPane: HerdrPane | undefined = frame.type === "snapshot" ? frame.snapshot.panes.find((pane) => pane.pane_id === paneId) : undefined;
      const plan = frame.type === "pane-status" && frame.pane_id === paneId ? frame.plan : snapshotPane?.plan;
      if (plan?.done === 1 && plan.total === 3) resolve();
    });
  });
  const response = await fetch(`${origin}/api/session`, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  const body: { snapshot: { panes: HerdrPane[] } } = await response.json();
  const pane = body.snapshot.panes.find((item) => item.pane_id === paneId);
  assert.equal(pane?.agent, "omo");
  assert.deepEqual(pane.plan, { done: 1, total: 3, current: "Implement OmO plans" });
  writeFileSync(join(evidence, "snapshot-pane.json"), JSON.stringify(pane, null, 2) + "\n");

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox", "--no-proxy-server"] });
  const errors: string[] = [];
  for (const width of [1280, 390]) {
    for (const theme of ["dark", "light"] as const) {
      const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: width === 390, hasTouch: width === 390, colorScheme: theme, locale: "en-US" });
      try {
        await context.addInitScript(({ paneId, theme }) => {
          localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme }));
          localStorage.setItem(`ovis:view:${paneId}`, "chat");
        }, { paneId, theme });
        const page = await context.newPage();
        page.setDefaultTimeout(20_000);
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${origin}/?pane=${encodeURIComponent(paneId)}`);
        await page.locator(".conn-live").waitFor();
        if (width === 390) {
          await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
          await page.locator(".agents-sidebar .agent-section-toggle").click();
        }
        const row = page.locator(`.agents-sidebar .agent-item[data-pane="${paneId}"]`);
        const badge = row.getByTestId("plan-progress");
        await badge.waitFor({ state: "visible" });
        assert.equal(await badge.textContent(), "1/3");
        await page.screenshot({ path: join(evidence, `${width}-${theme}-sidebar.png`), fullPage: true });
        await row.locator(".agent-select").click();
        const toggle = page.locator(".bg-tasks-toggle");
        await toggle.click();
        const panel = page.locator(".bg-tasks-menu");
        await panel.locator(".bg-step.is-in_progress").getByText("Implement OmO plans", { exact: true }).waitFor();
        assert.deepEqual(await panel.locator(".bg-step .bg-task-title").allTextContents(), ["Read the source", "Implement OmO plans", "Run isolated validation"]);
        await page.screenshot({ path: join(evidence, `${width}-${theme}-plan.png`), fullPage: true });
        console.log(`PASS ${width}px ${theme}: sidebar 1/3 and all three plan steps`);
      } finally { await context.close(); }
    }
  }
  assert.deepEqual(errors, []);
  console.log(`PASS pane.plan ${JSON.stringify(pane.plan)}`);
  console.log(`Evidence: ${evidence}`);
} finally {
  socket?.close();
  try { await browser?.close(); } finally {
    try { server?.stop(); } finally {
      try { if (workspaceId !== undefined) await workspaceClose(workspaceId); } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }
  console.log("Cleanup: browser, bridge, fixture workspace and fixture directory removed");
}
