/**
 * A long IME or dictation composition never pushes the terminal sideways, and the grid fills the
 * pane's width. At 412 and 720 wide, DPR 2.625, in Input line and Direct typing modes, with the
 * default font and with the bundled "JetBrains Mono Web": a long composition (CDP
 * Input.imeSetComposition, as Gboard's voice typing sends one) leaves the page and the terminal host
 * at scroll 0, keeps xterm's composition box inside the grid, and the grid is the pane's width less
 * its padding and less than one cell. On the isolated test herdr; UI_EVIDENCE_DIR=<dir> keeps the
 * screenshots.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { chromePath } from "./chrome-path.ts";

export async function checkTerminalComposition(browser: Browser, origin: string): Promise<void> {
  const out = process.env["UI_EVIDENCE_DIR"];
  if (out) mkdirSync(out, { recursive: true });
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-composition-")));
  const ws = await workspaceCreate({ cwd: root, label: "ovis-test-composition" });
  try {
    await herdrRpc("pane.send_text", { pane_id: ws.root_pane.pane_id, text: "seq -s ' ' 1 400\r" });
    for (const w of [412, 720]) for (const mode of ["line", "direct"]) for (const font of ["", "JetBrains Mono Web"]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2.625, locale: "en-US" });
      await ctx.addInitScript(([m, f]) => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", terminalInputMode: m, ...(f ? { terminalFontFamily: f } : {}) })), [mode, font]);
      const page = await ctx.newPage();
      await page.goto(`${origin}/?pane=${encodeURIComponent(ws.root_pane.pane_id)}`);
      await page.locator(".xterm-rows").waitFor();
      await page.waitForFunction(() => document.querySelector(".xterm-rows")?.textContent?.includes("400") ?? false, null, { timeout: 15_000 });
      // simulate long dictation composition
      const cdp = await ctx.newCDPSession(page);
      const target = mode === "line" ? ".terminal-input-text" : ".xterm-helper-textarea";
      await page.locator(target).focus();
      const long = "this is a long dictated sentence that keeps going and going without stopping for a while";
      let composed = "";
      for (let i = 10; i <= long.length; i += 10) {
        composed = long.slice(0, i);
        await cdp.send("Input.imeSetComposition", { text: composed, selectionStart: i, selectionEnd: i });
      }
      // the box shows the whole composition and has been fitted to the grid (Direct), or the line holds it
      await page.waitForFunction(([m, text]) => m === "line"
        ? (document.querySelector(".terminal-input-text") as HTMLTextAreaElement | null)?.value.includes(text) ?? false
        : document.querySelector(".composition-view.active")?.textContent === text, [mode, composed] as const, { timeout: 10_000 });
      const after = await page.evaluate(() => {
        const scrollers: string[] = [];
        for (const n of document.querySelectorAll<HTMLElement>("*")) if (n.scrollLeft > 0) scrollers.push(`${n.className || n.tagName}:${n.scrollLeft}`);
        return { docScroll: document.documentElement.scrollWidth, inner: innerWidth, scrollX, scrollers: scrollers.slice(0, 6) };
      });
      const label = `${w} ${mode} ${font || "default font"}`;
      const view = await page.evaluate(() => {
        const box = document.querySelector(".composition-view.active")?.getBoundingClientRect();
        const screen = document.querySelector(".xterm-screen")!.getBoundingClientRect();
        const cell = screen.width / (document.querySelector(".xterm-rows")!.firstElementChild!.textContent!.length || 1);
        const host = document.querySelector<HTMLElement>(".pane-terminal")!;
        const pad = getComputedStyle(document.querySelector(".pane-terminal .xterm")!);
        // the width the fit gives the grid: the pane's, less the gutter on .xterm
        const room = host.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight);
        return { right: box?.right ?? null, screenRight: screen.right, screen: screen.width, room, cell, host: host.scrollLeft };
      });
      if (out) await page.screenshot({ path: `${out}/composition-${w}-${mode}-${font ? "jb" : "default"}.png` });
      assert.ok(after.docScroll <= after.inner, `${label}: the page does not grow sideways (${after.docScroll} > ${after.inner}; ${after.scrollers.join(", ")})`);
      assert.equal(after.scrollX, 0, `${label}: the page is not scrolled sideways`);
      assert.equal(view.host, 0, `${label}: the terminal is not pushed sideways (${view.host})`);
      if (mode === "direct") assert.ok(view.right !== null && view.right <= view.screenRight + 1, `${label}: the composition stays inside the grid (${view.right} > ${view.screenRight})`);
      assert.ok(view.screen <= view.room + 0.5 && view.room - view.screen < Math.max(view.cell, 12), `${label}: the grid fills the pane and stays inside it (${view.screen} of ${view.room})`);
      console.log("ok", label);
      await cdp.send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 }).catch(() => {});
      await ctx.close();
    }
    console.log("PASS a long composition never pushes the terminal sideways and the grid fills the pane, at 412 and 720, Input line and Direct typing, default and bundled font");
  } finally {
    await workspaceClose(ws.workspace.workspace_id).catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await import("./test-herdr.ts");
  const { chromium } = await import("playwright-core");
  const { createServer } = await import("../server/index.ts");
  const { UsageService } = await import("../server/usage.ts");
  const state = mkdtempSync(join(tmpdir(), "ovis-composition-state-"));
  let server: ReturnType<typeof createServer> | undefined;
  let browser: Browser | undefined;
  try {
    server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: state, usage: new UsageService(undefined, []) });
    browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    await checkTerminalComposition(browser, `http://127.0.0.1:${server.port}`);
  } finally {
    await browser?.close();
    server?.stop();
    rmSync(state, { recursive: true, force: true });
  }
}
