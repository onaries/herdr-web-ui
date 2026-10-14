/** Real ChatView with an unavailable conversation and a stalled optional terminal. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { build as viteBuild } from "vite";
import { CONTENT_SECURITY_POLICY } from "../server/static.ts";
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
  // resolved by the server's handler: a browser-side waitForRequest can win the race against it
  const agentRead = new Promise<void>((resolve) => { agentReadArrived = resolve; });
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url), pane = url.searchParams.get("pane_id");
    if (url.pathname === "/api/pane/prompt") return Response.json({ prompt: null });
    if (url.pathname === "/api/pane/conversation") return Response.json({ source: (structured && pane === "agent") || pane === "empty" ? "codex-transcript" : "scrollback", cursor: null, turns: structured && pane === "agent" ? [{ role: "assistant", ts: null, parts: [{ kind: "text", text: "Structured conversation arrived" }] }] : [] });
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
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
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
  const fallbackError = page.getByText("Terminal output unavailable");
  await fallbackError.waitFor();
  assert.equal(await fallbackError.getAttribute("role"), "alert", "terminal-read failures are announced as errors");
  assert.equal(await page.locator(".chat-empty").count(), 0, "a fallback failure is not an empty structured conversation");
  await page.evaluate(() => window.chatFallbackQA.pane("empty"));
  await page.getByText("No conversation yet — say something below", { exact: true }).waitFor();
  assert.equal(await page.locator(".chat-terminal-fallback").count(), 0, "an empty structured conversation keeps its ordinary prompt");
  assert.deepEqual(errors, []);
  console.log("chat fallback: browser OK (no hidden terminal reads, opened stalled output cannot block structured refresh, late cleanup, non-agent inline output, fallback error announcement and accurate empty state)");

} finally {
  await browser?.close(); server?.stop(true); rmSync(root, { recursive: true, force: true });
}
