import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { homedir } from "node:os";

import { agentGet } from "./herdr/client.ts";

/**
 * Command Code's session store. One directory per project (the cwd), under
 * `~/.commandcode/projects/<slug>`, where `<slug>` is the cwd with its leading
 * slash dropped and every other slash turned into a dash, lowercased.
 */
export function cmdSlug(cwd: string): string {
  return cwd.replace(/^[/\\]+/, "").replace(/[/\\]/g, "-").toLowerCase();
}

export function defaultCmdHome(): string {
  return join(homedir(), ".commandcode");
}

export function defaultCmdProjectDir(cwd: string): string {
  return join(defaultCmdHome(), "projects", cmdSlug(cwd));
}

/** Where the commandcode provider's cached catalog lives: the file pi reads the same models from. */
export function cmdModelCatalogPath(): string {
  return join(homedir(), ".pi", "agent", "commandcode-models.json");
}

/**
 * The canonical file inside the store, or null. Command Code names an absolute
 * path itself, so the store is checked rather than trusted: a path elsewhere, a
 * link out of it or a non-session file is no evidence.
 */
export function cmdTranscriptInStore(path: string, sessionDir: string): string | null {
  let canonical: string;
  let root: string;
  try {
    canonical = realpathSync(path);
    root = realpathSync(sessionDir);
  } catch { return null; }
  const inside = relative(root, canonical);
  if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return null;
  if (!canonical.endsWith(".jsonl")) return null;
  let fd: number | undefined;
  try {
    fd = openSync(canonical, constants.O_RDONLY | constants.O_NONBLOCK);
    return fstatSync(fd).isFile() ? canonical : null;
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

const absent = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === "ENOENT";

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
      try { lstatSync(dir); return null; } catch (missing) { if (!absent(missing)) return null; }
    }
  }
}

type CmdTranscriptOptions = {
  agent?: Awaited<ReturnType<typeof agentGet>> | null;
  home?: string;
};

export async function cmdTranscriptPath(
  paneId: string,
  options: CmdTranscriptOptions = {},
): Promise<{ path: string } | { unwritten: { id: string; path: string } } | null> {
  const agent = options.agent === undefined ? await agentGet(paneId).catch(() => null) : options.agent;
  if (agent?.agent !== "cmd") return null;

  // Only herdr's report names the session, as for pi. The process environment's
  // COMMANDCODE_SESSION_ID is set at start-up or inherited, so after /clear, /resume or in a child it
  // names another session: shown as this pane's, another conversation would be read as this one.
  const session = agent.agent_session;
  const candidate = (session?.agent === "cmd" && session.source === "herdr:cmd" && session.kind === "path"
    && typeof session.value === "string") ? session.value : null;
  if (candidate === null) return null;
  // foreground_cwd can belong to a helper when herdr cannot read the group leader's cwd.
  // Each cwd is only a store candidate; the reported session must validate inside it.
  for (const cwd of new Set([agent.foreground_cwd, agent.cwd])) {
    if (typeof cwd !== "string" || cwd.length === 0) continue;
    const projectDir = defaultCmdProjectDir(cwd);
    const path = cmdTranscriptInStore(candidate, projectDir);
    if (path !== null) return { path };
    const unwritten = unwrittenSession(candidate, projectDir);
    if (unwritten !== null) return { unwritten };
  }
  return null;
}

/**
 * Command Code's context window for a model: read from the commandcode provider's
 * cached catalog. On `main` pi-models only consults models.json, which never
 * names commandcode's models, so cmd resolves its own window here.
 */
let cmdCatalogCache: { path: string; mtimeMs: number; windows: Map<string, number> } | null = null;

const MAX_CATALOG_BYTES = 8 * 1024 * 1024;

/** The catalog's text, read only as a regular file of bounded size: a FIFO there must not block the server. */
function readCatalog(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    return stat.isFile() && stat.size <= MAX_CATALOG_BYTES ? readFileSync(fd, "utf8") : null;
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function cmdContextWindow(model: string, catalogPath = cmdModelCatalogPath()): number | null {
  let mtimeMs: number;
  try { mtimeMs = statSync(catalogPath).mtimeMs; } catch { return null; }
  if (cmdCatalogCache === null || cmdCatalogCache.path !== catalogPath || cmdCatalogCache.mtimeMs !== mtimeMs) {
    const text = readCatalog(catalogPath);
    if (text === null) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(text.replace(/^\uFEFF/, "")); } catch { return null; }
    const windows = new Map<string, number>();
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as { models?: unknown };
      if (Array.isArray(record.models)) {
        for (const value of record.models) {
          if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
          const entry = value as { id?: unknown; contextWindow?: unknown };
          if (typeof entry.id !== "string") continue;
          const window = entry.contextWindow;
          if (typeof window !== "number" || !Number.isFinite(window) || window <= 0) continue;
          windows.set(entry.id, window);
        }
      }
    }
    cmdCatalogCache = { path: catalogPath, mtimeMs, windows };
  }
  return cmdCatalogCache.windows.get(model) ?? null;
}
