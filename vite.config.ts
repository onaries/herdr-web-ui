import { buildXtermSource } from "./scripts/build-xterm.ts";
import { compressedAssets } from "./scripts/compressed-assets.ts";
import { defineConfig, normalizePath, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const xtermSource = normalizePath(buildXtermSource(fileURLToPath(new URL(".", import.meta.url))));

let revision: string | null = null;
try { revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* non-Git build */ }

// agentSvgMarks.ts carries LobeHub Icons paths (MIT): their notice ships with every built client
const thirdPartyNotices: Plugin = {
  name: "third-party-notices",
  generateBundle() {
    this.emitFile({ type: "asset", fileName: "THIRD_PARTY_NOTICES.md", source: readFileSync("THIRD_PARTY_NOTICES.md", "utf8") });
  },
};

export default defineConfig({
  plugins: [react(), thirdPartyNotices, compressedAssets()],
  define: {
    __APP_REVISION__: JSON.stringify(revision),
    __APP_VERSION__: JSON.stringify((JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version),
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:7317",
      "/ws": { target: "ws://localhost:7317", ws: true },
    },
  },
  build: { outDir: "dist" },
  // The Bun patch targets xterm's readable source, not its minified distribution. Build that
  // source so dev, production and the website use the same reviewed IME backport.
  resolve: { alias: [
    { find: /^@xterm\/xterm$/, replacement: `${xtermSource}/browser/public/Terminal.js` },
    { find: /^browser\//, replacement: `${xtermSource}/browser/` },
    { find: /^common\//, replacement: `${xtermSource}/common/` },
    { find: "@shared", replacement: new URL("./shared", import.meta.url).pathname },
  ] },
});
