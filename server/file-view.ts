import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";

import type { FileInfo, FileKind } from "../shared/protocol.ts";
import { filesNamed } from "./files.ts";

/**
 * Opening a file from the browser: the files agents write (a screenshot, a demo video, a
 * PDF, a log) seen on a phone that has no terminal to open them with.
 *
 * Nothing is read into memory to serve a file: the response is `Bun.file`, which Bun
 * streams from disk (sendfile where it can) and answers Range requests for, so a video
 * plays and seeks without the server holding more than its socket buffers. Only the
 * first bytes of a file are read, to tell text from binary.
 *
 * It opens what this server's user can read, which is no more than the terminal the same
 * browser can already type into.
 */

/** A path as agents and people write it: absolute, `~/…`, or relative to the pane's folder. */
export function resolveFilePath(input: string, cwd: string | null): string | null {
  const path = input.trim();
  if (path === "") return null;
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  if (isAbsolute(path)) return resolve(path);
  return cwd === null ? null : resolve(cwd, path);
}

const TEXT_TYPES = /^(?:text\/|application\/(?:json|javascript|typescript|xml|x-sh|toml|yaml|x-yaml|sql)|image\/svg\+xml)/;
const SNIFF_BYTES = 8192;

function kindOf(mime: string, path: string): FileKind {
  if (mime === "image/svg+xml") return "image";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  if (TEXT_TYPES.test(mime)) return "text";
  // no known type (a .log, a dotfile, source without a registered extension): text when
  // its first bytes hold no NUL
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const read = readSync(fd, buffer, 0, SNIFF_BYTES, 0);
    return buffer.subarray(0, read).includes(0) ? "binary" : "text";
  } catch {
    return "binary";
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

const MAX_NAME_MATCHES = 10;

/** The same visible name may be stored composed or decomposed, one folder at a time. */
function pathsByName(path: string): string[] {
  if (!/[^\x00-\x7f]/.test(path)) return [];
  const root = parse(path).root;
  let paths = [root];
  for (const part of path.slice(root.length).split(sep).filter(Boolean)) {
    const next: string[] = [];
    for (const dir of paths) {
      const exact = join(dir, part);
      if (existsSync(exact)) {
        next.push(exact);
        continue;
      }
      if (!/[^\x00-\x7f]/.test(part)) continue;
      try {
        for (const name of readdirSync(dir)) {
          if (name.normalize("NFC") === part.normalize("NFC")) next.push(join(dir, name));
        }
      } catch { /* an unreadable folder has no matches */ }
    }
    paths = next.sort().slice(0, MAX_NAME_MATCHES);
    if (paths.length === 0) return [];
  }
  return paths;
}

/**
 * The file a path means: as written, or — for a relative path that is not there — the one
 * file under the pane's folder whose path ends in it (agents often name `demo.mp4` without
 * `docs/screenshots/`). Several such files come back as candidates to choose from.
 */
export function locateFile(input: string, cwd: string | null, anyForm = false): { info: FileInfo } | { candidates: string[] } | null {
  const path = resolveFilePath(input, cwd);
  const info = anyForm || path === null ? null : fileInfo(path);
  if (info !== null) return { info };
  if (anyForm && path !== null) {
    const matches = pathsByName(path).map(fileInfo).filter((match) => match !== null);
    if (matches.length === 1) return { info: matches[0]! };
    if (matches.length > 1) return { candidates: matches.map((match) => match.path) };
  }
  const relative = input.trim();
  if (cwd === null || relative === "" || isAbsolute(relative) || relative.startsWith("~") || relative.startsWith("../")) return null;
  if (anyForm && !/[^\x00-\x7f]/.test(relative)) return null;
  const found = filesNamed(cwd, relative, 10, anyForm).map((match) => resolve(cwd, match));
  if (found.length === 1) {
    const only = fileInfo(found[0]!);
    return only === null ? null : { info: only };
  }
  return found.length > 1 ? { candidates: found } : null;
}

/** A relative fallback stays in its own folder, including after following symlinks. */
export function locateFileInFolder(input: string, folder: string, anyForm = false): ReturnType<typeof locateFile> {
  const relative = input.trim();
  if (isAbsolute(relative) || relative.startsWith("~") || !resolve(folder, relative).startsWith(resolve(folder) + sep)) return null;
  const found = locateFile(relative, folder, anyForm);
  if (found === null) return null;
  try {
    const root = realpathSync(folder) + sep;
    const paths = "info" in found ? [found.info.path] : found.candidates;
    return paths.every((path) => realpathSync(path).startsWith(root)) ? found : null;
  } catch { return null; /* a missing or unreadable target is not a fallback */ }
}

/** Try every exact place before opening a name stored in another form. */
export async function findFile(input: string, cwd: string | null, scratchFolder: () => Promise<string | null>): Promise<ReturnType<typeof locateFile>> {
  const exact = locateFile(input, cwd);
  if (exact !== null) return exact;
  let folder: string | null = null;
  if (cwd !== null && !isAbsolute(input.trim()) && !input.trim().startsWith("~")) {
    folder = await scratchFolder();
    if (folder !== null) {
      const scratch = locateFileInFolder(input, folder);
      if (scratch !== null) return scratch;
    }
  }
  const found = locateFile(input, cwd, true);
  if (found !== null) return found;
  return folder === null ? null : locateFileInFolder(input, folder, true);
}

/** What the viewer needs to know about a file, or null when it is not a readable file. */
export function fileInfo(path: string): FileInfo | null {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const mime = Bun.file(path).type.split(";")[0] || "application/octet-stream";
  return { path, name: basename(path), size: stat.size, modified: stat.mtime.toISOString(), mime, kind: kindOf(mime, path) };
}

/**
 * An HTML page drawn as a page (the report or chart an agent wrote): its own script runs, but in
 * a sandbox without `allow-same-origin`, so it has no origin, no cookie and no storage of this
 * app's, and with no `connect-src` it cannot fetch, open a socket or beacon anything, here or
 * anywhere. It may load pictures, styles, fonts and scripts from https (a page made with a chart
 * library from a CDN draws as it does in any browser), but nothing from this server: an image
 * that loads or fails would tell it which of this PC's files exist. Only this app may frame it.
 * What it takes from its own folder (a screenshot beside the report, its stylesheet and script)
 * is put into the page before it is sent (`pageWithLocalFiles`), so it still asks for nothing.
 * The one exception is a video or sound too large to put into it, which plays from
 * `mediaSource` (`PAGE_MEDIA_PATH`): that path answers only the addresses this render gave out,
 * and only to the client that rendered it.
 */
const pagePolicy = (mediaSource: string | null): string => [
  "sandbox allow-scripts",
  "default-src 'none'",
  // nothing from the web either: the page holds its own folder's files (below), and a script that
  // could reach any https URL could send them there
  "script-src 'unsafe-inline' 'unsafe-eval' data:",
  "style-src 'unsafe-inline' data:",
  "img-src data: blob:",
  mediaSource === null ? "media-src data: blob:" : `media-src data: blob: ${mediaSource}`,
  "font-src data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join("; ");

/** A page's own files are put into it up to these sizes; a larger one is left as the page names it. */
const EMBED_FILE_BYTES = 8 * 1024 * 1024;
const EMBED_TOTAL_BYTES = 32 * 1024 * 1024;
/** A page larger than this is sent as it is, without its files put into it. */
const EMBED_PAGE_BYTES = 8 * 1024 * 1024;
/** Distinct URLs a page may name; past this many the rest are left as they are (each is a filesystem lookup). */
const EMBED_REFS = 1_000;

/**
 * Where a rendered page plays a video or sound too large to put into it: a random address per
 * file and render, handed out only by `pageWithLocalFiles` for a file that page names. The page
 * never holds the file (its script cannot read media served to another origin), but its script
 * can read the address from its own `<video src>` and pass it on. So an address plays only for
 * the client address (`authClient`) that rendered the page, only for `PAGE_MEDIA_LIFETIME_MS`
 * from the render, and no longer once that device is revoked or signs out (`forgetPageMedia`).
 * The page's request carries no cookie (it has no origin, and the cookies are SameSite=Strict),
 * so the client address is the one identity the render and the playing share: another device
 * behind the same address (one NAT, one proxy that hides its visitors) shares it too, and a phone
 * whose address changes must reload the page. The shared token is read once at startup, and
 * these addresses live in memory only: the restart that changes the token drops them all.
 */
export const PAGE_MEDIA_PATH = "/api/fs/page-media/";
/** A page media address and nothing else: the one shape `requiresAuth` lets through without a cookie. */
export const PAGE_MEDIA_ROUTE = /^\/api\/fs\/page-media\/[A-Za-z0-9_-]{32}$/;
/**
 * How long an address plays after its render, never extended. A player asks by Range for as long
 * as it plays and seeks, not only to start, so this covers a sitting with the page; past it a
 * reload gives a new address. It is also how long an address a page passed on keeps working.
 */
export const PAGE_MEDIA_LIFETIME_MS = 30 * 60 * 1000;
/** Addresses held at once; past this many the oldest goes. */
const PAGE_MEDIA_ADDRESSES = 4_096;
/** Files one render may play from here; past this many a page's media is left as it is, so one page cannot push out every other page's addresses. */
export const PAGE_MEDIA_PER_RENDER = 50;
/** Who rendered a page: the client address its media must come from, and the paired device (if any) whose revocation ends it. */
export interface PageMediaOwner { client: string | null; device: string | null }
/** What a page may play from here: the policy's media source and who rendered it. */
export interface PageMedia extends PageMediaOwner { source: string }
/** What an address serves: the file as its render found it, symlinks resolved, which file that was and in what state, and for whom. */
interface PageMediaEntry extends PageMediaOwner { file: string; mime: string; expires: number; dev: number; ino: number; size: number; mtimeMs: number }
/** In mint order, which with a fixed lifetime is also expiry order. */
const pageMediaFiles = new Map<string, PageMediaEntry>();

/** A new address (its token) for `file` (a resolved path), for this render only; null when the file is gone. */
function pageMediaUrl(file: string, mime: string, owner: PageMediaOwner, now = Date.now()): string | null {
  let stat;
  try { stat = statSync(file); } catch { return null; }
  if (!stat.isFile()) return null;
  for (const [old, entry] of pageMediaFiles) {
    if (entry.expires > now && pageMediaFiles.size < PAGE_MEDIA_ADDRESSES) break;
    pageMediaFiles.delete(old);
  }
  const token = randomBytes(24).toString("base64url");
  pageMediaFiles.set(token, { file, mime, expires: now + PAGE_MEDIA_LIFETIME_MS, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, client: owner.client, device: owner.device });
  return token;
}

/** Drop the addresses a device was given (it was revoked or signed out), or those a client address was given. */
export function forgetPageMedia(owner: { device: string } | { client: string | null }): void {
  for (const [token, entry] of pageMediaFiles) {
    if ("device" in owner ? entry.device === owner.device : entry.client === owner.client) pageMediaFiles.delete(token);
  }
}

/**
 * The media source a page's policy allows, for the address the browser asked this server by;
 * null for a Host that is not a plain host[:port]. Behind a proxy (`cameThroughProxy`) that is
 * the X-Forwarded-Host it passes on, as the scheme is its X-Forwarded-Proto: a proxy that rewrites
 * Host would otherwise write a source the page's relative `<video src>` never matches.
 */
export function pageMediaSource(host: string | null, secure: boolean, forwardedHost: string | null = null): string | null {
  const asked = forwardedHost?.split(",")[0]?.trim() || host;
  if (asked === null || !/^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i.test(asked)) return null;
  return `${secure ? "https" : "http"}://${asked}${PAGE_MEDIA_PATH}`;
}

/**
 * The file behind a page's media address (with Range, as any file), or null when this server
 * never gave it out, it lapsed, another client asks for it, or the file is not the one its
 * render checked.
 */
export function pageMediaResponse(token: string, client: string | null, now = Date.now()): Response | null {
  const entry = pageMediaFiles.get(token);
  if (entry === undefined) return null;
  if (entry.expires <= now) {
    pageMediaFiles.delete(token);
    return null;
  }
  // an address the page passed on plays nowhere else, answered like an address that never existed
  if (entry.client !== client) return null;
  // still the file its render checked: a folder on the way swapped for a symlink since, the file
  // replaced or written over in place would serve another one under the address (a new render gives a new address)
  try {
    if (realpathSync(entry.file) !== entry.file) return null;
    const stat = statSync(entry.file);
    if (!stat.isFile() || stat.dev !== entry.dev || stat.ino !== entry.ino || stat.size !== entry.size || stat.mtimeMs !== entry.mtimeMs) return null;
  } catch { return null; }
  // no CORS and no Cross-Origin-Resource-Policy: the page that plays it has no origin, and its script cannot read it
  return new Response(Bun.file(entry.file, { type: entry.mime }), { headers: {
    "content-disposition": "inline",
    "x-content-type-options": "nosniff",
    "cache-control": "private, no-store",
    "content-security-policy": "sandbox; default-src 'none'",
  } });
}

/** A page's relative URL as a path, decoded; null for a URL with a scheme, a host or a rooted path. */
function pageRelative(ref: string): string | null {
  const value = ref.trim();
  if (!value || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("/") || value.startsWith("\\") || value.startsWith("#")) return null;
  let relative: string;
  try { relative = decodeURIComponent(value.split(/[?#]/)[0]!); } catch { return null; }
  // decoded, it may name a root, a drive or a share (`%5C%5Chost%5Cshare`): on Windows, resolving
  // that would reach out to the share before any check, so it never gets that far
  if (!relative || isAbsolute(relative) || /^[\\/]/.test(relative) || /^[a-z]:/i.test(relative)) return null;
  return relative;
}

/**
 * Where a relative URL of a page leads, in the page's folder or below before symlinks are
 * resolved; null for a URL with a scheme, a host or a rooted path, or anything outside.
 */
function pageTarget(ref: string, folder: string): string | null {
  const relative = pageRelative(ref);
  if (relative === null) return null;
  const target = resolve(folder, relative);
  return target.startsWith(folder + sep) ? target : null;
}

const hiddenBelow = (folder: string, path: string): boolean => path.slice(folder.length + 1).split(sep).some((part) => part.startsWith("."));

/**
 * The file a page names by a relative URL, when it is a file in the page's folder or below,
 * symlinks resolved, with no hidden name on the way (`.ssh/`, `.env`); null for a URL with a
 * scheme, a host or a rooted path, or anything outside.
 */
function pageFile(ref: string, folder: string): string | null {
  const target = pageTarget(ref, folder);
  if (target === null) return null;
  try {
    const file = realpathSync(target);
    if (!file.startsWith(folder + sep) || hiddenBelow(folder, file)) return null;
    return statSync(file).isFile() ? file : null;
  } catch { return null; }
}

/**
 * The folders besides a page's own that a video it plays may lie in (a network share where
 * recordings are kept), from HERDR_WEB_MEDIA_ROOTS: absolute paths joined by the path delimiter.
 * None by default: a page that came with its own symlinks (an unpacked archive, a cloned
 * repository) could otherwise name any of this PC's videos, and whether one plays would tell it
 * that the file exists; in a folder named here, any page may learn that. Read on every render, so
 * a share mounted later counts.
 */
function mediaRoots(): string[] {
  const roots: string[] = [];
  for (const entry of (process.env["HERDR_WEB_MEDIA_ROOTS"] ?? "").split(delimiter)) {
    const path = entry.trim();
    if (!path || !isAbsolute(path)) continue;
    try { roots.push(realpathSync(path)); } catch { /* a share that is not mounted holds nothing to play */ }
  }
  return roots;
}

/**
 * A video or sound a page names by a relative URL with no hidden name in it, that is a file in
 * its folder or in one of `roots`, again with no hidden name below that: what decides is where the
 * file lies, whether a symlink beside the page leads there or the URL climbs out of its folder
 * (`../clips/take.mp4`). Without `roots` the URL stays in its folder. Null for anything else.
 */
function pageStreamFile(ref: string, folder: string, roots: readonly string[]): string | null {
  const relative = pageRelative(ref);
  if (relative === null || relative.split(/[\\/]/).some((part) => part.startsWith(".") && part !== "." && part !== "..")) return null;
  const target = resolve(folder, relative);
  if (!target.startsWith(folder + sep) && roots.length === 0) return null;
  try {
    const file = realpathSync(target);
    const root = [folder, ...roots].find((candidate) => file.startsWith(candidate.endsWith(sep) ? candidate : candidate + sep));
    if (root === undefined || hiddenBelow(root.endsWith(sep) ? root.slice(0, -1) : root, file)) return null;
    return statSync(file).isFile() && PLAYS(mimeOf(file)) ? file : null;
  } catch { return null; }
}

/** The page's script can read what is put into it, so each element takes only its own kind of
 * file: never a key or a .env named as a picture's source. */
const mimeOf = (file: string): string => Bun.file(file).type.split(";")[0] || "application/octet-stream";
const MEDIA = (mime: string) => /^(?:image|video|audio)\//.test(mime);
const PLAYS = (mime: string) => /^(?:video|audio)\//.test(mime);
const SCRIPT = (mime: string) => mime === "text/javascript" || mime === "application/javascript";
const STYLE = (mime: string) => mime === "text/css";
/** a script element that runs (no type, a JavaScript type, or a module); a data block (`type="text/plain"`) takes no file */
const RUNS = (type: string | null) => type === null || /^\s*(?:module|(?:text|application)\/(?:x-)?(?:java|ecma)script)?\s*$/i.test(type);

/**
 * The page with the pictures, media, stylesheets and scripts it takes from its own folder put
 * into it as data: URLs, so the element keeps its attributes (`defer`, `type="module"`, a
 * stylesheet's `media`): the sandbox may ask this server for nothing, and on a paired phone it
 * could not anyway (the device cookie is SameSite=Strict, and a sandboxed page has no origin).
 * Nothing outside the page's folder is read; a URL is resolved once however often it is named.
 * With `media`, a video or sound that does not fit is given an address to play from instead
 * (`PAGE_MEDIA_PATH`, up to `PAGE_MEDIA_PER_RENDER` files), the one thing this server answers the page.
 */
export function pageWithLocalFiles(path: string, media: PageMedia | null = null): string {
  const folder = realpathSync(dirname(path));
  let left = EMBED_TOTAL_BYTES;
  const resolved = new Map<string, string | null>();
  const streamed = new Map<string, string | null>();
  const roots = media !== null ? mediaRoots() : [];
  // one address per file in this render, however the page names it
  const addresses = new Map<string, string | null>();
  let granted = 0;
  const lookups = () => resolved.size + streamed.size;
  const take = (ref: string | null, accepts: (mime: string) => boolean): string | null => {
    if (ref === null) return null;
    if (!resolved.has(ref)) resolved.set(ref, lookups() < EMBED_REFS ? pageFile(ref, folder) : null);
    const file = resolved.get(ref) ?? null;
    if (file === null || !accepts(mimeOf(file))) return null;
    const size = statSync(file).size;
    if (size > EMBED_FILE_BYTES || size > left) return null;
    left -= size;
    return file;
  };
  const play = (ref: string): string | null => {
    if (!streamed.has(ref)) streamed.set(ref, lookups() < EMBED_REFS ? pageStreamFile(ref, folder, roots) : null);
    return streamed.get(ref) ?? null;
  };
  const embed = (attribute: string, accepts: (mime: string) => boolean, when: (element: HTMLRewriterTypes.Element) => boolean = () => true, streams = false) => ({
    element(element: HTMLRewriterTypes.Element) {
      if (!when(element)) return;
      const ref = element.getAttribute(attribute);
      const file = take(ref, accepts);
      if (file !== null) element.setAttribute(attribute, `data:${mimeOf(file)};base64,${readFileSync(file).toString("base64")}`);
      else if (media !== null && streams && ref !== null) {
        const far = play(ref);
        if (far === null) return;
        if (!addresses.has(far)) {
          // vanished since it was looked up: the src stays as the page wrote it
          const token = granted < PAGE_MEDIA_PER_RENDER ? pageMediaUrl(far, mimeOf(far), media) : null;
          if (token !== null) granted += 1;
          // absolute, from the same host as the policy's media source, so the two never disagree
          addresses.set(far, token === null ? null : media.source + token);
        }
        const address = addresses.get(far) ?? null;
        if (address !== null) element.setAttribute(attribute, address);
      }
    },
  });
  return new HTMLRewriter()
    .on("img[src]", embed("src", MEDIA))
    .on("source[src]", embed("src", MEDIA, undefined, true))
    .on("video[src]", embed("src", MEDIA, undefined, true))
    .on("video[poster]", embed("poster", MEDIA))
    .on("audio[src]", embed("src", MEDIA, undefined, true))
    .on("script[src]", embed("src", SCRIPT, (element) => RUNS(element.getAttribute("type"))))
    .on('link[rel~="stylesheet" i][href]', embed("href", STYLE))
    .transform(readFileSync(path, "utf8"));
}

/**
 * A file read asked for by another site's page as a picture, script or fetch, not a navigation:
 * a rendered page (which has no origin) naming this server's files to learn which exist, or any
 * other site doing the same where the server lets a request in without a cookie. A navigation (a
 * new tab, a download, Android's PDF "Open" button) and a browser that sends no Fetch Metadata
 * still pass.
 */
export function crossSiteFileRead(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site === null || site === "same-origin" || site === "none") return false;
  return request.headers.get("sec-fetch-mode") !== "navigate";
}

/** Whether `fileResponse` can draw this file as a page, given `render`. */
export function isHtmlPage(info: FileInfo): boolean {
  return info.kind === "text" && info.mime === "text/html";
}

/**
 * The file itself. `download` asks the browser to save it. Answers are sandboxed (an HTML
 * or SVG file opened from this origin must not run script with the app's access), and
 * text is served as plain text whatever its extension says it runs as. `render` asks for an
 * HTML page as a page (`pagePolicy`); any other file ignores it. `media`
 * (`pageMediaSource` and who asked) lets that page play its videos too large to put into it.
 */
export function fileResponse(info: FileInfo, download: boolean, render = false, media: PageMedia | null = null): Response {
  const name = encodeURIComponent(info.name);
  const headers = new Headers({
    "content-disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${name}`,
    "x-content-type-options": "nosniff",
    "cache-control": "private, no-store",
  });
  const page = render && !download && isHtmlPage(info);
  // a PDF is drawn by the browser's own viewer, which refuses a sandboxed document; its
  // scripts stay inside that viewer, never on this origin
  if (page) headers.set("content-security-policy", pagePolicy(media?.source ?? null));
  else if (info.kind !== "pdf") headers.set("content-security-policy", "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'");
  // text shows as text, whatever its extension says it runs as
  const type = page ? "text/html; charset=utf-8" : info.kind === "text" && info.mime !== "image/svg+xml" ? "text/plain; charset=utf-8" : info.mime;
  if (page && info.size <= EMBED_PAGE_BYTES) {
    headers.set("content-type", type);
    return new Response(pageWithLocalFiles(info.path, media), { headers });
  }
  const file = Bun.file(info.path, { type });
  return new Response(file, { headers });
}
