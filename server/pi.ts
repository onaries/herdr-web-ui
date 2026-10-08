import { constants, closeSync, fstatSync, lstatSync, openSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

import { herdrRpc } from "./herdr/client.ts";
import { piAgentDir } from "./pi-models.ts";

/**
 * pi's session store. `PI_CODING_AGENT_SESSION_DIR` moves it, exactly as CODEX_HOME
 * moves Codex's, and `PI_CODING_AGENT_DIR` moves the agent directory it sits in (seen on
 * pi 0.87.1: the store is `<agent dir>/sessions`); pi's `--session-dir` flag and its
 * `sessionDir` setting move it too, but this process cannot see either, so a pane started
 * that way keeps the terminal.
 */
export const defaultPiSessionDir = (): string =>
  process.env["PI_CODING_AGENT_SESSION_DIR"] || join(piAgentDir(), "sessions");

/**
 * The canonical file inside the store, or null. pi names an absolute path itself, so
 * the store is checked rather than trusted: a path elsewhere, a link out of it or a
 * non-session file is no evidence, and an unreadable store holds nothing readable.
 */
export function piTranscriptInStore(path: string, sessionDir: string): string | null {
  let canonical: string;
  let root: string;
  try {
    canonical = realpathSync(path);
    root = realpathSync(sessionDir);
  } catch { return null; }
  const inside = relative(root, canonical);
  if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return null;
  if (!canonical.endsWith(".jsonl")) return null;
  // A directory wearing the extension answers no transcript read later: refuse it here.
  let fd: number | undefined;
  try {
    fd = openSync(canonical, constants.O_RDONLY | constants.O_NONBLOCK);
    return fstatSync(fd).isFile() ? canonical : null;
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

const absent = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === "ENOENT";

/**
 * The session an agent named but has not written, or null. pi and omp write their file only
 * once the first answer is in (pi's SessionManager waits for an assistant message), so until
 * then the reported path does not exist. Only an absent `.jsonl` file whose nearest existing
 * ancestor is a directory inside the store, both resolved, counts: nothing is read from it,
 * its display id and canonical prospective path keep equally named sessions distinct.
 */
export function unwrittenSession(path: string, sessionDir: string): { id: string; path: string } | null {
  if (!isAbsolute(path) || !path.endsWith(".jsonl")) return null;
  let root: string;
  try { root = realpathSync(sessionDir); } catch { return null; }
  try {
    lstatSync(path);
    return null;
  } catch (error) { if (!absent(error)) return null; }
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    try {
      const real = realpathSync(dir);
      if (!statSync(real).isDirectory()) return null;
      const inside = relative(root, real);
      if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return null;
      return { id: basename(path, ".jsonl"), path: join(real, relative(dir, path)) };
    } catch (error) {
      if (!absent(error) || dirname(dir) === dir) return null;
      // a link to nowhere is a place the agent cannot write to, not a directory still to come
      try { lstatSync(dir); return null; } catch (missing) { if (!absent(missing)) return null; }
    }
  }
}

/**
 * pi's transcript for a pane, or the session it has not written yet. herdr's integration
 * re-reports the session file on every `session_start`, so `/new`, `/resume`, `/fork` and
 * `/clone` need no inference here: the next read names the file that replaced the old one.
 */
export async function piTranscriptPath(paneId: string, sessionDir = defaultPiSessionDir()): Promise<{ path: string } | { unwritten: { id: string; path: string } } | null> {
  const info = await herdrRpc<{ agent: { agent_session?: { agent?: unknown; kind?: unknown; value?: unknown } } }>(
    "agent.get",
    { target: paneId },
  ).catch(() => null);
  const session = info?.agent?.agent_session;
  // pi reports an absolute path; the id-only form belongs to agents with no store of ours.
  if (session?.kind !== "path" || typeof session.value !== "string") return null;
  const storeCandidates = Array.from(new Set([sessionDir, join(homedir(), ".omo", "agent", "sessions"), join(homedir(), ".omp", "agent", "sessions")]));
  for (const store of storeCandidates) {
    const path = piTranscriptInStore(session.value, store);
    if (path !== null) return { path };
    const unwritten = unwrittenSession(session.value, store);
    if (unwritten !== null) return { unwritten };
  }
  return null;
}
