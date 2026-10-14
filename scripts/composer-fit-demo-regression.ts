import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { appFaces } from "./app-faces.ts";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { openSettingsPage } from "./settings-page.ts";

// The model label in the input card's last row, fitted to what is measured there, on the
// unmodified app over the demo's fixture transport. The demo's panes name no context window and
// run no task, so the page's data is patched here, in the test only: the pane is a Claude or Codex one with
// two background tasks, in the state a case asks for, and its conversation names that case's
// model, the level xhigh and a context window; an upload never answers, so its sentence stays.
// All files and HTTP traffic stay in this disposable, loopback-only app; no herdr session is opened.
const repo = join(import.meta.dir, "..");
const app = mkdtempSync(join(tmpdir(), "herdr-composer-fit-demo-"));
// an id the composer cannot name is drawn as received, in the mono face: the widest label there is
const LONG_MODEL = "gpt-5.6-sol-codex-preview-2026-10";
// ids it names: "GPT-5.6" and "Opus 5.5"; null: the conversation names no model
const NAMED = ["gpt-5.6", "claude-opus-5-5"] as const;

interface Case { model: string | null; agent?: "claude" | "codex" | "pi" | "omo"; pending?: boolean; effort?: string | null; status?: "working" | "idle"; mic?: boolean; ring?: boolean; chatFontSize?: number | null; showUsage?: boolean; weeklyOnly?: boolean }
type Draw = "full" | "no-effort" | "out";

const measure = (page: Page) => page.evaluate(() => {
  const status = document.querySelector<HTMLElement>(".composer-status")!;
  const part = (selector: string) => {
    const item = document.querySelector<HTMLElement>(selector);
    if (!item) return null;
    const box = item.getBoundingClientRect();
    return { top: box.top, bottom: box.bottom, width: box.width, clipped: item.scrollWidth > item.clientWidth };
  };
  // everything drawn in the last row: no two of them may share a pixel
  const drawn = [...document.querySelectorAll<HTMLElement>(".composer-controls-left > *:not(input), .composer-status-meta > *, .composer-status-hint, .composer-controls-right > *")]
    // the pill and what it holds: its parts are compared with each other too, in every draw (a
    // pill without a box, the label out or no model, has no size and is filtered out below)
    .flatMap((item) => item.classList.contains("composer-pill") ? [item, ...item.children] as HTMLElement[] : [item])
    .flatMap((item) => item.classList.contains("composer-model-info") && getComputedStyle(item).display === "contents" ? [...item.children] as HTMLElement[] : [item])
    .filter((item) => item.getBoundingClientRect().width > 1.5 && item.getBoundingClientRect().height > 1.5);
  const overlaps: string[] = [];
  for (const [index, one] of drawn.entries()) for (const other of drawn.slice(index + 1)) {
    // the pill is around its own parts
    if (one.classList.contains("composer-pill") && one.contains(other)) continue;
    const a = one.getBoundingClientRect(), b = other.getBoundingClientRect();
    if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5) overlaps.push(`${one.className} | ${other.className}`);
  }
  const surface = document.querySelector(".composer-surface")!.getBoundingClientRect();
  return {
    draw: status.getAttribute("data-model") ?? "full", hintAlone: status.hasAttribute("data-hint-alone"),
    card: { width: surface.width, height: surface.height }, status: status.getBoundingClientRect().height,
    pill: (() => {
      const pill = document.querySelector<HTMLElement>(".composer-pill")!;
      const box = pill.getBoundingClientRect(), row = status.getBoundingClientRect();
      const inside = (selector: string): boolean => {
        const item = pill.querySelector<HTMLElement>(selector)?.getBoundingClientRect();
        return item !== undefined && item.left >= box.left - 0.5 && item.right <= box.right + 0.5 && item.top >= box.top - 0.5 && item.bottom <= box.bottom + 0.5;
      };
      const style = getComputedStyle(pill);
      return {
        width: box.width, height: box.height, inRow: box.left >= row.left - 0.5 && box.right <= row.right + 0.5,
        holds: inside(".agent-mark") && inside(".composer-model") && (pill.querySelector(".composer-context") === null || inside(".composer-context"))
          // the level too, wherever it is drawn (stepped out or not recorded it is a 1px box that is only read)
          && ((pill.querySelector<HTMLElement>(".composer-reasoning")?.getBoundingClientRect().width ?? 0) <= 1.5 || inside(".composer-reasoning")),
        // it only shows: nothing about it says it can be pressed
        inert: pill.tagName === "SPAN" && !pill.hasAttribute("role") && !pill.hasAttribute("tabindex") && style.cursor === "auto",
      };
    })(),
    name: document.querySelector<HTMLElement>(".composer-model")?.textContent ?? null, named: !document.querySelector(".composer-model")?.classList.contains("is-id"),
    label: part(".composer-model-info"), model: part(".composer-model"), effort: part(".composer-reasoning"), ring: part(".composer-context"), ringText: part(".composer-context-text"),
    // the ring's track, and the two tokens it can be: the bare ring's and the one on the pill's fill
    track: (() => {
      const track = document.querySelector(".composer-context-track");
      const token = (name: string): string => {
        const probe = document.body.appendChild(document.createElement("span"));
        probe.style.color = `var(${name})`;
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      };
      return track ? { stroke: getComputedStyle(track).stroke, bare: token("--border"), onFill: token("--border-strong") } : null;
    })(),
    hint: part(".composer-status-hint"), queue: document.querySelector(".composer-queue-button") !== null,
    send: document.querySelector(".composer-controls-right .composer-send") !== null,
    sendOptions: document.querySelector(".composer-send-options") !== null,
    stop: document.querySelector(".composer-controls-right .composer-stop") !== null,
    chip: document.querySelector(".bg-tasks-toggle") !== null, mic: document.querySelector(".composer-controls-left .voice-mic") !== null,
    overlaps, overflowing: document.documentElement.scrollWidth > window.innerWidth,
  };
});
type Row = Awaited<ReturnType<typeof measure>>;

/** The fit answers after the commit, a resize a frame later: wait for the mark, never a fixed time. */
const drawn = async (page: Page, draw: Draw, what: string): Promise<Row> => {
  await page.waitForFunction((want) => (document.querySelector(".composer-status")?.getAttribute("data-model") ?? "full") === want, draw, { timeout: 5_000 })
    .catch(async () => assert.fail(`${what}: the model label is drawn "${(await measure(page)).draw}", not "${draw}": ${JSON.stringify(await measure(page))}`));
  const row = await measure(page);
  // a label that is drawn whole is whole; with Queue it is never drawn in part
  if (draw === "full" || row.queue) assert.ok(!row.model?.clipped && !row.effort?.clipped, `${what}: no word of the model label is cut: ${JSON.stringify(row)}`);
  if (draw === "no-effort") assert.ok((row.effort?.width ?? 0) <= 1, `${what}: the level is read, not drawn: ${JSON.stringify(row)}`);
  if (draw === "out") assert.ok((row.label?.width ?? 0) <= 1, `${what}: the name and the level are read, not drawn: ${JSON.stringify(row)}`);
  // the pill goes with the label: no empty pill is left around the ring. Drawn, it holds the mark, the name and the ring
  if (draw === "out") assert.equal(row.pill.width, 0, `${what}: no pill is drawn without its label: ${JSON.stringify(row)}`);
  else assert.ok(row.pill.width > 1 && row.pill.inRow && row.pill.holds && row.pill.inert, `${what}: the mark, the name and the ring sit in one pill that is not a control: ${JSON.stringify(row)}`);
  // the ring's track is the stronger one only on the pill's fill: bare on the card it is the bare ring's
  if (row.track) assert.equal(row.track.stroke, draw === "out" ? row.track.bare : row.track.onFill, `${what}: the ring's track is the one for where it stands: ${JSON.stringify(row.track)}`);
  assert.deepEqual(row.overlaps, [], `${what}: nothing overlaps its neighbour`);
  assert.equal(row.overflowing, false, `${what}: the page does not scroll sideways`);
  return row;
};

const ring = (page: Page) => page.locator(".composer-context");
/**
 * Opens or closes the context number and answers how the label is drawn in that same task: React
 * commits a click in a microtask, and the label is fitted with that commit, not by whatever
 * renders the composer next (a poll, a status change), which no wait here would tell apart.
 */
const toggleRing = async (page: Page, open: boolean, draw?: Draw): Promise<void> => {
  const marked = await ring(page).evaluate(async (node: HTMLElement) => {
    node.click();
    await new Promise<void>((done) => queueMicrotask(done));
    return { open: node.getAttribute("aria-expanded"), draw: node.closest(".composer-status")!.getAttribute("data-model") ?? "full" };
  });
  assert.equal(marked.open, String(open));
  if (draw) assert.equal(marked.draw, draw, `the model label is fitted as the context number ${open ? "opens" : "closes"}`);
};
const draft = async (page: Page): Promise<void> => {
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("hold this");
  await page.getByRole("button", { name: "Send message", exact: true }).waitFor();
};
const upload = async (page: Page): Promise<void> => {
  await page.locator('.composer-controls-left input[type="file"]').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("x") });
  await page.locator(".composer-status-hint").waitFor();
  assert.equal(await page.locator(".composer-status-hint").textContent(), "· Uploading file…");
};

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  // What the demo answers, rewritten as it is read (`window.fitCase` is set per browser context).
  const patch = `<script>(() => {
    const TARGET = ${JSON.stringify(panes.api)};
    const fix = (value) => {
      if (!value || typeof value !== "object") return value;
      if (Array.isArray(value)) { value.forEach(fix); return value; }
      if (value.pane_id === TARGET && "agent_status" in value) {
        if ("agent" in value) Object.assign(value, { agent: window.fitCase.agent, background_tasks: 2 });
        value.agent_status = window.fitCase.status;
      }
      if (Array.isArray(value.features) && !window.fitCase.pending) value.features = value.features.filter((feature) => feature !== "pending-input");
      if (window.fitCase.weeklyOnly && value.id === "codex" && Array.isArray(value.windows)) value.windows = value.windows.filter((limit) => limit.kind !== "session");
      if (Array.isArray(value.turns) && value.metadata) value.metadata = { model: window.fitCase.model, reasoning_effort: window.fitCase.effort, ...(window.fitCase.ring ? { context: { used: 151000, window: 272000 } } : {}) };
      for (const key of Object.keys(value)) fix(value[key]);
      return value;
    };
    const clone = structuredClone;
    window.structuredClone = (value, options) => fix(clone(value, options));
    const later = window.setTimeout.bind(window);
    window.setTimeout = (callback, ms, ...args) => window.fitCase.status === "working" && (ms === 4500 || ms === 2400) ? 0 : later(callback, ms, ...args);
    const parse = JSON.parse;
    JSON.parse = function (text, reviver) { return fix(parse.call(JSON, text, reviver)); };
    const json = Response.prototype.json;
    Response.prototype.json = async function () { return fix(await json.call(this)); };
  })();</script>`;
  writeFileSync(index, html.replace(/<script type="module"/, () => `${patch}\n    <script src="./demo-transport.js"></script>\n    <script>(() => { const Socket = window.WebSocket; const Wrapped = function(...args) { const socket = new Socket(...args); window.fitSocket = socket; return socket; }; Object.assign(Wrapped, { CONNECTING: Socket.CONNECTING, OPEN: Socket.OPEN, CLOSING: Socket.CLOSING, CLOSED: Socket.CLOSED }); window.WebSocket = Wrapped; const demoFetch = window.fetch; window.fetch = (input, init) => String(typeof input === "string" ? input : input.url ?? input).includes("/pane/image") ? new Promise(() => {}) : demoFetch(input, init); })();</script>\n    <script type="module"`));

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
  const url = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(panes.api)}`;

  /** One card: a phone (390px, touch) or a mouse-driven window of `width`. */
  const withCard = async (browser: Browser, width: number, state: Case, run: (page: Page) => Promise<void>): Promise<void> => {
    const touch = width <= 480;
    const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: touch, isMobile: touch, locale: "en-US" });
    try {
      await context.addInitScript((fitCase) => {
        localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", voiceInput: fitCase.mic ? "on" : "off", chatFontSize: fitCase.chatFontSize ?? null, showUsage: fitCase.showUsage ?? false }));
        Object.assign(window, { fitCase });
      }, { agent: "claude", pending: true, status: "working", effort: "xhigh", mic: false, ring: true, ...state });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => { if (message.type() === "error" && message.text().includes("ResizeObserver")) errors.push(message.text()); });
      await page.goto(url);
      await page.locator(".conn-live").waitFor({ state: "attached" });
      if (await page.locator(".terminal-stack.is-chat").count() === 0) await page.getByTitle("Chat transcript (⌘⇧J)", { exact: true }).click();
      await page.locator(".terminal-stack.is-chat").waitFor();
      await page.locator(".composer-model").waitFor({ state: "attached" });
      await appFaces(page);
      await run(page);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  };

  try {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
    try {
      // One primary control across agents: Stop with an empty working draft, Send with text.
      for (const agent of ["claude", "codex"] as const) for (const width of [350, 390, 800, 1440]) for (const mic of [false, true]) await withCard(browser, width, { agent, model: "gpt-5.6", mic }, async (page) => {
        const rest = await measure(page);
        assert.ok(rest.stop && !rest.send && !rest.sendOptions && !rest.queue, JSON.stringify(rest));
        if (width <= 480) assert.equal(await page.locator(".composer-context").evaluate((node) =>
          node.tagName === "SPAN" && !node.hasAttribute("title") && !node.hasAttribute("aria-expanded") && !node.hasAttribute("tabindex")), true, "mobile context is a read-only ring");
        await draft(page);
        const row = await measure(page);
        await drawn(page, row.draw as Draw, `${agent} ${width}px, a written follow-up`);
        assert.ok(row.send && !row.stop && !row.sendOptions && !row.queue && row.ring, JSON.stringify(row));
        assert.equal(row.card.height, rest.card.height, "Send replaces Stop on the same row");
        if (width >= 800) {
          await toggleRing(page, true);
          const opened = await measure(page);
          await drawn(page, opened.draw as Draw, `${agent} ${width}px, context opened`);
          assert.equal(opened.card.height, row.card.height);
          await toggleRing(page, false);
        }
        await page.getByRole("textbox", { name: "Message", exact: true }).fill("");
        assert.equal((await measure(page)).stop, true);
      });
      for (const agent of ["pi", "omo"] as const) await withCard(browser, 390, { agent, model: LONG_MODEL, mic: true }, async (page) => {
        await draft(page);
        const row = await measure(page);
        await drawn(page, row.draw as Draw, `${agent}, a long model identifier`);
        assert.ok(row.send && !row.queue && !row.sendOptions);
      });
      console.log("PASS agents at 350, 390, 800 and 1440px use one Stop/Send control with no Queue or dropdown");

      for (const width of [350, 390]) await withCard(browser, width, { agent: "codex", model: LONG_MODEL, mic: true }, async (page) => {
        await draft(page);
        await upload(page);
        const row = await measure(page);
        await drawn(page, row.draw as Draw, `${width}px, a pending upload`);
        assert.ok(row.send && !row.queue && !row.sendOptions && row.hint && !row.hint.clipped, JSON.stringify(row));
        assert.equal(await page.getByRole("button", { name: "Send message", exact: true }).isDisabled(), true, "an upload cannot enqueue an incomplete mention");
        assert.equal(await page.locator(".pending-message-bubble").count(), 0);
      });

      // Queued text is not a transcript turn. Its selectable bubble has no action: the explicit
      // Send now button acts on the ID, and X discards it. The current fixture turn keeps running.
      for (const agent of ["claude", "codex"] as const) for (const width of [350, 390, 1440]) await withCard(browser, width, { agent, model: "gpt-5.6" }, async (page) => {
        const box = page.getByRole("textbox", { name: "Message", exact: true });
        await box.fill("check the first pending change");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        const strip = page.locator(".pending-messages");
        await strip.waitFor();
        assert.equal(await box.inputValue(), "", "an accepted pending request clears its acknowledged draft");
        assert.equal(await page.locator(".pending-message-bubble").first().textContent(), "check the first pending change");
        const before = await page.evaluate(async (paneId) => await (await fetch(`/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`)).json(), panes.api);
        assert.ok(!JSON.stringify(before).includes("check the first pending change"), "pending text has not been typed");
        await box.fill("discard this second pending change");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        await page.waitForFunction(() => document.querySelectorAll(".pending-message-bubble").length === 2);
        const geometry = await strip.evaluate((node) => {
          const edge = node.getBoundingClientRect();
          return { width: edge.width, height: edge.height, fits: edge.left >= 0 && edge.right <= innerWidth,
            actionsFit: !matchMedia("(pointer: coarse)").matches || [...node.querySelectorAll(".pending-message-action")].every((item) => { const r = item.getBoundingClientRect(), size = parseFloat(getComputedStyle(item).getPropertyValue("--touch-target")); return r.width >= size && r.height >= size; }),
            bubblesFit: [...node.querySelectorAll(".pending-message-bubble")].every((item) => { const r = item.getBoundingClientRect(); return r.left >= edge.left && r.right <= edge.right + 0.5; }) };
        });
        assert.ok(geometry.fits && geometry.bubblesFit && geometry.actionsFit && geometry.height <= 844 * 0.2 + 0.5, JSON.stringify(geometry));
        const bubbles = page.locator(".pending-message-bubble");
        assert.equal(await bubbles.first().evaluate((node) => node.tagName), "DIV", "pending text is selectable, without a click action");
        await bubbles.first().click();
        assert.equal(await bubbles.count(), 2, "clicking message text does not send it");
        const untouched = await page.evaluate(async (paneId) => await (await fetch(`/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`)).json(), panes.api);
        assert.ok(!JSON.stringify(untouched).includes("check the first pending change"));
        await strip.getByRole("button", { name: "Send now: check the first pending change", exact: true }).click();
        await page.waitForFunction(() => document.querySelectorAll(".pending-message-bubble").length === 1);
        const after = await page.evaluate(async (paneId) => await (await fetch(`/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`)).json(), panes.api);
        assert.equal(JSON.stringify(after).split("check the first pending change").length - 1, 1, "Send now delivers this ID once");
        await strip.getByRole("button", { name: "Discard", exact: true }).click();
        await strip.waitFor({ state: "hidden" });
        const discarded = await page.evaluate(async (paneId) => await (await fetch(`/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`)).json(), panes.api);
        assert.ok(!JSON.stringify(discarded).includes("discard this second pending change"));
      });
      console.log("PASS selectable pending bubbles fit phones; explicit Send now and Discard act on IDs");

      // A confirmed hold can be sent explicitly on a new connection. An unconfirmed queued
      // request instead becomes uncertain and never offers an automatic or explicit retry.
      for (const held of [false, true]) await withCard(browser, 390, { agent: "codex", model: "gpt-5.6" }, async (page) => {
        const text = held ? "confirmed held follow-up" : "unconfirmed follow-up";
        await page.getByRole("textbox", { name: "Message", exact: true }).fill(text);
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        await page.locator(".pending-message-bubble").waitFor();
        await page.evaluate(({ held, paneId }) => {
          const socket = (window as unknown as { fitSocket: { holdPending: (pane: string) => void; close: () => void } }).fitSocket;
          if (held) socket.holdPending(paneId);
          socket.close();
        }, { held, paneId: panes.api });
        await page.waitForFunction(() => (window as unknown as { fitSocket?: { readyState: number } }).fitSocket?.readyState === 1);
        const bubble = page.locator(".pending-message-bubble");
        await page.waitForFunction((state) => document.querySelector(".pending-message")?.getAttribute("data-state") === state, held ? "held" : "uncertain");
        const notSent = await page.evaluate(async (paneId) => await (await fetch(`/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`)).json(), panes.api);
        assert.ok(!JSON.stringify(notSent).includes(text), "reconnection never sends a stored copy");
        if (held) {
          await page.waitForFunction(() => !(document.querySelector(".pending-message-send") as HTMLButtonElement).disabled);
          await page.getByRole("button", { name: `Send now: ${text}`, exact: true }).click();
          await bubble.waitFor({ state: "hidden" });
          const sent = await page.evaluate(async (paneId) => await (await fetch(`/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`)).json(), panes.api);
          assert.equal(JSON.stringify(sent).split(text).length - 1, 1);
        } else {
          assert.equal(await page.locator(".pending-message-send").count(), 0, "uncertain text has no Send now action");
          assert.equal(await page.locator(".pending-message-action").evaluateAll((items) => items.every((item) => {
            const r = item.getBoundingClientRect(), size = parseFloat(getComputedStyle(item).getPropertyValue("--touch-target"));
            return r.width >= size && r.height >= size;
          })), true, "Copy and Discard keep the full touch target");
          await page.getByRole("button", { name: "Discard saved copy", exact: true }).click();
          await bubble.waitFor({ state: "hidden" });
        }
      });
      await withCard(browser, 800, { agent: "codex", pending: false, model: "gpt-5.6" }, async (page) => {
        await draft(page);
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        await page.locator(".composer-note").waitFor();
        assert.equal(await page.getByRole("textbox", { name: "Message", exact: true }).inputValue(), "hold this");
        assert.equal(await page.locator(".pending-message-bubble").count(), 0);
        assert.match(await page.locator(".composer-note").textContent() ?? "", /Update this PC/);
        // the reason sits on the box's top edge, the box's width, not under it
        const [noteBox, surfaceBox] = await Promise.all([page.locator(".composer-note").boundingBox(), page.locator(".composer-surface").boundingBox()]);
        assert.ok(noteBox && surfaceBox && noteBox.y + noteBox.height <= surfaceBox.y + 1, "the note is above the message box");
        assert.ok(noteBox && surfaceBox && Math.abs(noteBox.width - surfaceBox.width) <= 1 && Math.abs(noteBox.x - surfaceBox.x) <= 1, "and as wide as it");
      });
      console.log("PASS connection loss suspends pending items, confirmed holds need Send now, and old bridges keep the draft");

      for (const weeklyOnly of [false, true]) await withCard(browser, 1440, { agent: "codex", model: "gpt-5.6", showUsage: true, weeklyOnly }, async (page) => {
        const usage = page.locator(".composer-status .composer-usage");
        await usage.waitFor();
        assert.equal(await usage.evaluate((node) => node.tagName === "SPAN" && !node.hasAttribute("tabindex")), true, "desktop quota is a read-only glance");
        assert.equal(await usage.locator('span[aria-hidden="true"]').textContent(), weeklyOnly ? "Weekly 84%" : "5h 22%", "the session precedes the tighter week; no session falls back to the week");
        assert.equal(await usage.evaluate((node) => node.classList.contains("is-high")), weeklyOnly);
        assert.match(await usage.getAttribute("title") ?? "", /sam@work\.example/);
      });
      await withCard(browser, 390, { agent: "codex", model: "gpt-5.6", showUsage: true }, async (page) => {
        assert.equal(await page.locator(".composer-status .composer-usage").count(), 0, "mobile omits the desktop quota even when sidebar limits are enabled");
        assert.equal(await page.locator(".composer-context").evaluate((node) => node.tagName === "SPAN" && !node.hasAttribute("aria-expanded")), true);
      });
      console.log("PASS desktop quota is read-only and session-first with weekly fallback; mobile keeps only the inert context ring");

      // The message box is typed at the transcript's size (Settings → Chat font size): with a mouse
      // exactly, on a phone never under 16px, the smallest size iOS does not zoom the page for
      for (const width of [390, 1440]) for (const chatFontSize of [null, 20]) await withCard(browser, width, { model: "claude-opus-5-5", chatFontSize }, async (page) => {
        const [box, body] = await page.evaluate(() => {
          const probe = document.createElement("span");
          probe.style.fontSize = "var(--chat-fs-body)";
          document.querySelector(".chat-view")!.append(probe);
          const sizes = [document.querySelector(".composer-text")!, probe].map((node) => parseFloat(getComputedStyle(node).fontSize));
          probe.remove();
          return sizes;
        });
        const want = width <= 480 ? Math.max(16, body!) : body!;
        assert.ok(Math.abs(box! - want) < 0.05, `${width}px, chat size ${chatFontSize ?? "default"}: the box is ${box}px, the transcript ${body}px`);
        if (chatFontSize === null) assert.equal(box, width <= 480 ? 16 : 15, "with no size chosen the box keeps its size");
      });
      console.log("PASS the message box follows Chat font size: with a mouse at the transcript's size, on a phone never under 16px");

      // Changing the setting in an already-open chat rewraps the existing draft: an automatic
      // box grows and shrinks with it, while a height chosen with the grip stays chosen.
      for (const width of [390, 1440]) await withCard(browser, width, { model: "claude-opus-5-5" }, async (page) => {
        const box = page.getByRole("textbox", { name: "Message", exact: true });
        const grip = page.getByRole("separator", { name: "Resize message box", exact: true });
        const text = "An unsent draft changes size with the transcript.\nIts second line stays visible.\nThe third line stays visible too.";
        const height = () => box.evaluate((node) => node.clientHeight);
        const chooseSize = async (size: number) => {
          await page.keyboard.press("ControlOrMeta+Shift+Comma");
          await openSettingsPage(page, "Chat");
          const current = Number.parseInt(await page.locator('.settings-stepper[aria-label="Chat font size"] output').innerText(), 10);
          const button = page.getByRole("button", { name: size > current ? "Increase chat font size" : "Decrease chat font size", exact: true });
          for (let step = 0; step < Math.abs(size - current); step++) await button.click();
          await page.getByRole("button", { name: "Close settings", exact: true }).click();
        };
        await box.fill(text);
        const initial = await height();
        await chooseSize(20);
        await page.waitForFunction((before) => {
          const box = document.querySelector<HTMLTextAreaElement>(".composer-text")!;
          return box.clientHeight > before && box.scrollHeight <= box.clientHeight + 1;
        }, initial);
        const large = await height();
        assert.equal(await box.inputValue(), text, "resizing keeps the draft whole");
        await chooseSize(11);
        await page.waitForFunction((before) => document.querySelector(".composer-text")!.clientHeight < before, large);
        assert.equal(await box.inputValue(), text, "shrinking keeps the draft whole");
        assert.equal(await grip.getAttribute("aria-valuetext"), "automatic height");

        await grip.press("ArrowUp");
        const chosen = await height();
        assert.equal(await box.evaluate((node) => node.classList.contains("is-sized")), true);
        await chooseSize(20);
        await page.waitForFunction(() => parseFloat(getComputedStyle(document.querySelector(".composer-text")!).fontSize) > 21);
        assert.equal(await height(), chosen, "a font-size change preserves the chosen height");
        assert.equal(await box.inputValue(), text, "a manual box keeps the draft whole too");
        await grip.press("Home");
        await page.waitForFunction(() => {
          const box = document.querySelector<HTMLTextAreaElement>(".composer-text")!;
          return !box.classList.contains("is-sized") && box.scrollHeight <= box.clientHeight + 1;
        });
        assert.equal(await box.inputValue(), text);
      });
      console.log("PASS changing Chat font size grows and shrinks an existing draft's automatic box and preserves a chosen height");

      // CSS layout zoom exercises fractional geometry and rewrapping; it is not native browser
      // zoom or mobile pinch zoom. Keep one draft mounted while changing each scale.
      for (const width of [390, 1440]) await withCard(browser, width, { model: "gpt-5.6-sol", status: "idle" }, async (page) => {
        const box = page.getByRole("textbox", { name: "Message", exact: true });
        const drafts = ["", "A short message. 짧은 메시지", "long_unbroken_text_".repeat(100), Array.from({ length: 40 }, (_, i) => `Line ${i + 1}: a long draft`).join("\n")];
        for (const text of drafts) {
          await box.fill(text);
          for (const zoom of [0.8, 1, 1.25, 1.5, 2, 1]) {
            await page.evaluate((scale) => { document.documentElement.style.zoom = String(scale); }, zoom);
            await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
            // The width observer commits the automatic height after layout zoom rewraps text.
            await page.waitForFunction((short) => {
              const node = document.querySelector<HTMLTextAreaElement>(".composer-text")!;
              return node.scrollWidth <= node.clientWidth + 1 && (!short || node.scrollHeight <= node.clientHeight + 1);
            }, text === drafts[0] || text === drafts[1], { timeout: 5_000 });
            const metrics = await box.evaluate((node) => {
              const style = getComputedStyle(node);
              const probe = document.body.appendChild(document.createElement("span"));
              probe.style.color = "var(--border-strong)";
              const thumb = getComputedStyle(probe).color;
              probe.remove();
              return { scrollbar: style.scrollbarWidth, color: style.scrollbarColor, thumb, gutter: style.scrollbarGutter, overflowY: style.overflowY, height: node.clientHeight, scrollHeight: node.scrollHeight };
            });
            // a token that does not exist drops the whole declaration: the colour is then "auto"
            assert.equal(metrics.color, `${metrics.thumb} rgba(0, 0, 0, 0)`, "the scroll cue is drawn in the theme's border colour on the card's own fill");
            assert.equal(metrics.scrollbar, "thin", `${width}px at ${zoom}: long drafts keep a narrow scroll cue`);
            assert.equal(metrics.gutter, "stable", "the scroll cue keeps reserved room beside the draft");
            assert.equal(metrics.overflowY, "auto", "long drafts remain scrollable");
            assert.equal(await box.inputValue(), text, "changing zoom preserves the draft");
            if (text === drafts[0] || text === drafts[1]) assert.ok(metrics.scrollHeight <= metrics.height + 1, "empty and short drafts fit without vertical clipping");
          }
        }
        const endKey = process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End";
        await box.press(endKey);
        await page.waitForFunction(() => {
          const node = document.querySelector<HTMLTextAreaElement>(".composer-text")!;
          return node.selectionStart === node.value.length && node.scrollTop > 0;
        }, undefined, { timeout: 5_000 });
        const endScroll = await box.evaluate((node) => node.scrollTop);
        await box.press(process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home");
        // Native caret scrolling trims different amounts of padding/leading across platforms.
        // Check keyboard movement independently from reaching the absolute wheel boundary.
        await page.waitForFunction((end) => {
          const node = document.querySelector<HTMLTextAreaElement>(".composer-text")!;
          return node.selectionStart === 0 && node.scrollTop < end;
        }, endScroll, { timeout: 5_000 });
        await box.hover();
        await page.mouse.wheel(0, -2000);
        await page.waitForFunction(() => document.querySelector(".composer-text")!.scrollTop <= 1, undefined, { timeout: 5_000 });
        await page.mouse.wheel(0, 400);
        await page.waitForFunction(() => document.querySelector(".composer-text")!.scrollTop > 1, undefined, { timeout: 5_000 });
        const wheelScroll = await box.evaluate((node) => node.scrollTop);
        await box.press(endKey);
        await page.waitForFunction((before) => {
          const node = document.querySelector<HTMLTextAreaElement>(".composer-text")!;
          return node.selectionStart === node.value.length && node.scrollTop > before;
        }, wheelScroll, { timeout: 5_000 });
        assert.equal(await box.inputValue(), drafts[3], "wheel and keyboard scrolling preserve the draft");
        if (width === 1440 && process.env.COMPOSER_FIT_SCREENSHOT) await page.locator(".composer").screenshot({ path: process.env.COMPOSER_FIT_SCREENSHOT });
      });
      console.log("PASS stable thin scrollbars, wrapped drafts and wheel/keyboard scrolling at 80–200% CSS layout zoom");
    } finally {
      await browser.close();
    }
  } finally {
    server.stop(true);
  }
} finally {
  rmSync(app, { recursive: true, force: true });
}
