import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { openSettingsPage } from "./settings-page.ts";
import { KO } from "../src/lib/i18n.ko.ts";
import { JA } from "../src/lib/i18n.ja.ts";
import { ZH } from "../src/lib/i18n.zh.ts";

// Settings on the unmodified app over the demo's fixture transport: every page fits a phone, and
// the browser's Back button steps out of the dialog instead of out of the app. All files and
// HTTP traffic stay in this disposable, loopback-only app; no herdr session is opened.
const app = mkdtempSync(join(tmpdir(), "herdr-settings-demo-"));
const PAGES = ["Appearance", "Chat", "Terminal", "Alerts", "Voice input", "Subscription usage", "Shortcuts", "Phone & devices", "Remote PCs", "Agent integrations", "About"];
const SETTINGS = { language: "en", showUsage: true, voiceInput: true, showQuickReplies: true };

const dialogOf = (page: Page) => page.getByRole("dialog", { name: "Settings", exact: true });
const openSettings = async (page: Page): Promise<void> => {
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  await page.locator(".settings-dialog").waitFor();
};
/** The Settings entry of the current history state, as the app wrote it. */
const entryOf = (page: Page): Promise<{ page: string | null; keyBar: boolean; depth: number } | null> =>
  page.evaluate(() => (history.state as Record<string, unknown> | null)?.["herdr-web-ui:settings"] as never ?? null);
/** Controls and text that reach past their card, and cards past the page's box: a row wider than its card is cut there. */
const cutOff = (page: Page): Promise<string[]> => page.locator(".settings-body:not([hidden]), .settings-key-bar-body").evaluate((body) => {
  const edge = body.getBoundingClientRect();
  const out = [...body.querySelectorAll<HTMLElement>("button, input, select, a, .settings-card, .settings-row")]
    .filter((node) => {
      const box = node.getBoundingClientRect();
      // a control is held by its card, where it has one; a card by the page
      const card = node.classList.contains("settings-card") ? null : node.closest<HTMLElement>(".settings-card");
      const within = card ? card.getBoundingClientRect() : edge;
      return box.width > 0 && (box.right > within.right + 0.5 || box.left < within.left - 0.5);
    })
    .map((node) => `${node.tagName.toLowerCase()}.${node.className} ${node.getAttribute("aria-label") ?? node.textContent?.trim().slice(0, 30) ?? ""}`);
  return body.scrollWidth > body.clientWidth ? [`the page scrolls sideways (${body.scrollWidth} > ${body.clientWidth})`, ...out] : out;
});

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    <script type="module"`));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    const prefix = "/herdr-web-ui/demo/app/";
    if (!path.startsWith(prefix)) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice(prefix.length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
  } });
  const url = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/`;
  try {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
    try {
      for (const [width, language] of [[390, "en"], [320, "en"], [320, "ko"], [320, "ja"], [320, "zh"]] as const) {
        const started = performance.now();
        const strings: Record<string, string> = language === "ko" ? KO : language === "ja" ? JA : language === "zh" ? ZH : {};
        const label = (name: string): string => strings[name] ?? name;
        const context = await browser.newContext({ viewport: { width, height: 760 }, isMobile: true, hasTouch: true, locale: language });
        try {
          await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(url).origin });
          await context.addInitScript((settings) => { if (localStorage.getItem("herdr-web-ui:settings") === null) localStorage.setItem("herdr-web-ui:settings", settings); }, JSON.stringify({ ...SETTINGS, language }));
          const page = await context.newPage();
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(url);
          await page.locator(".conn-live").waitFor({ state: "attached" });
          const terminal = page.locator(".pane-terminal");
          await terminal.waitFor({ state: "attached" });
          const lens = page.getByRole("group", { name: "Pane view", exact: true });
          await lens.getByTitle(label("Live terminal (⌘⇧J)"), { exact: true }).tap();
          assert.equal(await terminal.getAttribute("role"), "region");
          assert.equal(await terminal.getAttribute("aria-roledescription"), label("Terminal"));
          assert.equal(await terminal.getAttribute("aria-label"), label("Terminal for {title}").replace("{title}", "Idempotent payments"));
          assert.equal(await terminal.getAttribute("tabindex"), null, "the wrapper adds no empty keyboard stop");
          await lens.getByTitle(label("Chat transcript (⌘⇧J)"), { exact: true }).tap();
          assert.equal(await terminal.getAttribute("role"), null, "chat exposes no empty terminal landmark");
          assert.equal(await terminal.getAttribute("aria-label"), null);
          await openSettings(page);
          for (const name of PAGES) {
            await openSettingsPage(page, label(name), label("Back to settings"));
            // what a page asks the server for (devices, the phone address, the accounts) has arrived
            await page.waitForFunction((loading) => ![...document.querySelectorAll(".settings-body [role='status']")].some((node) => loading.includes(node.textContent?.trim() ?? "")),
              [label("Loading…"), label("Asking this PC about Tailscale…")]);
            if (name === "Subscription usage") await page.locator(".usage-accounts-row").first().waitFor();
            if (name === "Voice input") {
              await page.locator(".voice-key").waitFor();
              const dictation = page.getByLabel(label("Dictation language"), { exact: true });
              await dictation.selectOption("hu-HU");
              await page.waitForFunction(() => JSON.parse(localStorage.getItem("herdr-web-ui:settings")!).voiceLanguage === "hu-HU");
              assert.equal(await dictation.inputValue(), "hu-HU");
              assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("herdr-web-ui:settings")!).language), language,
                "dictation selection does not change the display language");
              await dictation.selectOption("auto");
            }
            if (name === "Agent integrations") {
              // the demo's fixture, in herdr's order with the agents found on the PC first: a failed request
              // would leave one error paragraph that still fits, so the rows and their states are asserted
              const body = page.locator(".settings-body:not([hidden])");
              assert.equal(await body.locator("[role='alert']").count(), 0, "the integrations page shows no error");
              const install = (target: string): string => `herdr integration install ${target}`;
              const shown = await body.locator(".settings-row").evaluateAll((nodes) => nodes.map((node) => ({
                label: node.querySelector(".settings-label")?.textContent ?? "",
                description: node.querySelector(".settings-description")?.textContent ?? "",
                command: node.querySelector("code")?.textContent ?? null,
                copy: node.querySelector("button")?.getAttribute("aria-label") ?? null,
              })));
              const copyLabel = (target: string): string => label("Copy the command for {name}").replace("{name}", target);
              const missing = label("Not installed");
              assert.deepEqual(shown, [
                { label: "pi", description: missing + install("pi"), command: install("pi"), copy: copyLabel("pi") },
                { label: "claude", description: label("Installed"), command: null, copy: null },
                { label: "codex", description: label("Installed, but older than this herdr: run this to update it") + install("codex"), command: install("codex"), copy: copyLabel("codex") },
                { label: "opencode", description: missing + install("opencode"), command: install("opencode"), copy: copyLabel("opencode") },
                { label: "omp", description: missing + install("omp"), command: install("omp"), copy: copyLabel("omp") },
                { label: "copilot", description: missing + install("copilot"), command: install("copilot"), copy: copyLabel("copilot") },
                { label: "cursor", description: missing + install("cursor"), command: install("cursor"), copy: copyLabel("cursor") },
                { label: "antigravity-cli", description: missing + install("antigravity-cli"), command: install("antigravity-cli"), copy: copyLabel("antigravity-cli") },
              ], "every fixture integration, with its state and install command");
              assert.deepEqual(await body.locator("h3").allTextContents(), [label("Not found on this PC")]);
              const copy = body.getByRole("button", { name: copyLabel("codex"), exact: true });
              await copy.tap();
              await body.getByRole("button", { name: copyLabel("codex"), exact: true }).filter({ hasText: label("Copied") }).waitFor();
              assert.equal(await page.evaluate(() => navigator.clipboard.readText()), install("codex"));
            }
            assert.deepEqual(await cutOff(page), [], `${name} fits a ${width}px phone (${language})`);
          }
          await openSettingsPage(page, label("Terminal"), label("Back to settings"));
          await page.getByRole("button", { name: label("Edit key bar"), exact: true }).tap();
          await page.locator(".key-bar-settings").waitFor();
          assert.deepEqual(await cutOff(page), [], `Key bar fits a ${width}px phone (${language})`);
          await page.getByRole("button", { name: label("Back to settings"), exact: true }).tap();
          // the quick replies are text fields beside a Remove button each: both stay in the card
          if (language === "en") {
            await openSettingsPage(page, "Chat");
            const replies = page.locator(".quick-replies-list li");
            assert.ok(await replies.count() > 0);
            await page.getByRole("button", { name: "Remove quick reply 1", exact: true }).tap();
            assert.equal(await replies.count(), (JSON.parse(await page.evaluate(() => localStorage.getItem("herdr-web-ui:settings")!)) as { quickReplies: string[] }).quickReplies.length);
            await page.getByRole("button", { name: "Restore defaults", exact: true }).tap();
          }
          assert.deepEqual(errors, []);
          await page.getByRole("button", { name: label("Close settings"), exact: true }).tap();
          if (language === "en") {
            const composer = page.locator(".composer textarea");
            await composer.fill("/");
            const menu = page.getByRole("listbox", { name: "Slash commands" });
            await menu.getByRole("option").last().waitFor();
            await composer.press("ArrowUp");
            await page.waitForFunction(() => {
              const menu = document.querySelector(".composer-menu");
              const active = menu?.querySelector('[aria-selected="true"]');
              if (!menu || !active) return false;
              const box = menu.getBoundingClientRect(), row = active.getBoundingClientRect();
              return active.textContent?.includes("vim") && row.top >= box.top && row.bottom <= box.bottom;
            });
            // Enter right after the keystroke that narrows the list, before React's next render, completes the row
            await page.evaluate(async () => {
              const box = document.querySelector<HTMLTextAreaElement>(".composer textarea")!;
              Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "/comments");
              box.selectionStart = box.selectionEnd = box.value.length;
              box.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
              await Promise.resolve(); await Promise.resolve();
              box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
            });
            await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.value === "/pr-comments ");
            await composer.fill("/comments");
            await menu.getByRole("option").filter({ hasText: "pr-comments" }).waitFor();
            assert.equal(await menu.getByRole("option").count(), 1);
            await composer.press("Tab");
            await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.value === "/pr-comments ");
            assert.equal(await composer.inputValue(), "/pr-comments ");
            // a key typed after a completion, before the next frame (a busy phone), stays where it was typed
            await composer.fill("/comments");
            await menu.getByRole("option").filter({ hasText: "pr-comments" }).waitFor();
            await page.evaluate(() => {
              const real = window.requestAnimationFrame, held: FrameRequestCallback[] = [];
              window.requestAnimationFrame = (callback) => { held.push(callback); return 0; };
              addEventListener("release-frames", () => {
                window.requestAnimationFrame = real;
                for (const callback of held) callback(performance.now());
              }, { once: true });
            });
            await composer.press("Tab");
            await page.keyboard.type("a");
            await page.evaluate(() => dispatchEvent(new Event("release-frames")));
            await page.keyboard.type("b");
            assert.equal(await composer.inputValue(), "/pr-comments ab");
            await composer.fill("/rln");
            await menu.getByRole("option").filter({ hasText: "release-notes" }).waitFor();
            assert.equal(await menu.getByRole("option").count(), 1);
            await composer.fill("");
            console.log(`PASS fuzzy commands and offscreen keyboard selection (${width}px)`);
          }
          console.log(`PASS every Settings page and key bar fit a ${width}px phone (${language}); ${(performance.now() - started).toFixed(0)}ms`);
        } finally {
          await context.close();
        }
      }

      const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
      try {
        await phone.addInitScript((settings) => localStorage.setItem("herdr-web-ui:settings", settings), JSON.stringify(SETTINGS));
        const page = await phone.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(url);
        await page.locator(".conn-live").waitFor({ state: "attached" });
        const dialog = dialogOf(page);
        const list = dialog.getByRole("tablist");

        // Back steps out one screen at a time: the key bar editor, the page, the list, and only then nothing
        await openSettings(page);
        assert.deepEqual(await entryOf(page), { page: null, keyBar: false, depth: 1 });
        await openSettingsPage(page, "Terminal");
        await dialog.getByRole("button", { name: "Edit key bar", exact: true }).tap();
        await page.getByRole("dialog", { name: "Key bar", exact: true }).waitFor();
        assert.deepEqual(await entryOf(page), { page: "terminal", keyBar: true, depth: 3 });
        await page.goBack();
        await dialog.getByRole("tabpanel", { name: "Terminal", exact: true }).waitFor();
        assert.equal(await page.locator(".key-bar-settings").count(), 0);
        await page.goBack();
        await list.waitFor();
        assert.equal(await dialog.getByRole("tabpanel").count(), 0, "Back from a page shows the list again");
        await page.goBack();
        await page.locator(".settings-dialog").waitFor({ state: "detached" });
        assert.equal(await entryOf(page), null);
        assert.equal(page.url(), url, "the last Back closes Settings and leaves the app where it was");
        await page.locator(".conn-live").waitFor({ state: "attached" });
        console.log("PASS Back on a phone leaves the key bar editor, then the page, then the list, and stays in the app");

        // the dialog's own Back control takes the same entry off: the next Back is not spent on it
        await openSettings(page);
        await openSettingsPage(page, "Chat");
        await dialog.getByRole("button", { name: "Back to settings", exact: true }).tap();
        await list.waitFor();
        await page.waitForFunction(() => (history.state as Record<string, { depth: number }> | null)?.["herdr-web-ui:settings"]?.depth === 1);
        await page.goBack();
        await page.locator(".settings-dialog").waitFor({ state: "detached" });
        console.log("PASS the Back control in the dialog and the system Back button share one history");

        // closing from the deepest screen leaves no entry behind, and Forward does not reopen what the X closed by itself
        await openSettings(page);
        await openSettingsPage(page, "Terminal");
        await dialog.getByRole("button", { name: "Edit key bar", exact: true }).tap();
        await page.getByRole("button", { name: "Close settings", exact: true }).tap();
        await page.locator(".settings-dialog").waitFor({ state: "detached" });
        await page.waitForFunction(() => (history.state as Record<string, unknown> | null)?.["herdr-web-ui:settings"] === undefined);
        // and a new opening starts on the list, with one entry
        await openSettings(page);
        await list.waitFor();
        await page.waitForFunction(() => (history.state as Record<string, { depth: number }> | null)?.["herdr-web-ui:settings"]?.depth === 1);
        // a reload keeps the history but not the dialog: its entries are stepped out of
        await openSettingsPage(page, "Alerts");
        await page.reload();
        await page.locator(".conn-live").waitFor({ state: "attached" });
        await page.waitForFunction(() => (history.state as Record<string, unknown> | null)?.["herdr-web-ui:settings"] === undefined);
        assert.equal(await page.locator(".settings-dialog").count(), 0, "a reload does not reopen Settings");
        assert.deepEqual(errors, []);
        console.log("PASS the X from the key bar editor and a reload leave no Settings entry in the history");
      } finally {
        await phone.close();
      }

      const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
      try {
        await desktop.addInitScript((settings) => localStorage.setItem("herdr-web-ui:settings", settings), JSON.stringify(SETTINGS));
        const page = await desktop.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(url);
        await page.locator(".conn-live").waitFor({ state: "attached" });
        await openSettings(page);
        // beside the list, turning pages is one step however many are turned
        for (const name of ["Chat", "Shortcuts", "About"]) await openSettingsPage(page, name);
        await page.waitForFunction(() => (history.state as Record<string, { page: string; depth: number }> | null)?.["herdr-web-ui:settings"]?.page === "about");
        assert.equal((await entryOf(page))?.depth, 1);
        await page.goBack();
        await page.locator(".settings-dialog").waitFor({ state: "detached" });
        // Forward opens it where it was
        await page.goForward();
        await dialogOf(page).getByRole("tabpanel", { name: "About", exact: true }).waitFor();
        await page.keyboard.press("Escape");
        await page.locator(".settings-dialog").waitFor({ state: "detached" });
        await page.waitForFunction(() => (history.state as Record<string, unknown> | null)?.["herdr-web-ui:settings"] === undefined);
        assert.deepEqual(errors, []);
        console.log("PASS on a desktop Back closes Settings in one step, Forward reopens its page, Escape takes the entry off");

        // the window changes width with Settings open: the steps Back takes are the ones now shown
        await openSettings(page);
        await openSettingsPage(page, "Terminal");
        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForFunction(() => (history.state as Record<string, { depth: number }> | null)?.["herdr-web-ui:settings"]?.depth === 2);
        await page.goBack();
        await dialogOf(page).getByRole("tablist").waitFor();
        assert.equal(await dialogOf(page).getByRole("tabpanel").count(), 0, "narrowed, Back from the page shows the list");
        await page.goBack();
        await page.locator(".settings-dialog").waitFor({ state: "detached" });
        await openSettings(page);
        await openSettingsPage(page, "Terminal");
        await dialogOf(page).getByRole("button", { name: "Edit key bar", exact: true }).click();
        await page.getByRole("dialog", { name: "Key bar", exact: true }).waitFor();
        await page.setViewportSize({ width: 1280, height: 800 });
        // the rebuilt stack, not the step the widening passes through
        await page.waitForFunction(() => { const entry = (history.state as Record<string, { page: string; keyBar: boolean; depth: number }> | null)?.["herdr-web-ui:settings"]; return entry?.depth === 2 && entry.page === "terminal" && entry.keyBar === true; });
        await page.goBack();
        await dialogOf(page).getByRole("tabpanel", { name: "Terminal", exact: true }).waitFor();
        assert.equal(await page.locator(".key-bar-settings").count(), 0, "widened, Back from the editor shows the Terminal page");
        await page.goBack();
        await page.locator(".settings-dialog").waitFor({ state: "detached" });
        await page.waitForFunction(() => (history.state as Record<string, unknown> | null)?.["herdr-web-ui:settings"] === undefined);
        assert.deepEqual(errors, []);
        console.log("PASS a window that changes width with Settings open keeps Back to the steps it shows");
      } finally {
        await desktop.close();
      }
    } finally {
      await browser.close();
    }
  } finally {
    server.stop(true);
  }
} finally {
  rmSync(app, { recursive: true, force: true });
}
