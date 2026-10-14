/** Agy's append-only step ledger, reduced in physical order before shared paging. */
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ConversationPart, ConversationTurn } from "../shared/protocol.ts";
import { trimOutput } from "./tool-output.ts";
import { toolSummary } from "./transcript-records.ts";

const MAX_ENTRIES = 100_000;
const MAX_LINE = 16 * 1024 * 1024;
const SCAN_BYTES = 32 * 1024 * 1024;
const hash = (value: string): string => createHash("sha256").update(value).digest("base64url");
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export class AgyUnavailable extends Error { constructor() { super("Agy history is unavailable"); } }
interface Step { index: number; start: number; end: number; type: string; status: string; digest: string; activity?: "working" | "idle" }
interface Index { identity: string; size: number; changed: string; scanned: number; revision: string; steps: Step[]; visible: Step[]; retired: Set<number> }
const indexes = new Map<string, Index>();
export function forgetAgyState(path?: string): void { if (path === undefined) indexes.clear(); else indexes.delete(path); }

/** The catalog beside this resolved native ledger; also watched for saved rewinds. */
export function agyDatabasePath(path: string): string {
  const sessionDir = dirname(dirname(dirname(path)));
  return join(dirname(dirname(sessionDir)), "conversations", `${basename(sessionDir)}.db`);
}

/** The database supplies only the active indices, never payloads or guessed numeric statuses. */
export function agyCatalog(path: string): Set<number> {
  const dbPath = agyDatabasePath(path);
  let db: Database | undefined;
  try {
    if (realpathSync(dbPath) !== dbPath) throw new AgyUnavailable();
    db = new Database(dbPath, { readonly: true });
    db.exec("PRAGMA busy_timeout = 100");
    const rows = db.query<{ idx: number }, []>(`SELECT idx FROM steps ORDER BY idx LIMIT ${MAX_ENTRIES + 1}`).all();
    if (rows.length > MAX_ENTRIES || rows.some((row) => !Number.isSafeInteger(row.idx) || row.idx < 0)) throw new AgyUnavailable();
    return new Set(rows.map((row) => row.idx));
  } catch { throw new AgyUnavailable(); }
  finally { db?.close(); }
}

function entry(line: string): Record<string, unknown> {
  let value: Record<string, unknown>;
  try { value = record(JSON.parse(line)); } catch { throw new AgyUnavailable(); }
  if (!Number.isSafeInteger(value.step_index) || (value.step_index as number) < 0 || typeof value.type !== "string") throw new AgyUnavailable();
  return value;
}

export interface AgyProjection { segments: { start: number; end: number }[]; promptStarts: number[]; revision: string; indices: number[]; activity: "working" | "idle" }
export function agyProjection(path: string, fd: number): AgyProjection {
  const stat = fstatSync(fd);
  const identity = `${stat.dev}:${stat.ino}`;
  const changed = `${stat.mtimeMs}:${stat.ctimeMs}`;
  let index = indexes.get(path);
  if (!index || index.identity !== identity || stat.size < index.size || (stat.size === index.size && changed !== index.changed)) {
    index = { identity, size: stat.size, changed, scanned: 0, revision: randomUUID(), steps: [], visible: [], retired: new Set() };
  }
  index.size = stat.size; index.changed = changed;
  indexes.delete(path); indexes.set(path, index);
  if (indexes.size > 16) indexes.delete(indexes.keys().next().value!);
  let position = index.scanned;
  let carry: Buffer[] = [];
  let carried = 0;
  const end = Math.min(stat.size, position + SCAN_BYTES);
  while (position < end) {
    const chunk = Buffer.alloc(Math.min(64 * 1024, end - position));
    const read = readSync(fd, chunk, 0, chunk.length, position);
    if (!read) throw new AgyUnavailable();
    const bytes = chunk.subarray(0, read);
    let start = 0;
    for (let newline = bytes.indexOf(10); newline !== -1; newline = bytes.indexOf(10, start)) {
      if (carried + newline - start > MAX_LINE) throw new AgyUnavailable();
      const line = (carried ? Buffer.concat([...carry, bytes.subarray(start, newline)]) : bytes.subarray(start, newline)).toString("utf8");
      const lineStart = position + start - carried;
      const lineEnd = position + newline + 1;
      carry = []; carried = 0;
      const value = entry(line);
      const number = value.step_index as number;
      if (index.steps.length && number <= index.steps.at(-1)!.index) {
        while (index.steps.length && index.steps.at(-1)!.index >= number) index.steps.pop();
      }
      // DONE completes one exported step, not the turn. In the native 1.3.3 trace,
      // a planner response with tools continues work; its tool-free answer ends it.
      // Reasoning is exported after the planner finishes, so it cannot prove Thinking.
      const activity = value.status !== "DONE" ? undefined
        : value.type === "USER_INPUT" ? "working"
        : value.type === "PLANNER_RESPONSE"
          ? (Array.isArray(value.tool_calls) && value.tool_calls.length > 0) || typeof value.content !== "string" || !value.content.trim() ? "working" : "idle"
          : undefined;
      index.steps.push({ index: number, start: lineStart, end: lineEnd, type: value.type as string, status: String(value.status ?? ""), digest: hash(line), activity });
      if (index.steps.length > MAX_ENTRIES) throw new AgyUnavailable();
      index.scanned = lineEnd;
      start = newline + 1;
    }
    if (start < bytes.length) { carry.push(bytes.subarray(start)); carried += bytes.length - start; }
    if (carried > MAX_LINE) throw new AgyUnavailable();
    position += read;
  }
  if (position < stat.size) throw new AgyUnavailable();
  const catalog = agyCatalog(path);
  // Native idle rewind updates the DB before any replacement ledger lines arrive.
  // DB-only steps are normal; equality or a strict prefix would reject healthy logs.
  const physicalStarts = new Set(index.steps.map((step) => step.start));
  for (const start of index.retired) if (!physicalStarts.has(start)) index.retired.delete(start);
  // Once the active DB removed a displayed step, its old bytes cannot return merely
  // because the replacement DB row precedes the replacement export. Never-published
  // lagging steps remain eligible. The set is bounded by the active physical index.
  for (const step of index.visible) if (!catalog.has(step.index) && physicalStarts.has(step.start)) index.retired.add(step.start);
  const retained = index.steps.filter((step) => catalog.has(step.index) && !index.retired.has(step.start));
  const visible = retained.at(-1)?.status !== "DONE" ? retained.slice(0, -1) : retained;
  // A DB snapshot can lag an exported append. Keep the physical index intact so the
  // next poll can admit it. Only changes to already published spans invalidate paging.
  if (index.visible.some((step, at) => visible[at]?.start !== step.start || visible[at]?.end !== step.end)) index.revision = randomUUID();
  index.visible = visible;
  const segments: AgyProjection["segments"] = [];
  const promptStarts: number[] = [], indices: number[] = [];
  let length = 0;
  let activity: AgyProjection["activity"] = "idle";
  for (const step of visible) {
    if (step.activity !== undefined) activity = step.activity;
    indices.push(step.index);
    if (step.type === "USER_INPUT" && step.status === "DONE") promptStarts.push(length);
    const previous = segments.at(-1);
    if (previous?.end === step.start) previous.end = step.end;
    else segments.push({ start: step.start, end: step.end });
    length += step.end - step.start;
  }
  return { segments, promptStarts, revision: index.revision, indices, activity };
}

/** Keep one fd through projection and page reads, and reject a cut during the read. */
export function withAgyHistory<T>(path: string, read: (projection: AgyProjection, fd: number) => T): T {
  const fd = openSync(path, "r");
  try {
    if (realpathSync(path) !== path) throw new AgyUnavailable();
    const before = fstatSync(fd);
    const projection = agyProjection(path, fd);
    const result = read(projection, fd);
    const after = statSync(path), pinned = fstatSync(fd);
    const current = agyCatalog(path);
    if (before.dev !== after.dev || before.ino !== after.ino || pinned.size < before.size
      || (pinned.size === before.size && (pinned.mtimeMs !== before.mtimeMs || pinned.ctimeMs !== before.ctimeMs))
      || projection.indices.some((index) => !current.has(index))) throw new AgyUnavailable();
    return result;
  } finally { closeSync(fd); }
}

function userText(text: string): string {
  if (!text.startsWith("<USER_REQUEST>")) return text;
  const end = text.lastIndexOf("</USER_REQUEST>");
  if (end < 0) return text;
  const suffix = text.slice(end + "</USER_REQUEST>".length);
  if (!/^\s*<(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>/.test(suffix)) return text;
  return text.slice("<USER_REQUEST>".length, end).replace(/^\n|\n$/g, "");
}
function outputRef(path: string, step: Step): string {
  const index = indexes.get(path)!;
  return `agy:${hash(JSON.stringify([path, index.identity, index.revision, step.start, step.digest]))}`;
}
export function parseAgyTranscript(text: string, path?: string): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  const steps = path ? new Map(indexes.get(path)?.visible.map((step) => [step.index, step])) : undefined;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const value = entry(line);
    if (value.status !== "DONE") continue;
    const content = typeof value.content === "string" ? value.content : "";
    const ts = typeof value.created_at === "string" ? value.created_at : null;
    if (value.type === "USER_INPUT") { turns.push({ role: "user", ts, parts: [{ kind: "text", text: userText(content) }] }); continue; }
    if (value.type !== "PLANNER_RESPONSE" && value.type !== "GENERIC") continue;
    const parts: ConversationPart[] = [];
    if (value.type === "GENERIC") {
      if (!content) continue;
      // Native exports provide no call ID. Keep this result independent of planner calls.
      const part: Extract<ConversationPart, { kind: "tool" }> = { kind: "tool", name: "Tool output", summary: `Step ${value.step_index}`, input: "", output: "" };
      const step = steps?.get(value.step_index as number);
      trimOutput(part, content, path && step ? outputRef(path, step) : `agy:${hash(line)}`);
      parts.push(part);
    } else {
      if (content) parts.push({ kind: "text", text: content });
      for (const call of Array.isArray(value.tool_calls) ? value.tool_calls : []) {
        const tool = record(call), input = record(tool.args);
        if (typeof tool.name !== "string") continue;
        const mapped = { ...input, command: input.CommandLine, file_path: input.AbsolutePath ?? input.TargetFile };
        parts.push({ kind: "tool", name: tool.name, summary: toolSummary(tool.name, mapped), input: JSON.stringify(input), output: "" });
      }
    }
    if (!parts.length) continue;
    const previous = turns.at(-1);
    if (previous?.role === "assistant") { previous.parts.push(...parts); previous.end_ts = ts ?? undefined; }
    else turns.push({ role: "assistant", ts, end_ts: ts ?? undefined, parts });
  }
  return turns;
}

export function agyToolOutput(path: string, ref: string): string | null {
  if (!/^agy:[A-Za-z0-9_-]{43}$/.test(ref)) return null;
  try {
    return withAgyHistory(path, (projection, fd) => {
      const visible = new Set(projection.indices);
      for (const step of indexes.get(path)!.visible) {
        if (step.type !== "GENERIC" || !visible.has(step.index) || outputRef(path, step) !== ref) continue;
        const bytes = Buffer.alloc(step.end - step.start);
        if (readSync(fd, bytes, 0, bytes.length, step.start) !== bytes.length) return null;
        const value = entry(bytes.toString("utf8"));
        const text = typeof value.content === "string" ? value.content : "";
        return text.length > 2_000_000 ? `${text.slice(0, 2_000_000)}\n… trimmed` : text;
      }
      return null;
    });
  } catch { return null; }
}
