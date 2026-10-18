/**
 * GJC conversation identity comes only from its public SDK broker binding a live pane
 * process to its exact saved session. Shared terminal/store helpers below are also used by omp.
 */

import { execFileSync } from "node:child_process";
import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, statSync } from "node:fs";
import nodePath, { join, type PlatformPath } from "node:path";

import { GjcSdkLookupError, gjcSdkTranscript } from "./gjc-sdk.ts";
import { herdrRpc } from "./herdr/client.ts";
import { processStartedAt } from "./process-start.ts";
import { descendantArgv, windowsProcessTable, type ProcessRow } from "./windows-processes.ts";

export interface GjcTerminal { id: string; startedAt: number }

/**
 * An agent run natively or as a bun/node script, as process_info names either: `executable`
 * matches its binary or script path (a Windows process comes with backslashes and `.exe`).
 */
export function runsAgent(argv: readonly string[], executable: RegExp): boolean {
  return executable.test(argv[0] ?? "") ||
    (/(^|[\\/])(?:bun|node)(?:\.exe)?$/i.test(argv[0] ?? "") && executable.test(argv[1] ?? ""));
}

const GJC_EXECUTABLE = /(^|[\\/])gjc(?:\.exe|\.[cm]?js)?$/i;

export function isGjcProcess(argv: readonly string[]): boolean {
  return runsAgent(argv, GJC_EXECUTABLE);
}

const PROCESS_TABLE_MS = 5000;
let processTable: { at: number; rows: Promise<ProcessRow[]> } | null = null;

/**
 * The Windows process table, read at most once per PROCESS_TABLE_MS. The chat polls a pane
 * every 2 s and each read starts a PowerShell (about 1.3 s on a real PC), so the polls of a
 * few seconds share one; a gjc that left its pane can still count as running for that long.
 */
export function recentProcessTable(read: () => Promise<ProcessRow[]> = windowsProcessTable, now = Date.now()): Promise<ProcessRow[]> {
  if (processTable && now - processTable.at < PROCESS_TABLE_MS) return processTable.rows;
  const entry = { at: now, rows: read() };
  processTable = entry;
  // an empty table is a read that failed: the next poll asks again
  void entry.rows.then((rows) => { if (rows.length === 0 && processTable === entry) processTable = null; });
  return entry.rows;
}

/** A gjc process by its number and when it started: a number alone comes back for another process. */
export type GjcProcess = { pid: number; started: number | null };

/**
 * The gjc process below a pane's shell on a Windows PC, or null. herdr names only the shell
 * there (windows-processes.ts), so the PC's process table answers; elsewhere herdr's
 * foreground processes are the answer and the table is never asked. undefined: the table could
 * not be read (a query that timed out answers no rows), which says nothing about gjc.
 */
export async function gjcPidUnderShell(
  shellPid: unknown,
  platform: string = process.platform,
  table: () => Promise<ProcessRow[]> = recentProcessTable,
): Promise<GjcProcess | null | undefined> {
  if (platform !== "win32" || typeof shellPid !== "number") return null;
  const rows = await table();
  if (rows.length === 0) return undefined;
  const seen = new Set<number>([shellPid]);
  let level = [shellPid];
  while (level.length > 0) {
    const next: number[] = [];
    for (const row of rows) {
      if (!level.includes(row.parent) || seen.has(row.pid)) continue;
      // nearest first: the session's own process, not the helper gjc starts below itself
      if (descendantArgv([row], row.parent).some(isGjcProcess)) return { pid: row.pid, started: row.started ?? null };
      seen.add(row.pid);
      next.push(row.pid);
    }
    level = next;
  }
  return null;
}

/** Forget the process table kept between Windows polls. */
export function forgetGjcState(): void { processTable = null; transcriptFlights.clear(); transcriptBindings.clear(); }

/**
 * Where `file` sits inside `root`, as path segments, or null when it is not inside. The
 * platform's own rules decide: a Windows path comes with backslashes and a drive letter whose
 * case means nothing, and a prefix test would take `sessions-evil` or a `..` for the store.
 */
export function storeRelative(root: string, file: string, paths: PlatformPath = nodePath): string[] | null {
  const relative = paths.relative(root, file);
  // another drive or share comes back absolute
  if (relative === "" || paths.isAbsolute(relative)) return null;
  const parts = relative.split(paths.sep);
  return parts[0] === ".." ? null : parts;
}

/**
 * GJC's native terminal-sessions key, not the most recently written cwd session. `environ`, when
 * given (null: unreadable), stands in for /proc/<pid>/environ, which is then never read here.
 */
export function gjcTerminal(pid: number, environ?: readonly string[] | null): GjcTerminal | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "linux") {
      const startedAt = processStartedAt(pid);
      if (startedAt === null) return null;
      const env = environ === undefined ? readFileSync(`/proc/${pid}/environ`, "utf8").split("\0") : environ ?? [];
      const tmux = env.find((word) => word.startsWith("TMUX="))?.slice(5);
      const pane = env.find((word) => word.startsWith("TMUX_PANE="))?.slice(10);
      if (tmux && pane && /^%\d+$/.test(pane)) return { id: `tmux-${pane}`, startedAt };
      const tty = readlinkSync(`/proc/${pid}/fd/0`);
      if (!/^\/dev\/(?:pts\/\d+|tty[\w-]+)$/.test(tty)) return null;
      return { id: tty.slice(5).replaceAll("/", "-"), startedAt };
    }
    if (process.platform === "darwin") {
      // lstart is local time without a zone: print it in the zone Date.parse reads it in,
      // which is not always $TZ (bun test runs in UTC without setting it)
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const output = execFileSync("ps", ["-p", String(pid), "-o", "tty=", "-o", "lstart="], {
        encoding: "utf8", timeout: 1500, maxBuffer: 4096, env: { ...process.env, LC_ALL: "C", TZ: zone }, stdio: ["ignore", "pipe", "ignore"],
      });
      return parseGjcPs(output);
    }
  } catch { /* process exited or its terminal metadata is unavailable */ }
  return null;
}

export function parseGjcPs(output: string): GjcTerminal | null {
  const match = output.trim().match(/^(?:\/dev\/)?(ttys\d+)\s+(.+)$/);
  if (!match) return null;
  const startedAt = Date.parse(match[2]!);
  return Number.isFinite(startedAt) ? { id: match[1]!, startedAt } : null;
}

/**
 * The cwd a gjc or omp transcript names in its header (`{"type":"session",...}`), or null when
 * the file is not one. omp writes a title record before the header. Read bounded: only the
 * header decides, and a rejected candidate can be megabytes.
 */
function transcriptCwd(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null; // the file vanished between the listing and this read
  }
  try {
    const buffer = Buffer.alloc(4096);
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    const lines = buffer.subarray(0, size).toString("utf8").split("\n");
    let header = JSON.parse(lines[0] ?? "") as { type?: string; cwd?: unknown };
    if (header.type === "title") header = JSON.parse(lines[1] ?? "") as { type?: string; cwd?: unknown };
    return header.type === "session" && typeof header.cwd === "string" ? header.cwd : null;
  } catch {
    return null; // not a gjc transcript, or a header longer than the read
  } finally {
    closeSync(fd);
  }
}

/**
 * Shared breadcrumb/descriptor lookup: GJC and omp subagents live beside their session file, so
 * this helper maps such a path to its parent. The SDK-based GJC pane resolver does not use it.
 */
export function gjcSessionFile(root: string, path: string, paths: PlatformPath = nodePath): string | null {
  const parts = path.endsWith(".jsonl") ? storeRelative(root, path, paths) : null;
  if (!parts) return null;
  if (parts.length === 2) return path;
  if (parts.length !== 3) return null;
  const session = paths.join(root, parts[0]!, `${parts[1]!}.jsonl`);
  try { return statSync(session).isFile() ? session : null; } catch { return null; }
}

/** Validate the shared native breadcrumb under `agentDir/terminal-sessions` and reject stale leftovers. */
export function terminalBreadcrumb(agentDir: string, cwd: string, terminalId: string, startedAt: number): string | null {
  if (!/^(?:pts-\d+|tty[\w-]+|tmux-%\d+)$/.test(terminalId) || !Number.isFinite(startedAt)) return null;
  try {
    const marker = join(agentDir, "terminal-sessions", terminalId);
    const stat = statSync(marker);
    if (!stat.isFile() || stat.size > 8192 || stat.mtimeMs < startedAt - 1000) return null;
    const [savedCwd, savedPath] = readFileSync(marker, "utf8").split("\n");
    if (!savedCwd || !savedPath || realpathSync(savedCwd) !== realpathSync(cwd)) return null;
    const root = realpathSync(join(agentDir, "sessions"));
    const saved = realpathSync(savedPath);
    if (!statSync(saved).isFile()) return null;
    const path = gjcSessionFile(root, saved);
    if (!path) return null;
    const headerCwd = transcriptCwd(path);
    return headerCwd && realpathSync(headerCwd) === realpathSync(cwd) ? path : null;
  } catch { return null; }
}

/**
 * The transcript an agent's processes show, from its store under `agentDir` (GJC and omp lay
 * theirs out alike): an exact open transcript first, then the terminal-scoped breadcrumb written
 * during the process's lifetime. A directory descriptor or cwd proves only the store, not the
 * active session; never infer ownership from cwd or session recency. `path` is null unless
 * exactly one transcript qualifies; `found` says how many did. `environOf` supplies a process's
 * environment already read elsewhere, so none is read here; undefined for a pid reads it.
 */
export function heldTranscript(agentDir: string, cwd: string, pids: readonly number[], environOf?: (pid: number) => readonly string[] | null | undefined): { path: string | null; found: number } {
  let root: string;
  try { root = realpathSync(join(agentDir, "sessions")); }
  catch { return { path: null, found: 0 }; }
  const open = new Set<string>();
  const breadcrumbs = new Set<string>();
  for (const pid of pids) {
    const terminal = gjcTerminal(pid, environOf?.(pid));
    if (terminal) {
      const path = terminalBreadcrumb(agentDir, cwd, terminal.id, terminal.startedAt);
      if (path) breadcrumbs.add(path);
    }
    let fds: string[] = [];
    try { fds = readdirSync(`/proc/${pid}/fd`); } catch { /* macOS uses the native breadcrumb */ }
    for (const fd of fds) {
      try {
        const file = realpathSync(readlinkSync(`/proc/${pid}/fd/${fd}`));
        const target = statSync(file).isFile() ? gjcSessionFile(root, file) : null;
        if (target && transcriptCwd(target) === cwd) open.add(target);
      } catch { /* closed, deleted or unreadable descriptor */ }
    }
  }
  const candidates = open.size > 0 ? open : breadcrumbs;
  return { path: candidates.size === 1 ? [...candidates][0]! : null, found: candidates.size };
}

const GJC_HEADER_BYTES = 64 * 1024;

type GjcSdkBinding = NonNullable<Awaited<ReturnType<typeof gjcSdkTranscript>>>;

/** The SDK-selected path is usable only as its exact main session transcript. */
export function validateGjcSdkTranscript(binding: GjcSdkBinding, cwd: string, agentDir: string): string | null {
  if (!binding || !Number.isSafeInteger(binding.pid) || binding.pid <= 0
    || typeof binding.sessionId !== "string" || binding.sessionId === ""
    || typeof binding.path !== "string" || !nodePath.isAbsolute(binding.path)
    || !nodePath.isAbsolute(cwd) || !nodePath.isAbsolute(agentDir)) return null;
  let fd: number;
  try {
    const root = realpathSync(join(agentDir, "sessions"));
    const expectedCwd = realpathSync(cwd);
    const path = realpathSync(binding.path);
    const parts = storeRelative(root, path);
    // A GJC main session is sessions/<project>/<file>.jsonl. Never translate a subagent path.
    if (!parts || parts.length !== 2 || !path.endsWith(".jsonl")) return null;
    fd = openSync(path, "r");
    try {
      if (!fstatSync(fd).isFile()) return null;
      const buffer = Buffer.alloc(GJC_HEADER_BYTES);
      const size = readSync(fd, buffer, 0, buffer.length, 0);
      const end = buffer.subarray(0, size).indexOf(0x0a);
      if (end < 0) return null;
      const header = JSON.parse(buffer.subarray(0, end).toString("utf8")) as { type?: unknown; id?: unknown; cwd?: unknown };
      if (header.type !== "session" || header.id !== binding.sessionId || typeof header.cwd !== "string") return null;
      const headerCwd = realpathSync(header.cwd);
      const sameCwd = process.platform === "win32"
        ? headerCwd.toLowerCase() === expectedCwd.toLowerCase()
        : headerCwd === expectedCwd;
      return sameCwd ? path : null;
    } finally { closeSync(fd); }
  } catch { return null; }
}

type GjcPaneProcessInfo = { process_info?: { shell_pid?: unknown; foreground_processes?: { pid?: unknown; argv?: unknown }[] } };
type GjcProcessIdentity = { pid: number; birth: number };

type GjcTranscriptOptions = {
  platform?: string;
  processInfo?: (paneId: string) => Promise<GjcPaneProcessInfo | null>;
  processBirth?: (pid: number) => number | null;
  sdkTranscript?: typeof gjcSdkTranscript;
  readProcessTable?: () => Promise<ProcessRow[]>;
  now?: () => number;
};

/** Each SDK lookup spawns the gjc CLI, so equivalent pane/directory/I/O contexts share one flight. */
const transcriptFlights = new Map<string, Set<{ options: GjcTranscriptOptions; flight: Promise<string | null> }>>();

function sameLookupContext(a: GjcTranscriptOptions, b: GjcTranscriptOptions): boolean {
  return a.processInfo === b.processInfo
    && a.processBirth === b.processBirth
    && a.sdkTranscript === b.sdkTranscript
    && a.readProcessTable === b.readProcessTable;
}

/**
 * The broker answers session.list from `sdk/sessions/index.jsonl` (and its compacted snapshot),
 * which it re-reads on every list; GJC appends a row there, synced, before its broker knows of
 * any session change: /new and /resume unregister the old session and register the new one
 * while the pid and the old transcript stay. GJC tells its own index changed by this same stat
 * fingerprint. null (no index, or a stat that failed): nothing may be kept.
 */
function indexFingerprint(agentDir: string): string | null {
  const parts: string[] = [];
  for (const name of ["index.jsonl", "index.snapshot.json"]) {
    try {
      const stat = statSync(join(agentDir, "sdk", "sessions", name), { bigint: true });
      parts.push(`${stat.size}:${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}`);
    } catch (error) {
      if (name === "index.jsonl" || (error as NodeJS.ErrnoException).code !== "ENOENT") return null;
      parts.push("-");
    }
  }
  return parts.join("|");
}

/**
 * A binding the broker proved, kept while the index it came from is unchanged. Its liveness also
 * ages with the clock (a session whose heartbeats stop, about one a minute, stops counting as live
 * within two), so a kept binding lives well under that; age can only turn a binding into no
 * binding, never into another session.
 */
const BINDING_TTL_MS = 30_000;

type KeptBinding = {
  options: GjcTranscriptOptions;
  fingerprint: string;
  processes: GjcProcessIdentity[];
  binding: GjcSdkBinding;
  at: number;
};

/**
 * Proven bindings by lookup context. A null answer is never kept: the first message after /new
 * creates the transcript the broker then names, without a new index row.
 */
const transcriptBindings = new Map<string, KeptBinding>();

/**
 * Resolves only while the SDK-selected GJC process is still foreground in this pane with the
 * same birth identity. Optional I/O callbacks keep this race check fixture-testable. Overlapping
 * reads with the same lookup context share a lookup. A later read reuses the proven binding only
 * while the session index is unchanged, the pane's GJC processes are the same ones and the
 * transcript still names that session; anything else asks the broker again (a /new keeps the pid
 * and can keep the old file, but always writes the index).
 */
export function gjcTranscriptForPane(
  paneId: string,
  cwd: string,
  home = process.env["HOME"] ?? "",
  options: GjcTranscriptOptions = {},
): Promise<string | null> {
  const key = JSON.stringify([paneId, cwd, home, options.platform ?? process.platform]);
  const flights = transcriptFlights.get(key) ?? new Set<{ options: GjcTranscriptOptions; flight: Promise<string | null> }>();
  for (const shared of flights) {
    if (sameLookupContext(shared.options, options)) return shared.flight;
  }
  const flight: Promise<string | null> = lookupGjcTranscript(key, paneId, cwd, home, options).finally(() => {
    flights.delete(entry);
    if (transcriptFlights.get(key) === flights && flights.size === 0) transcriptFlights.delete(key);
  });
  const entry = { options, flight };
  flights.add(entry);
  transcriptFlights.set(key, flights);
  return flight;
}

async function lookupGjcTranscript(
  key: string,
  paneId: string,
  cwd: string,
  home: string,
  options: GjcTranscriptOptions,
): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  const agentDir = join(home, ".gjc", "agent");
  if (!nodePath.isAbsolute(cwd) || !nodePath.isAbsolute(agentDir)) return null;
  const readProcessInfo = options.processInfo ?? ((id: string) => herdrRpc<GjcPaneProcessInfo>(
    "pane.process_info", { pane_id: id },
  ).catch(() => null));
  const sdkTranscript = options.sdkTranscript ?? gjcSdkTranscript;
  const readProcessTable = options.readProcessTable ?? windowsProcessTable;
  const processBirth = options.processBirth ?? processStartedAt;
  const now = options.now ?? Date.now;
  // macOS reads a start as now minus whole elapsed seconds, so two reads of one process
  // differ by up to a second.
  const sameBirth = (a: number, b: number) => platform === "darwin" ? Math.abs(a - b) <= 1000 : a === b;
  const sameProcesses = (a: GjcProcessIdentity[], b: GjcProcessIdentity[]) => a.length === b.length
    && a.every((process) => b.some((other) => other.pid === process.pid && sameBirth(other.birth, process.birth)));
  const forget = (): null => { transcriptBindings.delete(key); return null; };

  const processes = async (info: GjcPaneProcessInfo | null, fresh: boolean): Promise<GjcProcessIdentity[] | null> => {
    if (!info?.process_info) return null;
    if (platform === "win32") {
      const table = fresh ? readProcessTable : () => recentProcessTable(readProcessTable);
      const process = await gjcPidUnderShell(info.process_info.shell_pid, platform, table);
      if (process === undefined) return null;
      if (process === null) return [];
      if (!Number.isSafeInteger(process.started) || process.started === null) return null;
      return [{ pid: process.pid, birth: process.started }];
    }

    const foreground = info.process_info.foreground_processes;
    if (!Array.isArray(foreground)) return null;
    const found: GjcProcessIdentity[] = [];
    const seen = new Map<number, number>();
    for (const process of foreground) {
      const argv = Array.isArray(process.argv) ? process.argv.map(String) : [];
      if (!isGjcProcess(argv)) continue;
      if (typeof process.pid !== "number" || !Number.isSafeInteger(process.pid) || process.pid <= 0) return null;
      const started = processBirth(process.pid);
      if (started === null || !Number.isFinite(started)) return null;
      const previous = seen.get(process.pid);
      if (previous !== undefined && !sameBirth(previous, started)) return null;
      if (previous === undefined) {
        seen.set(process.pid, started);
        found.push({ pid: process.pid, birth: started });
      }
    }
    return found;
  };

  try {
    const initialInfo = await readProcessInfo(paneId);
    if (!initialInfo) return forget();
    const initial = await processes(initialInfo, false);
    if (!initial || initial.length === 0) return forget();
    // Read before the lookup: a write that lands during it then makes the next read ask again.
    const fingerprint = indexFingerprint(agentDir), checkedAt = now();
    const kept = transcriptBindings.get(key);
    if (kept && fingerprint !== null && kept.fingerprint === fingerprint
      && sameLookupContext(kept.options, options) && checkedAt - kept.at < BINDING_TTL_MS) {
      // the kept table may be a few seconds old on Windows; the shared one is not proof enough
      const current = platform === "win32" ? await processes(initialInfo, true) : initial;
      if (current && sameProcesses(current, kept.processes)) {
        const path = validateGjcSdkTranscript(kept.binding, cwd, agentDir);
        if (path) return path;
      }
    }
    transcriptBindings.delete(key);
    const pids = initial.map((process) => process.pid);
    const binding = await sdkTranscript(pids, cwd, agentDir);
    const owner = binding && initial.find((process) => process.pid === binding.pid);
    if (!binding || !owner) return null;
    const path = validateGjcSdkTranscript(binding, cwd, agentDir);
    if (!path) return null;

    const finalInfo = await readProcessInfo(paneId);
    if (!finalInfo) return null;
    const final = await processes(finalInfo, true);
    if (!final?.some((process) => process.pid === owner.pid && sameBirth(process.birth, owner.birth))) return null;
    if (fingerprint !== null) {
      for (const [other, entry] of transcriptBindings) if (checkedAt - entry.at >= BINDING_TTL_MS) transcriptBindings.delete(other);
      // aged from before the lookup, when the fingerprint was read
      transcriptBindings.set(key, { options, fingerprint, processes: initial, binding, at: checkedAt });
    }
    return path;
  } catch (error) {
    // a timed-out lookup reaches the route as 504, so the chat keeps what it shows (#1295); the kept
    // binding was already dropped, since a lookup only runs once it no longer held
    if (error instanceof GjcSdkLookupError) throw error;
    return forget();
  }
}
