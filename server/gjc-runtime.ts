/**
 * GJC conversation identity comes only from its public SDK broker binding a live pane
 * process to its exact saved session. Shared terminal/store helpers below are also used by omp.
 */

import { execFileSync } from "node:child_process";
import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, statSync } from "node:fs";
import nodePath, { join, type PlatformPath } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { SlashCommand } from "../shared/protocol.ts";
import { registerCatalogSource } from "./catalog-sources.ts";
import { GjcSdkLookupError, gjcSdkQuery, gjcSdkTranscript } from "./gjc-sdk.ts";
import { captureGjcIndex, gjcIndexUnchanged, type GjcIndexStamp } from "./gjc-index.ts";
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

/**
 * A lookup outlives what it was asked about: its pane can end, the state can be reset, a newer lookup can
 * finish first. Each lookup takes a token from one monotonic sequence and is listed under its pane until it
 * settles. Forgetting cancels the listed tokens, and a lookup publishes only while its token stands and is
 * newer than what is already kept for its key, so nothing is kept about an ended pane.
 */
type LookupToken = { seq: number; key: string; cancelled: boolean; /** settled from what was kept (a cache hit or a replayed failure), not from new evidence */ cached?: true; /** settled with a fresh failure (timeout, unavailable) */ failed?: true };
let lookupSeq = 0;
const lookupsInFlight = new Map<string, Set<LookupToken>>();
/** Per pane, the seq of the newest lookup that settled (any outcome, any cwd key): an older lookup publishes nothing past it. Deleted with the pane. */
const settledSeq = new Map<string, number>();
/** Per pane and cwd key, the seq of the newest lookup that settled with a fresh failure: it only overtakes the older lookups of other keys, since a failure says nothing about its own key's proof. */
const settledFailures = new Map<string, Map<string, number>>();

/** Whether a lookup of this key and seq was overtaken by a newer lookup of its pane that settled on new evidence. */
function overtaken(paneId: string, key: string, seq: number): boolean {
  if (seq <= (settledSeq.get(paneId) ?? -1)) return true;
  for (const [other, failed] of settledFailures.get(paneId) ?? []) if (other !== key && failed > seq) return true;
  return false;
}

function cancelLookups(tokens: Iterable<LookupToken>): void { for (const token of tokens) token.cancelled = true; }

/** Forget the process table kept between Windows polls, and every kept gjc state; running lookups publish nothing after it. */
export function forgetGjcState(): void {
  for (const tokens of lookupsInFlight.values()) cancelLookups(tokens);
  lookupsInFlight.clear();
  settledSeq.clear();
  settledFailures.clear();
  processTable = null; transcriptFlights.clear(); transcriptBindings.clear(); transcriptFailures.clear(); nativeSkills.clear();
}

/** Per pane only the most recent proof counts: a lookup that starts or ends drops every older binding of the pane, under any cwd key. */
function supersedeBindings(paneId: string, key: string, seq: number): void {
  for (const [other, kept] of transcriptBindings) {
    if (other !== key && kept.seq < seq && (JSON.parse(other) as [string])[0] === paneId) transcriptBindings.delete(other);
  }
}

/** Drop one pane's kept gjc state: its proven binding, kept failures and native rows, and cancel any lookup or refresh still running for it. */
export function forgetGjcPane(paneId: string): void {
  cancelLookups(lookupsInFlight.get(paneId) ?? []);
  lookupsInFlight.delete(paneId);
  settledSeq.delete(paneId);
  settledFailures.delete(paneId);
  for (const map of [transcriptBindings, transcriptFailures, transcriptFlights] as Map<string, unknown>[]) {
    for (const key of [...map.keys()]) if ((JSON.parse(key) as [string])[0] === paneId) map.delete(key);
  }
  const entry = nativeSkills.get(paneId);
  if (entry) entry.dropped = true;
  nativeSkills.delete(paneId);
}

/** How many entries gjc state holds, for tests of what an ended pane leaves behind. */
export function gjcRetainedEntries(): number {
  return lookupsInFlight.size + settledSeq.size + settledFailures.size + transcriptBindings.size + transcriptFailures.size + transcriptFlights.size + nativeSkills.size;
}

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
  /** Status uses shorter SDK deadlines and may reuse recent failures; chat reads retry. */
  purpose?: "chat" | "status";
  platform?: string;
  processInfo?: (paneId: string) => Promise<GjcPaneProcessInfo | null>;
  processBirth?: (pid: number) => number | null;
  sdkTranscript?: typeof gjcSdkTranscript;
  readProcessTable?: () => Promise<ProcessRow[]>;
  now?: () => number;
};

const lookupKey = (paneId: string, cwd: string, home: string, options: GjcTranscriptOptions): string =>
  JSON.stringify([paneId, cwd, home, options.platform ?? process.platform]);

/** Each SDK lookup spawns the gjc CLI, so equivalent pane/directory/I/O contexts share one flight. */
type TranscriptFlight = { options: GjcTranscriptOptions; flight: Promise<string | null> };
const transcriptFlights = new Map<string, { entries: Set<TranscriptFlight>; successes: number }>();

function sameLookupContext(a: GjcTranscriptOptions, b: GjcTranscriptOptions): boolean {
  return a.processInfo === b.processInfo
    && a.processBirth === b.processBirth
    && a.sdkTranscript === b.sdkTranscript
    && a.readProcessTable === b.readProcessTable;
}

/**
 * A binding the broker proved, kept while the index it came from is unchanged or only gains
 * unrelated heartbeats. Its liveness also ages with the clock (a session whose heartbeats stop,
 * about one a minute, stops counting as live within two), so age can only turn it into no binding.
 */
const BINDING_TTL_MS = 30_000;

type KeptBinding = {
  options: GjcTranscriptOptions;
  indexStamp: GjcIndexStamp;
  processes: GjcProcessIdentity[];
  binding: GjcSdkBinding;
  at: number;
  /** the lookup that proved it: an older lookup never replaces it */
  seq: number;
};

/**
 * Proven bindings by lookup context. A null answer is never kept: the first message after /new
 * creates the transcript the broker then names, without a new index row.
 */
const transcriptBindings = new Map<string, KeptBinding>();
const transcriptFailures = new Map<string, {
  options: GjcTranscriptOptions;
  at: number;
  processes: GjcProcessIdentity[];
  indexStamp: GjcIndexStamp | null;
  error: GjcSdkLookupError | null;
  seq: number;
}>();

/**
 * Resolves only while the SDK-selected GJC process is still foreground in this pane with the
 * same birth identity. Optional I/O callbacks keep this race check fixture-testable. Overlapping
 * reads with the same lookup context share a lookup. A later read reuses the proven binding only
 * while the index is unchanged or has only unrelated heartbeats, the pane's GJC processes are the
 * same ones and the transcript still names that session; anything else asks the broker again (a
 * /new keeps the pid and can keep the old file, but always writes the index).
 */
export function gjcTranscriptForPane(
  paneId: string,
  cwd: string,
  home = process.env["HOME"] ?? "",
  options: GjcTranscriptOptions = {},
): Promise<string | null> {
  const key = lookupKey(paneId, cwd, home, options);
  const now = (options.now ?? Date.now)();
  for (const [other, failure] of transcriptFailures) {
    if (now - failure.at >= BINDING_TTL_MS) transcriptFailures.delete(other);
  }
  const flights = transcriptFlights.get(key) ?? { entries: new Set<TranscriptFlight>(), successes: 0 };
  for (const shared of flights.entries) {
    if (sameLookupContext(shared.options, options)
      && (shared.options.purpose ?? "chat") === (options.purpose ?? "chat")) return shared.flight;
  }
  const successes = flights.successes;
  const token: LookupToken = { seq: ++lookupSeq, key, cancelled: false };
  const running = lookupsInFlight.get(paneId) ?? new Set<LookupToken>();
  running.add(token);
  lookupsInFlight.set(paneId, running);
  // The group lives until every overlapping flight settles, including one finishing after a success.
  const flight: Promise<string | null> = lookupGjcTranscript(key, paneId, cwd, home, options, () => flights.successes === successes && !token.cancelled, token).then((path) => {
    if (path !== null) { flights.successes += 1; if (!token.cancelled && token.seq > (transcriptFailures.get(key)?.seq ?? -1) && !overtaken(paneId, key, token.seq)) transcriptFailures.delete(key); }
    return path;
  }, (error) => { token.failed = true; throw error; }).finally(() => {
    // a cancelled lookup belongs to a pane that ended or a state that was reset: it leaves no record
    // only a lookup that settled on new evidence outranks the older ones; one answered from the cache blocks nobody
    if (!token.cancelled && !token.cached) {
      if (!token.failed) { if (token.seq > (settledSeq.get(paneId) ?? -1)) settledSeq.set(paneId, token.seq); }
      else {
        const failures = settledFailures.get(paneId) ?? new Map<string, number>();
        if (token.seq > (failures.get(key) ?? -1)) failures.set(key, token.seq);
        settledFailures.set(paneId, failures);
      }
    }
    running.delete(token);
    // with nothing in flight every later lookup is newer, so the record is no longer needed
    if (running.size === 0 && lookupsInFlight.get(paneId) === running) { lookupsInFlight.delete(paneId); settledSeq.delete(paneId); settledFailures.delete(paneId); }
    flights.entries.delete(entry);
    if (transcriptFlights.get(key) === flights && flights.entries.size === 0) transcriptFlights.delete(key);
  });
  const entry = { options, flight };
  flights.entries.add(entry);
  transcriptFlights.set(key, flights);
  return flight;
}

async function lookupGjcTranscript(
  key: string,
  paneId: string,
  cwd: string,
  home: string,
  options: GjcTranscriptOptions,
  canCacheFailure: () => boolean,
  token: LookupToken,
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
  // publishing, or removing what is kept, is for a lookup that stands and is newer than what it would replace
  const newest = (kept: Map<string, { seq: number }>): boolean => !token.cancelled && token.seq > (kept.get(key)?.seq ?? -1)
    // a newer lookup of the pane has already settled on new evidence: this one describes a proof that was overtaken
    && !overtaken(paneId, key, token.seq);
  const forget = (): null => {
    if (!token.cancelled) supersedeBindings(paneId, key, token.seq);
    if (canCacheFailure()) {
      if (newest(transcriptBindings)) transcriptBindings.delete(key);
      if (newest(transcriptFailures)) transcriptFailures.delete(key);
    }
    return null;
  };

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
    let initial = await processes(initialInfo, false);
    if (!initial || initial.length === 0) return forget();
    // Read before the lookup: a write that lands during it then makes the next read ask again.
    const indexStamp = captureGjcIndex(agentDir), checkedAt = now();
    const kept = transcriptBindings.get(key);
    if (kept && indexStamp !== null
      && sameLookupContext(kept.options, options) && checkedAt - kept.at < BINDING_TTL_MS) {
      // the kept table may be a few seconds old on Windows; the shared one is not proof enough
      const current = platform === "win32" ? await processes(initialInfo, true) : initial;
      const guardSessionIds = [...new Set([...kept.binding.guardSessionIds, kept.binding.sessionId])];
      if (current && sameProcesses(current, kept.processes)
        && gjcIndexUnchanged(agentDir, kept.indexStamp, indexStamp, kept.processes.map(({ pid }) => pid), guardSessionIds)) {
        const path = validateGjcSdkTranscript(kept.binding, cwd, agentDir);
        if (path) {
          kept.indexStamp = indexStamp;
          token.cached = true;
          return path;
        }
      }
    }
    const failure = transcriptFailures.get(key);
    if (options.purpose === "status" && failure) {
      const current = platform === "win32" ? await processes(initialInfo, true) : initial;
      if (!current || current.length === 0) return forget();
      if (sameLookupContext(failure.options, options) && failure.options.purpose === options.purpose
        && checkedAt - failure.at < BINDING_TTL_MS
        && sameProcesses(current, failure.processes) && isDeepStrictEqual(failure.indexStamp, indexStamp)) {
        token.cached = true;
        if (failure.error) throw failure.error;
        return null;
      }
      if (newest(transcriptFailures)) transcriptFailures.delete(key);
      initial = current;
    }
    if (!token.cancelled) supersedeBindings(paneId, key, token.seq);
    if (newest(transcriptBindings)) transcriptBindings.delete(key);
    const pids = initial.map((process) => process.pid);
    const cacheFailure = (error: GjcSdkLookupError | null): void => {
      if (options.purpose === "status" && canCacheFailure() && newest(transcriptFailures)) {
        transcriptFailures.set(key, { options, at: now(), processes: initial, indexStamp, error, seq: token.seq });
      }
    };
    let binding: GjcSdkBinding | null;
    try {
      binding = await sdkTranscript(pids, cwd, agentDir, options.purpose);
    } catch (error) {
      if (error instanceof GjcSdkLookupError) cacheFailure(error);
      throw error;
    }
    if (binding === null) { cacheFailure(null); return null; }
    const owner = binding && initial.find((process) => process.pid === binding.pid);
    if (!binding || !owner) return null;
    const path = validateGjcSdkTranscript(binding, cwd, agentDir);
    if (!path) return null;

    const finalInfo = await readProcessInfo(paneId);
    if (!finalInfo) return null;
    const final = await processes(finalInfo, true);
    if (!final?.some((process) => process.pid === owner.pid && sameBirth(process.birth, owner.birth))) return null;
    if (indexStamp !== null && newest(transcriptBindings)) {
      for (const [other, entry] of transcriptBindings) if (checkedAt - entry.at >= BINDING_TTL_MS) transcriptBindings.delete(other);
      // aged from before the lookup, when the index stamp was read
      transcriptBindings.set(key, { options, indexStamp, processes: initial, binding, at: checkedAt, seq: token.seq });
    }
    return path;
  } catch (error) {
    // a timed-out lookup reaches the route as 504, so the chat keeps what it shows (#1295); the kept
    // binding was already dropped, since a lookup only runs once it no longer held
    if (error instanceof GjcSdkLookupError) throw error;
    return forget();
  }
}

type GjcQueryFn = (agentDir: string, sessionId: string, query: "runtime.capabilities" | "skill.list/state") => Promise<Record<string, unknown> | null>;

/** Injection points for fixtures; production passes none. */
export interface GjcNativeOptions {
  home?: string;
  platform?: string;
  now?: () => number;
  query?: GjcQueryFn;
}

/** How long one broker answer is kept, and the least time between two attempts to get one. */
const NATIVE_REFRESH_MS = 30_000;
const nativeQuery: GjcQueryFn = (agentDir, sessionId, query) => gjcSdkQuery(agentDir, sessionId, query);
const asRecord = (value: unknown): Record<string, unknown> | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
const firstPage = (response: Record<string, unknown> | null): unknown[] | null => {
  const page = asRecord(response?.page);
  return page?.complete === true && Array.isArray(page.items) ? page.items : null;
};

type NativeSkills = { sessionId: string; /** the binding the rows came from: a newer binding invalidates them */ seq: number; rows: SlashCommand[] | null; attemptedAt: number; flight?: Promise<void>; /** the pane ended: a refresh still running must not store rows */ dropped?: true };
const nativeSkills = new Map<string, NativeSkills>();

/** The binding the chat reads already hold for this pane, still inside its lifetime; never resolves one. */
function keptBindingForPane(paneId: string, home: string, platform: string, now: number): KeptBinding | null {
  let newest: KeptBinding | null = null;
  for (const [key, kept] of transcriptBindings) {
    const [pane, , keptHome, keptPlatform] = JSON.parse(key) as [string, string, string, string];
    if (pane !== paneId || keptHome !== home || keptPlatform !== platform || now - kept.at >= BINDING_TTL_MS) continue;
    if (!newest || kept.seq > newest.seq) newest = kept;
  }
  return newest;
}

/**
 * gjc's own skill list as the broker answers it (skill.list/state, offered by
 * runtime.capabilities), attach-only and read-only: the broker itself is never started. Asking it
 * means running the gjc CLI, once in the background per period per pane and only while the
 * transcript adapter holds a resolved binding for the pane; a request never waits for that run,
 * it gets what the last refresh kept. A list that is not one complete page, or any failure, keeps
 * no rows: the scan rows stay.
 */
async function refreshNativeSkills(entry: NativeSkills, agentDir: string, query: GjcQueryFn): Promise<void> {
  try {
    const [capabilities, skills] = await Promise.all([
      query(agentDir, entry.sessionId, "runtime.capabilities"),
      query(agentDir, entry.sessionId, "skill.list/state"),
    ]);
    const operations = asRecord(firstPage(capabilities)?.[0])?.operations;
    const items = firstPage(skills);
    if (!Array.isArray(operations) || !operations.includes("skill.list/state") || !items) { entry.rows = null; return; }
    const rows = new Map<string, SlashCommand>();
    for (const item of items) {
      const skill = asRecord(item);
      if (!skill || typeof skill.name !== "string" || skill.name.length > 128 || /[\s\0]/u.test(skill.name) || skill.name === "") continue;
      const name = skill.name.startsWith("skill:") ? skill.name : `skill:${skill.name}`;
      if (rows.has(name)) continue;
      rows.set(name, {
        name, description: typeof skill.description === "string" ? skill.description.slice(0, 500) : "",
        source: "skill", id: name, provenance: { transport: "native", verified: true },
      });
    }
    if (!entry.dropped) entry.rows = [...rows.values()];
  } catch { entry.rows = null; /* a broker that is absent, slow or odd leaves the scan rows */ }
}

/** The kept native skill rows of a pane (null when none) and the refresh this call started, if any. */
export function gjcNativeSkills(paneId: string, options: GjcNativeOptions = {}): { rows: SlashCommand[] | null; refreshed?: Promise<void> } {
  const home = options.home ?? process.env["HOME"] ?? "";
  const now = (options.now ?? Date.now)();
  // Windows keeps scan rows: its process table is a PowerShell round trip, far past the catalog's budget
  const kept = home && (options.platform ?? process.platform) !== "win32" ? keptBindingForPane(paneId, home, options.platform ?? process.platform, now) : null;
  // no proven binding (a pane between two proofs of the same session, or no gjc): nothing is served and nothing is dropped
  if (!kept) return { rows: null };
  let entry = nativeSkills.get(paneId);
  if (entry && entry.sessionId === kept.binding.sessionId) entry.seq = kept.seq; // the same session proven again keeps its rows
  else {
    if (entry) entry.dropped = true;
    entry = { sessionId: kept.binding.sessionId, seq: kept.seq, rows: null, attemptedAt: -Infinity };
    nativeSkills.delete(paneId);
    nativeSkills.set(paneId, entry);
    if (nativeSkills.size > 128) nativeSkills.delete(nativeSkills.keys().next().value!);
  }
  if (entry.flight || now - entry.attemptedAt < NATIVE_REFRESH_MS) return { rows: entry.rows, ...(entry.flight ? { refreshed: entry.flight } : {}) };
  // The one place a catalog request can cause a process: the gjc CLI is the only way to the broker. It never
  // waits for it, runs once per period per pane, and only while the adapter holds a live binding (above).
  entry.attemptedAt = now;
  const target = entry;
  target.flight = refreshNativeSkills(target, join(home, ".gjc", "agent"), options.query ?? nativeQuery).finally(() => { target.flight = undefined; });
  return { rows: entry.rows, refreshed: target.flight };
}

registerCatalogSource({ agent: "gjc", owns: ["skills"], rows: async (pane) => gjcNativeSkills(pane.pane_id).rows });
