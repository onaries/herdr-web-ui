import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";

/**
 * A shared state document as it is on disk (preferences.json, seen.json): absent, JSON for its
 * store to check, or bytes that are not JSON. A read that fails otherwise (permissions, a
 * directory in its place) throws: an unreadable file is not an absent one.
 */
export type StateDocument = { kind: "missing" } | { kind: "json"; value: unknown } | { kind: "malformed" };

export function readStateDocument(path: string): StateDocument {
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw error;
  }
  try { return { kind: "json", value: JSON.parse(text) }; } catch { return { kind: "malformed" }; }
}

/** The name a damaged document is kept under until the next damaged one replaces it. */
export const damagedCopy = (path: string): string => `${path}.bad`;

/**
 * Replaces the document at `path` with `text` through a private temporary file. With
 * `keepDamaged`, the file now at `path` is first moved, bytes untouched, to `<path>.bad` (0600),
 * replacing an older one; when it cannot be kept the write is refused and `path` is left as it
 * was. Synchronous, so nothing else in this process writes the file in between.
 */
export function writeStateDocument(path: string, text: string, keepDamaged: boolean): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  if (keepDamaged) {
    try {
      chmodSync(path, 0o600);
      renameSync(path, damagedCopy(path));
    } catch (error) {
      rmSync(temporary, { force: true });
      const reason = (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : String(error));
      throw new Error(`Cannot keep the damaged ${basename(path)} as ${basename(damagedCopy(path))} (${reason}), so it was not replaced`);
    }
  }
  renameSync(temporary, path);
}
