/**
 * dsh-tui (DeepSeek Harness) writes one zstd-compressed JSONL session per directory:
 * `<DSH_HOME>/sessions/<cwd-slug>/<session-uuid>/session.v*.jsonl.zstd`, records shaped
 * `{ type, seq, time, data }`. Parked sessions stay open, but the TUI rebinds its
 * injection socket to the attached session. Only the pane's own socket descriptors
 * identify that session; file mtimes and the cross-process resume marker cannot.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import type { ConversationMetadata, ConversationPart, ConversationTurn } from "../shared/protocol.ts";

const SESSION_FILE = /^session\.v\d+\.jsonl\.zstd$/;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BYTES = 64 * 1024 * 1024;
const PAGE_PROMPTS = 20;
const OUTPUT_MAX = 24_000;
const TOOL_OUTPUT_MAX = 2_000_000;

export function dshHome(env: NodeJS.ProcessEnv = process.env): string {
  return env["DSH_HOME"]?.trim() || join(homedir(), ".dsh");
}

/**
 * The current injection listener follows dsh's channel binding, unlike parked file handles.
 * Older TUIs without that listener are usable only when their descriptors name one session.
 */
export function dshSessionFromPids(pids: readonly number[], home = dshHome(), injectDir = join(process.env["HOME"] || homedir(), ".dsh-tui", "inject")): string | null {
  const root = join(home, "sessions");
  const paths = new Set<string>();
  for (const pid of pids) {
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const sockets = new Set<string>();
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let target: string;
      try {
        target = readlinkSync(`/proc/${pid}/fd/${fd}`);
      } catch {
        continue;
      }
      const socket = /^socket:\[(\d+)\]$/.exec(target);
      if (socket?.[1]) sockets.add(socket[1]);
      // /proc appends " (deleted)" to an unlinked target; that is not a live session.
      if (!/\/session\.(lock|v\d+\.jsonl\.zstd)$/.test(target)) continue;
      const directory = dirname(target);
      if (!directory.startsWith(`${root}/`)) continue;
      let names: string[];
      try {
        names = readdirSync(directory);
      } catch {
        continue;
      }
      const file = names.filter((name) => SESSION_FILE.test(name)).sort().at(-1);
      if (!file) continue;
      try {
        if (statSync(join(directory, file)).isFile()) paths.add(join(directory, file));
      } catch {
        continue;
      }
    }
    const attached = new Set<string>();
    try {
      for (const line of readFileSync(`/proc/${pid}/net/unix`, "utf8").split("\n").slice(1)) {
        const entry = /^\S+\s+\S+\s+\S+\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(.+)$/.exec(line.trim());
        if (!entry || entry[1] !== "00010000" || entry[2] !== "0001" || entry[3] !== "01" || !entry[4] || !sockets.has(entry[4])) continue;
        const socketPath = entry[5];
        if (!socketPath) continue;
        const sessionId = basename(socketPath, ".sock");
        if (dirname(socketPath) === injectDir && socketPath.endsWith(".sock") && SESSION_ID.test(sessionId)) attached.add(sessionId);
      }
    } catch {
      // No socket evidence: only an unambiguous legacy file binding is safe.
    }
    if (attached.size > 1) return null;
    const sessionId = attached.values().next().value;
    if (sessionId) return dshTranscriptPath(sessionId, home);
  }
  return paths.size === 1 ? paths.values().next().value ?? null : null;
}

export function dshTranscriptPath(id: string, home = dshHome()): string | null {
  if (!SESSION_ID.test(id)) return null;
  const store = join(home, "sessions");
  let slugs: string[];
  try {
    slugs = readdirSync(store);
  } catch {
    return null;
  }
  for (const slug of slugs) {
    const directory = join(store, slug, id);
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch {
      continue;
    }
    const file = names.filter((name) => SESSION_FILE.test(name)).sort().at(-1);
    if (!file) continue;
    try {
      if (statSync(join(directory, file)).isFile()) return join(directory, file);
    } catch {
      continue;
    }
  }
  return null;
}

interface SessionRecord {
  seq: number;
  type: string;
  time: number | null;
  /** The header record carries its session id at the top level, every other record under `data`. */
  id: string | null;
  data: Record<string, unknown>;
  raw: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);
const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const iso = (ms: number | null): string | null => {
  if (ms === null) return null;
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

/** The assistant's prose and reasoning; tool-call blocks are read by the caller. */
function textBlocks(content: unknown): { text: string[]; thinking: string[] } {
  const text: string[] = [];
  const thinking: string[] = [];
  if (!Array.isArray(content)) return { text, thinking };
  for (const block of content) {
    if (!isObject(block)) continue;
    const value = asString(block["text"]);
    if (!value) continue;
    if (block["type"] === "text") text.push(value);
    else if (block["type"] === "reasoning") thinking.push(value);
  }
  return { text, thinking };
}

type ToolPart = Extract<ConversationPart, { kind: "tool" }>;

function toolPart(name: string, input: string): ToolPart {
  return { kind: "tool", name, summary: input.slice(0, 160), input, output: "" };
}

export class DshHistoryChanged extends Error {}

/**
 * The ref a truncated card hands out. A dsh call id carries a `|` that the tool-output route's
 * own ref guard rejects, so the card names the call by digest and the reader matches it back.
 */
export function dshOutputRef(callId: string): string {
  return createHash("sha256").update(callId).digest("hex").slice(0, 32);
}

export interface DshTurn extends ConversationTurn {
  /** Where the turn starts in the record stream; a page boundary is one of these. */
  startSeq: number;
}

export function parseDshRecords(records: SessionRecord[]): { turns: DshTurn[]; contextUsed: number | null } {
  const turns: DshTurn[] = [];
  const tools = new Map<string, ToolPart>();
  let contextUsed: number | null = null;

  const assistantTurn = (record: SessionRecord): DshTurn => {
    const previous = turns.at(-1);
    if (previous?.role === "assistant") return previous;
    const turn: DshTurn = { role: "assistant", ts: iso(record.time), parts: [], startSeq: record.seq };
    turns.push(turn);
    return turn;
  };

  for (const record of records) {
    const ts = iso(record.time);
    switch (record.type) {
      case "user/message": {
        // Runtime context and other injections sit in the user's seat without anyone typing them.
        const source = isObject(record.data["source"]) ? record.data["source"] : {};
        if (asString(source["kind"]) !== "user") continue;
        const body = textBlocks(record.data["content"]).text.join("\n").trim();
        if (!body) continue;
        turns.push({ role: "user", ts, parts: [{ kind: "text", text: body }], startSeq: record.seq });
        continue;
      }
      case "assistant/message": {
        const message = isObject(record.data["message"]) ? record.data["message"] : {};
        const content = Array.isArray(message["content"]) ? message["content"] : [];
        const { thinking } = textBlocks(content);
        const parts: ConversationPart[] = thinking.map((value) => ({ kind: "thinking" as const, text: value }));
        for (const block of content) {
          if (!isObject(block)) continue;
          if (block["type"] === "text") {
            const value = asString(block["text"]);
            if (value) parts.push({ kind: "text", text: value });
          } else if (block["type"] === "tool-call") {
            const id = asString(block["id"]);
            const part = toolPart(asString(block["name"]) ?? "tool", asString(block["arguments"]) ?? "");
            parts.push(part);
            if (id) tools.set(id, part);
          }
        }
        if (!parts.length) continue;
        const turn = assistantTurn(record);
        turn.parts.push(...parts);
        if (ts) turn.end_ts = ts;
        const usage = isObject(record.data["usage"]) ? record.data["usage"] : null;
        const total = usage ? asNumber(usage["totalTokens"]) : null;
        if (total !== null) contextUsed = total;
        continue;
      }
      case "tool/call": {
        // The call the assistant message already declared; only one it omitted starts its own card.
        const id = asString(record.data["callId"]);
        if (id && tools.has(id)) continue;
        const part = toolPart(asString(record.data["name"]) ?? "tool", asString(record.data["arguments"]) ?? "");
        assistantTurn(record).parts.push(part);
        if (id) tools.set(id, part);
        continue;
      }
      case "tool/result": {
        const message = isObject(record.data["message"]) ? record.data["message"] : {};
        const id = asString(message["toolCallId"]);
        let part = id ? tools.get(id) : undefined;
        if (!part) {
          part = toolPart("tool", "");
          assistantTurn(record).parts.push(part);
          if (id) tools.set(id, part);
        }
        const output = textBlocks(message["content"]).text.join("\n");
        part.output = output.slice(0, OUTPUT_MAX);
        if (id && output.length > OUTPUT_MAX) {
          part.output_ref = dshOutputRef(id);
          part.output_size = output.length;
        }
        if (message["isError"] === true) part.error = true;
        const turn = assistantTurn(record);
        if (ts) turn.end_ts = ts;
        continue;
      }
      default:
        // session/title, request/*, system/message, turn|step boundaries and the policy records
        // describe the run rather than the conversation, so they add no turn and no part.
        continue;
    }
  }
  return { turns: turns.filter((turn) => turn.parts.length > 0), contextUsed };
}

function pageOf(records: SessionRecord[], page: { before?: string; since?: string; from?: string }, path: string) {
  const header = records.find((record) => record.type === "session");
  const sessionId = header?.id ?? asString(header?.data["id"]);
  if (!sessionId) throw new Error("missing dsh session header");
  const stat = statSync(path);
  const history_id = `dsh:${sessionId}:${stat.dev}:${stat.ino}`;
  const indexOf = (value: string | undefined): number | undefined => {
    if (value === undefined) return undefined;
    const suffix = value.slice(history_id.length + 1);
    if (!value.startsWith(`${history_id}:`) || !/^\d+$/.test(suffix)) throw new DshHistoryChanged();
    const index = Number(suffix);
    if (!Number.isSafeInteger(index)) throw new DshHistoryChanged();
    return index;
  };

  const { turns, contextUsed } = parseDshRecords(records);
  const prompts = turns.filter((turn) => turn.role === "user").map((turn) => turn.startSeq);
  const before = indexOf(page.before);
  const since = indexOf(page.since);
  const from = indexOf(page.from);
  for (const index of [before, since, from]) {
    if (index !== undefined && !prompts.includes(index)) throw new DshHistoryChanged();
  }
  const eligible = prompts.filter((index) => (before === undefined || index < before) && (since === undefined || index >= since));
  const start = before !== undefined ? eligible[Math.max(0, eligible.length - PAGE_PROMPTS)]
    : from ?? (since !== undefined ? eligible[0] : prompts[Math.max(0, prompts.length - PAGE_PROMPTS)]);
  const lo = start ?? 0;
  const hi = before ?? Number.MAX_SAFE_INTEGER;

  const context = [...records].reverse().find((record) => record.type === "request/context")?.data;
  const metadata: ConversationMetadata = {
    model: context ? asString(context["model"]) : null,
    reasoning_effort: null,
    ...(contextUsed === null ? {} : { context: { used: contextUsed, window: context ? asNumber(context["contextWindow"]) : null } }),
  };

  const hash = createHash("sha256").update(history_id).update(JSON.stringify(metadata));
  for (const record of records) if (record.seq >= lo && record.seq < hi) hash.update(record.raw);

  return {
    source: "dsh-transcript" as const,
    turns: turns.filter((turn) => turn.startSeq >= lo && turn.startSeq < hi)
      .map(({ startSeq: _startSeq, ...turn }) => turn),
    metadata,
    cursor: lo > (prompts[0] ?? 0) ? `${history_id}:${lo}` : null,
    history_id,
    version: `"${hash.digest("hex")}"`,
  };
}

export function readDshSession(path: string): SessionRecord[] {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(path);
  } catch {
    throw new Error("dsh session missing");
  }
  let text: string;
  try {
    text = Buffer.from(Bun.zstdDecompressSync(bytes)).toString("utf8");
  } catch {
    throw new Error("dsh session is not readable zstd");
  }
  if (text.length > MAX_BYTES) throw new Error("dsh session too large");
  const records: SessionRecord[] = [];
  for (const raw of text.split("\n")) {
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A torn tail line is not a record, and never becomes text of its own.
      continue;
    }
    if (!isObject(parsed)) continue;
    const type = asString(parsed["type"]);
    if (!type) continue;
    records.push({
      seq: asNumber(parsed["seq"]) ?? -1,
      type,
      time: asNumber(parsed["time"]),
      id: asString(parsed["id"]),
      data: isObject(parsed["data"]) ? parsed["data"] : {},
      raw,
    });
  }
  return records;
}

export function dshConversation(path: string, page: { before?: string; since?: string; from?: string } = {}) {
  return pageOf(readDshSession(path), page, path);
}

export function dshToolOutput(path: string, ref: string): string | null {
  for (const record of readDshSession(path)) {
    if (record.type !== "tool/result") continue;
    const message = isObject(record.data["message"]) ? record.data["message"] : {};
    const id = asString(message["toolCallId"]);
    if (!id || dshOutputRef(id) !== ref) continue;
    return textBlocks(message["content"]).text.join("\n").slice(0, TOOL_OUTPUT_MAX);
  }
  return null;
}
