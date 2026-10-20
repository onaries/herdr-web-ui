import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import { appFaces } from "./app-faces.ts";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

// What became of a command sent from Chat, on the unmodified app over the demo's fixture transport
// (site/demo/transport.ts tracks each send as the bridge would): the chip under the sent bubble
// moves from accepted to done on the demo's transcript evidence, an inline `$review` to the Codex
// pane and an unlisted `/myext run` to the pi pane get chips of their own, and a Claude `/btw`,
// which the agent answers on its screen alone, keeps its sent row with "Runs in the terminal", the
// transcript unchanged, a folded preview of the changed screen, and is never done. Every scenario
// runs in a 1280×800 window and on a 390×844 phone, light and dark. Screenshots go to
// command-outcome/ under UI_EVIDENCE_DIR (CI's uploaded folder) or else evidence/. All files and
// HTTP traffic stay in this disposable, loopback-only app; no herdr session is opened.
const repo = join(import.meta.dir, "..");
const app = mkdtempSync(join(tmpdir(), "herdr-command-outcome-demo-"));
const evidence = join(process.env.UI_EVIDENCE_DIR || join(repo, "evidence"), "command-outcome");
const RUNS = [[1280, "light"], [1280, "dark"], [390, "light"], [390, "dark"]] as const;
/** the demo answers a chat message, and settles a command's outcome, in 2.4 s; its outcome poll is 2 s */
const SETTLE_MS = 15_000;

const failures: string[] = [];

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  writeFileSync(index, html.replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    <script type="module"`));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/herdr-web-ui/demo/app/")) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice("/herdr-web-ui/demo/app/".length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return (await body.exists()) ? new Response(body) : new Response("not found", { status: 404 });
  } });
  const url = (pane: string): string => `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(pane)}`;
  mkdirSync(evidence, { recursive: true });

  /** The chat lens over one pane: a pane switched away from keeps a hidden frame, so the owner tells them apart. */
  const chatStack = (page: Page, pane: string): Locator => page.locator(`.terminal-stack.is-chat[data-pane-owner="${pane}"]`);
  /** The pane's chat log, once the chat lens shows it; the sidebar's row names its pane first. */
  const chatOf = async (page: Page, pane: string): Promise<Locator> => {
    const row = page.locator(`.pane-select[title^="${pane} —"]`).first();
    await row.waitFor({ state: "attached" });
    if (await row.getAttribute("aria-current") !== "true") {
      await row.evaluate((node: HTMLElement) => node.click());
      await page.locator(`.pane-select[title^="${pane} —"][aria-current="true"]`).first().waitFor({ state: "attached" });
    }
    const stack = chatStack(page, pane);
    if (await stack.count() === 0) await page.getByTitle("Chat transcript (⌘⇧J)", { exact: true }).click();
    await stack.waitFor();
    return stack.getByRole("log");
  };
  const send = async (page: Page, text: string): Promise<void> => {
    const box = page.getByRole("textbox", { name: "Message", exact: true });
    await box.fill(text);
    await page.getByRole("button", { name: "Send message", exact: true }).click();
  };
  /** the one chip for `text`: on the turn that records it, or on its provisional sent row, never both */
  const chipFor = (log: Locator, text: string): Locator => log.locator(".chat-turn-user").filter({ has: log.page().locator(".chat-bubble-body", { hasText: text }) }).locator(".chat-outcome");

  const withPane = async (browser: Browser, width: number, scheme: "light" | "dark", run: (page: Page, errors: string[]) => Promise<void>): Promise<void> => {
    const touch = width <= 480;
    const context = await browser.newContext({ viewport: { width, height: touch ? 844 : 800 }, hasTouch: touch, isMobile: touch, colorScheme: scheme, locale: "en-US" });
    try {
      await context.addInitScript((theme) => {
        localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", theme }));
        for (const pane of ["w1H:p1", "w1D:p1", "w1K:p1"]) localStorage.setItem(`herdr-web-ui:view:${pane}`, "chat");
      }, scheme);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.setDefaultTimeout(SETTLE_MS);
      await page.goto(url(panes.flaky));
      await page.locator(".conn-live").waitFor({ state: "attached" });
      await chatStack(page, panes.flaky).waitFor();
      await page.locator(".chat-turn-user").first().waitFor();
      await appFaces(page);
      await run(page, errors);
      assert.deepEqual(errors, [], `page errors at ${width}px (${scheme})`);
    } finally {
      await context.close();
    }
  };

  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  try {
    for (const [width, scheme] of RUNS) {
      const label = `${width}px ${scheme}`;
      const shot = (name: string) => join(evidence, `${width}-${scheme}-${name}.png`);
      try {
        await withPane(browser, width, scheme, async (page) => {
          // happy: a Claude /context is accepted, then done on the transcript, on the one bubble for it
          const claude = await chatOf(page, panes.flaky);
          const turnsBefore = await claude.locator(".chat-turn-user").count();
          await send(page, "/context");
          const context = chipFor(claude, "/context");
          await context.and(page.locator('[data-outcome-state="accepted"]')).waitFor();
          assert.equal(await context.locator('.chat-outcome-state[role="status"]').count(), 1, "the chip's words are a live region");
          assert.equal(await claude.locator(".chat-bubble-body", { hasText: "/context" }).count(), 1, "one bubble for the send while its chip is accepted");
          await context.and(page.locator('[data-outcome-state="result-observed"]')).waitFor();
          assert.equal(await claude.locator(".chat-bubble-body", { hasText: "/context" }).count(), 1, "one bubble for the send once it is done");
          assert.equal(await claude.locator(".chat-turn-sent").count(), 0, "the transcript's own turn carries the chip; no provisional row stays");
          assert.equal(await claude.locator(".chat-turn-user").count(), turnsBefore + 1);
          assert.match(await context.locator(".chat-outcome-state").innerText(), /^Done/);
          await page.screenshot({ path: shot("context-done"), animations: "disabled" });
          console.log(`PASS ${label}: /context shows accepted, then done on the transcript, on one bubble`);

          // failure: /btw is answered on the screen alone: the composer offers the terminal, Run in
          // Terminal sends it, and back in the chat its sent row says so and never turns done
          await send(page, "/btw is the retry test flaky on CI too?");
          await page.getByRole("button", { name: "Run in Terminal", exact: true }).click();
          await chatStack(page, panes.flaky).waitFor({ state: "detached" });
          const back = await chatOf(page, panes.flaky);
          const btw = chipFor(back, "/btw is the retry test flaky");
          await btw.and(page.locator('[data-outcome-state="terminal-required"]')).waitFor();
          assert.equal(await back.locator(".chat-turn-sent").count(), 1, "the send has a row of its own: the transcript holds no turn for it");
          assert.equal(await back.locator(".chat-turn-user:not(.chat-turn-sent)").count(), turnsBefore + 1, "the transcript stays as it was after /context");
          assert.equal(await btw.locator(".chat-outcome-state").innerText(), "Runs in the terminal");
          const preview = btw.locator(".chat-outcome-preview");
          await preview.waitFor();
          assert.match(await preview.locator("summary").innerText(), /^Terminal output changed after \/btw, not confirmed$/);
          assert.equal(await preview.getAttribute("open"), null, "the preview starts folded");
          await preview.locator("summary").click();
          await preview.locator(".chat-outcome-preview-text").waitFor();
          const lines = await preview.locator(".chat-outcome-preview-text").evaluate((node) => node.textContent?.split("\n").length ?? 0);
          assert.ok(lines >= 3, `the preview keeps its line breaks (${lines} lines)`);
          assert.equal(await preview.locator(".chat-outcome-preview-text").evaluate((node) => getComputedStyle(node).whiteSpace), "pre-wrap");
          // opened at the transcript's end, the screen text is brought into view above the input card, not left under it
          await page.waitForFunction(() => {
            const text = document.querySelector(".chat-outcome-preview-text");
            const composer = document.querySelector(".terminal-stack.is-chat .composer");
            return text !== null && composer !== null && text.getBoundingClientRect().bottom <= composer.getBoundingClientRect().top + 1;
          }, undefined, { timeout: 5_000 });
          await page.screenshot({ path: shot("btw-terminal"), animations: "disabled" });
          // the demo's answer window has passed (the /context send above went done in it): still not done
          await send(page, "and one more question for the transcript");
          await back.locator(".chat-bubble-body", { hasText: "and one more question for the transcript" }).waitFor();
          await back.locator(".chat-turn-agent").last().getByText("This is the demo, so nothing ran", { exact: false }).waitFor();
          assert.equal(await btw.getAttribute("data-outcome-state"), "terminal-required", "a typed-only command is never done");
          assert.equal(await back.locator(".chat-turn-sent").count(), 1, "and its row stays where it was sent");
          console.log(`PASS ${label}: /btw keeps its sent row with Runs in the terminal, a folded preview with line breaks, and is never done`);

          if (!(width <= 480)) {
            // keyboard: from the row's copy button, Tab reaches Open Terminal, then the preview's summary
            await back.locator(".chat-turn-sent .chat-copy").focus();
            await page.keyboard.press("Tab");
            assert.equal(await page.evaluate(() => document.activeElement?.className), "chat-outcome-action", "Tab from the row reaches Open Terminal");
            await page.keyboard.press("Tab");
            assert.equal(await page.evaluate(() => document.activeElement?.tagName), "SUMMARY", "then the preview's summary");
            await page.keyboard.press("Enter");
            await preview.locator(".chat-outcome-preview-text").waitFor({ state: "hidden" });
            // Open Terminal from the chip shows the terminal and sends nothing
            await btw.getByRole("button", { name: "Open Terminal", exact: true }).click();
            await chatStack(page, panes.flaky).waitFor({ state: "detached" });
            const again = await chatOf(page, panes.flaky);
            assert.equal(await again.locator(".chat-turn-sent").count(), 1);
            console.log(`PASS ${label}: the chip's controls are reached by Tab, and Open Terminal switches the lens`);
          }

          // an inline $review to the Codex pane, once its approval card is answered, shows its chip
          await page.evaluate(async (pane) => {
            const prompt = ((await (await fetch(`/api/pane/prompt?pane_id=${encodeURIComponent(pane)}`)).json()) as { prompt: { id: string } | null }).prompt;
            if (prompt !== null) await fetch("/api/pane/prompt/answer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pane_id: pane, prompt_id: prompt.id, option_index: 0 }) });
          }, panes.web);
          const codex = await chatOf(page, panes.web);
          await page.locator(".prompt-card").waitFor({ state: "detached" });
          // the answered approval's turn ends with the push: the pane takes a message again
          await codex.locator(".chat-turn-agent").last().getByText("Pushed", { exact: false }).waitFor();
          await send(page, "Please use $review now");
          const review = chipFor(codex, "use $review now");
          await review.waitFor();
          await review.and(page.locator('[data-outcome-state="result-observed"]')).waitFor();
          assert.equal(await codex.locator(".chat-bubble-body", { hasText: "use $review now" }).count(), 1);
          console.log(`PASS ${label}: an inline $review to the Codex pane shows its chip`);

          // an unlisted /myext run to the pi pane: accepted, then unknown, since nothing can show its result
          const pi = await chatOf(page, panes.cli);
          await send(page, "/myext run");
          const myext = chipFor(pi, "/myext run");
          await myext.and(page.locator('[data-outcome-state="unknown"]')).waitFor();
          assert.equal(await myext.locator(".chat-outcome-state").innerText(), "No result seen");
          assert.equal(await pi.locator(".chat-bubble-body", { hasText: "/myext run" }).count(), 1);
          await page.screenshot({ path: shot("myext-unknown"), animations: "disabled" });
          console.log(`PASS ${label}: an unlisted /myext run to the pi pane shows the unknown chip`);
        });
      } catch (error) {
        failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await browser.close();
    server.stop();
  }
} finally {
  rmSync(app, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`FAIL command outcome chips:\n${failures.map((failure) => `  ${failure}`).join("\n")}`);
  process.exit(1);
}
console.log(`PASS command outcome chips: ${RUNS.length} runs; screenshots in ${evidence}`);
