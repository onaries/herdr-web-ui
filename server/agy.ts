/** Antigravity CLI 1.3 stores gemini_coder.Step protobufs in a per-conversation SQLite database. */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { closeSync, openSync, readlinkSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ConversationMetadata, ConversationPart, ConversationTurn } from "../shared/protocol.ts";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BYTES = 64 * 1024 * 1024;
const PAGE_PROMPTS = 20;

function agyAccountStores(): string[] {
  const accountsRoot = join(homedir(), ".local", "share", "agy-accounts");
  try {
    return readdirSync(accountsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(accountsRoot, entry.name, ".gemini", "antigravity-cli", "conversations"));
  } catch { return []; }
}

export function agyTranscriptPath(id: string, store?: string): string | null {
  if (!SESSION_ID.test(id)) return null;
  const storeCandidates = store !== undefined
    ? [store]
    : [join(homedir(), ".gemini", "antigravity-cli", "conversations"), ...agyAccountStores()];
  for (const candidate of storeCandidates) {
    try {
      const root = realpathSync(candidate);
      const path = realpathSync(join(root, `${id}.db`));
      if (dirname(path) === root && statSync(path).isFile()) return path;
    } catch { continue; }
  }
  return null;
}

/** Resumed agy sessions may omit the terminal session report; its own open log names them. */
export function agySessionFromPids(pids: readonly number[], procRoot = "/proc"): string | null {
  for (const pid of pids) {
    if (!Number.isInteger(pid) || pid <= 0) continue;
    let fds: string[];
    try { fds = readdirSync(join(procRoot, String(pid), "fd")); } catch { continue; }
    for (const fd of fds) {
      let file: number | undefined;
      try {
        const log = readlinkSync(join(procRoot, String(pid), "fd", fd));
        if (!/\/antigravity-cli\/log\/cli-[^/]+\.log$/.test(log)) continue;
        file = openSync(log, "r");
        const size = statSync(log).size;
        const bytes = Buffer.alloc(Math.min(size, 64 * 1024));
        const length = readSync(file, bytes, 0, bytes.length, size - bytes.length);
        const lines = bytes.subarray(0, length).toString("utf8").split("\n");
        for (const line of lines.reverse()) {
          const id = /(?:Streaming conversation|Starting conversation update stream for) ([0-9a-f-]{36})(?:\s|$)/i.exec(line)?.[1];
          if (id) return agyTranscriptPath(id, join(dirname(dirname(log)), "conversations"));
        }
      } catch { continue; }
      finally { if (file !== undefined) closeSync(file); }
    }
  }
  return null;
}

interface Field { number: number; value: number | Uint8Array }

/** Only the wire types Step uses. Unknown fields are skipped, never interpreted as text. */
function fields(bytes: Uint8Array): Field[] {
  let offset = 0;
  const varint = (): number => {
    let value = 0;
    for (let shift = 0; shift < 70; shift += 7) {
      if (offset >= bytes.length) throw new Error("truncated agy protobuf");
      const byte = bytes[offset++]!;
      value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) return value;
    }
    throw new Error("invalid agy protobuf varint");
  };
  const result: Field[] = [];
  while (offset < bytes.length) {
    const tag = varint();
    const number = Math.floor(tag / 8);
    const wire = tag % 8;
    if (number === 0) throw new Error("invalid agy protobuf tag");
    if (wire === 0) result.push({ number, value: varint() });
    else if (wire === 2 || wire === 1 || wire === 5) {
      const size = wire === 2 ? varint() : wire === 1 ? 8 : 4;
      if (!Number.isSafeInteger(size) || size < 0 || offset + size > bytes.length) throw new Error("truncated agy protobuf field");
      if (wire === 2) result.push({ number, value: bytes.subarray(offset, offset + size) });
      offset += size;
    } else throw new Error("unsupported agy protobuf wire type");
  }
  return result;
}

const block = (message: Field[], number: number): Uint8Array => {
  const value = message.find((field) => field.number === number)?.value;
  return value instanceof Uint8Array ? value : new Uint8Array();
};
const text = (message: Field[], number: number): string => Buffer.from(block(message, number)).toString("utf8");
const nested = (message: Field[], number: number): Field[] => fields(block(message, number));

function timestamp(metadata: Field[], number: number): string | null {
  const stamp = nested(metadata, number);
  const seconds = stamp.find((field) => field.number === 1)?.value;
  const nanos = stamp.find((field) => field.number === 2)?.value;
  if (typeof seconds !== "number") return null;
  const date = new Date(seconds * 1000 + (typeof nanos === "number" ? nanos / 1_000_000 : 0));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export interface AgyStep { idx: number; step_type: number; status: number; step_format: number; step_payload: Uint8Array }
type ToolPart = Extract<ConversationPart, { kind: "tool" }>;

function toolResult(message: Field[]): { output: string; error: boolean } {
  const result = nested(nested(message, 140), 2);
  const payload = nested(result, 6);
  if (text(payload, 1) !== "type.googleapis.com/gemini_coder.Step") return { output: text(result, 1), error: false };
  const step = nested(payload, 2);
  const command = nested(step, 28);
  if (command.length) {
    const combined = nested(command, 21);
    const snapshot = nested(command, 26);
    const stdout = nested(command, 19);
    const stderr = nested(command, 20);
    const exit = command.find((field) => field.number === 6)?.value;
    const output = text(combined, 1) || text(snapshot, 1) || text(combined, 2) || text(snapshot, 2)
      || [text(stdout, 1) || text(stdout, 2), text(stderr, 1) || text(stderr, 2)].filter(Boolean).join("\n") || text(result, 1);
    return { output, error: typeof exit === "number" && exit !== 0 };
  }
  const file = nested(step, 14);
  return { output: text(file, 9) || text(file, 4) || text(result, 1), error: false };
}

/** UserResponse appears again in items; read it once, and never promote system context to user input. */
export function parseAgySteps(steps: AgyStep[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  const tools = new Map<string, ToolPart>();
  for (const step of steps) {
    if (step.step_format !== 0) throw new Error("unsupported agy step format");
    const message = fields(step.step_payload);
    const metadata = nested(message, 5);
    const ts = timestamp(metadata, 1);
    if (step.step_type === 14) {
      const user = nested(message, 19);
      const response = text(user, 2) || user.filter((field) => field.number === 3 && field.value instanceof Uint8Array)
        .map((field) => text(fields(field.value as Uint8Array), 1)).join("\n") || text(user, 1);
      if (response) turns.push({ role: "user", ts, parts: [{ kind: "text", text: response }] });
      continue;
    }
    if (step.step_type !== 15 && step.step_type !== 132) continue;
    let turn = turns.at(-1);
    if (turn?.role !== "assistant") {
      turn = { role: "assistant", ts, parts: [] };
      turns.push(turn);
    }
    const end = timestamp(metadata, 8);
    if (end) turn.end_ts = end;
    if (step.step_type === 15) {
      const answer = nested(message, 20);
      const thinking = text(answer, 16) || text(answer, 3);
      if (thinking) turn.parts.push({ kind: "thinking", text: thinking });
      const response = text(answer, 8) || text(answer, 1);
      if (response) turn.parts.push({ kind: "text", text: response });
      for (const field of answer) {
        if (field.number !== 7 || !(field.value instanceof Uint8Array)) continue;
        const call = fields(field.value);
        const id = text(call, 1);
        const name = text(call, 2);
        const input = text(call, 3);
        const tool: ToolPart = { kind: "tool", name, summary: input.slice(0, 160), input, output: "" };
        turn.parts.push(tool);
        if (id) tools.set(id, tool);
      }
    } else {
      const call = nested(metadata, 4);
      const id = text(call, 1);
      let tool = tools.get(id);
      if (!tool) {
        const input = text(call, 3);
        tool = { kind: "tool", name: text(call, 2), summary: input.slice(0, 160), input, output: "" };
        turn.parts.push(tool);
        if (id) tools.set(id, tool);
      }
      const { output, error } = toolResult(message);
      tool.output = output.slice(0, 24_000);
      if (output.length > 24_000 && id) { tool.output_ref = id; tool.output_size = output.length; }
      if (error) tool.error = true;
    }
  }
  return turns.filter((turn) => turn.parts.length > 0);
}

export class AgyHistoryChanged extends Error {}

export function agyToolOutput(path: string, id: string): string | null {
  const db = new Database(path, { readonly: true });
  try {
    const rows = db.query<AgyStep, []>("SELECT idx,step_type,status,step_format,step_payload FROM steps WHERE step_type=132 ORDER BY idx DESC").iterate();
    for (const row of rows) {
      if (row.step_format !== 0 || row.step_payload.length > MAX_BYTES) continue;
      const message = fields(row.step_payload);
      if (text(nested(nested(message, 5), 4), 1) === id) return toolResult(message).output.slice(0, 2_000_000);
    }
    return null;
  } finally { db.close(); }
}

/** SQLite snapshots include the WAL; a main-file stat alone would permanently cache live appends. */
export function agyConversation(path: string, page: { before?: string; since?: string; from?: string } = {}) {
  const db = new Database(path, { readonly: true });
  try {
    return db.transaction(() => {
      const stat = statSync(path);
      const meta = db.query<{ trajectory_id: string; cascade_id: string }, []>("SELECT trajectory_id, cascade_id FROM trajectory_meta LIMIT 1").get();
      if (!meta) throw new Error("missing agy trajectory");
      const history_id = `agy:${meta.trajectory_id}:${meta.cascade_id}:${stat.dev}:${stat.ino}`;
      const cursor = (index: number): string => `${history_id}:${index}`;
      const indexOf = (value: string | undefined): number | undefined => {
        if (value === undefined) return undefined;
        const suffix = value.slice(history_id.length + 1);
        if (!value.startsWith(`${history_id}:`) || !/^\d+$/.test(suffix)) throw new AgyHistoryChanged();
        const index = Number(suffix);
        if (!Number.isSafeInteger(index)) throw new AgyHistoryChanged();
        return index;
      };
      const before = indexOf(page.before);
      const since = indexOf(page.since);
      const from = indexOf(page.from);
      const prompts = db.query<{ idx: number }, []>("SELECT idx FROM steps WHERE step_type=14 ORDER BY idx").all().map((row) => row.idx);
      for (const index of [before, since, from]) {
        if (index !== undefined && !prompts.includes(index)) throw new AgyHistoryChanged();
      }
      const eligible = prompts.filter((index) => (before === undefined || index < before) && (since === undefined || index >= since));
      const start = before !== undefined ? eligible[Math.max(0, eligible.length - PAGE_PROMPTS)]
        : from ?? (since !== undefined ? eligible[0] : prompts[Math.max(0, prompts.length - PAGE_PROMPTS)]);
      const lo = start ?? 0;
      const hi = before ?? Number.MAX_SAFE_INTEGER;
      const total = db.query<{ bytes: number }, [number, number]>("SELECT coalesce(sum(length(step_payload)),0) AS bytes FROM steps WHERE idx>=? AND idx<?").get(lo, hi)!;
      if (total.bytes > MAX_BYTES) throw new Error("agy conversation page too large");
      const steps = db.query<AgyStep, [number, number]>("SELECT idx,step_type,status,step_format,step_payload FROM steps WHERE idx>=? AND idx<? ORDER BY idx").all(lo, hi);
      const model = db.query<{ data: Uint8Array }, []>("SELECT data FROM gen_metadata ORDER BY idx DESC LIMIT 1").get();
      const metadata: ConversationMetadata = { model: model ? text(nested(fields(model.data), 1), 19) || null : null, reasoning_effort: null };
      const hash = createHash("sha256").update(history_id).update(JSON.stringify(metadata));
      for (const step of steps) hash.update(`${step.idx}:${step.status}:${step.step_format}:`).update(step.step_payload);
      return { source: "agy-transcript" as const, turns: parseAgySteps(steps), metadata,
        cursor: lo > (prompts[0] ?? 0) ? cursor(lo) : null, history_id, version: `"${hash.digest("hex")}"` };
    })();
  } finally { db.close(); }
}
