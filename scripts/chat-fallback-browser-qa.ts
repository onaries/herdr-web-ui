/** Real ChatView with an unavailable conversation and a stalled optional terminal. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { build as viteBuild } from "vite";
import { CONTENT_SECURITY_POLICY } from "../server/static.ts";
import { chromePath } from "./chrome-path.ts";
import { parseClaudeTranscript } from "../server/conversation.ts";
import type { ConversationTurn } from "../shared/protocol.ts";
const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-chat-fallback-")));
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
try {
  const repo = join(import.meta.dir, ".."), output = join(root, "dist");
  symlinkSync(join(repo, "node_modules"), join(root, "node_modules"), "dir");
  symlinkSync(join(repo, "scripts/chat-fallback-fixture.tsx"), join(root, "fixture.tsx"));
  writeFileSync(join(root, "index.html"), '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>');
  await viteBuild({ configFile: join(repo, "vite.config.ts"), root, publicDir: false, logLevel: "warn", build: { outDir: output, emptyOutDir: true } });
  const terminalReads: string[] = [];
  let structured = false, resolveAgent!: () => void, agentReadArrived!: () => void;
  let lookupTimeout = false;
  let source = "codex-transcript";
  let turns: ConversationTurn[] = [{ role: "assistant", ts: null, parts: [{ kind: "text", text: "Structured conversation arrived" }] }];
  // resolved by the server's handler: a browser-side waitForRequest can win the race against it
  const agentRead = new Promise<void>((resolve) => { agentReadArrived = resolve; });
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url), pane = url.searchParams.get("pane_id");
    if (url.pathname === "/api/pane/prompt") return Response.json({ prompt: null });
    // the chat's skill matcher asks for the pane's commands
    if (url.pathname === "/api/pane/commands") return Response.json({ commands: [] });
    if (url.pathname === "/api/pane/conversation") {
      if (lookupTimeout && pane === "agent") return Response.json({ error: { code: "gjc_sdk_timeout", message: "GJC SDK lookup timed out." } }, { status: 504 });
      return Response.json({ source: (structured && pane === "agent") || pane === "empty" ? source : "scrollback", cursor: null, turns: structured && pane === "agent" ? turns : [] });
    }
    if (url.pathname === "/api/pane/read") {
      terminalReads.push(pane ?? "");
      if (pane === "error") return Response.json({ error: { code: "read_failed", message: "Terminal output unavailable" } }, { status: 500 });
      const response = () => Response.json({ read: { text: pane === "shell" ? "Shell inline output" : "OLD AGENT TERMINAL", truncated: false } });
      if (pane === "agent") return new Promise<Response>((resolve) => { resolveAgent = () => resolve(response()); agentReadArrived(); });
      return response();
    }
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
    return new Response(Bun.file(join(output, url.pathname === "/" ? "index.html" : url.pathname.slice(1))), { headers: { "content-security-policy": CONTENT_SECURITY_POLICY } });
  } });
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage(); page.setDefaultTimeout(10_000);
  await page.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" })));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.port}`);
  const summary = page.locator(".chat-terminal-fallback summary");
  await summary.waitFor();
  await page.getByText("Loading conversation…", { exact: true }).waitFor({ state: "detached" });
  assert.equal(terminalReads.length, 0, "a hidden terminal read cannot hold the initial chat");
  assert.equal(await page.locator(".chat-empty").count(), 0, "an agent terminal fallback does not claim the conversation is empty");
  if (process.env.UI_EVIDENCE_DIR) {
    mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "terminal-fallback-closed.png") });
  }
  await summary.click();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([agentRead, new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("opening the disclosure never read the agent terminal")), 10_000); })]);
  clearTimeout(deadline);
  assert.ok(terminalReads.includes("agent"));
  structured = true;
  await page.evaluate(() => window.chatFallbackQA.refresh());
  await page.getByText("Structured conversation arrived", { exact: true }).waitFor();
  lookupTimeout = true;
  const timedOut = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/pane/conversation" && response.status() === 504);
  await page.evaluate(() => window.chatFallbackQA.refresh());
  await timedOut;
  await page.getByText("Waiting for the PC…", { exact: true }).waitFor();
  assert.equal(await page.getByText("Structured conversation arrived", { exact: true }).isVisible(), true, "a temporary SDK timeout keeps the already rendered conversation");
  assert.equal(await page.locator(".chat-terminal-fallback").count(), 0, "a timeout does not replace the conversation with terminal fallback");
  lookupTimeout = false;
  turns = [{ role: "assistant", ts: null, parts: [{ kind: "text", text: "Conversation recovered after SDK timeout" }] }];
  await page.evaluate(() => window.chatFallbackQA.refresh());
  await page.getByText("Conversation recovered after SDK timeout", { exact: true }).waitFor();
  await page.getByText("Waiting for the PC…", { exact: true }).waitFor({ state: "hidden" });
  const nextKindRead = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/pane/conversation", { timeout: 3_000 });
  await page.evaluate(() => window.chatFallbackQA.agent("claude"));
  await nextKindRead;
  resolveAgent();
  await page.locator(".chat-terminal-fallback").waitFor({ state: "detached" });
  assert.ok(!(await page.locator("body").innerText()).includes("OLD AGENT TERMINAL"));
  await page.evaluate(() => window.chatFallbackQA.pane("shell"));
  await page.getByText("Shell inline output", { exact: true }).waitFor();
  assert.ok(terminalReads.includes("shell"), "non-agent scrollback remains inline");
  await page.evaluate(() => window.chatFallbackQA.pane("error"));
  await summary.waitFor();
  await summary.click();
  // the failure is one line naming what failed, Try again beside it (no cause is known), and the
  // advice with the server's words folded behind Details (lib/userError.ts, ChatView FailureLine)
  const fallbackError = page.locator(".chat-terminal-fallback [role=\"alert\"]");
  await fallbackError.waitFor();
  assert.equal(await fallbackError.count(), 1, "terminal-read failures are announced as errors");
  assert.equal(await fallbackError.locator(".chat-failure-line").innerText(), "Couldn't load the terminal output", "the alert names what failed, nothing more on the line");
  assert.equal(await fallbackError.getByRole("button", { name: "Try again", exact: true }).count(), 1, "an unknown cause offers Try again");
  const fold = fallbackError.locator("details");
  assert.equal(await fold.locator("> summary").innerText(), "Details", "the rest is folded");
  assert.equal(await fold.evaluate((node: HTMLDetailsElement) => node.open), false, "and folded until asked");
  await fold.locator("> summary").click();
  assert.ok((await fold.innerText()).includes("Try again; if it keeps failing, restart herdr web ui on the PC."), "opened, Details holds the advice");
  assert.equal(await fold.locator("code").innerText(), "Terminal output unavailable", "and the server's words, selectable, beside it");
  assert.equal(await page.locator(".chat-empty").count(), 0, "a fallback failure is not an empty structured conversation");
  await page.evaluate(() => window.chatFallbackQA.pane("empty"));
  await page.getByText("No conversation yet — say something below", { exact: true }).waitFor();
  assert.equal(await page.locator(".chat-terminal-fallback").count(), 0, "an empty structured conversation keeps its ordinary prompt");
  // Native parser output crosses HTTP into the real ChatView. Later activity must not
  // move a final reply into the fold or duplicate it; narration and tools stay there.
  const jsonl = (...records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n");
  source = "claude-transcript";
  turns = parseClaudeTranscript(jsonl(
    { type: "assistant", timestamp: "2026-01-01T12:00:00Z", message: { content: [{ type: "text", text: "The catalog has three books." }], stop_reason: "end_turn" } },
    { type: "user", message: { content: "<task-notification><task-id>catalog</task-id><status>completed</status><summary>Catalog check finished.</summary></task-notification>" } },
    { type: "assistant", timestamp: "2026-01-01T12:01:00Z", message: { content: [{ type: "tool_use", id: "check", name: "Bash", input: { command: "true" } }], stop_reason: "tool_use" } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "check", content: "Two available" }] } },
    { type: "assistant", timestamp: "2026-01-01T12:02:00Z", message: { content: [{ type: "text", text: "Two books are available." }], stop_reason: "end_turn" } },
    { type: "user", isMeta: true, userType: "external", message: { content: "Background command catalog-check failed with exit code 124" } },
    { type: "assistant", timestamp: "2026-01-01T12:03:00Z", message: { content: [{ type: "text", text: "The background check timed out." }], stop_reason: "end_turn" } },
  ));
  await page.evaluate(() => { window.chatFallbackQA.agent("claude"); window.chatFallbackQA.pane("agent"); window.chatFallbackQA.refresh(); });
  await page.getByText("The background check timed out.", { exact: true }).waitFor();
  const replies = page.locator(".chat-turn-agent");
  console.log("Claude background reply rendering:", JSON.stringify(await replies.allTextContents()));
  assert.equal(await replies.count(), 3, "completed replies have separate message bubbles");
  for (const [index, text] of ["The catalog has three books.", "Two books are available.", "The background check timed out."].entries()) {
    assert.equal(await replies.nth(index).getByText(text, { exact: true }).isVisible(), true, "replies stay visible in transcript order");
    assert.equal(await replies.nth(index).locator("time").count(), 1, "each reply has its own time");
    assert.equal(await replies.nth(index).locator("time").getAttribute("datetime"), ["2026-01-01T12:00:00Z", "2026-01-01T12:01:00Z", "2026-01-01T12:03:00Z"][index], "each bubble keeps its own turn timestamp");
  }
  assert.equal(await replies.nth(0).locator(".work-block").count(), 0, "later tools do not move before the first reply");
  assert.equal(await replies.nth(1).locator(".work-block").count(), 1, "tools stay with the reply they produced");
  assert.equal(await replies.nth(2).locator(".work-block").count(), 0, "later reply does not inherit earlier tools");
  if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "claude-separate-replies.png") });
  console.log("PASS Claude background continuations keep separate replies, times and intervening work");
  {
    const answer = "The fictional Claude catalog contains three books.";
    const narration = "Checking the Claude catalog.";
    turns = parseClaudeTranscript(jsonl(
      { type: "assistant", message: { content: [{ type: "text", text: answer }], stop_reason: "end_turn" } },
      { type: "user", isMeta: true, userType: "external", message: { role: "user", content: "Stop hook feedback: Verify the fictional catalog." } },
      { type: "system", subtype: "stop_hook_summary" },
      { type: "assistant", message: { content: [{ type: "text", text: narration }, { type: "tool_use", id: "cleanup", name: "Bash", input: { command: "true" } }], stop_reason: "tool_use" } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "cleanup", content: "Verified" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "Catalog verification complete." }], stop_reason: "end_turn" } },
    ));
    await page.evaluate(() => { window.chatFallbackQA.agent("claude"); window.chatFallbackQA.pane("agent"); window.chatFallbackQA.refresh(); });
    await page.getByText(answer, { exact: true }).waitFor();
    const work = page.locator(".work-block");
    const head = work.locator(".work-block-head");
    await head.waitFor();
    if (await head.getAttribute("aria-expanded") === "true") await head.click();
    await work.locator(".work-block-rows").waitFor({ state: "hidden" });
    assert.equal(await work.getByText(answer, { exact: true }).count(), 0, "the reply is outside work");
    assert.equal(await page.getByText(answer, { exact: true }).count(), 1, "the reply appears once");
    assert.equal(await page.getByText(answer, { exact: true }).isVisible(), true, "folding work keeps the reply visible");
    assert.equal(await page.getByText("Catalog verification complete.", { exact: true }).isVisible(), true, "the hook continuation's short reply is also visible");
    assert.equal(await page.locator(".chat-turn-agent").count(), 2, "hook continuation answers have separate bubbles");
    assert.equal(await page.getByText(/Stop hook feedback:/).count(), 0, "injected hook context is not a user message");
    await head.click();
    await work.getByText(narration, { exact: true }).waitFor();
    assert.equal(await work.locator(".work-row-head").count(), 1, "the tool stays inside work");
    await head.click();
    if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "claude-hook-separate-replies.png") });
    console.log("PASS Claude hook replies stay separately visible outside folded work; narration and tool remain grouped");
  }
  assert.deepEqual(errors, []);
  console.log("chat fallback: browser OK (no hidden terminal reads, opened stalled output cannot block structured refresh, late cleanup, non-agent inline output, fallback error announcement and accurate empty state)");

} finally {
  await browser?.close(); server?.stop(true); rmSync(root, { recursive: true, force: true });
}
