/** Where app state and managed-update state live. Dependency-free on purpose: the launcher
 * (server/managed.ts) imports it and must stay small and stable across releases. */
import { createHash } from "node:crypto";
import { readdirSync, realpathSync, renameSync, rmdirSync, statSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function defaultStateDir(env: Record<string, string | undefined> = process.env): string {
  const override = env["OVIS_STATE_DIR"];
  if (override) return override;
  const { legacy, next } = stateDirNames(env);
  return currentStateDir(legacy, next);
}

function stateDirNames(env: Record<string, string | undefined>): { legacy: string; next: string } {
  const config = env["XDG_CONFIG_HOME"] || join(homedir(), ".config");
  return { legacy: join(config, "herdr-web-ui"), next: join(config, "ovis") };
}

const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

/** The dir under its name from before the rename, when it still holds state of its own. */
function holdsOwnState(legacy: string, next: string): boolean {
  try {
    if (!isDir(legacy) || readdirSync(legacy).length === 0) return false;
    return !isDir(next) || realpathSync(legacy) !== realpathSync(next);
  } catch (error) {
    // ENOENT: another process of this install is moving it right now. An old dir this process
    // cannot read is not one it can use; the new one then reports what it cannot write.
    if (["ENOENT", "EACCES", "EPERM", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

/** Where the state is now; moves nothing. The old dir wins while it holds state of its own. */
export function currentStateDir(legacy: string, next: string): string {
  return holdsOwnState(legacy, next) ? legacy : next;
}

let moved = false;

/**
 * Moves the state dir from before the rename to its new name, once per process. Only the
 * processes that own the state call it (launcher, supervisor, server), before they read it;
 * anything else, a test included, only resolves where the state is (defaultStateDir).
 */
export function moveLegacyStateDir(env: Record<string, string | undefined> = process.env): void {
  if (moved || env["OVIS_STATE_DIR"]) return;
  moved = true;
  const { legacy, next } = stateDirNames(env);
  adoptLegacyDir(legacy, next);
}

/**
 * Moves `legacy` to `next` and leaves a link at the old name for a launcher, plugin or older
 * release that still uses it. A link at `legacy` moves as a link, so state kept elsewhere stays
 * there. Where the move fails, or `next` already holds other files, the old dir stays in use.
 */
export function adoptLegacyDir(legacy: string, next: string): void {
  if (!holdsOwnState(legacy, next)) return;
  try {
    // an empty dir at the new name gives way; one with files of its own stays
    if (isDir(next)) rmdirSync(next);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ENOENT: another process of this install removed it first, and the move goes on
    if (code !== "ENOENT") {
      if (holdsOwnState(legacy, next)) console.error(code === "ENOTEMPTY" || code === "EEXIST"
        ? `both ${legacy} and ${next} hold files, so the state in ${legacy} stays in use; move what you keep into one of them`
        : `cannot move ${legacy} to ${next}, so the old state dir stays in use: ${(error as Error).message}`);
      return;
    }
  }
  try {
    renameSync(legacy, next);
  } catch (error) {
    // another process of this install moved it first
    if (!holdsOwnState(legacy, next)) return;
    console.error(`cannot move ${legacy} to ${next}, so the old state dir stays in use: ${(error as Error).message}`);
    return;
  }
  try {
    // "junction" needs no privilege on Windows; other platforms ignore the type
    symlinkSync(next, legacy, "junction");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    console.error(`moved ${legacy} to ${next} but cannot link the old name to it: ${(error as Error).message}`);
  }
}

/** One update state per source checkout and port, so two checkouts or ports never share builds. */
export function updateStateDir(root: string, port: number, stateDir = defaultStateDir()): string {
  return join(resolve(stateDir), "updates",
    createHash("sha256").update(`${resolve(root)}:${port}`).digest("hex").slice(0, 16));
}

/** A supervisor exits with this after an install: "start the supervisor of the release now active"
 * (EX_TEMPFAIL, never a crash code). */
export const HANDOVER_EXIT = 75;
