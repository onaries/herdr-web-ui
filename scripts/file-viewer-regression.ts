/** Mobile history regression using a real chat transcript and an owned herdr pane. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { openSettingsPage } from "./settings-page.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-file-back-"));
const codexHome = join(root, "codex-home");
const thread = "01a0c7a1-56d9-7e20-9f08-f7a2d973bc11";
mkdirSync(join(codexHome, "sessions"), { recursive: true });
const transcript = join(codexHome, "sessions", `rollout-2026-09-28T00-00-00-${thread}.jsonl`);
const fidelitySources = ["const last = 7;\n\n", "first\n", "first\n\nlast", "\n"];
writeFileSync(transcript, [
  { type: "session_meta", payload: { id: thread, cwd: root } },
  { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Show me the demo video." }] } },
  { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: `Open [demo video](./preview.webm) or [notes](./notes.txt) or [file URI notes](${new URL(`file://${join(root, "notes.txt")}`).href}) or [folder](${new URL(`file://${root}`).href}).\n\n${new URL(`file://${join(root, "notes.txt")}`).href}\n\n\`\`\`ts\nconst answer = 42;\n\nexport { answer };\n\`\`\`` }] } },
  // a block the highlighter is quadratic on (a line of dashes in YAML): seconds on the page
  { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: `Dashes:\n\n\`\`\`yaml\n${"-".repeat(90_000)}\n\`\`\`` }] } },
  // more lines than are drawn one element each (LINE_ELEMENT_LIMIT): 30 000 elements held the page
  { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: `Lines:\n\n\`\`\`\n${"x\n".repeat(30_000)}\`\`\`` }] } },
  ...fidelitySources.map((source, index) => ({ type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: `\`\`\`${index === 0 ? "ts" : "text"}\n${source}\n\`\`\`` }] } })),
].map((row) => JSON.stringify(row)).join("\n"));
const db = new Database(join(codexHome, "state_5.sqlite"));
db.exec("CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT, archived INTEGER, agent_role TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, first_user_message TEXT)");
db.query("INSERT INTO threads VALUES (?, ?, ?, 0, NULL, 1, 1, 'cli', ?)").run(thread, transcript, root, "Show me the demo video.");
db.close();
const standIn = join(root, "codex");
writeFileSync(standIn, "#!/bin/sh\nsleep 600\n");
chmodSync(standIn, 0o755);
copyFileSync(join(import.meta.dir, "fixtures", "file-preview.webm"), join(root, "preview.webm"));
writeFileSync(join(root, "notes.txt"), "File preview history regression\n");
let workspace: string | undefined;
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

try {
  const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-file-back" });
  workspace = created.workspace.workspace_id;
  const pane = created.root_pane.pane_id;
  await herdrRpc("pane.send_text", { pane_id: pane, text: `${standIn} resume ${thread}\n` });
  for (let attempt = 0; attempt < 100; attempt++) {
    const info = await herdrRpc<{ process_info?: { foreground_processes?: { argv?: string[] }[] } }>("pane.process_info", { pane_id: pane });
    if (info.process_info?.foreground_processes?.some((process) => process.argv?.includes(standIn))) break;
    if (attempt === 99) throw new Error("test Codex process did not start");
    await Bun.sleep(50);
  }
  await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "codex", state: "idle", agent_session_path: transcript });
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), codexHome });
  const origin = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  // seeded once: a later step changes a setting and reloads. Long tasks are recorded from the first
  // paint: nothing an agent writes may hold the page for a second
  await page.addInitScript(() => {
    if (localStorage.getItem("herdr-web-ui:settings") === null) localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" }));
    const record = window as unknown as { longTasks: number[] };
    record.longTasks = [];
    new PerformanceObserver((list) => { for (const entry of list.getEntries()) record.longTasks.push(entry.duration); }).observe({ type: "longtask" });
  });
  const frozen = async () => (await page.evaluate(() => (window as unknown as { longTasks?: number[] }).longTasks ?? [])).filter((duration) => duration >= 1_000);
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // A known prior document proves explicit close leaves no invisible preview entry.
  await page.goto(`${origin}/api/health`);
  await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
  await page.locator(".conn-live").waitFor();
  const videoLink = page.getByRole("button", { name: "demo video", exact: true });
  await videoLink.waitFor();
  await page.locator(".markdown-code").first().locator(".hl-keyword", { hasText: "const" }).waitFor();
  await page.locator(".markdown-code .hl-number", { hasText: "42" }).waitFor();
  console.log("PASS Chat fenced code block is syntax highlighted");
  // a blank line must survive in the text a copy picks up
  const codeText = await page.locator(".markdown-code .hl-code").first().innerText();
  if (codeText !== "const answer = 42;\n\nexport { answer };") throw new Error(`Chat code block text lost its blank line: ${JSON.stringify(codeText)}`);
  console.log("PASS Chat code block keeps its blank line in the text");
  const checkCodeFidelity = async (mode: string) => {
    for (const [index, source] of fidelitySources.entries()) {
      const block = page.locator(".markdown-code").nth(3 + index);
      assert.equal(await block.locator("code").textContent(), source, `${mode}: source whitespace`);
      const selections = await block.locator("pre").evaluate((pre, source) => {
        const selection = window.getSelection()!;
        const select = (node: Node) => {
          const range = document.createRange(); range.selectNodeContents(node);
          selection.removeAllRanges(); selection.addRange(range);
          return selection.toString();
        };
        const actual = select(pre);
        const baseline = document.createElement("pre");
        const code = document.createElement("code"); code.textContent = source;
        baseline.append(code); document.body.append(baseline);
        const expected = select(baseline);
        baseline.remove(); selection.removeAllRanges();
        return { actual, expected };
      }, source);
      assert.equal(selections.actual, selections.expected, `${mode}: selection matches native pre/code`);
    }
    if (process.env.UI_EVIDENCE_DIR) {
      mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
      await page.locator(".markdown-code").nth(3).screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `code-fidelity-${mode}.png`) });
    }
    console.log(`PASS ${mode}: trailing and interior blank lines match source and native selection`);
  };
  await checkCodeFidelity("highlight-on");
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("Keep my mobile draft");
  const chatUrl = page.url();
  await page.evaluate(() => {
    history.replaceState({ ...history.state, testMarker: "preserved" }, "");
    (window as unknown as { testDocument: string }).testDocument = "same-document";
  });
  const baseline = await page.evaluate(() => history.length);
  const preview = page.getByRole("dialog", { name: "preview.webm", exact: true });
  await videoLink.click();
  await preview.locator("video").waitFor();
  await page.waitForFunction(() => (document.querySelector("video")?.readyState ?? 0) >= 1);
  assert.equal(await page.evaluate(() => history.length), baseline + 1);
  if (process.env.UI_EVIDENCE_DIR) {
    mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "mobile-video-open.png") });
  }
  // The Android system Back button uses this same browser history traversal.
  await page.goBack();
  await preview.waitFor({ state: "hidden" });
  assert.equal(page.url(), chatUrl);
  assert.equal(await composer.inputValue(), "Keep my mobile draft");
  assert.equal(await page.evaluate(() => (window as unknown as { testDocument: string }).testDocument), "same-document");
  assert.equal(await page.evaluate(() => history.state.testMarker), "preserved");
  await videoLink.waitFor();
  if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "mobile-back-to-chat.png") });
  console.log("PASS mobile Back closes a playable video and preserves the chat document and draft");

  await page.goForward();
  await preview.waitFor();
  await preview.getByRole("button", { name: "Close file", exact: true }).click();
  await preview.waitFor({ state: "hidden" });
  // Repeated opens must not accumulate extra history entries.
  await videoLink.click();
  await preview.waitFor();
  assert.equal(await page.evaluate(() => history.length), baseline + 1);
  await page.keyboard.press("Escape");
  await preview.waitFor({ state: "hidden" });
  await videoLink.click();
  await preview.waitFor();
  // A press on the backdrop itself closes the viewer. On a touch device the viewer fills the
  // scrim edge to edge, so the press is sent to the scrim rather than aimed at an exposed pixel.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator(".file-viewer-scrim").evaluate((scrim) => scrim.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
  await preview.waitFor({ state: "hidden" });
  await page.setViewportSize({ width: 390, height: 844 });
  console.log("PASS Forward restores the viewer; X, Escape and scrim close consume its entry");

  // The Settings shortcut must open a visible dialog above the preview. Its history entries
  // retain the file beneath it, so only Settings may handle Escape until those entries land.
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await videoLink.click();
    await preview.waitFor();
    const previewEntry = await page.evaluate(() => history.state["herdr-web-ui:file-preview"]);
    await page.keyboard.press("ControlOrMeta+Shift+Comma");
    const settings = page.getByRole("dialog", { name: "Settings", exact: true });
    await settings.waitFor();
    await page.waitForFunction(() => history.state?.["herdr-web-ui:settings"] !== undefined);
    const settingsClose = settings.getByRole("button", { name: "Close settings", exact: true });
    assert.equal(await settingsClose.evaluate((button) => {
      const rect = button.getBoundingClientRect();
      return Boolean(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest(".settings-dialog"));
    }), true, `Settings is above the preview at ${width}px`);
    if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `settings-over-preview-${width}.png`) });
    // two traps are open: only the one in front moves the focus, so Tab walks Settings' controls
    // instead of being sent back to its first one by the preview's trap beneath
    const focused: string[] = [];
    for (let press = 0; press < 3; press++) {
      await page.keyboard.press("Tab");
      focused.push(await page.evaluate(() => {
        const active = document.activeElement;
        return active?.closest(".settings-dialog") ? active.outerHTML.slice(0, 120) : `outside: ${active?.outerHTML.slice(0, 80)}`;
      }));
    }
    assert.ok(focused.every((entry) => !entry.startsWith("outside")), `Tab stays inside Settings at ${width}px: ${focused.join(" | ")}`);
    // Settings has two stops on a phone (Close, and the one focusable tab of its roving list): Tab
    // moves between them; the trap beneath held it on the first
    assert.ok(new Set(focused).size >= 2 && focused[0] !== focused[1], `Tab moves through Settings at ${width}px: ${focused.join(" | ")}`);
    await page.keyboard.press("Escape");
    await settings.waitFor({ state: "hidden" });
    await page.waitForFunction(() => history.state?.["herdr-web-ui:settings"] === undefined);
    await preview.waitFor();
    assert.deepEqual(await page.evaluate(() => history.state["herdr-web-ui:file-preview"]), previewEntry, "Escape closes only Settings and preserves the preview entry");
    await preview.getByRole("button", { name: "Close file", exact: true }).click();
    await preview.waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => history.state?.["herdr-web-ui:file-preview"]), undefined, "one click on Close file consumes the preview entry");
    assert.equal(await composer.inputValue(), "Keep my mobile draft");

    // System Back follows the same order, preserving the document instead of closing the file.
    await videoLink.click();
    await preview.waitFor();
    await page.keyboard.press("ControlOrMeta+Shift+Comma");
    await settings.waitFor();
    await page.waitForFunction(() => history.state?.["herdr-web-ui:settings"] !== undefined);
    await page.goBack();
    await settings.waitFor({ state: "hidden" });
    await preview.waitFor();
    await preview.getByRole("button", { name: "Close file", exact: true }).click();
    await preview.waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => (window as unknown as { testDocument: string }).testDocument), "same-document");
    console.log(`PASS Settings opens above the preview at ${width}px; Escape and Back preserve it, then X closes the file once`);
  }

  // Add PC from Settings over a preview: Settings closes, the preview stays mounted beneath, and
  // the native modal Add PC opens is on top. Tab walks Add PC's own controls; the preview's trap
  // must not take it back to its own, now inert, controls.
  await page.setViewportSize({ width: 1280, height: 800 });
  await videoLink.click();
  await preview.waitFor();
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  const settingsOverPreview = page.getByRole("dialog", { name: "Settings", exact: true });
  await settingsOverPreview.waitFor();
  await openSettingsPage(page, "Remote PCs");
  await settingsOverPreview.getByRole("button", { name: "Add PC", exact: true }).click();
  const addPc = page.locator("dialog.machine-dialog");
  await addPc.waitFor();
  await settingsOverPreview.waitFor({ state: "hidden" });
  assert.equal(await page.locator(".file-viewer").count(), 1, "the preview stays beneath Add PC");
  await page.waitForFunction(() => Boolean(document.activeElement?.closest("dialog.machine-dialog")));
  const addPcFocus: string[] = [];
  for (let press = 0; press < 3; press++) {
    await page.keyboard.press("Tab");
    addPcFocus.push(await page.evaluate(() => {
      const active = document.activeElement;
      return active?.closest("dialog.machine-dialog") ? active.outerHTML.slice(0, 120) : `outside: ${active?.outerHTML.slice(0, 80)}`;
    }));
  }
  assert.ok(addPcFocus.every((entry) => !entry.startsWith("outside")), `Tab stays inside Add PC over a preview: ${addPcFocus.join(" | ")}`);
  assert.ok(new Set(addPcFocus).size >= 2, `Tab moves through Add PC over a preview: ${addPcFocus.join(" | ")}`);
  // Escape is Add PC's too: it closes Add PC alone, and the preview and its entry stay
  const previewUnderAddPc = await page.evaluate(() => history.state["herdr-web-ui:file-preview"]);
  await page.keyboard.press("Escape");
  await addPc.waitFor({ state: "hidden" });
  assert.equal(await page.locator(".file-viewer").count(), 1, "Escape over Add PC leaves the preview beneath it");
  assert.deepEqual(await page.evaluate(() => history.state["herdr-web-ui:file-preview"]), previewUnderAddPc, "Escape over Add PC preserves the preview entry");
  await preview.getByRole("button", { name: "Close file", exact: true }).click();
  await preview.waitFor({ state: "hidden" });
  console.log("PASS Add PC opened from Settings over a preview keeps Tab inside Add PC, and its Escape closes Add PC alone");

  // With no preview beneath it, Settings stays on the layer every dialog shares, so the palette
  // its shortcut opens is drawn above Settings instead of taking focus and Escape unseen.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  const settingsAlone = page.getByRole("dialog", { name: "Settings", exact: true });
  await settingsAlone.waitFor();
  await page.waitForFunction(() => history.state?.["herdr-web-ui:settings"] !== undefined);
  await page.keyboard.press("ControlOrMeta+Shift+K");
  const palette = page.getByRole("dialog", { name: "Command palette", exact: true });
  const paletteSearch = palette.getByRole("searchbox", { name: "Search panes and actions", exact: true });
  await paletteSearch.waitFor();
  assert.equal(await paletteSearch.evaluate((input) => {
    const rect = input.getBoundingClientRect();
    return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === input;
  }), true, "the command palette is above Settings");
  if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "palette-over-settings-1280.png") });
  await page.keyboard.press("Escape");
  await palette.waitFor({ state: "hidden" });
  await settingsAlone.waitFor();
  await page.keyboard.press("Escape");
  await settingsAlone.waitFor({ state: "hidden" });
  await page.waitForFunction(() => history.state?.["herdr-web-ui:settings"] === undefined);
  console.log("PASS the command palette opens above Settings; Escape closes the palette, then Settings");

  // Over Settings raised above a preview, too, the palette it opens is the top layer: it takes
  // focus and Escape, so it must not be drawn beneath either of them.
  await videoLink.click();
  await preview.waitFor();
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  await settingsAlone.waitFor();
  await page.waitForFunction(() => history.state?.["herdr-web-ui:settings"] !== undefined);
  await page.keyboard.press("ControlOrMeta+Shift+K");
  await paletteSearch.waitFor();
  const topmost = (input: Element) => {
    const rect = input.getBoundingClientRect();
    return { above: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === input, focused: document.activeElement === input };
  };
  // the palette takes focus once it has mounted: wait for that, then say which part is missing
  await page.waitForFunction((input) => {
    const rect = input!.getBoundingClientRect();
    return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === input && document.activeElement === input;
  }, await paletteSearch.elementHandle(), { timeout: 5000 }).catch(() => undefined);
  if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "palette-over-settings-over-preview-1280.png") });
  assert.deepEqual(await paletteSearch.evaluate(topmost), { above: true, focused: true }, "the command palette is above Settings and the preview, and has focus");
  await page.keyboard.press("Escape");
  await palette.waitFor({ state: "hidden" });
  await settingsAlone.waitFor();
  await preview.waitFor();
  await page.keyboard.press("Escape");
  await settingsAlone.waitFor({ state: "hidden" });
  await preview.waitFor();
  await preview.getByRole("button", { name: "Close file", exact: true }).click();
  await preview.waitFor({ state: "hidden" });
  console.log("PASS the command palette opens above Settings over a preview; Escape closes the palette, then Settings, then X the file");
  await page.setViewportSize({ width: 390, height: 844 });

  await page.getByRole("button", { name: "notes", exact: true }).click();
  const notes = page.getByRole("dialog", { name: "notes.txt", exact: true });
  await notes.getByText("File preview history regression", { exact: true }).waitFor();
  await page.reload();
  await notes.getByText("File preview history regression", { exact: true }).waitFor();
  await page.goBack();
  await notes.waitFor({ state: "hidden" });
  await videoLink.waitFor();
  await videoLink.click();
  await preview.waitFor();
  await preview.getByRole("button", { name: "Close file", exact: true }).click();
  await preview.waitFor({ state: "hidden" });
  await page.goBack();
  assert.equal(page.url(), `${origin}/api/health`, "no ghost modal entry or back trap after explicit close");
  assert.deepEqual(errors, []);
  console.log("PASS text preview survives reload; closed viewers leave normal Back navigation intact");
  await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
  await page.getByRole("button", { name: "file URI notes", exact: true }).tap();
  await page.locator(".file-viewer-text").waitFor();
  assert.match(await page.locator(".file-viewer-text").innerText(), /File preview history regression/);
  console.log("PASS Chat file URI label opens file content through touch");
  await page.getByRole("button", { name: "Close file", exact: true }).click();
  await page.locator(".file-viewer").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "folder", exact: true }).tap();
  await page.locator(".file-viewer .dir-browser").waitFor();
  await page.locator(".file-viewer .dir-browser").getByRole("button", { name: /notes.txt/ }).tap();
  await page.locator(".file-viewer-text").waitFor();
  assert.match(await page.locator(".file-viewer-text").innerText(), /File preview history regression/);
  console.log("PASS Chat folder URI opens directory browser through touch");
  await page.locator(".file-viewer-header button").click();
  await page.locator(".file-viewer").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: new URL(`file://${join(root, "notes.txt")}`).href, exact: true }).tap();
  await page.locator(".file-viewer-text").waitFor();
  assert.match(await page.locator(".file-viewer-text").innerText(), /File preview history regression/);
  console.log("PASS Chat plain file URI opens content through touch");
  await page.getByRole("button", { name: "Close file", exact: true }).click();
  await page.locator(".file-viewer").waitFor({ state: "hidden" });

  // a chat code block the highlighter gives up on stays plain and says so, and the page runs on
  await page.locator(".markdown-code .hl-note", { hasText: "Too long to highlight" }).waitFor();
  assert.equal(await page.locator(".markdown-code").nth(1).locator("code span:not(.hl-line)").count(), 0, "the slow block is plain");
  await page.locator(".markdown-code").first().locator(".hl-keyword", { hasText: "const" }).waitFor();
  console.log("PASS A chat code block too slow to highlight stays plain, the others are colored");
  // a block of more lines than are drawn one element each opens whole as one text
  const many = page.locator(".markdown-code").nth(2);
  await many.getByRole("button", { name: "Show all 30000 lines", exact: true }).click();
  await many.getByRole("button", { name: "Show less", exact: true }).waitFor();
  assert.equal(await many.locator(".hl-line").count(), 0, "no element per line");
  assert.equal((await many.locator(".hl-code").innerText()).split("\n").length, 30_000);
  assert.deepEqual(await frozen(), [], "no task held the page for a second");
  console.log("PASS A chat code block of 30 000 lines opens as one text, and the page never freezes");

  // Settings → Highlight code, off: code in the chat is plain text
  await page.evaluate(() => {
    const settings = JSON.parse(localStorage.getItem("herdr-web-ui:settings") ?? "{}") as Record<string, unknown>;
    localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ ...settings, highlightCode: false }));
  });
  await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
  await page.locator(".conn-live").waitFor();
  await page.locator(".markdown-code .hl-code").first().waitFor();
  assert.equal(await page.locator(".markdown-code .hl-keyword, .markdown-code .hl-number").count(), 0, "chat code is plain");
  assert.equal(await page.locator(".markdown-code .hl-note").count(), 0, "plain by choice is not too long");
  await checkCodeFidelity("highlight-off");
  console.log("PASS Settings → Highlight code off shows chat code plain");
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  server?.stop();
  if (workspace) await workspaceClose(workspace);
  rmSync(root, { recursive: true, force: true });
}
