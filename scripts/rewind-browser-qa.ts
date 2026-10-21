/**
 * Rewind to here, end to end: the real Claude Code (CLAUDE_BIN, else `claude` on PATH) resumes an
 * apple/banana session in the isolated herdr test session, with its own HOME and a made-up API key
 * (no model turn is needed: /rewind is Claude's own dialog), and the real server and React chat in
 * Chromium drive it. Failure first: with a draft in the message box the action is absent. Then
 * Rewind to here on apple opens Claude's confirm step as a card; Restore conversation answers it and
 * the chat drops apple and banana at once, apple back in the message box; a send from Chat then goes
 * through without touching the terminal. A grok pane's Rewind in terminal sends nothing and opens its
 * terminal with the hint. `REWIND_QA_EVIDENCE=<dir>` keeps screenshots at 1280 and 390.
 */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { claudeProjectDir } from "../server/claude-store.ts";
import { herdrRpc, sessionSnapshot, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";

const claude = process.env.CLAUDE_BIN || Bun.which("claude");
if (!claude || process.platform === "win32") { console.log("SKIP Rewind QA needs Claude Code (CLAUDE_BIN) on Linux or macOS"); process.exit(0); }

const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-rewind-browser-")));
const home = join(root, "home");
const config = join(home, ".claude");
const project = join(root, "proj");
mkdirSync(project, { recursive: true });
// a key Claude accepts the shape of and the API refuses: nothing here reaches a model
const key = `sk-ant-api03-${"x".repeat(80)}REWINDQAFAKEKEY00001`;
const settings = JSON.stringify({
  hasCompletedOnboarding: true, autoUpdates: false, theme: "dark",
  customApiKeyResponses: { approved: [key.slice(-20)], rejected: [] },
  projects: { [project]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, allowedTools: [] } },
});
mkdirSync(join(config, "projects", claudeProjectDir(project)), { recursive: true });
writeFileSync(join(config, ".claude.json"), settings);
writeFileSync(join(home, ".claude.json"), settings);
const session = crypto.randomUUID();
const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
const base = { isSidechain: false, userType: "external", cwd: project, sessionId: session, version: "2.1.304", gitBranch: "" };
const at = (seconds: number) => new Date(Date.now() - 3_600_000 + seconds * 1000).toISOString();
const user = (index: number, parent: string | null, text: string) => ({ parentUuid: parent, ...base, type: "user", message: { role: "user", content: text }, uuid: ids[index], timestamp: at(index * 5) });
const answer = (index: number, text: string) => ({
  parentUuid: ids[index - 1], ...base, type: "assistant", uuid: ids[index], timestamp: at(index * 5),
  message: { id: `msg_${index}`, type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
});
writeFileSync(join(config, "projects", claudeProjectDir(project), `${session}.jsonl`),
  [user(0, null, "apple"), answer(1, "Apple noted."), user(2, ids[1]!, "banana"), answer(3, "Banana noted.")].map((entry) => JSON.stringify(entry)).join("\n") + "\n");

// grok (Linux): a fictional native session and a stand-in process named as grok's binary, as
// scripts/grok-chat-browser-qa.ts sets them up. Its Rewind in terminal must type nothing
const grokRoot = join(root, "grok");
const grokSession = "00000000-0000-4000-8000-000000000032";
const grokDir = join(grokRoot, "sessions", "fiction", grokSession);
mkdirSync(grokDir, { recursive: true });
const grokEvents = join(grokDir, "events.jsonl");
writeFileSync(grokEvents, "");
const grokEvent = (update: object) => JSON.stringify({ timestamp: 1700000000, method: "session/update", params: { sessionId: grokSession, update } }) + "\n";
writeFileSync(join(grokDir, "updates.jsonl"), grokEvent({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "grok apple" }, _meta: { promptIndex: 0, modelId: "fictional-model" } })
  + grokEvent({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Fictional grok answer." } }));
const grokExecutable = join(grokRoot, "grok");
copyFileSync("/bin/sleep", join(grokRoot, "grok-1.0.50-linux-x86_64")); symlinkSync("grok-1.0.50-linux-x86_64", grokExecutable); chmodSync(grokExecutable, 0o755);

const evidence = process.env.REWIND_QA_EVIDENCE;
let workspace: string | undefined;
let grokWorkspace: string | undefined;
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const created = await workspaceCreate({ cwd: project, label: "herdr-web-ui-test-rewind" });
  workspace = created.workspace.workspace_id;
  const pane = created.root_pane.pane_id;
  // Claude starts as every agent here does: env -i, its own HOME and XDG dirs, PATH only
  const env = [`HOME=${home}`, `XDG_CONFIG_HOME=${join(root, "xdg", "config")}`, `XDG_STATE_HOME=${join(root, "xdg", "state")}`, `XDG_DATA_HOME=${join(root, "xdg", "data")}`,
    `XDG_CACHE_HOME=${join(root, "xdg", "cache")}`, `PATH=${process.env.PATH ?? ""}`, "TERM=xterm-256color", "LANG=en_US.UTF-8",
    `CLAUDE_CONFIG_DIR=${config}`, `ANTHROPIC_API_KEY=${key}`, "DISABLE_AUTOUPDATER=1", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1"];
  await herdrRpc("pane.send_text", { pane_id: pane, text: `env -i ${env.join(" ")} ${claude} --resume ${session}\n` });
  for (const deadline = Date.now() + 30_000; ;) {
    const shown = (await sessionSnapshot()).panes.find((candidate) => candidate.pane_id === pane);
    if (shown?.agent === "claude" && (shown.agent_status === "idle" || shown.agent_status === "done")) break;
    if (Date.now() > deadline) throw new Error("Claude Code did not come up waiting in the test pane");
    await Bun.sleep(100);
  }
  let grokPane: string | null = null;
  if (process.platform === "linux") {
    const grokCreated = await workspaceCreate({ cwd: grokRoot, label: "herdr-web-ui-test-rewind-grok" });
    grokWorkspace = grokCreated.workspace.workspace_id;
    grokPane = grokCreated.root_pane.pane_id;
    await herdrRpc("pane.send_text", { pane_id: grokPane, text: `env -i HOME=${home} PATH=${process.env.PATH ?? ""} ${grokExecutable} 600 3<${grokEvents}\n` });
    for (const deadline = Date.now() + 10_000; ;) {
      if ((await sessionSnapshot()).panes.find((candidate) => candidate.pane_id === grokPane)?.agent === "grok") break;
      if (Date.now() > deadline) throw new Error("the grok stand-in did not start");
      await Bun.sleep(50);
    }
    await herdrRpc("pane.report_agent_session", { pane_id: grokPane, source: "herdr:grok", agent: "grok", agent_session_id: grokSession, session_start_source: "new", seq: 1 });
  }
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), grokHome: grokRoot, tailscaleOwner: null });
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  page.setDefaultTimeout(20_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((ids) => { for (const id of ids) localStorage.setItem(`herdr-web-ui:view:${id}`, "chat"); }, [pane, grokPane].filter((id) => id !== null));
  const rewindRequests: string[] = [];
  page.on("request", (request) => { if (request.url().includes("/pane/rewind")) rewindRequests.push(request.url()); });
  await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(pane)}`);
  const frame = page.locator(`.pane-frame[data-layout-pane="${pane}"]`);
  const log = frame.getByRole("log");
  const bubble = (text: string) => log.locator(".chat-turn-user").filter({ has: page.locator(".chat-bubble", { hasText: new RegExp(`^${text}$`) }) });
  await bubble("banana").waitFor();
  const rewindOn = (text: string) => bubble(text).getByRole("button", { name: "Rewind to here" });
  await rewindOn("apple").waitFor({ state: "attached" });
  const shot = async (name: string): Promise<void> => {
    if (!evidence) return;
    mkdirSync(evidence, { recursive: true });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
      // on a phone the workspace list is a drawer: shot once it has slid out of view
      if (width === 390) await page.waitForFunction(() => (document.getElementById("workspace-drawer")?.getBoundingClientRect().right ?? 0) <= 1);
      await page.screenshot({ path: join(evidence, `task-32-agent-command-capabilities${name}${width === 390 ? ".390" : ""}.png`) });
    }
    await page.setViewportSize({ width: 1280, height: 800 });
  };

  // failure: a draft in the message box takes the action away, and it comes back with the box empty
  const box = frame.locator(".composer textarea").first();
  await box.fill("a draft");
  await rewindOn("apple").waitFor({ state: "detached" });
  assert.equal(await log.getByRole("button", { name: "Rewind to here" }).count(), 0);
  await shot(".failure");
  await box.fill("");
  await rewindOn("apple").waitFor({ state: "attached" });

  // happy, the plan's scenario: Rewind to here on apple, Restore conversation. Claude writes nothing
  // yet, but the chat ends before apple at once, banana gone with it, and apple waits in the message box
  await bubble("apple").hover();
  await rewindOn("apple").click();
  const card = page.locator(".prompt-card");
  await card.getByRole("button", { name: "Restore conversation" }).click();
  await card.waitFor({ state: "detached" });
  await bubble("banana").waitFor({ state: "detached" });
  await bubble("apple").waitFor({ state: "detached" });
  await page.waitForFunction((selector) => (document.querySelector(selector) as HTMLTextAreaElement | null)?.value === "apple",
    `.pane-frame[data-layout-pane="${pane}"] .composer textarea`);
  await shot("");

  // and the chat goes on from there, the terminal untouched: the send empties Claude's box first
  await box.fill("cherry");
  await frame.getByRole("button", { name: "Send message" }).click();
  await bubble("cherry").waitFor();
  assert.equal(await frame.getByRole("button", { name: "Send anyway" }).count(), 0);
  assert.equal(await bubble("banana").count(), 0);
  await shot(".sent");

  // grok: Rewind in terminal types nothing (no request to the rewind route), keeps a draft in the
  // message box, and opens the pane's terminal with the hint to run grok's own /rewind there
  if (grokPane !== null) {
    await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(grokPane)}`);
    const grokFrame = page.locator(`.pane-frame[data-layout-pane="${grokPane}"]`);
    const grokBubble = grokFrame.getByRole("log").locator(".chat-turn-user").filter({ hasText: "grok apple" });
    await grokBubble.waitFor();
    assert.equal(await grokBubble.getByRole("button", { name: "Rewind to here" }).count(), 0);
    const grokBox = grokFrame.locator(".composer textarea").first();
    await grokBox.fill("kept draft");
    const before = rewindRequests.length;
    await grokBubble.hover();
    await grokBubble.getByRole("button", { name: "Rewind in terminal" }).click();
    await grokFrame.locator(".terminal-banner-rewind").waitFor();
    await grokFrame.getByRole("log").waitFor({ state: "detached" });
    await shot(".grok-terminal");
    assert.equal(rewindRequests.length, before, "Rewind in terminal must send nothing to the rewind route");
    await page.getByRole("button", { name: "Chat", exact: true }).first().click();
    await page.waitForFunction((selector) => (document.querySelector(selector) as HTMLTextAreaElement | null)?.value === "kept draft",
      `.pane-frame[data-layout-pane="${grokPane}"] .composer textarea`);
    assert.equal(rewindRequests.length, before);
  }
  assert.deepEqual(errors, []);
  console.log("PASS Rewind to here: absent over a draft; apple restored from its card hides banana at once; the next Chat send goes through; grok's Rewind in terminal sends nothing and opens the terminal");
} finally {
  const cleanupErrors: unknown[] = [];
  try { await browser?.close(); } catch (error) { cleanupErrors.push(error); }
  try { server?.stop(); } catch (error) { cleanupErrors.push(error); }
  try { if (workspace) await workspaceClose(workspace); } catch (error) { cleanupErrors.push(error); }
  try { if (grokWorkspace) await workspaceClose(grokWorkspace); } catch (error) { cleanupErrors.push(error); }
  try { rmSync(root, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }
  if (cleanupErrors.length) {
    console.error(new AggregateError(cleanupErrors, "Rewind browser QA cleanup failed"));
    process.exitCode = 1;
  }
}
