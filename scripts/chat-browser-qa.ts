/** Native transcript -> real HTTP -> React checks on an owned herdr pane.
 * Run after bun run build. No live user's terminal is attached or written. */
import "./test-herdr.ts"; // a herdr session of its own: nothing shows in the user's
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-chat-browser-"));
const codexHome = join(root, "codex");
const rollout = join(codexHome, "sessions", "rollout.jsonl");
const answer = "The conversation is now clean. Native transcript records preserve the user request and final answer while internal instructions stay hidden.";
const records: unknown[] = [];
const add = (payload: unknown, second: number) => records.push({ type: "response_item", timestamp: `2026-09-22T00:00:${String(second).padStart(2, "0")}Z`, payload });
const message = (role: string, text: string, phase?: string) => ({ type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }], ...(phase ? { phase } : {}) });
const persist = () => writeFileSync(rollout, records.map((record) => JSON.stringify(record)).join("\n"));
let workspaceId: string | undefined;
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let release: (() => void) | undefined;

try {
  mkdirSync(join(codexHome, "sessions"), { recursive: true });
  const db = new Database(join(codexHome, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (rollout_path TEXT, cwd TEXT, archived INTEGER, agent_role TEXT, updated_at INTEGER)");
  db.query("INSERT INTO threads VALUES (?, ?, 0, NULL, 1)").run(rollout, root);
  db.close();
  records.push({ type: "session_meta", payload: { id: "01a0c7a1-56d9-7e20-9f08-f7a2d973bcbb", cwd: root } });
  records.push({ type: "turn_context", payload: { model: "codex-test-model", effort: "xhigh" } });
  add(message("developer", "PRIVATE DEVELOPER CONTEXT"), 0);
  add(message("user", "# AGENTS.md instructions for /demo\n<INSTRUCTIONS>PRIVATE PROJECT CONTEXT</INSTRUCTIONS>"), 0);
  add(message("user", "Please check the chat display."), 0);
  add(message("assistant", "I am checking the transcript.", "commentary"), 1);
  add({ type: "function_call", name: "exec_command", call_id: "c1", arguments: '{"cmd":"git status"}' }, 2);
  add({ type: "function_call_output", call_id: "c1", output: "clean" }, 3);
  add({ type: "function_call", name: "exec_command", call_id: "c2", arguments: '{"cmd":"bun test"}' }, 4);
  add({ type: "function_call_output", call_id: "c2", output: "Process exited with code 1\n1 fail" }, 5);
  add(message("assistant", answer, "final_answer"), 8);
  persist();
  const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-chat-browser" });
  workspaceId = created.workspace.workspace_id;
  const paneId = created.root_pane.pane_id;
  await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "codex", state: "idle", agent_session_path: rollout });
  await herdrRpc("pane.send_text", { pane_id: paneId, text: `printf '%s\\n' '${answer}'\n` });
  // tailscaleOwner null: the plain-HTTP page below reaches the server under a name that is not
  // loopback, which a PC running Tailscale would otherwise send to pairing
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "push"), codexHome, tailscaleOwner: null });
  browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox", "--host-resolver-rules=MAP clipboard.test 127.0.0.1", "--no-proxy-server"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  const page = await context.newPage();
  // a pane opens its terminal the first time; this QA is about the chat lens
  await page.addInitScript((id) => localStorage.setItem(`herdr-web-ui:view:${id}`, "chat"), paneId);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(10_000);
  await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(paneId)}`);
  await page.locator(".conn-live").waitFor();
  const log = page.getByRole("log", { name: `conversation of ${paneId}` });
  await log.getByText(answer, { exact: true }).waitFor();
  assert.equal(await log.locator(".chat-turn-user").count(), 1);
  assert.equal((await log.innerText()).includes("PRIVATE"), false);
  const modelInfo = page.getByLabel("Model and reasoning");
  await modelInfo.getByText("codex-test-model", { exact: true }).waitFor();
  // the level is drawn as one word; the sentence is the screen reader's
  await modelInfo.getByText("xhigh", { exact: true }).waitFor();
  await modelInfo.getByText("Reasoning xhigh", { exact: true }).waitFor({ state: "attached" });
  assert.equal(await page.locator(".composer-surface > .composer-status").count(), 1, "the status content is inside the input card");
  assert.equal(await page.locator(".composer-surface").evaluate((card) => {
    const box = (selector: string): DOMRect => card.querySelector(selector)!.getBoundingClientRect();
    const [text, attach, status, action] = [box(".composer-text"), box(".composer-attach"), box(".composer-status"), box(".composer-action")];
    return card.querySelectorAll(".composer-action").length === 1 && action.width === action.height
      // the message is the first row, at the card's full width
      && text.width >= card.getBoundingClientRect().width - 4 && text.bottom <= Math.min(attach.top, action.top)
      // and one row under it: add, then the status content, then the round button
      && attach.right <= status.left && status.right <= action.left && status.top < action.bottom && status.bottom > action.top;
  }), true, "the message on top, one row of controls under it, one round button");
  assert.equal(await page.locator(".composer-status").evaluate((node) => {
    // Every pane status word is read by assistive tech, not drawn in the chat controls.
    const word = node.querySelector("strong");
    const hidden = [node.querySelector(".composer-agent-label"), word, node.querySelector(".composer-reasoning-full")];
    return hidden.every((item) => item !== null && item.textContent !== "" && item.getBoundingClientRect().width <= 1);
  }), true, "the agent's name, every pane status word and the reasoning sentence are read, not drawn");
  const work = log.locator(".work-block-head");
  const report = (state: "working" | "idle") => herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "codex", state, agent_session_path: rollout });
  const head = (expanded: boolean, title: string) => log.locator(`.work-block-head[aria-expanded="${expanded}"]`).filter({ hasText: title });
  await head(false, "Worked for 7s").waitFor();
  await report("working");
  await head(true, "Working…").waitFor();
  assert.equal(await log.locator(".work-block.is-folded").count(), 0, "the running turn's work is open");
  await report("idle");
  await head(false, "Worked for 7s").waitFor();
  // working inside the block is a choice to keep it: the fold must not take a focused row away
  await report("working");
  await head(true, "Working…").waitFor();
  // the row reads as verb + object (#457); its tool id is the title
  const toolRow = log.getByRole("button", { name: "Ran git status", exact: true });
  await toolRow.click();
  await log.getByText("git status", { exact: true }).last().waitFor();
  await report("idle");
  await head(true, "Worked for 7s").waitFor();
  assert.equal(await toolRow.evaluate((node) => node === document.activeElement), true, "the row the reader opened keeps focus when the turn settles");
  await log.getByText("git status", { exact: true }).last().waitFor();
  await work.click();
  await head(false, "Worked for 7s").waitFor();
  console.log("PASS the running turn's work is open, folds when it settles, and stays open under a reader working inside it");
  assert.equal(await work.getAttribute("aria-expanded"), "false", "a settled turn folds its work: only a running turn is open");
  assert.equal(await log.locator(".work-block.is-folded").count(), 1);
  assert.match(await work.innerText(), /Worked for 7s/);
  await work.click();
  assert.equal(await work.getAttribute("aria-expanded"), "true");
  // a tool the verb table knows reads as verb + object; its id is the title and the detail's first line
  const row = log.getByRole("button", { name: "Ran git status", exact: true });
  assert.equal(await row.getAttribute("title"), "exec_command · git status");
  assert.equal(await row.locator(".work-row-caret").isVisible(), true);
  assert.equal(await row.locator(".work-row-icon, .work-row-sep").count(), 0);
  // a failed call says so after its object, never between the verb and what it ran
  const failedRow = log.getByRole("button", { name: "Ran bun test failed", exact: true });
  assert.equal(await failedRow.evaluate((node) => node.lastElementChild?.className), "work-row-failed");
  assert.equal(await failedRow.getAttribute("title"), "exec_command · bun test");
  await row.click();
  assert.equal(await log.locator(".work-row-detail > :first-child").innerText(), "exec_command");
  await log.getByText("git status", { exact: true }).last().waitFor();
  assert.equal(await log.locator(".chat-agent-meta").count(), 1);
  console.log("PASS native user/answer rendering, internal context filtering, settled work folded, tool expansion, duration");

  add(message("user", "A second request."), 20); persist();
  await log.getByText("A second request.", { exact: true }).waitFor();
  assert.equal(await work.getAttribute("aria-expanded"), "true", "manual expansion is preserved when a new turn arrives");
  await work.click();
  assert.equal(await work.getAttribute("aria-expanded"), "false", "and so is folding it again");
  add(message("assistant", "Checking the second request.", "commentary"), 21); persist();
  // the pane is idle: this turn is settled and has no answer, so folding it would hide its only text
  await log.getByText("Checking the second request.", { exact: true }).waitFor();
  assert.equal(await work.first().getAttribute("aria-expanded"), "false", "manual folding is preserved");
  assert.equal(await work.nth(1).getAttribute("aria-expanded"), "true", "a settled turn that ends in commentary keeps its text in view");
  assert.equal(await log.locator(".chat-agent-meta").count(), 1, "commentary is not a final answer");
  console.log("PASS manual state persists, commentary stays inside work and stays visible when the turn has no answer");

  records.push({ type: "turn_context", payload: { model: "codex-updated-model", effort: "low" } }); persist();
  await modelInfo.getByText("codex-updated-model", { exact: true }).waitFor();
  await modelInfo.getByText("low", { exact: true }).waitFor();
  await modelInfo.getByText("Reasoning low", { exact: true }).waitFor({ state: "attached" });
  assert.equal(await modelInfo.getByText("codex-test-model", { exact: true }).count(), 0);
  console.log("PASS model and reasoning metadata update without a new message");

  const imagePath = join(root, "native-image.png");
  copyFileSync("public/icons/icon-192.png", imagePath);
  records.push({ type: "event_msg", timestamp: "2026-09-22T00:00:22Z", payload: { type: "user_message", message: "", local_images: [imagePath] } });
  persist();
  const nativeImage = log.locator(".chat-user-images img");
  await nativeImage.waitFor();
  await page.waitForFunction(() => {
    const image = document.querySelector<HTMLImageElement>(".chat-user-images img");
    return image !== null && image.complete && image.naturalWidth > 0;
  });
  assert.equal(await nativeImage.count(), 1);
  console.log("PASS native Codex image-only turn loads its pane-scoped thumbnail");

  const gate = new Promise<void>((resolve) => { release = resolve; });
  let requests = 0;
  await page.route("**/api/pane/conversation?*", async (route) => { requests += 1; await gate; await route.continue(); });
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("true");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.waitForTimeout(250);
  assert.equal(await log.getByText(answer, { exact: true }).count(), 1, "send refresh must not blank existing history");
  const beforeWait = requests;
  await page.waitForTimeout(2500);
  assert.equal(requests, beforeWait, "slow polls must not overlap");
  release();
  await page.unrouteAll({ behavior: "wait" });
  console.log("PASS send refresh preserves history and slow polling does not overlap");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#workspace-drawer").waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await log.evaluate((node) => node.scrollWidth <= node.clientWidth), true, "chat contents fit the mobile scroller");
  // the wrapper has no box of its own (display: contents): measure the name and the level themselves
  const statusItems = page.locator(".composer-model, .composer-reasoning");
  assert.equal(await statusItems.evaluateAll((items) => items.length === 2 && items.every((item) => item.getBoundingClientRect().width > 0 && item.getBoundingClientRect().right <= innerWidth)), true, "model and reasoning stay visible on mobile");
  assert.equal(await page.locator(".composer-status").evaluate((node) => node.scrollWidth <= node.clientWidth), true, "the status content fits its place in the controls row");
  // a level that does not fit steps out whole (read, not drawn): it is never drawn in part
  await page.waitForFunction(() => {
    const level = document.querySelector(".composer-reasoning");
    return level !== null && (level.scrollWidth <= level.clientWidth || level.getBoundingClientRect().width <= 1);
  }, undefined, { timeout: 5_000 });
  mkdirSync("evidence/chat-mode", { recursive: true });
  await page.screenshot({ path: "evidence/chat-mode/mobile.png", fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ path: "evidence/chat-mode/desktop.png", fullPage: true, animations: "disabled" });
  // Read back Chromium's actual clipboard from the secure loopback page. The copy itself
  // runs on an ordinary HTTP hostname, where navigator.clipboard genuinely does not exist.
  const secureOrigin = `http://127.0.0.1:${server.port}`;
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: secureOrigin });
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
  const code = "printf 'clipboard ✓'";
  add(message("assistant", `\`\`\`sh\n${code}\n\`\`\``, "final_answer"), 9);
  persist();
  const insecure = await page.context().newPage();
  await insecure.addInitScript((id) => localStorage.setItem(`herdr-web-ui:view:${id}`, "chat"), paneId);
  insecure.on("pageerror", (error) => errors.push(error.message));
  await insecure.goto(`http://clipboard.test:${server.port}/?pane=${encodeURIComponent(paneId)}`);
  const insecureLog = insecure.getByRole("log", { name: `conversation of ${paneId}` });
  await insecureLog.getByText(answer, { exact: true }).waitFor();
  assert.equal(await insecure.evaluate(() => window.isSecureContext), false);
  assert.equal(await insecure.evaluate(() => typeof navigator.clipboard), "undefined");
  const messageCopy = insecureLog.getByRole("button", { name: "Copy as markdown", exact: true }).first();
  await messageCopy.focus();
  await messageCopy.click();
  assert.deepEqual(errors, [], "copying on HTTP must not throw a browser error");
  await insecureLog.getByRole("button", { name: "Copied", exact: true }).waitFor();
  assert.equal(await clipboard(), answer);
  assert.equal(await insecureLog.getByRole("button", { name: "Copied", exact: true }).evaluate((node) => node === document.activeElement), true, "fallback restores the triggering button's focus");
  assert.equal(await insecure.locator("textarea[readonly]").count(), 0);
  await insecureLog.getByRole("button", { name: "Copy code", exact: true }).focus();
  await insecureLog.getByRole("button", { name: "Copy code", exact: true }).click();
  await insecureLog.getByRole("button", { name: "Code copied", exact: true }).waitFor();
  assert.equal(await clipboard(), code);
  // A rejected secure API still gets the copy-command path. Neither failure may be
  // advertised as success if the browser refuses both mechanisms.
  const secureCopy = page.getByRole("button", { name: "Copy as markdown", exact: true }).first();
  await secureCopy.focus();
  await secureCopy.click();
  await page.getByRole("button", { name: "Copied", exact: true }).waitFor();
  assert.equal(await clipboard(), answer, "the native secure-context API copies the message");
  await page.getByRole("button", { name: "Copy code", exact: true }).waitFor();
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.reject(new DOMException("Denied", "NotAllowedError")), readText: navigator.clipboard.readText.bind(navigator.clipboard) } }));
  await page.getByRole("button", { name: "Copy code", exact: true }).focus();
  await page.getByRole("button", { name: "Copy code", exact: true }).click();
  await page.getByRole("button", { name: "Code copied", exact: true }).waitFor();
  assert.equal(await clipboard(), code);
  await insecure.evaluate(() => { document.execCommand = () => false; });
  await insecureLog.getByRole("button", { name: "Copy as markdown", exact: true }).first().waitFor();
  await messageCopy.focus();
  await messageCopy.click();
  await insecureLog.getByRole("alert").filter({ hasText: "Couldn't copy. Select the text and copy it manually." }).waitFor();
  assert.equal(await messageCopy.getAttribute("aria-label"), "Copy as markdown");
  // the hint outlives the hover/focus that shows the copy controls (reduced motion: no fade to wait out)
  await insecure.emulateMedia({ reducedMotion: "reduce" });
  await insecure.mouse.move(0, 0);
  await insecure.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const messageHint = insecureLog.getByRole("alert").filter({ hasText: "Couldn't copy. Select the text and copy it manually." }).first();
  assert.equal(await messageHint.evaluate((node) => {
    for (let element: Element | null = node; element !== null; element = element.parentElement) if (getComputedStyle(element).opacity === "0") return false;
    return true;
  }), true, "the manual-copy hint stays visible after the pointer and focus leave the turn");
  await insecureLog.getByRole("button", { name: "Copy code", exact: true }).waitFor();
  await insecureLog.getByRole("button", { name: "Copy code", exact: true }).focus();
  await insecureLog.getByRole("button", { name: "Copy code", exact: true }).click();
  await insecureLog.getByRole("alert").filter({ hasText: "Couldn't copy. Select the text and copy it manually." }).nth(1).waitFor();
  assert.equal(await insecureLog.getByRole("alert").filter({ hasText: "Couldn't copy. Select the text and copy it manually." }).count(), 2);
  assert.equal(await insecureLog.getByRole("button", { name: "Code copied", exact: true }).count(), 0);
  assert.equal(await insecure.locator("textarea[readonly]").count(), 0, "temporary copy field is removed");
  await insecure.screenshot({ path: "evidence/chat-mode/clipboard-refused.png", fullPage: true, animations: "disabled" });
  await insecure.close();
  console.log("PASS actual clipboard contents on HTTP, denied API fallback, and refused-copy feedback");
  rmSync(rollout);
  const fallback = log.locator(".chat-terminal-fallback");
  await fallback.waitFor();
  await modelInfo.waitFor({ state: "hidden" });
  assert.equal(await fallback.getAttribute("open"), null, "unmatched Codex output stays folded");
  assert.deepEqual(errors, []);
  console.log("PASS mobile layout, explicit collapsed fallback, no browser errors");
} finally {
  release?.();
  await browser?.close();
  server?.stop();
  if (workspaceId) await workspaceClose(workspaceId);
  rmSync(root, { recursive: true, force: true });
}
