/**
 * Serves the built client out of dist/.
 *
 * Cache-Control is decided per file on purpose: Vite fingerprints everything under
 * /assets/, so those are safe to pin for a year, while the service worker, the web
 * manifest and the index.html shell must revalidate on every load - a cached sw.js
 * or shell pins the installed PWA to a build the user can no longer get rid of.
 */

import type { BunFile } from "bun";
import { existsSync } from "node:fs";
import { join, normalize } from "node:path";

// A URL's pathname is not a file path: on Windows it is `/C:/...`, and spaces come percent-encoded.
const DIST_DIR = join(import.meta.dir, "..", "dist");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/** Files whose URL never changes but whose contents decide what the app becomes. */
const REVALIDATED_PATHS = new Set(["/sw.js", "/manifest.webmanifest"]);

const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const SHORT_CACHE = "public, max-age=86400";
const REVALIDATE = "no-cache";

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return "application/octet-stream";
  return MIME[path.slice(dot)] ?? "application/octet-stream";
}

function cacheControlFor(pathname: string): string {
  if (REVALIDATED_PATHS.has(pathname)) return REVALIDATE;
  if (pathname.startsWith("/assets/")) return IMMUTABLE_CACHE;
  return SHORT_CACHE;
}

/**
 * The app's own Content-Security-Policy, sent with the shell and every static file. The file
 * viewer's own answers (`/api/fs/*`, a PDF in a frame, images in an <img>) do not pass through
 * here: `fileResponse` (file-view.ts) sends them its own, stricter `sandbox; default-src 'none'`.
 * Every directive is here for a reason, and none of them is a guess:
 *
 * - `default-src 'self'`: the fallback for anything not named below. Nothing is fetched
 *   from another host: the API, the terminal socket, the machines event stream, the
 *   fonts (bundled woff2, `src/fonts/`), the PC bundle and the push endpoints are all
 *   same-origin, and the remote PCs are reached through this server's own /api/machines
 *   proxy rather than from the browser.
 * - `script-src 'self'`: both entry points are Vite modules (index.html), nothing in the
 *   app evaluates a string, and there is no inline handler attribute. This is the
 *   directive that matters: KaTeX output and the agent marks are the two places that put
 *   third-party HTML into the page.
 * - `style-src 'self' 'unsafe-inline'`: inline style attributes are how measured layout
 *   reaches the DOM (AgentPicker, RowMenu, Droplet, UsageMeters), and KaTeX writes one on
 *   every expression it cannot render. It is also load-bearing for the terminal itself:
 *   xterm.js builds its layers by appending a <style> element to the DOM, and a
 *   DOM-inserted <style> is subject to style-src, so without 'unsafe-inline' the pane
 *   loses its cursor and its layers. The unsafe part is styles, not script.
 * - `img-src 'self' data: blob:`: same-origin icons, pane images and file-viewer images;
 *   `blob:` for a pasted image previewed before it is uploaded; `data:` for the inline
 *   agent marks.
 * - `font-src 'self' data:`: every face is bundled (the app's own and KaTeX's, both
 *   through Vite). No font CDN. The `data:` is Vite's own inlining: an asset under ~4 KB
 *   is emitted as a data: URL inside the CSS rather than as a file, and KaTeX_Size3's
 *   3 KB woff2 is one of them. That data: is app-bundled bytes, never anything an agent
 *   or a transcript can reach. Measured in Chromium: without it the load reports one
 *   `font-src` violation per maths-bearing page, and the browser falls through to the
 *   same-origin .woff of the same face, so the maths still draws.
 * - `connect-src 'self'`: every fetch is a relative /api path, the terminal socket is
 *   window.location.host over ws:/wss: (which 'self' matches — confirmed in Chromium:
 *   an explicit `new WebSocket("ws://<same host>/ws")` and the machines event stream both
 *   connect under the enforcing header).
 * - `media-src 'self'`: the file viewer's <video>/<audio>, same-origin.
 * - `frame-src 'self'`: the PDF viewer frames /api/fs/file, same-origin.
 * - `worker-src 'self'`: the service worker is /sw.js, same-origin.
 * - `object-src 'none'`: no <object>/<embed> in the app, and none may appear.
 * - `base-uri 'self'`: no <base>, and a tag that adds one changes what every relative URL
 *   in the page means.
 * - `form-action 'self'`: every form is submitted by script, but a form that ever grows
 *   an action must not post this PC's credentials somewhere else.
 * - `frame-ancestors 'none'`: nothing frames the app itself.
 */
const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self'",
  "frame-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
];

/**
 * HERDR_WEB_CSP=report-only measures the policy above without enforcing it: the browser
 *   logs what the policy would have blocked and the app keeps working. `report-only` is the
 *   measurement mode; anything else enforces.
 */
function cspHeader(): Record<string, string> {
  const mode = process.env["HERDR_WEB_CSP"];
  const policy = CSP_DIRECTIVES.join("; ");
  return mode === "report-only"
    ? { "content-security-policy-report-only": policy }
    : { "content-security-policy": policy };
}

/**
 * HERDR_WEB_APP_NAME names the installed app. Each PC is its own origin, so two PCs installed
 * on one phone are two apps, and both would be called "herdr" (#476). Unset or blank, every
 * file is served as built. Read on every request, like HERDR_WEB_CSP; the manifest and the
 * shell revalidate on every load, so an installed app learns a new name without a reinstall.
 */
export function appName(): string | null {
  const name = process.env["HERDR_WEB_APP_NAME"]?.trim();
  return name ? name : null;
}

/** The manifest under another name: `short_name` is the home-screen label, `name` the rest. */
export function renameManifest(manifest: string, name: string): string {
  return JSON.stringify({ ...JSON.parse(manifest), name, short_name: name }, null, 2);
}

const APPLE_TITLE = /(<meta name="apple-mobile-web-app-title" content=")[^"]*(")/;

/** The shell under another name: an iOS home-screen install takes its label from this meta. */
export function renameShell(html: string, name: string): string {
  const content = name.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return html.replace(APPLE_TITLE, (_, start: string, end: string) => `${start}${content}${end}`);
}

/** The file as built, or the manifest and the shell under HERDR_WEB_APP_NAME. */
async function body(file: BunFile, kind: "manifest" | "shell" | null): Promise<BunFile | string> {
  const name = appName();
  if (!name || !kind) return file;
  return kind === "manifest" ? renameManifest(await file.text(), name) : renameShell(await file.text(), name);
}

export async function serveStatic(pathname: string): Promise<Response> {
  const indexPath = join(DIST_DIR, "index.html");
  if (!existsSync(indexPath)) {
    return new Response(
      "herdr-web-ui server is running, but the browser client has not been built yet.\nRun: bun run build\n",
      { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
  const relative = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const candidate = join(DIST_DIR, relative);
  if (candidate.startsWith(DIST_DIR) && relative !== "/" && existsSync(candidate)) {
    const file = Bun.file(candidate);
    if ((await file.exists()) && !(await file.stat()).isDirectory()) {
      const kind = pathname === "/manifest.webmanifest" ? "manifest" : candidate === indexPath ? "shell" : null;
      return new Response(await body(file, kind), {
        headers: { "content-type": contentTypeFor(candidate), "cache-control": cacheControlFor(pathname), ...cspHeader() },
      });
    }
  }
  return new Response(await body(Bun.file(indexPath), "shell"), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": REVALIDATE, ...cspHeader() },
  });
}
