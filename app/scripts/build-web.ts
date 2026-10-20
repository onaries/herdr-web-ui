/**
 * Assembles app/www, what the iOS app carries: its own pages (app/web) and the demo, built from
 * this checkout's client with the demo's fixture transport (scripts/demo-build.ts), so the app
 * can be tried with no PC, as App Review must. Run `bun run build:web` in app/.
 */
import { cpSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildDemoApp } from "../../scripts/demo-build.ts";

const app = join(import.meta.dir, "..");
const www = join(app, "www");
rmSync(www, { recursive: true, force: true });
cpSync(join(app, "web"), www, { recursive: true });
// error.html stands alone: Android serves it without the files beside it while a PC is open
const errorPage = join(www, "error.html");
const link = '<link rel="stylesheet" href="shell.css">';
const errorHtml = readFileSync(errorPage, "utf8");
if (!errorHtml.includes(link)) throw new Error("error.html no longer links shell.css the way build-web.ts inlines it");
writeFileSync(errorPage, errorHtml.replace(link, `<style>${readFileSync(join(www, "shell.css"), "utf8")}</style>`));

const demo = join(www, "demo");
await buildDemoApp(demo);
// the build's .gz and .br sidecars are for a server's Accept-Encoding; the app reads files itself,
// and Android's asset merger takes x.js and x.js.gz for the same asset
for (const file of readdirSync(demo, { recursive: true, encoding: "utf8" })) {
  if (file.endsWith(".gz") || file.endsWith(".br")) rmSync(join(demo, file));
}
const index = join(demo, "index.html");
const html = readFileSync(index, "utf8");
if (!html.includes('<script type="module"')) throw new Error("the demo's index.html has no module script to load the transport before");
writeFileSync(index, html.replace('<script type="module"', '<script src="./demo-transport.js"></script>\n    <script type="module"'));
