import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

// A split pane under 80 columns draws in a smaller font to reach them (src/lib/narrowPaneFont.ts),
// on the unmodified app over the demo's fixture transport: no herdr session is opened. The font
// is read from the drawn rows and the columns from the resize frames the pane sends for its pty.
const app = mkdtempSync(join(tmpdir(), "herdr-narrow-pane-demo-"));
const BASE_PX = 13;
const MIN_PX = 10;
const COLS = 80;

interface Drawn { id: string; px: number; cols: number | null }
interface Want { panes: number; font: "base" | "shrunk"; cols: "fits" | "narrow" }

/** Waits until every visible pane draws and reports what `want` says, and returns what they drew. */
async function settled(page: Page, want: Want, label: string): Promise<Drawn[]> {
  const read = (): Promise<Drawn[]> => page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".pane-frame:not(.is-hidden)")].map((frame) => {
    const id = frame.dataset["layoutPane"] ?? "";
    const rows = frame.querySelector(".xterm-rows");
    return { id, px: rows ? parseFloat(getComputedStyle(rows).fontSize) : 0, cols: (window as unknown as { sentCols: Record<string, number> }).sentCols[id] ?? null };
  }));
  const matches = (drawn: Drawn[]): boolean => drawn.length === want.panes && drawn.every((pane) =>
    (want.font === "base" ? pane.px === BASE_PX : pane.px < BASE_PX && pane.px >= MIN_PX)
    && pane.cols !== null && (want.cols === "fits" ? pane.cols >= COLS : pane.cols < COLS));
  const deadline = Date.now() + 10_000;
  let drawn = await read();
  while (!matches(drawn)) {
    assert(Date.now() < deadline, `${label}: wanted ${JSON.stringify(want)}, drew ${JSON.stringify(drawn)}`);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    drawn = await read();
  }
  return drawn;
}

const layout = async (page: Page, path: string, body: Record<string, unknown>): Promise<void> => {
  const status = await page.evaluate(async ([url, payload]) => (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: payload })).status,
    [path, JSON.stringify(body)] as const);
  assert.equal(status, 200, `${path} answered ${status}`);
};

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  // the demo's socket is a class of its own that no browser event reports: note each pane's last grid as it is sent
  const record = `<script>(() => {
    const Demo = window.WebSocket;
    window.sentCols = {};
    const Recorded = function (url, protocols) {
      const socket = new Demo(url, protocols);
      const send = socket.send.bind(socket);
      socket.send = (data) => {
        if (typeof data === "string") { const frame = JSON.parse(data); if (frame.type === "resize" || frame.type === "attach") window.sentCols[frame.pane_id] = frame.cols; }
        send(data);
      };
      return socket;
    };
    for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Object.defineProperty(Recorded, name, { value: Demo[name] });
    window.WebSocket = Recorded;
  })();</script>`;
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    ${record}\n    <script type="module"`));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/herdr-web-ui/demo/app/")) return new Response("not found", { status: 404 });
    let file = decodeURIComponent(path.slice("/herdr-web-ui/demo/app/".length));
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return (await body.exists()) ? new Response(body) : new Response("not found", { status: 404 });
  } });
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      const context = await browser.newContext({ viewport: { width: 1700, height: 900 }, locale: "en-US" });
      await context.addInitScript(() => {
        if (!localStorage.getItem("herdr-web-ui:settings")) localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" }));
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      // A lone chat pane's floating ellipsis and Find must remain separate click targets.
      await page.goto(`http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(panes.infra)}&view=chat`);
      await page.locator(".conn-live").waitFor({ state: "attached" });
      const frame = page.locator(".pane-frame.is-single:visible");
      const find = frame.getByRole("button", { name: "Find in messages", exact: true });
      const paneMenu = frame.locator(".pane-frame-menu");
      await find.waitFor();
      for (const density of ["comfortable", "compact"]) {
        await page.evaluate((density) => document.documentElement.dataset.density = density, density);
        // a mouse reaches the pane menu by right-click: only keyboard focus reveals the ellipsis
        await page.keyboard.press("Tab");
        await paneMenu.focus();
        assert.equal(await paneMenu.evaluate((node) => getComputedStyle(node).opacity), "1", `${density}: the focused pane menu is shown`);
        const searchBox = await find.boundingBox();
        const menuBox = await paneMenu.boundingBox();
        assert.ok(searchBox && menuBox, "both pane controls are visible");
        assert.ok(searchBox.x + searchBox.width <= menuBox.x, `${density}: Find stays left of the pane menu`);
        await find.click();
        await frame.getByRole("search", { name: "Find in messages", exact: true }).waitFor();
        await frame.getByRole("button", { name: "Close search", exact: true }).click();
        await page.keyboard.press("Tab");
        await paneMenu.focus();
        await paneMenu.press("Enter");
        const actions = page.getByRole("menu", { name: /^Pane actions for / });
        await actions.waitFor();
        await page.keyboard.press("Escape");
        await actions.waitFor({ state: "detached" });
      }
      await page.setViewportSize({ width: 390, height: 844 });
      const searchBox = await find.boundingBox();
      const headerBox = await page.locator(".app-header").boundingBox();
      assert.ok(searchBox && headerBox);
      assert.ok(searchBox.y >= headerBox.y + headerBox.height, "phone Find stays below the glass header and its menu");
      await find.click();
      await frame.getByRole("button", { name: "Close search", exact: true }).click();
      await page.setViewportSize({ width: 1700, height: 900 });
      console.log("PASS chat Find stays clear of desktop pane menus and the phone header");
      await page.goto(`http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(panes.shell)}`);
      await page.locator(".conn-live").waitFor({ state: "attached" });
      const saved = (): Promise<number | undefined> => page.evaluate(() => JSON.parse(localStorage.getItem("herdr-web-ui:settings") ?? "{}").terminalFontSize as number | undefined);

      await settled(page, { panes: 1, font: "base", cols: "fits" }, "a pane alone");
      await layout(page, "/api/pane/split", { pane_id: panes.shell, direction: "right", focus: true });
      await settled(page, { panes: 2, font: "base", cols: "fits" }, "a split wide enough");

      await page.setViewportSize({ width: 1450, height: 900 });
      const shrunk = await settled(page, { panes: 2, font: "shrunk", cols: "fits" }, "a split under 80 columns");

      await page.setViewportSize({ width: 1200, height: 900 });
      await settled(page, { panes: 2, font: "base", cols: "narrow" }, "a split no font can bring to 80 columns");
      await page.setViewportSize({ width: 1450, height: 900 });
      await settled(page, { panes: 2, font: "shrunk", cols: "fits" }, "the split reachable again");

      await layout(page, "/api/pane/zoom", { pane_id: panes.shell, mode: "on" });
      await settled(page, { panes: 1, font: "base", cols: "fits" }, "the pane zoomed");
      await layout(page, "/api/pane/zoom", { pane_id: panes.shell, mode: "off" });
      await settled(page, { panes: 2, font: "shrunk", cols: "fits" }, "the pane unzoomed");

      await page.setViewportSize({ width: 1700, height: 900 });
      await settled(page, { panes: 2, font: "base", cols: "fits" }, "the split widened");

      const size = await saved();
      assert(size === undefined || size === BASE_PX, `the smaller font was never the saved one (saved ${size})`);
      assert.deepEqual(errors, []);
      console.log(`narrow pane: ${shrunk.map((pane) => `${pane.px}px for ${pane.cols} columns`).join(", ")} at 1450px; the user's ${BASE_PX}px elsewhere`);
    } finally { await browser.close(); }
  } finally { await server.stop(true); }
} finally {
  rmSync(app, { recursive: true, force: true });
}
