import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import type { SetupJob, SetupRequest } from "../shared/machines.ts";

// Render the real dialog against synthetic setup responses. No SSH host or herdr is used.
const repo = join(import.meta.dir, "..");
const root = mkdtempSync(join(tmpdir(), "herdr-machine-dialog-"));
try {
  symlinkSync(join(repo, "node_modules"), join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const entry = join(root, "entry.tsx");
  writeFileSync(entry, `
    import React, { useState } from ${JSON.stringify(join(repo, "node_modules/react/index.js"))};
    import { createRoot } from ${JSON.stringify(join(repo, "node_modules/react-dom/client.js"))};
    import ${JSON.stringify(join(repo, "src/styles.css"))};
    import { SettingsProvider } from ${JSON.stringify(join(repo, "src/lib/settings.ts"))};
    import { MachineDialog } from ${JSON.stringify(join(repo, "src/components/MachineDialog.tsx"))};
    function Fixture() {
      const [connected, setConnected] = useState("");
      return <SettingsProvider>{connected ? <p>Connected: {connected}</p> :
        <MachineDialog onClose={() => setConnected("closed")} onConnected={setConnected} />}</SettingsProvider>;
    }
    createRoot(document.getElementById("root")).render(<Fixture />);
  `);
  const out = join(root, "dist");
  const build = await Bun.build({ entrypoints: [entry], outdir: out, target: "browser", define: { __APP_REVISION__: JSON.stringify("fixture"), __APP_VERSION__: JSON.stringify("fixture") } });
  assert.ok(build.success, build.logs.map(String).join("\n"));
  writeFileSync(join(out, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/entry.css"></head><body><div id="root"></div><script type="module" src="/entry.js"></script></body></html>`);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (!["/", "/entry.js", "/entry.css"].includes(path)) return new Response("not found", { status: 404 });
    return new Response(Bun.file(join(out, path === "/" ? "index.html" : path.slice(1))));
  } });
  try {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
    try {
      for (const width of [1280, 390]) {
        const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: width === 390, hasTouch: width === 390 });
        try {
          await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })));
          const page = await context.newPage();
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          const requests: SetupRequest[] = [];
          let approvals = 0;
          let job: SetupJob;
          await page.route("**/api/machines/setup**", async (route) => {
            const request = route.request();
            const path = new URL(request.url()).pathname;
            if (request.method() === "POST" && path === "/api/machines/setup") {
              requests.push(request.postDataJSON());
              job = { id: "setup", machine_id: "fixture", target: { destination: "fixture-only" },
                phase: requests.length === 1 ? "failed" : "approval", step: requests.length === 1 ? "Connection failed" : "Review the changes on this PC",
                error: requests.length === 1 ? "Bridge version mismatch" : null, action_required: requests.length === 1 ? "update_bridge" : null,
                installations: ["Download and verify the bridge runtime, then restart this bridge"], challenge: null, ssh_output: null, progress: null };
            } else if (request.method() === "POST" && path === "/api/machines/setup/setup") {
              assert.deepEqual(request.postDataJSON(), { action: "approve" });
              approvals++;
              job = { ...job!, phase: "connected", step: "Connected" };
            } else assert.equal(request.method(), "GET");
            await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(job!) });
          });
          await page.goto(`http://127.0.0.1:${server.port}/`);
          const dialog = page.getByRole("dialog", { name: "Add PC", exact: true });
          const destination = dialog.getByRole("textbox", { name: "SSH alias or user@address", exact: true });
          await destination.fill("fixture-only");
          await destination.press("Enter");
          const update = dialog.getByRole("button", { name: "Update bridge and connect", exact: true });
          await update.waitFor();
          assert.deepEqual(requests, [{ destination: "fixture-only" }]);
          assert.equal(await dialog.getByRole("button", { name: "Retry connection", exact: true }).count(), 0);
          const settled = () => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
          await destination.fill("");
          await update.click();
          await settled();
          assert.equal(await destination.evaluate((input: HTMLInputElement) => input.validity.valueMissing), true);
          assert.equal(requests.length, 1, "update click obeys the required destination");
          await destination.fill("fixture-only");
          await dialog.locator("summary").click();
          const port = dialog.getByRole("spinbutton", { name: "SSH port", exact: true });
          await port.fill("70000");
          await update.click();
          await settled();
          assert.equal(await port.evaluate((input: HTMLInputElement) => input.validity.rangeOverflow), true);
          assert.equal(requests.length, 1, "update click obeys the SSH port range");
          await port.fill("2222");
          await destination.press("Enter");
          const approve = dialog.getByRole("button", { name: "Install and connect", exact: true });
          await approve.waitFor();
          assert.deepEqual(requests, [{ destination: "fixture-only" }, { destination: "fixture-only", port: 2222, update_remote: true }]);
          assert.equal(approvals, 0, "Enter requests an update but does not approve it");
          await approve.click();
          await dialog.getByRole("button", { name: "Open PC", exact: true }).click();
          await page.getByText("Connected: fixture", { exact: true }).waitFor();
          assert.equal(approvals, 1);
          assert.deepEqual(errors, []);
          console.log(`PASS ${width}px: version failure → validated update by Enter → separate approval → Open PC`);
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  } finally { server.stop(true); }
} finally { rmSync(root, { recursive: true, force: true }); }
