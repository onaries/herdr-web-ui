import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import nodePath, { join } from "node:path";

const MAX_ANCHOR_BYTES = 64 * 1024;
const MAX_DELTA_BYTES = 256 * 1024;
const EVENT_TYPES = new Set([
  "host_registered",
  "host_heartbeat",
  "host_unregistered",
  "lifecycle_started",
  "lifecycle_terminal",
  "session_closed",
  "session_deleted",
  "record_reconciled",
]);

type FileStamp = Readonly<{
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;

export type GjcIndexStamp = Readonly<{
  log: FileStamp;
  snapshot: FileStamp | null;
}>;

function fileStamp(path: string): FileStamp | null {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile()) return null;
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

/** Capture the regular session-index log and optional compaction snapshot. */
export function captureGjcIndex(agentDir: string): GjcIndexStamp | null {
  try {
    const directory = join(agentDir, "sdk", "sessions");
    const log = fileStamp(join(directory, "index.jsonl"));
    if (log === null) return null;
    let snapshot: FileStamp | null;
    try {
      snapshot = fileStamp(join(directory, "index.snapshot.json"));
      if (snapshot === null) return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
      snapshot = null;
    }
    return { log, snapshot };
  } catch {
    return null;
  }
}

function sameFileStamp(a: FileStamp, b: FileStamp): boolean {
  return a.size === b.size && a.dev === b.dev && a.ino === b.ino
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

function sameStamp(a: GjcIndexStamp, b: GjcIndexStamp): boolean {
  return sameFileStamp(a.log, b.log)
    && (a.snapshot === null ? b.snapshot === null : b.snapshot !== null && sameFileStamp(a.snapshot, b.snapshot));
}

function readAt(fd: number, length: number, position: number): Buffer | null {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const count = readSync(fd, buffer, offset, length - offset, position + offset);
    if (count === 0) return null;
    offset += count;
  }
  return buffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function absoluteOrNull(value: unknown): boolean {
  return value === null || (typeof value === "string" && nodePath.isAbsolute(value));
}

function validIdentityShape(event: Record<string, unknown>): boolean {
  const locator = event.locator;
  if (!isRecord(locator) || !Object.hasOwn(locator, "worktreeRoot") || !Object.hasOwn(locator, "stateRoot")
    || typeof locator.cwd !== "string" || !nodePath.isAbsolute(locator.cwd)
    || !absoluteOrNull(locator.worktreeRoot) || !absoluteOrNull(locator.stateRoot)) return false;
  return nonEmptyString(event.hostIncarnation)
    && nonEmptyString(event.processIncarnation)
    && typeof event.endpointGeneration === "number"
    && Number.isSafeInteger(event.endpointGeneration) && event.endpointGeneration >= 0
    && typeof event.ts === "number" && Number.isFinite(event.ts);
}

function parseEvent(line: Buffer): Record<string, unknown> | null {
  const text = line.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(line)) return null;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (!isRecord(value) || typeof value.checksum !== "string") return null;
  const unsigned = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "checksum"));
  const expected = createHash("sha256").update(JSON.stringify(unsigned)).digest("hex");
  if (value.checksum !== expected || value.version !== 4
    || typeof value.type !== "string" || !EVENT_TYPES.has(value.type)
    || typeof value.indexSeq !== "number" || !Number.isSafeInteger(value.indexSeq) || value.indexSeq <= 0
    || !validIdentityShape(value)) return null;
  return value;
}

function lastCompleteRow(fd: number, previousSize: number): Buffer | null {
  if (previousSize <= 0) return null;
  const length = Math.min(previousSize, MAX_ANCHOR_BYTES + 2);
  const suffix = readAt(fd, length, previousSize - length);
  if (!suffix || suffix.length === 0 || suffix[suffix.length - 1] !== 0x0a) return null;
  const separator = suffix.lastIndexOf(0x0a, suffix.length - 2);
  const start = separator + 1;
  if (separator < 0 && previousSize !== suffix.length) return null;
  const row = suffix.subarray(start, suffix.length - 1);
  return row.length > 0 && row.length <= MAX_ANCHOR_BYTES ? row : null;
}

/**
 * Upstream v0.18.9 session-index.ts reduceEvents/projectIdentity keeps heartbeat activity
 * separate from identity; only validated unrelated heartbeat appends preserve a proven binding.
 */
export function gjcIndexUnchanged(
  agentDir: string,
  previous: GjcIndexStamp,
  current: GjcIndexStamp,
  pids: readonly number[],
  guardSessionIds: readonly string[],
): boolean {
  if (sameStamp(previous, current)) return true;
  if (previous.snapshot === null ? current.snapshot !== null
    : current.snapshot === null || !sameFileStamp(previous.snapshot, current.snapshot)) return false;
  if (previous.log.dev !== current.log.dev || previous.log.ino !== current.log.ino) return false;
  const growth = current.log.size - previous.log.size;
  if (growth <= 0n || growth > BigInt(MAX_DELTA_BYTES)
    || previous.log.size > BigInt(Number.MAX_SAFE_INTEGER)
    || current.log.size > BigInt(Number.MAX_SAFE_INTEGER)) return false;

  let fd: number | undefined;
  try {
    const logPath = join(agentDir, "sdk", "sessions", "index.jsonl");
    const nonblocking = process.platform === "win32" ? 0 : (constants.O_NONBLOCK ?? 0);
    fd = openSync(logPath, constants.O_RDONLY | nonblocking);
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || !sameFileStamp(before, current.log)) return false;

    const previousSize = Number(previous.log.size);
    const deltaSize = Number(growth);
    const anchorRow = lastCompleteRow(fd, previousSize);
    const anchor = anchorRow && parseEvent(anchorRow);
    if (!anchor) return false;
    const delta = readAt(fd, deltaSize, previousSize);
    if (!delta || delta.length === 0 || delta[delta.length - 1] !== 0x0a) return false;
    const deltaText = delta.toString("utf8");
    if (!Buffer.from(deltaText, "utf8").equals(delta)) return false;
    const lines = deltaText.split("\n");
    if (lines.pop() !== "" || lines.length === 0) return false;

    const wantedPids = new Set(pids);
    const guardedSessions = new Set(guardSessionIds);
    let sequence = anchor.indexSeq as number;
    for (const line of lines) {
      if (line === "") return false;
      const event = parseEvent(Buffer.from(line, "utf8"));
      if (!event || event.type !== "host_heartbeat"
        || !nonEmptyString(event.sessionId)
        || guardedSessions.has(event.sessionId)
        || typeof event.pid !== "number" || !Number.isSafeInteger(event.pid) || event.pid <= 0
        || wantedPids.has(event.pid)
        || sequence === Number.MAX_SAFE_INTEGER || event.indexSeq !== sequence + 1) return false;
      sequence = event.indexSeq as number;
    }

    if (!sameFileStamp(fstatSync(fd, { bigint: true }), current.log)) return false;
    closeSync(fd);
    fd = undefined;
    const after = captureGjcIndex(agentDir);
    return after !== null && sameStamp(after, current);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* failed reads are already rejected */ }
    }
  }
}
