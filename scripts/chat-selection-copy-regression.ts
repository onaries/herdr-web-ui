/** Real ChatView selection and browser clipboard over fictional conversation HTTP. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, webkit, type Page } from "playwright-core";

const root = mkdtempSync(join(tmpdir(), "herdr-chat-selection-copy-"));
const reply = "Outside selection.\n\n- First item\n- Second item\n- Third item\n\nKeep `src/main.ts` and `worker` here.\n\nNext paragraph.\n\n```sh\n  first\n\n  second  \n```\n\nOutside end.";
const expected = "- First item\n- Second item\n- Third item\n\nKeep `src/main.ts` and `worker` here.\n\nNext paragraph.\n\n```sh\n  first\n\n  second  \n```";
const safari = process.env.COPY_WEBKIT === "1";

async function readClipboard(page: Page): Promise<string> {
  const copied = safari ? null : await page.evaluate(() => navigator.clipboard.readText());
  // Read through native textarea paste too: WebKit has no clipboard-read permission.
  await page.evaluate(() => {
    const input = document.createElement("textarea");
    input.id = "clipboard-reader";
    document.body.append(input);
    input.focus();
  });
  await page.keyboard.press("ControlOrMeta+v");
  const value = await page.locator("#clipboard-reader").inputValue();
  await page.locator("#clipboard-reader").evaluate((node) => node.remove());
  if (copied !== null) assert.equal(value, copied, "native paste preserves copied text/plain");
  return value;
}
try {
  const build = await Bun.build({ entrypoints: ["scripts/chat-virtual-fixture.tsx"], outdir: root, target: "browser", define: { "process.env.NODE_ENV": '"development"' } });
  assert.ok(build.success, String(build.logs));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/favicon.ico") return new Response(null, { status: 204 });
    if (path.endsWith("/pane/commands")) return Response.json({ commands: [] });
    if (path.endsWith("/pane/conversation")) return Response.json({ source: "claude-transcript", history_id: "copy-fixture", cursor: null, turns: [{ role: "assistant", ts: null, parts: [{ kind: "text", text: reply }] }] });
    if (path === "/") return new Response('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/chat-virtual-fixture.css"></head><body><div id="root"></div><script type="module" src="/chat-virtual-fixture.js"></script></body></html>', { headers: { "content-type": "text/html" } });
    return new Response(Bun.file(join(root, path.slice(1))));
  } });
  try {
    const browser = await (safari ? webkit : chromium).launch({ executablePath: safari ? undefined : process.env.CHROME_PATH, headless: true });
    try {
      for (const width of [1440, 390]) {
        const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width === 390, isMobile: width === 390, permissions: safari ? [] : ["clipboard-read", "clipboard-write"] });
        const page = await context.newPage();
        page.setDefaultTimeout(10_000);
        await page.goto(`http://127.0.0.1:${server.port}/`);
        await page.getByText("Outside end.", { exact: true }).waitFor();
        await page.locator(".markdown").evaluate((node) => {
          const range = document.createRange();
          range.setStart(node.querySelector("li span")!.firstChild!, 0);
          range.setEndAfter(node.querySelector(".markdown-code")!);
          getSelection()!.removeAllRanges();
          getSelection()!.addRange(range);
        });
        await page.keyboard.press("ControlOrMeta+c");
        const copied = await readClipboard(page);
        assert.equal(copied, expected, "partial reply keeps list rows, paragraphs, inline code and fenced whitespace");
        assert.deepEqual(await page.locator(".markdown").evaluate((node) => ({
          item: getComputedStyle(node.querySelector("li")!).display,
          paragraph: getComputedStyle(node.querySelector("p")!).display,
          file: getComputedStyle(node.querySelector(".markdown-file")!).getPropertyValue("-webkit-user-select"),
        })), { item: "list-item", paragraph: "block", file: "text" }, "touch/WebKit CSS keeps semantic blocks and selectable file code");
        await page.locator(".markdown").evaluate((node) => {
          const items = node.querySelectorAll("li span");
          const range = document.createRange();
          range.setStart(items[0]!.firstChild!, 2);
          range.setEnd(items[2]!.firstChild!, 3);
          getSelection()!.removeAllRanges();
          getSelection()!.addRange(range);
        });
        await page.keyboard.press("ControlOrMeta+c");
        assert.equal(await readClipboard(page), "- rst item\n- Second item\n- Thi", "partial list endpoints keep markers and rows");
        await page.locator(".markdown-file code").evaluate((node) => {
          const range = document.createRange();
          range.setStart(node.firstChild!, 4);
          range.setEnd(node.firstChild!, 8);
          getSelection()!.removeAllRanges();
          getSelection()!.addRange(range);
        });
        await page.keyboard.press("ControlOrMeta+c");
        assert.equal(await readClipboard(page), "`main`", "a selection inside a file-code button keeps only selected text");
        await page.locator(".markdown p code").filter({ hasText: "worker" }).evaluate((node) => {
          const range = document.createRange();
          range.selectNodeContents(node);
          getSelection()!.removeAllRanges();
          getSelection()!.addRange(range);
        });
        await page.keyboard.press("ControlOrMeta+c");
        assert.equal(await readClipboard(page), "`worker`", "non-file inline command code is retained");
        await page.locator(".markdown").evaluate((node) => {
          const paragraphs = node.querySelectorAll("p");
          const start = document.createTreeWalker(paragraphs[1]!, NodeFilter.SHOW_TEXT);
          let last = start.nextNode()!;
          while (start.nextNode()) last = start.currentNode;
          const end = document.createTreeWalker(paragraphs[2]!, NodeFilter.SHOW_TEXT).nextNode()!;
          const range = document.createRange();
          range.setStart(last, 1);
          range.setEnd(end, 4);
          getSelection()!.removeAllRanges();
          getSelection()!.addRange(range);
        });
        await page.keyboard.press("ControlOrMeta+c");
        assert.equal(await readClipboard(page), "here.\n\nNext", "prose-only partial endpoints retain the paragraph break");
        await page.locator(".markdown pre").evaluate((node) => {
          const range = document.createRange();
          range.selectNodeContents(node);
          getSelection()!.removeAllRanges();
          getSelection()!.addRange(range);
        });
        await page.keyboard.press("ControlOrMeta+c");
        assert.equal(await readClipboard(page), "  first\n\n  second  ", "code-only selection keeps spaces and empty lines without fences");
        await page.evaluate(() => getSelection()!.removeAllRanges());
        await page.getByRole("button", { name: "Copy as markdown", exact: true }).click({ force: true });
        assert.equal(await readClipboard(page), reply, "per-message Markdown Copy is unchanged");
        await page.getByRole("button", { name: "Copy as plain text", exact: true }).click({ force: true });
        assert.equal(await readClipboard(page), "Outside selection.\n\n- First item\n- Second item\n- Third item\n\nKeep src/main.ts and worker here.\n\nNext paragraph.\n\n  first\n\n  second  \n\n\nOutside end.", "per-message Plain text Copy keeps text and line breaks");
        await context.close();
        console.log(`PASS ${width}: partial rendered reply keeps list rows, paragraphs, inline code and fenced whitespace through real copy`);
      }
    } finally { await browser.close(); }
  } finally { await server.stop(true); }
} finally { rmSync(root, { recursive: true, force: true }); }
