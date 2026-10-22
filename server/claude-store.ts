/**
 * Where Claude Code keeps a session's transcript: `<config dir>/projects/<project>/<session>.jsonl`,
 * the config dir being the process's `CLAUDE_CONFIG_DIR`, else `~/.claude`.
 *
 * <project> is Claude's own encoding of the directory it started in (read from Claude Code
 * 2.1.284): every character that is not an ASCII letter or digit becomes `-`, and a name longer
 * than 200 characters keeps its first 200 plus `-` and a base-36 hash of the whole path. So
 * `my_project`, `example.com`, `.dotfiles`, `My Project` and a Korean folder all differ from a
 * plain `/` → `-` swap.
 *
 * The directory is only the fast path. The pane's cwd need not be the one Claude started in, and
 * Claude may change its encoding again, so a miss looks the session id up in every project: the
 * id is a UUID herdr reports, so at most one file answers to it.
 */

import { constants } from "node:fs";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath, { basename, dirname, isAbsolute, join, type PlatformPath } from "node:path";
import { directoryKey, withoutVerbatimPrefix } from "./codex.ts";
import { recentProcessTable } from "./gjc-runtime.ts";
import type { ProcessRow } from "./windows-processes.ts";

const MAX_PROJECT_NAME = 200;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Claude's executable; a Windows one (backslashes or `.exe`) is matched without case, as Windows names files. */
function isClaudeExecutable(text = ""): boolean {
  return /(?:^|[\\/])claude(?:\.exe)?$/.test(/\\|\.exe$/i.test(text) ? text.toLowerCase() : text);
}

/** A Claude Code process in herdr's process info. */
export function isClaudeProcess(entry: { name?: string; argv0?: string; argv?: readonly string[] }): boolean {
  // macOS keeps the executable name "node" for npm installs; the process title is argv0.
  if (isClaudeExecutable(entry.name) || isClaudeExecutable(entry.argv0) || isClaudeExecutable(entry.argv?.[0])) return true;
  // the native build runs under its version as the name and titles itself "Claude": both its
  // argv0 and its argv[0] say so, which one field alone does not prove
  return /^\d+\.\d+\.\d+$/.test(entry.name ?? "") && entry.argv0 === "Claude" && entry.argv?.[0] === "Claude";
}

/** Java's String.hashCode, which Claude Code uses for the suffix of a long name. */
function stringHash(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash << 5) - hash + text.charCodeAt(i) | 0;
  return hash;
}

export function claudeProjectDir(cwd: string): string {
  const name = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (name.length <= MAX_PROJECT_NAME) return name;
  return `${name.slice(0, MAX_PROJECT_NAME)}-${Math.abs(stringHash(cwd)).toString(36)}`;
}

/** The default store: `$CLAUDE_CONFIG_DIR` of this server, else `~/.claude`. */
export function defaultClaudeConfigDir(home: string): string {
  return process.env["CLAUDE_CONFIG_DIR"] || join(home, ".claude");
}

/** What readProcessConfigDir found, by pid and argv, and when: a process's environment does not change. */
const processDirs = new Map<string, { dir: string | null; at: number }>();
const PROCESS_DIR_TTL_MS = 30_000;

/**
 * The CLAUDE_CONFIG_DIR in one `ps -E -o command=` line: the last assignment, to the next `NAME=`.
 * As with CODEX_HOME, ps cannot distinguish an argument or a value containing ` NAME=` from an
 * assignment. A process that overwrites its argument/environment memory may expose no value.
 */
export function configDirInPsLine(text: string): string | null {
  return [...text.matchAll(/(?:^|\s)CLAUDE_CONFIG_DIR=(.*?)(?=\s+[A-Za-z_][A-Za-z0-9_]*=|\s*$)/g)].at(-1)?.[1] || null;
}

/**
 * What one store is known by, so that a directory reached two ways (another letter case, the
 * `\\?\` prefix, a junction) is one store, not two that both claim the process (#586): its volume
 * and file id where it has one, else its spelling without the prefix and with the drive letter in
 * one case. Past the drive letter case is kept: a case-sensitive directory's `.claude-Work` is
 * another store than `.claude-work`, and both go to the ambiguity check.
 */
export function claudeStoreKey(store: string, id: { dev: bigint; ino: bigint } | null, paths: PlatformPath = nodePath): string {
  return id !== null && id.ino !== 0n ? `${id.dev}:${id.ino}` : directoryKey(paths.resolve(withoutVerbatimPrefix(store)));
}

/**
 * The stores a Claude on Windows may use: the default one and each `~/.claude-*` beside it (the
 * usual second account, as usage.ts finds its sign-in). One listing of home, nothing deeper.
 */
async function windowsClaudeStores(home: string): Promise<string[]> {
  let siblings: string[] = [];
  try {
    siblings = (await readdir(home, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.toLowerCase().startsWith(".claude-"))
      .map((entry) => join(home, entry.name))
      .sort();
  } catch { /* no home to list: the default store alone */ }
  const stores = new Map<string, string>();
  for (const store of [defaultClaudeConfigDir(home), join(home, ".claude"), ...siblings]) {
    let id: { dev: bigint; ino: bigint } | null = null;
    try { id = await stat(store, { bigint: true }); } catch { /* not there: its spelling stands for it */ }
    const key = claudeStoreKey(store, id);
    if (!stores.has(key)) stores.set(key, store);
  }
  return [...stores.values()];
}

/** More than one store holds a live PID record of the process: which one it writes cannot be told (#586). */
export class AmbiguousClaudeStore extends Error {
  constructor(pid: number) {
    super(`more than one Claude store holds process ${pid}`);
    this.name = "AmbiguousClaudeStore";
  }
}

/**
 * Windows lets no other process read Claude's environment, so the store is the one holding the
 * process's live PID record (claudeProcessSession checks its start); null when none does, and
 * AmbiguousClaudeStore when several do (a store copied while Claude ran), never the default store.
 * A store that cannot be read is not the process's.
 */
async function windowsProcessStore(home: string, pid: number, table: () => Promise<ProcessRow[]>): Promise<string | null> {
  const stores = await windowsClaudeStores(home);
  const checks = await Promise.allSettled(stores.map((store) => claudeProcessSession(home, pid, store, "win32", table)));
  const owners = stores.filter((_, index) => { const check = checks[index]!; return check.status === "fulfilled" && check.value !== null; });
  if (owners.length > 1) throw new AmbiguousClaudeStore(pid);
  return owners[0] ?? null;
}

async function readProcessConfigDir(pid: number, home: string, platform: string, table: () => Promise<ProcessRow[]>): Promise<string | null> {
  let dir: string | null = null;
  try {
    if (platform === "win32") {
      dir = await windowsProcessStore(home, pid, table);
    } else if (platform === "linux") {
      dir = (await readFile(`/proc/${pid}/environ`, "utf8")).split("\0").find((entry) => entry.startsWith("CLAUDE_CONFIG_DIR="))?.slice(18) || null;
    } else if (platform === "darwin") {
      const child = Bun.spawn(["/bin/ps", "-E", "-ww", "-p", String(pid), "-o", "command="], { stdout: "pipe", stderr: "ignore" });
      const timer = setTimeout(() => child.kill(), 3000);
      try {
        const text = await new Response(child.stdout).text();
        await child.exited;
        dir = configDirInPsLine(text);
      } finally { clearTimeout(timer); }
    }
  } catch (error) {
    if (error instanceof AmbiguousClaudeStore) throw error;
    dir = null;
  }
  if (dir === null || !isAbsolute(dir)) return null;
  try { return (await stat(dir)).isDirectory() ? dir : null; } catch { return null; }
}

/**
 * The CLAUDE_CONFIG_DIR a Claude process was started with (a launcher such as cac keeps one store
 * per environment), or null when it has none. /proc on Linux, `ps -E` (same user only) on macOS,
 * the store holding its PID record on Windows, kept for PROCESS_DIR_TTL_MS under the process's
 * pid and argv. Throws AmbiguousClaudeStore, remembered no more than a miss, when several Windows
 * stores hold it.
 */
export async function processClaudeConfigDir(
  pid: number,
  argv: readonly string[] = [],
  home = process.env["HOME"] ?? "",
  platform: string = process.platform,
  table: () => Promise<ProcessRow[]> = recentProcessTable,
): Promise<string | null> {
  const key = `${pid}\0${argv.join("\0")}`;
  const known = processDirs.get(key);
  if (known && Date.now() - known.at < PROCESS_DIR_TTL_MS) return known.dir;
  const dir = await readProcessConfigDir(pid, home, platform, table);
  processDirs.delete(key);
  // Claude writes its PID record as it starts: on Windows a miss is asked again on the next read
  if (dir === null && platform === "win32") return null;
  processDirs.set(key, { dir, at: Date.now() });
  if (processDirs.size > 256) processDirs.delete(processDirs.keys().next().value!);
  return dir;
}

/** Only an absent path is a miss: an unreadable store is an error to report, not an empty one. */
function absent(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function isFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch (error) { if (absent(error)) return false; throw error; }
}

/** Store + session id → the file a project scan found it in; checked again on every use. */
const found = new Map<string, string>();

/** How much of a transcript's end is read for a `continued-in` record: only metadata follows one. */
const CONTINUED_TAIL_BYTES = 64 * 1024;

/**
 * The session Claude continued in, when this transcript ends in a `continued-in` record with no
 * user or assistant turn after it. Only the file's tail is read, since this runs on every lookup.
 * A file that cannot be read names no continuation: its own reader reports the failure.
 */
async function transcriptTail(path: string): Promise<string | null> {
  try {
    const file = await open(path, constants.O_RDONLY);
    try {
      const size = (await file.stat()).size;
      const start = Math.max(0, size - CONTINUED_TAIL_BYTES);
      const buffer = Buffer.alloc(size - start);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
      const text = buffer.subarray(0, bytesRead).toString("utf8");
      // a tail that starts mid-line drops that partial line
      return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}

async function continuedInSession(path: string): Promise<string | null> {
  const text = await transcriptTail(path);
  if (text === null) return null;
  let continued: string | null = null;
  for (const line of text.split("\n")) {
    if (!line.includes('"type"')) continue;
    try {
      const entry = JSON.parse(line) as { type?: unknown; continuedInSessionId?: unknown };
      if (entry.type === "user" || entry.type === "assistant") continued = null;
      else if (entry.type === "continued-in" && typeof entry.continuedInSessionId === "string" && SESSION_ID.test(entry.continuedInSessionId)) {
        continued = entry.continuedInSessionId;
      }
    } catch { /* a torn tail line cannot name the active session */ }
  }
  return continued;
}

/**
 * `/resume` of a session running in the background parks the pane on a continuation that never
 * gets a transcript; the conversation lives in the job's own `<8 hex>-*.jsonl` of the same project,
 * whose id the command prints as `running in the background (<8 hex>)`. Only an unambiguous
 * single match is taken, and the job's state.json, when it names a transcript, must agree.
 */
async function backgroundJobTranscript(path: string, configDir: string): Promise<string | null> {
  const text = await transcriptTail(path);
  if (text === null) return null;
  // each continued-in record claims only the output printed since the previous record, so an
  // earlier /resume's job id never names a later continuation
  let pending: string | undefined;
  let id: string | undefined;
  for (const line of text.split("\n")) {
    if (line.includes('"type":"continued-in"')) {
      id = pending;
      pending = undefined;
    } else {
      pending = [...line.matchAll(/running in the background \(([0-9a-f]{8})\)/g)].at(-1)?.[1] ?? pending;
    }
  }
  if (id === undefined) return null;
  let matches: string[];
  try {
    matches = (await readdir(dirname(path))).filter((name) => name.startsWith(`${id}-`) && name.endsWith(".jsonl"));
  } catch { return null; }
  if (matches.length !== 1) return null;
  const job = join(dirname(path), matches[0]!);
  try {
    const state = JSON.parse(await readFile(join(configDir, "jobs", id, "state.json"), "utf8")) as { linkScanPath?: unknown };
    if (typeof state.linkScanPath === "string" && state.linkScanPath !== job) return null;
  } catch (error) {
    if (!(error instanceof SyntaxError || absent(error))) return null;
  }
  return await isFile(job) ? job : null;
}

export function forgetClaudeSessions(): void {
  found.clear();
  processDirs.clear();
}

/**
 * macOS has no /proc: Claude records the process's start as `ps -o lstart` text in UTC, which a reused PID cannot repeat.
 * It records the C locale's order ("Fri Oct  9"); an en_GB server's ps would print "Fri  9 Oct" and match no record.
 */
async function darwinProcessStart(pid: number): Promise<string | null> {
  const child = Bun.spawn(["/bin/ps", "-o", "lstart=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore", env: { ...process.env, LC_ALL: "C", TZ: "UTC" } });
  const timer = setTimeout(() => child.kill(), 3000);
  try {
    const text = (await new Response(child.stdout).text()).replace(/\s+/g, " ").trim();
    await child.exited;
    return text || null;
  } finally { clearTimeout(timer); }
}

/** Drops what a project scan remembered about one transcript file: the scan runs again if it is ever asked for. */
export function forgetClaudeSessionFile(path: string): void {
  for (const [key, value] of found) if (value === path) found.delete(key);
}

/** Windows: Claude records the start as FILETIME (100 ns since 1601), the process table in ms since 1970. */
function fileTimeMs(text: string): number | null {
  return /^\d+$/.test(text) ? Number(BigInt(text) / 10_000n - 11_644_473_600_000n) : null;
}

/**
 * Claude's native PID record names the current session even without Herdr's hook.
 * The process's exact start (ticks on Linux, `ps` lstart text on macOS, the process table's
 * start to the millisecond on Windows) rejects leftovers after a PID is reused. Read again on
 * every request: /clear and resume can change sessions in the same process. Other platforms and
 * older records without procStart keep the hook-only path.
 */
export async function claudeProcessSession(
  home: string,
  pid: number,
  configDir = join(home, ".claude"),
  platform: string = process.platform,
  table: () => Promise<ProcessRow[]> = recentProcessTable,
): Promise<string | null> {
  if ((platform !== "linux" && platform !== "darwin" && platform !== "win32") || !Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    // Non-blocking and no symlinks: a FIFO or a link in the record's place must not hang the read.
    const file = await open(join(configDir, "sessions", `${pid}.json`), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    let text: string;
    try {
      if (!(await file.stat()).isFile()) return null;
      const bytes = Buffer.alloc(16 * 1024 + 1);
      let length = 0;
      // One read may return less than the file holds; only a read of nothing is its end.
      for (;;) {
        const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
        if (length === bytes.length) return null;
      }
      text = bytes.subarray(0, length).toString("utf8");
    } finally { await file.close(); }
    const record: unknown = JSON.parse(text);
    if (record === null || typeof record !== "object" ||
      !("pid" in record) || record.pid !== pid ||
      !("kind" in record) || record.kind !== "interactive" ||
      !("sessionId" in record) || typeof record.sessionId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(record.sessionId) ||
      !("procStart" in record) || typeof record.procStart !== "string") return null;
    if (platform === "linux") {
      if (!/^\d+$/.test(record.procStart)) return null;
      const processStat = await readFile(`/proc/${pid}/stat`, "utf8");
      const fields = processStat.slice(processStat.lastIndexOf(") ") + 2).split(" ");
      if (fields[19] !== record.procStart) return null;
    } else if (platform === "win32") {
      // an unreadable table (no rows) leaves the process unknown, and so the record
      const started = fileTimeMs(record.procStart);
      if (started === null || (await table()).find((row) => row.pid === pid)?.started !== started) return null;
    } else if (await darwinProcessStart(pid) !== record.procStart.replace(/\s+/g, " ").trim()) return null;
    return record.sessionId;
  } catch (error) {
    // A closed process, absent/older native store or a torn write gives no identity.
    if (error instanceof SyntaxError || absent(error) ||
      (error !== null && typeof error === "object" && "code" in error && ["EACCES", "EPERM", "ESRCH", "ELOOP", "ENXIO"].includes(String(error.code)))) return null;
    throw error;
  }
}

/**
 * The session a pane's one Claude process names in its own PID record, which Claude rewrites when
 * /clear or /resume switches it to another session in the same process; null when the pane has no
 * single Claude process or the record cannot be trusted (claudeProcessSession).
 */
export async function claudeForegroundSession(
  processes: readonly { pid: number; name?: string | null; argv0?: string | null; argv?: readonly string[] | null }[],
  home = process.env["HOME"] ?? "",
): Promise<string | null> {
  const claude = processes.filter((entry) => isClaudeProcess({ name: entry.name ?? undefined, argv0: entry.argv0 ?? undefined, argv: entry.argv ?? undefined }));
  if (claude.length !== 1) return null;
  const only = claude[0]!;
  try {
    const dir = await processClaudeConfigDir(only.pid, only.argv ?? [only.argv0 ?? only.name ?? ""], home);
    return await claudeProcessSession(home, only.pid, dir || defaultClaudeConfigDir(home));
  } catch {
    // two stores claim the process, or one cannot be read: no session to pin
    return null;
  }
}

/**
 * The transcript of `session` (a UUID, validated by the caller): under the project of each cwd
 * in turn, else in whichever project holds it. Null when no project does (a session that has not
 * written its first message yet). Such a session is scanned again on every poll, so the scan
 * stays off the event loop.
 */
export async function claudeTranscriptFile(home: string, session: string, cwds: readonly (string | null | undefined)[], configDir = join(home, ".claude")): Promise<string | null> {
  const projects = join(configDir, "projects");
  const locate = async (id: string): Promise<string | null> => {
    const file = `${id}.jsonl`;
    for (const cwd of cwds) {
      if (!cwd) continue;
      const path = join(projects, claudeProjectDir(cwd), file);
      if (await isFile(path)) return path;
    }
    const key = `${projects}\0${id}`;
    const known = found.get(key);
    if (known !== undefined && await isFile(known)) return known;
    found.delete(key);
    let entries: string[];
    try { entries = await readdir(projects); } catch (error) { if (absent(error)) return null; throw error; }
    // one unreadable project must not hide the session in another: an error counts only without a hit
    const checks = await Promise.allSettled(entries.map(async (entry) => {
      const path = join(projects, entry, file);
      return await isFile(path) ? path : null;
    }));
    for (const check of checks) {
      if (check.status === "fulfilled" && check.value !== null) { found.set(key, check.value); return check.value; }
    }
    const failed = checks.find((check) => check.status === "rejected");
    if (failed) throw failed.reason;
    return null;
  };

  const seen = new Set<string>([session]);
  let path = await locate(session);
  while (path !== null) {
    const next = await continuedInSession(path);
    if (next === null || seen.has(next)) return path;
    seen.add(next);
    // a continuation whose file is not there keeps the transcript that named it, unless a
    // /resume of a background session names that job's own transcript
    const nextPath = await locate(next) ?? await backgroundJobTranscript(path, configDir);
    if (nextPath === null) return path;
    path = nextPath;
  }
  return null;
}

/**
 * The folder Claude Code keeps for a session's own files outside the project, such as the
 * `scratchpad/` it names in prose by a relative path: `<tmp>/claude-<uid>/<project>/<session>/`,
 * <project> and <session> being the transcript's folder and name. Only a `claude-<uid>` folder
 * this user owns is read (another user could make it first in a shared /tmp). Null when there is
 * none, and on Windows, which has no uid.
 */
export async function claudeSessionTempDir(
  transcript: string,
  roots: readonly string[] = [...new Set([tmpdir(), "/tmp"])],
  uid: number | undefined = process.getuid?.(),
): Promise<string | null> {
  if (uid === undefined || !transcript.endsWith(".jsonl")) return null;
  const session = basename(transcript, ".jsonl");
  if (!SESSION_ID.test(session)) return null;
  const project = basename(dirname(transcript));
  for (const root of roots) {
    const base = join(root, `claude-${uid}`);
    try {
      if ((await stat(base)).uid !== uid) continue;
      const dir = join(base, project, session);
      if ((await stat(dir)).isDirectory()) return dir;
    } catch { /* absent or unreadable: not in this root */ }
  }
  return null;
}
