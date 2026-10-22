/** Real touch gestures over Markdown tables, in the popup and standalone file reader. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { workspaceCreate, workspaceClose } from "../server/herdr/client.ts";
import { UsageService } from "../server/usage.ts";
import { chromePath } from "./chrome-path.ts";
import { sheetsSettled } from "./sheets-settled.ts";

const root = mkdtempSync(join(tmpdir(), "ovis-table-"));
const path = join(root, "table.md");
const cells = Array.from({ length: 8 }, (_, index) => `column_${index}_long_value`);
writeFileSync(path, "# Table scrolling\n\n| " + cells.join(" | ") + " |\n| " + cells.map(() => "---").join(" | ") + " |\n"
  + Array.from({ length: 45 }, (_, row) => "| " + cells.map(cell => `${cell}_${row}`).join(" | ") + " |").join("\n") + "\n\nEnd of document.\n");
let workspace: string | undefined;
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const created = await workspaceCreate({ cwd: root, label: "isolated Markdown table scroll" });
  workspace = created.workspace.workspace_id;
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), usage: new UsageService(undefined, []) });
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  for (const width of [390, 844]) for (const theme of ["dark", "light"]) for (const mode of ["popup", "reader"]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 390 }, isMobile: true, hasTouch: true, colorScheme: theme === "dark" ? "dark" : "light" });
    try {
      await context.addInitScript(theme => localStorage.setItem("ovis:settings", JSON.stringify({ theme, language: "en" })), theme);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      const origin = `http://127.0.0.1:${server.port}`;
      await page.goto(`${origin}/?file=${encodeURIComponent(path)}${mode === "popup" ? `&pane=${encodeURIComponent(created.root_pane.pane_id)}` : ""}`);
      await page.locator(".file-viewer-markdown .markdown-table-wrap").waitFor();
      // Wide screens dock files; the explicit popup action exercises the same surface as a phone.
      if (mode === "popup" && await page.locator(".file-panel").count()) await page.getByRole("button", { name: "Show in dialog", exact: true }).click();
      await sheetsSettled(page);
      if (process.env.FILE_VIEWER_CSS) await page.addStyleTag({ content: readFileSync(process.env.FILE_VIEWER_CSS, "utf8") });
      const table = page.locator(".file-viewer-markdown .markdown-table-wrap");
      const body = page.locator(".file-viewer-body");
      const cdp = await context.newCDPSession(page);
      const box = (await table.boundingBox())!;
      const height = page.viewportSize()!.height;
      const x = Math.min(width - 70, box.x + box.width / 2), y = Math.min(height - 60, box.y + 180);
      const swipe = async (dx: number, dy: number) => {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
        for (let step = 1; step <= 10; step++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + dx * step / 10, y: y + dy * step / 10 }] });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      };
      assert.ok(await table.evaluate(node => node.scrollWidth > node.clientWidth), "the fixture has a wide table");
      await swipe(-Math.min(140, x - 20), 0);
      await page.waitForFunction(() => document.querySelector(".file-viewer-markdown .markdown-table-wrap")!.scrollLeft > 30);
      console.log(`Horizontal pan reached ${mode} ${width}px ${theme}`);
      await swipe(0, -Math.min(180, y - 90));
      await page.waitForFunction(() => document.querySelector(".file-viewer-body")!.scrollTop > 50, undefined, { timeout: 3000 });
      assert.equal(await body.evaluate(node => node.scrollLeft), 0, "only the table scrolls sideways");
      assert.equal(await page.evaluate(() => document.documentElement.scrollTop), 0, "the page behind the viewer stays still");
      assert.deepEqual(errors, []);
      if (process.env.UI_EVIDENCE_DIR) {
        mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
        await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `table-${mode}-${width}-${theme}.png`) });
      }
      console.log(`PASS ${mode} ${width}px ${theme}: table horizontal pan, document vertical pan, fixed outer page`);
      await cdp.detach();
    } finally { await context.close(); }
  }
} finally {
  await browser?.close(); server?.stop();
  if (workspace) await workspaceClose(workspace);
  rmSync(root, { recursive: true, force: true });
}
