/** Rewind handoff on the real client over owned demo fixtures; no CLI or live herdr session. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { appFaces } from "./app-faces.ts";
import panes from "../site/demo/fixtures/panes.json";

interface RewindFixture { agent: string; inputs: string[]; mutations: string[] }
declare global { interface Window { rewindFixture: RewindFixture } }
const app = mkdtempSync(join(tmpdir(), "herdr-rewind-demo-"));
const evidence = process.env.REWIND_QA_EVIDENCE ?? process.env.UI_EVIDENCE_DIR;
try {
  await buildDemoApp(app);
  const patch = `<script>(() => {
    const fix = (value) => {
      if (!value || typeof value !== "object") return value;
      if (Array.isArray(value)) { value.forEach(fix); return value; }
      if (value.pane_id === ${JSON.stringify(panes.hermes)} && "agent_status" in value && "agent" in value) value.agent = window.rewindFixture.agent;
      for (const key of Object.keys(value)) fix(value[key]);
      return value;
    };
    const clone = structuredClone;
    window.structuredClone = (value, options) => fix(clone(value, options));
    const parse = JSON.parse;
    JSON.parse = function(text, reviver) { return fix(parse.call(JSON, text, reviver)); };
    const json = Response.prototype.json;
    Response.prototype.json = async function() { return fix(await json.call(this)); };
  })();</script>`;
  const record = `<script>(() => {
    const Demo = window.WebSocket;
    const Recorded = function(url, protocols) {
      const socket = new Demo(url, protocols);
      const send = socket.send.bind(socket);
      socket.send = (raw) => {
        const frame = JSON.parse(String(raw));
        if (["input", "key", "keys", "submit", "secret-input", "pending-input"].includes(frame.type)) window.rewindFixture.inputs.push(String(raw));
        send(raw);
      };
      return socket;
    };
    Object.assign(Recorded, { CONNECTING: Demo.CONNECTING, OPEN: Demo.OPEN, CLOSING: Demo.CLOSING, CLOSED: Demo.CLOSED });
    window.WebSocket = Recorded;
    const demoFetch = window.fetch;
    window.fetch = (input, init) => {
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (!["GET", "HEAD"].includes(method)) window.rewindFixture.mutations.push(String(input instanceof Request ? input.url : input));
      return demoFetch(input, init);
    };
  })();</script>`;
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => patch + '<script src="./demo-transport.js"></script>' + record + '<script type="module"'));
  const prefix = "/herdr-web-ui/demo/app/";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith(prefix)) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice(prefix.length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
  } });
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
    try {
      for (const agent of ["claude", "grok", "agy"]) for (const width of [1440, 390]) for (const theme of ["dark", "light"]) {
        const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, isMobile: width === 390, hasTouch: width === 390, colorScheme: theme === "dark" ? "dark" : "light", locale: "en-US" });
        try {
          await context.addInitScript(({ agent, theme }) => {
            window.rewindFixture = { agent, inputs: [], mutations: [] };
            localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme, defaultView: "chat", alertsOn: false }));
          }, { agent, theme });
          const page = await context.newPage();
          page.setDefaultTimeout(10000);
          const errors: string[] = [];
          page.on("pageerror", error => errors.push(error.message));
          await page.goto(`http://127.0.0.1:${server.port}${prefix}?pane=${encodeURIComponent(panes.hermes)}&view=chat`);
          const frame = page.locator(`.pane-frame[data-layout-pane="${panes.hermes}"]`);
          await frame.locator(".chat-turn-user").first().waitFor();
          await appFaces(page);
          const box = frame.locator(".composer textarea").first();
          await box.fill("kept draft");
          const turn = frame.locator(".chat-turn-user").first();
          if (width !== 390) await turn.hover();
          const action = turn.getByRole("button", { name: "Rewind in terminal", exact: true });
          await action.waitFor();
          assert.equal(await frame.getByRole("button", { name: "Rewind to here", exact: true }).count(), 0);
          if (evidence) { mkdirSync(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, `${agent}-${width}-${theme}-chat.png`) }); }
          const before = await page.evaluate(() => ({ inputs: [...window.rewindFixture.inputs], mutations: [...window.rewindFixture.mutations] }));
          await action.click();
          await frame.locator(".terminal-banner-rewind").waitFor();
          await frame.getByRole("log").waitFor({ state: "detached" });
          assert.deepEqual(await page.evaluate(() => ({ inputs: window.rewindFixture.inputs, mutations: window.rewindFixture.mutations })), before, "handoff sends no terminal input or HTTP mutation");
          if (evidence) await page.screenshot({ path: join(evidence, `${agent}-${width}-${theme}-terminal.png`) });
          await page.getByTitle("Chat transcript (⌘⇧J)", { exact: true }).click();
          await box.waitFor();
          assert.equal(await box.inputValue(), "kept draft");
          assert.equal(await frame.locator(".terminal-banner-rewind").count(), 0);
          assert.deepEqual(errors, []);
          console.log(`PASS ${agent}-${width}-${theme}: handoff, no input, draft retained, return to Chat`);
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  } finally { server.stop(true); }
} finally { rmSync(app, { recursive: true, force: true }); }
