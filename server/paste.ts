/**
 * Image paste support: the browser POSTs a pasted or file-picked image, the server
 * writes it next to the pane and hands back the absolute path. The agent TUI (Claude
 * Code and friends) reads the path from the prompt text - the one image channel a pty
 * byte stream can carry; there is no clipboard or sixel hop in between.
 *
 * Files land in `<pane cwd>/.herdr-web-ui/`, not /tmp, on purpose: agents ask before
 * reading outside their project directory, and a path inside the project keeps the
 * attachment visible (and git-ignorable) next to the conversation. A pane without a
 * known cwd (or one the OS no longer has) falls back to the OS temp dir - the path still works, it just may cost
 * the agent a read-permission prompt. `HERDR_WEB_PASTE_DIR` sends every attachment to
 * one directory instead, for those who would rather keep them out of the working tree.
 */

import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { paneGet } from "./herdr/client.ts";
import { MAX_ATTACHMENT_BYTES } from "../shared/attachments.ts";

/** Decode ceiling: the limit the browser checks a file against before it uploads. */
export const MAX_IMAGE_BYTES = MAX_ATTACHMENT_BYTES;

/**
 * A file that is not one of the image types keeps its own name (sanitised), so the agent
 * reading the path sees what it is: an icon.svg, a notes.pdf, a data.csv.
 */
function storedName(name: string | undefined): { base: string; extension: string } {
  const clean = (name ?? "").normalize("NFC").replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^[._]+/, "").slice(-80);
  const dot = clean.lastIndexOf(".");
  const extension = dot > 0 ? clean.slice(dot + 1).toLowerCase() : "";
  return {
    base: (dot > 0 ? clean.slice(0, dot) : clean) || "file",
    extension: /^[a-z0-9]{1,10}$/.test(extension) ? extension : "bin",
  };
}

/**
 * A cwd the OS still has. Herdr reports a removed directory as `<path> (deleted)`, and
 * `mkdir -p` on that string creates a tree named after the kernel's marker instead of
 * failing, so a cwd that is not a directory now counts as no cwd at all.
 */
function existingDirectory(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  try {
    return statSync(cwd).isDirectory() ? cwd : null;
  } catch {
    return null;
  }
}

/** Where one pane's attachment goes: `pasteDirectory` of its cwd when that cwd still exists. */
export function pasteDirectoryForPane(cwd: string | null | undefined): string {
  return pasteDirectory(existingDirectory(cwd));
}

/** Where a pane's attachments go: `HERDR_WEB_PASTE_DIR` when set, else `<cwd>/.herdr-web-ui`. */
export function pasteDirectory(cwd: string | null | undefined): string {
  const override = process.env["HERDR_WEB_PASTE_DIR"]?.trim();
  if (override) {
    // the plugin's env file is not a shell: expand a leading ~ here, before either separator.
    // The separators are dropped with it: a leading one would make the rest an absolute path
    const home = /^~(?:[\\/]+(.*))?$/s.exec(override);
    return home ? resolve(homedir(), home[1] ?? "") : resolve(override);
  }
  return join(cwd ?? join(tmpdir(), "herdr-web-ui"), ".herdr-web-ui");
}

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** A validation failure the /api/pane/image route answers with this status + code. */
export class PasteImageError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Validates and stores one pasted image for a pane; resolves to the absolute file
 * path the prompt should reference. Validation failures are PasteImageError (the
 * route maps them to the error envelope); an unknown pane is the herdr-shaped
 * `pane_not_found` HerdrError like every other pane route.
 */
export async function savePaneImage(options: {
  paneId: string;
  contentType: string;
  dataBase64: string;
  /** the file's own name: any type is accepted, and one that is not a pasted image keeps it */
  name?: string;
}): Promise<string> {
  const imageExtension = EXTENSIONS[options.contentType];
  const named = imageExtension === undefined ? storedName(options.name) : null;
  // cheap pre-check: reject the ENCODED length before allocating the decode buffer,
  // so an oversized body never costs a second copy of itself in memory
  if (options.dataBase64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4) {
    throw new PasteImageError("image_too_large", `file exceeds ${MAX_IMAGE_BYTES} bytes`, 413);
  }
  const data = Buffer.from(options.dataBase64, "base64");
  if (data.byteLength === 0) {
    throw new PasteImageError("empty_image", "file is empty", 400);
  }
  if (data.byteLength > MAX_IMAGE_BYTES) {
    throw new PasteImageError("image_too_large", `file exceeds ${MAX_IMAGE_BYTES} bytes`, 413);
  }

  const pane = await paneGet(options.paneId);

  const directory = pasteDirectoryForPane(pane.cwd);
  mkdirSync(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const unique = `${stamp}-${crypto.randomUUID().slice(0, 8)}`;
  const name = named === null ? `paste-${unique}.${imageExtension}` : `${named.base}-${unique}.${named.extension}`;
  const path = join(directory, name);
  writeFileSync(path, data, { mode: 0o600 });
  return path;
}
