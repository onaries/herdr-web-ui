/** Replay the native iPadOS Safari + hardware keyboard trace (Korean 2-set), not a claim to automate the OS IME. */
import assert from "node:assert/strict";
import type { Browser } from "playwright-core";

/**
 * iPadOS 27 Safari with a Magic Keyboard sends each jamo as a printable keydown (its own keyCode,
 * not 229, isComposing false), then a keypress, then composes in the editor: a new syllable is an
 * insertText, a changed one is deleteContentBackward followed by insertText of the whole result.
 * There are no composition events. Recorded with scripts/terminal-ime-diagnostic.ts on 2026-10-13.
 */
export async function checkIpadIme(browser: Browser, origin: string, pane: string, otherPane: string): Promise<void> {
  // one context for both platforms: the page, not the context, carries the platform it reports
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Safari/605.1.15",
    viewport: { width: 1100, height: 700 },
  });
  try {
  // the platform iPadOS Safari reports by default (desktop site), and the one it reports otherwise
  for (const platform of ["MacIntel", "iPad"]) {
    const page = await context.newPage();
    await page.addInitScript(({ pane, platform }) => {
      Object.defineProperty(navigator, "platform", { get: () => platform });
      localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", terminalInputMode: "direct" }));
      localStorage.setItem(`herdr-web-ui:view:${pane}`, "terminal");
    }, { pane, platform });
    const sent: Array<{ pane_id: string; text: string }> = [];
    let ready = false;
    // output for the page as if the pane wrote it: input here never reaches the pane to echo
    let toPage = (_data: string): void => {};
    await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
      const server = socket.connectToServer();
      toPage = (data) => socket.send(JSON.stringify({ type: "pty-data", pane_id: pane, data }));
      server.onMessage((raw) => {
        const frame = JSON.parse(String(raw));
        if (frame.type === "input-ready") ready = frame.ready !== false;
        socket.send(raw);
      });
      socket.onMessage((raw) => {
        const frame = JSON.parse(String(raw));
        if (frame.type === "input") sent.push(frame);
        else server.send(raw);
      });
    });
    const until = async (check: () => boolean | Promise<boolean>) => {
      const deadline = Date.now() + 10_000;
      while (!(await check())) { assert(Date.now() < deadline, "iPad trace replay timed out"); await new Promise((resolve) => setTimeout(resolve, 25)); }
    };
    const input = page.locator(".xterm-helper-textarea:visible");
    const reset = async () => {
      ready = false;
      await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
      await until(() => ready);
      await input.focus();
      await input.evaluate((box) => { (box as HTMLTextAreaElement).value = ""; });
      sent.length = 0;
    };
    // One key of the recorded order: keydown (jamo, real keyCode), keypress, then the editor's
    // edits. A cancelled keydown means a browser makes no edit, which is the failure this guards.
    const KEYCODES: Record<string, number> = { "ㅎ": 71, "ㅏ": 75, "ㄴ": 83, "ㄱ": 82, "ㅡ": 77, "ㄹ": 70, "ㅇ": 68, "ㅁ": 65 };
    const key = async (jamo: string, edits: Array<["delete"] | ["insert", string]>) => {
      return input.evaluate(async (element, { jamo, keyCode, edits }) => {
        const box = element as HTMLTextAreaElement;
        const down = box.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: jamo, code: "", keyCode, isComposing: false }));
        const press = down && box.dispatchEvent(new KeyboardEvent("keypress", { bubbles: true, cancelable: true, key: jamo, keyCode: jamo.charCodeAt(0), charCode: jamo.charCodeAt(0) }));
        if (down && press) {
          for (const edit of edits) {
            const end = box.value.length;
            if (edit[0] === "delete") {
              box.setSelectionRange(end - 1, end);
              box.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, composed: true, inputType: "deleteContentBackward", isComposing: false }));
              box.setRangeText("", end - 1, end, "end");
              box.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "deleteContentBackward", isComposing: false }));
            } else {
              box.setSelectionRange(end, end);
              box.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, composed: true, inputType: "insertText", data: edit[1], isComposing: false }));
              box.setRangeText(edit[1], end, end, "end");
              box.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: edit[1], isComposing: false }));
            }
          }
        }
        box.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: jamo, keyCode, isComposing: false }));
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        return down;
      }, { jamo, keyCode: KEYCODES[jamo] ?? 65, edits });
    };
    const fresh = (jamo: string) => key(jamo, [["insert", jamo]]);
    const replace = (jamo: string, result: string) => key(jamo, [["delete"], ["insert", result]]);
    const check = async (expected: string, label: string) => {
      await input.press("Control+g");
      await until(() => sent.at(-1)?.text === "\x07");
      assert.equal(sent.map((frame) => frame.text).join(""), expected + "\x07", `${label} (platform ${platform})`);
      assert(sent.every((frame) => frame.pane_id === pane), "input stays with its pane");
    };
    try {
      await reset();
      await input.press("a"); await input.press("b"); await input.press("c");
      assert.equal(await fresh("ㅎ"), true, `a Hangul keydown is left to the editor (platform ${platform})`);
      await replace("ㅏ", "하"); await replace("ㄴ", "한");
      assert.equal(sent.map((frame) => frame.text).join(""), "abc", "provisional Hangul stays local, no jamo is sent");
      await fresh("ㄱ"); await replace("ㅡ", "그"); await replace("ㄹ", "글");
      await input.press("Space");
      await check("abc한글 ", "English then iPad Hangul commits each syllable once, in order");
      // the syllable being typed is drawn at the size its row gives the committed ones
      // (terminalGlyphs enlarges a two-cell glyph that leaves its cells half empty)
      toPage("\r\n한 ");
      await page.waitForFunction(() => [...document.querySelectorAll(".xterm-rows span")].some((span) => span.textContent?.includes("한")));
      await fresh("ㄱ"); await replace("ㅡ", "그");
      const sizes = await page.evaluate(() => {
        const row = [...document.querySelectorAll<HTMLElement>(".xterm-rows span")].find((span) => span.textContent?.includes("한"))!;
        const view = document.querySelector<HTMLElement>(".composition-view")!;
        return { row: getComputedStyle(row).fontSize, view: getComputedStyle(view).fontSize, pending: view.classList.contains("active") ? view.textContent : null };
      });
      assert.equal(sizes.pending, "그", "a syllable is pending");
      assert(Math.abs(Number.parseFloat(sizes.view) - Number.parseFloat(sizes.row)) < 0.01,
        `the pending syllable is drawn at its row's size: ${sizes.view} against ${sizes.row} (platform ${platform})`);

      await reset();
      // 망 then ㅏ: the final ㅇ moves on and the editor puts back two syllables at once
      await fresh("ㅁ"); await replace("ㅏ", "마"); await replace("ㅇ", "망"); await replace("ㅏ", "마아");
      await input.press("Space");
      await check("마아 ", "a two-syllable replacement commits both");

      for (const [press, expected] of [["Enter", "\r"], ["Control+c", "\x03"], ["Tab", "\t"]]) {
        await reset(); await fresh("ㅎ"); await replace("ㅏ", "하"); await replace("ㄴ", "한");
        await input.press(press!);
        await check("한" + expected, `iPad commit precedes ${press}`);
      }

      await reset(); await fresh("ㅎ"); await replace("ㅏ", "하"); await replace("ㄴ", "한");
      await input.evaluate((box) => (box as HTMLTextAreaElement).blur());
      await until(() => sent.length > 0);
      await input.focus();
      await check("한", "blur commits the pending syllable once");

      await reset(); await fresh("ㅎ"); await replace("ㅏ", "하");
      ready = false;
      await page.locator(`.pane-select[title^="${otherPane} —"]`).first().evaluate((node: HTMLElement) => node.click());
      await until(async () => (await page.evaluate(() => JSON.parse(localStorage.getItem("herdr-web-ui:selection")!).pane_id)) === otherPane);
      await until(() => ready);
      await input.press("Control+g");
      await until(() => sent.at(-1)?.text === "\x07");
      assert.equal(sent.map((frame) => frame.text).join(""), "\x07", "pending iPad text cannot enter another pane");
      console.log(`  ok navigator.platform ${platform}`);
    } finally {
      // left open until the context closes: closing a page whose WebSocket is routed took the
      // whole headless browser down on macOS
      await page.goto("about:blank").catch(() => {});
    }
  }
  } finally { await context.close(); }
  console.log("PASS iPad hardware-keyboard replay: jamo keys composed in the editor, pending syllable at its row's size, commit keys, two-syllable replacement, blur and pane reset");
}

if (import.meta.main) {
  await import("./test-herdr.ts");
  const { createServer } = await import("../server/index.ts");
  const { workspaceCreate, workspaceClose } = await import("../server/herdr/client.ts");
  const { chromium } = await import("playwright-core");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "herdr-ipad-replay-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", stateDir: root, token: "" });
  const owned: string[] = [];
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true });
    const panes: string[] = [];
    for (let i = 0; i < 2; i++) {
      const made = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-ipad-replay" });
      owned.push(made.workspace.workspace_id); panes.push(made.root_pane.pane_id);
    }
    await checkIpadIme(browser, `http://127.0.0.1:${server.port}`, panes[0]!, panes[1]!);
  } finally {
    await browser?.close(); server.stop();
    for (const workspace of owned) await workspaceClose(workspace);
    rmSync(root, { recursive: true, force: true });
  }
}
