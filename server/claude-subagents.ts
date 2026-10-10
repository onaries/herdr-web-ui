import { closeSync, lstatSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import type { HerdrPane, OmoTask } from "../shared/protocol.ts";

/**
 * The subagents one Claude Code session started (the `Agent` tool), for the status line's list,
 * the pane's running count and the chat's result cards. Claude keeps, beside the session's
 * transcript `<project>/<session>.jsonl`, a folder `<session>/subagents/` with one pair per
 * subagent: `agent-<id>.meta.json` (description, agent type, the tool call that started it) and
 * `agent-<id>.jsonl`, its own transcript. Whether it ended is told only by the parent
 * transcript: a background subagent by the `<task-notification>` Claude queues when it stops (a
 * teammate of an agent team gets none, and one's notice may not be written yet: its own file
 * ending in an `end_turn` answer, with no message to it after, says it stopped), a synchronous
 * one by the tool_result of its call (the "Async agent launched" acknowledgement of a
 * background call is no answer).
 *
 * A notification is carried up to three times (a user entry, a queue-operation, a queued_command
 * attachment) and the same agent notifies again each time it is resumed, so notices are kept per
 * agent, the newest of notice and answer wins, and an agent whose own file has entries newer than
 * that was resumed and is running again. A running agent lives inside the Claude process that
 * started it: one last written before the process now in the pane started is lost.
 *
 * Reading is cheap enough to run every few seconds per Claude pane: the parent transcript and
 * each subagent file are read only from where the last read stopped, at most READ_BUDGET bytes
 * per file per call (the first read of a parent covers its last PARENT_WINDOW bytes); a file whose
 * size did not change is not opened; the folder listing is kept until the folder changes; only
 * files touched in the last day are looked at, at most MAX_AGENTS of them; only plain files are
 * read; ids that become paths are plain words. Prompts and answers stay here.
 *
 * `tokens` is the total Claude's own footer shows for a subagent: what its last request held,
 * input + cache read + cache creation + output tokens of the last assistant entry (checked
 * against `totalTokens` in the tool result of a finished agent). Summing every entry instead
 * would count the cached context again on each turn.
 *
 * Background commands are listed with them, as Claude Code's footer counts both: a `Bash` call
 * whose answer carries a `backgroundTaskId` (`run_in_background`, Ctrl+B, or a call moved there
 * when it ran past its timeout), by the session or by a subagent. One ends with the
 * `<task-notification>` of its task id, in any transcript of the session, or with the answer
 * of the `TaskStop` (`KillShell` in older Claude Code) that stopped it, which no notice follows.
 * It lives in the Claude process that started it, as a running agent does.
 */
const READ_BUDGET = 8 * 1024 * 1024;
/** how much of a parent transcript is read the first time: older notices are not found */
const PARENT_WINDOW = 16 * 1024 * 1024;
const MAX_META_BYTES = 64 * 1024;
const MAX_AGENTS = 200;
const MAX_NAMES = 5000;
const RECENT_MS = 24 * 60 * 60 * 1000;
const RECENT_LIMIT = 10;
/** how much of the end of an agent's file tells its status, whatever else has been read of it */
const TAIL_BYTES = 64 * 1024;
/** a process's start is known to the second, and the clock can step: only an agent quiet this long before the start is taken for another process's */
const START_SLACK_MS = 60_000;
/** an agent id is a file name's part: nothing that could leave the folder */
const AGENT_ID = /^[A-Za-z0-9_-]+$/;

type Row = Record<string, unknown>;
const row = (value: unknown): Row | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Row : null;
const text = (value: unknown): string | null => typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, 300) : null;
const stamp = (value: unknown): number | null => { const at = typeof value === "string" ? Date.parse(value) : NaN; return Number.isFinite(at) ? at : null; };
const iso = (at: number | null): string | null => at === null ? null : new Date(at).toISOString();

/** Set `key` as the newest entry; the oldest one goes when the map is over `cap`, never all of them. */
export function remember<T>(map: Map<string, T>, key: string, value: T, cap: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > cap) map.delete(map.keys().next().value!);
}

/** One `<task-notification>` block, the part of it the chat and the list read. */
export interface TaskNotification {
  taskId: string;
  toolUseId: string | null;
  status: "completed" | "failed" | "cancelled";
  summary: string;
  result: string;
  /** whether it is a subagent's: a background command and a monitor use the same block */
  agent: boolean;
}

export function taskNotification(content: string): TaskNotification | null {
  const block = content.trim();
  if (!block.startsWith("<task-notification>") || !block.endsWith("</task-notification>")) return null;
  const tag = (name: string): string | null => block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim() ?? null;
  const taskId = tag("task-id");
  const raw = tag("status");
  const summary = tag("summary");
  if (taskId === null || !AGENT_ID.test(taskId) || raw === null || summary === null) return null;
  // the answer may quote the closing tag itself: it runs to the last one
  const from = block.indexOf("<result>");
  const to = block.lastIndexOf("</result>");
  return {
    taskId,
    toolUseId: tag("tool-use-id"),
    status: raw === "completed" ? "completed" : raw === "failed" || raw === "error" ? "failed" : "cancelled",
    summary,
    result: from !== -1 && to > from ? block.slice(from + "<result>".length, to).trim() : "",
    agent: summary.startsWith('Agent "'),
  };
}

/** The blocks a transcript entry carries as a notification, in whichever of the three records holds them. */
function blocksIn(entry: Row): string[] {
  if (entry["type"] === "queue-operation") return entry["operation"] === "enqueue" && typeof entry["content"] === "string" ? [entry["content"]] : [];
  if (entry["type"] === "attachment") {
    const attachment = row(entry["attachment"]);
    return attachment?.["commandMode"] === "task-notification" && typeof attachment["prompt"] === "string" ? [attachment["prompt"]] : [];
  }
  if (entry["type"] !== "user") return [];
  const content = row(entry["message"])?.["content"];
  if (typeof content === "string") return [content];
  // only what the person's side wrote as text: a tool result that quotes a block is not one
  return (Array.isArray(content) ? content : []).flatMap((value) => { const block = row(value); return block?.["type"] === "text" && typeof block["text"] === "string" ? [block["text"]] : []; });
}

/** The notifications one transcript line carries, none for a line that only mentions the tag. */
export function lineNotifications(line: string): TaskNotification[] {
  if (!line.includes("<task-notification>")) return [];
  let entry: Row | null;
  try { entry = row(JSON.parse(line)); } catch { return []; }
  return entry === null ? [] : blocksIn(entry).flatMap((block) => taskNotification(block) ?? []);
}

/**
 * The complete lines of `path` from `from`, at most `limit` bytes of them. `skipping`: the read
 * begins inside a line that is not wanted (a window's start, or a line too long to take), which
 * is passed over to its end. A line that does not fit `limit` waits for a call with more, and
 * one that does not fit READ_BUDGET is skipped, not waited for. `more`: the file goes on past
 * what this read looked at.
 */
export function readLines(path: string, from: number, size: number, limit: number, each: (line: string) => void, skipping: boolean): { offset: number; skipping: boolean; more: boolean; failed?: true } {
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return { offset: from, skipping, more: true, failed: true }; }
  try {
    const length = Math.min(size - from, limit);
    const buffer = Buffer.alloc(length);
    let got = 0;
    while (got < length) {
      const n = readSync(fd, buffer, got, length - got, from + got);
      if (n === 0) break;
      got += n;
    }
    const more = from + got < size;
    let start = 0;
    if (skipping) {
      const newline = buffer.subarray(0, got).indexOf(0x0a);
      if (newline === -1) return { offset: from + got, skipping: true, more };
      start = newline + 1;
    }
    const end = buffer.subarray(0, got).lastIndexOf(0x0a) + 1;
    if (end <= start) {
      // the skipped line ended in this read and nothing complete follows: the next line is read from its start
      if (skipping) return { offset: from + start, skipping: false, more };
      // a line larger than the whole budget is given up; a shorter one waits for a larger share
      return more && limit >= READ_BUDGET ? { offset: from + got, skipping: true, more } : { offset: from + start, skipping: false, more };
    }
    for (const line of buffer.subarray(start, end).toString("utf8").split("\n")) if (line.length > 0) each(line);
    return { offset: from + end, skipping: false, more };
  } catch { return { offset: from, skipping, more: true, failed: true }; } finally { closeSync(fd); }
}

export function plain(path: string, max = Infinity): { size: number; mtimeMs: number; id: string } | null {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && stat.size <= max ? { size: stat.size, mtimeMs: stat.mtimeMs, id: `${stat.dev}:${stat.ino}` } : null;
  } catch { return null; }
}

/** What one transcript says of background commands: those it started, by task id, and how those it heard of ended. */
interface Commands {
  /** the title of each `Bash` call not answered yet: its description, else its command */
  calls: Map<string, string>;
  launches: Map<string, { at: number; title: string }>;
  ends: Map<string, { at: number; status: OmoTask["status"] }>;
}
const noCommands = (): Commands => ({ calls: new Map(), launches: new Map(), ends: new Map() });
const TITLE_LENGTH = 120;

/** Whether a line may say something of a background command, before it is parsed: the answers of every other call are passed over. */
const commandLine = (line: string): boolean => line.includes('"name":"Bash"') || line.includes('"backgroundTaskId"') || line.includes('"task_id"') || line.includes('"shell_id"');

function scanCommands(commands: Commands, entry: Row, at: number | null, notices: readonly TaskNotification[]): void {
  if (at === null) return;
  const content = row(entry["message"])?.["content"];
  const blocks = (Array.isArray(content) ? content : []).flatMap((value): Row[] => { const block = row(value); return block === null ? [] : [block]; });
  for (const block of blocks) {
    if (block["type"] !== "tool_use" || block["name"] !== "Bash" || typeof block["id"] !== "string") continue;
    const input = row(block["input"]);
    const title = text(input?.["description"]) ?? text(input?.["command"]);
    if (title !== null) remember(commands.calls, block["id"], title.slice(0, TITLE_LENGTH), 512);
  }
  const failed = blocks.some((block) => block["type"] === "tool_result" && block["is_error"] === true);
  const result = failed ? null : row(entry["toolUseResult"]);
  const launched = result?.["backgroundTaskId"];
  if (typeof launched === "string" && AGENT_ID.test(launched)) {
    const call = blocks.find((block) => block["type"] === "tool_result" && typeof block["tool_use_id"] === "string")?.["tool_use_id"] as string | undefined;
    remember(commands.launches, launched, { at, title: (call === undefined ? undefined : commands.calls.get(call)) ?? "Background command" }, MAX_NAMES);
    if (call !== undefined) commands.calls.delete(call);
  }
  // TaskStop answers with the task it stopped, KillShell with the shell
  const stopped = typeof result?.["task_type"] === "string" ? result["task_id"] : result?.["shell_id"];
  if (typeof stopped === "string" && !commands.ends.has(stopped)) remember(commands.ends, stopped, { at, status: "cancelled" }, MAX_NAMES);
  for (const notice of notices) if (!notice.agent && !commands.ends.has(notice.taskId)) remember(commands.ends, notice.taskId, { at, status: notice.status }, MAX_NAMES);
}

/**
 * A prompt the person gave, which starts a turn. A notice's turn, a tool's answer, a message from
 * another session, an interruption and Claude Code's own records are not: Claude Code 2.1.2xx
 * marks the person's prompts with `origin` `human`, and older versions with a permission mode,
 * which the others lack. A prompt typed while a turn works is handed to that turn on the way
 * (a `queued_command` attachment): the same turn.
 */
function prompted(entry: Row): boolean {
  if (entry["type"] !== "user" || entry["isMeta"] === true || entry["isCompactSummary"] === true || entry["isSidechain"] === true) return false;
  const content = row(entry["message"])?.["content"];
  if (Array.isArray(content) && content.some((block) => row(block)?.["type"] === "tool_result")) return false;
  const origin = entry["origin"];
  const kind = typeof origin === "string" ? origin : row(origin)?.["kind"];
  if (kind !== undefined) return kind === "human";
  return typeof entry["permissionMode"] === "string" && !blocksIn(entry).join("").trimStart().startsWith("<task-notification>");
}

interface Parent {
  id: string;
  offset: number;
  skipping: boolean;
  /** read from the middle of the file: what happened before the first entry read is not known */
  windowed: boolean;
  firstAt: number | null;
  /** the read stopped for its budget, not for the end of what was written: what it has not seen says nothing */
  behind: boolean;
  /** per agent, its newest notification */
  notes: Map<string, { at: number; status: TaskNotification["status"] }>;
  /** the ids of `Agent` calls, and how those that were answered ended */
  calls: Set<string>;
  results: Map<string, { at: number; error: boolean }>;
  commands: Commands;
  /** when the person last gave a prompt: the turn going on, or last ended, began there */
  promptAt: number | null;
}
const parents = new Map<string, Parent>();

function scanParent(path: string): Parent | null {
  const stat = plain(path);
  if (stat === null) return null;
  let parent = parents.get(path);
  if (!parent || parent.id !== stat.id || parent.offset > stat.size) {
    const from = Math.max(0, stat.size - PARENT_WINDOW);
    parent = { id: stat.id, offset: from, skipping: from > 0, windowed: from > 0, firstAt: null, behind: false, notes: new Map(), calls: new Set(), results: new Map(), commands: noCommands(), promptAt: null };
  }
  remember(parents, path, parent, 256);
  const state = parent;
  if (state.offset >= stat.size) state.behind = false;
  // the first read takes the whole window, a chunk at a time; after that a call reads what was appended
  for (let left = PARENT_WINDOW; state.offset < stat.size && left > 0;) {
    const read = readLines(path, state.offset, stat.size, READ_BUDGET, (line) => {
      if (state.firstAt === null) state.firstAt = stamp(line.match(/"timestamp":"([^"]+)"/)?.[1]);
      scanParentLine(state, line);
    }, state.skipping);
    const consumed = read.offset - state.offset;
    state.offset = read.offset;
    state.skipping = read.skipping;
    state.behind = read.more;
    left -= consumed;
    if (consumed === 0) break;
  }
  return state;
}

/** An `Agent` call's launch is answered at once, with an acknowledgement that is no answer. */
function acknowledgement(entry: Row, block: Row): boolean {
  if (row(entry["toolUseResult"])?.["status"] === "async_launched") return true;
  const content = block["content"];
  const words = typeof content === "string" ? content : (Array.isArray(content) ? content : []).map((part) => row(part)?.["text"]).filter((part) => typeof part === "string").join("");
  return words.startsWith("Async agent launched");
}

function scanParentLine(parent: Parent, line: string): void {
  const mentioned = line.includes("<task-notification>");
  const calling = line.includes('"name":"Agent"') || line.includes('"name":"Task"');
  const answering = parent.calls.size > 0 && line.includes('"tool_result"');
  const commanding = commandLine(line);
  // a tool's answer always names its call: a prompt is a user entry that does not
  const prompting = line.includes('"type":"user"') && !line.includes('"tool_use_id"');
  if (!mentioned && !calling && !answering && !commanding && !prompting) return;
  let entry: Row | null;
  try { entry = row(JSON.parse(line)); } catch { return; }
  if (entry === null) return;
  const at = stamp(entry["timestamp"]);
  if (prompting && at !== null && prompted(entry)) parent.promptAt = at;
  // one line can hold all three: a batched entry, or an answer that quotes the tag
  const notices = mentioned ? blocksIn(entry).flatMap((block) => taskNotification(block) ?? []) : [];
  if (at !== null) {
    for (const notice of notices) {
      const known = parent.notes.get(notice.taskId);
      if (notice.agent && (!known || at >= known.at)) parent.notes.set(notice.taskId, { at, status: notice.status });
    }
  }
  if (commanding || notices.length > 0) scanCommands(parent.commands, entry, at, notices);
  const content = row(entry["message"])?.["content"];
  for (const value of Array.isArray(content) ? content : []) {
    const block = row(value);
    if (block === null) continue;
    if (calling && block["type"] === "tool_use" && (block["name"] === "Agent" || block["name"] === "Task") && typeof block["id"] === "string") parent.calls.add(block["id"]);
    else if (answering && block["type"] === "tool_result" && at !== null && typeof block["tool_use_id"] === "string" && parent.calls.has(block["tool_use_id"]) && !acknowledgement(entry, block)) {
      parent.results.set(block["tool_use_id"], { at, error: block["is_error"] === true });
    }
  }
  if (parent.calls.size > MAX_NAMES) parent.calls.clear();
  if (parent.results.size > MAX_NAMES) parent.results.clear();
}

/** `title`: what it was called (description, else a teammate's name); a session resumed in a new file keeps neither toolUseId nor description */
interface Meta { title: string | null; agent: string | null; toolUseId: string | null }
const metas = new Map<string, { key: string; meta: Meta | null }>();

function readMeta(path: string): Meta | null {
  const stat = plain(path, MAX_META_BYTES);
  if (stat === null) return null;
  const key = `${stat.id}:${stat.mtimeMs}:${stat.size}`;
  const known = metas.get(path);
  if (known?.key === key) return known.meta;
  let meta: Meta | null = null;
  try {
    const record = row(JSON.parse(readFileSync(path, "utf8")));
    if (record !== null) meta = { title: text(record["description"]) ?? text(record["name"]), agent: text(record["agentType"]), toolUseId: text(record["toolUseId"]) };
  } catch { return null; } // being written
  remember(metas, path, { key, meta }, 4096);
  return meta;
}

/** What a subagent's own transcript says of it so far. */
interface Work {
  id: string;
  offset: number;
  skipping: boolean;
  behind: boolean;
  /** it waits for a larger share of the budget than it was given: it is read first next time */
  hungry: boolean;
  firstAt: number | null;
  lastAt: number | null;
  /** latest instruction to this agent, not a result of a tool it called */
  dispatchAt: number | null;
  model: string | null;
  turns: number;
  toolCalls: number;
  tokens: number | null;
  lastMessage: string | null;
  /** when its last request ended its turn, while nothing has been said to it or by it since */
  turnEndedAt: number | null;
  commands: Commands;
}
const works = new Map<string, Work>();

function scanWork(path: string, budget: { left: number }): Work | null {
  const stat = plain(path);
  if (stat === null) return null;
  let work = works.get(path);
  if (!work || work.id !== stat.id || work.offset > stat.size) {
    work = { id: stat.id, offset: 0, skipping: false, behind: false, hungry: false, firstAt: null, lastAt: null, dispatchAt: null, model: null, turns: 0, toolCalls: 0, tokens: null, lastMessage: null, turnEndedAt: null, commands: noCommands() };
  }
  remember(works, path, work, 4096);
  if (work.offset >= stat.size) { work.behind = false; work.hungry = false; return work; }
  // a file whose turn has not come reads nothing now, and is behind
  if (budget.left <= 0) { work.behind = true; work.hungry = true; return work; }
  const state = work;
  const limit = Math.min(budget.left, READ_BUDGET);
  const read = readLines(path, state.offset, stat.size, limit, (line) => {
    let entry: Row | null;
    try { entry = row(JSON.parse(line)); } catch { return; }
    if (entry === null) return;
    const at = stamp(entry["timestamp"]);
    if (at !== null) { state.firstAt ??= at; state.lastAt = at; }
    if (at !== null && isDispatch(entry)) state.dispatchAt = at;
    // attachments and bookkeeping say nothing of its turn
    state.turnEndedAt = turnAfter(entry, at, state.turnEndedAt);
    const notices = line.includes("<task-notification>") ? blocksIn(entry).flatMap((block) => taskNotification(block) ?? []) : [];
    if (notices.length > 0 || commandLine(line)) scanCommands(state.commands, entry, at, notices);
    if (entry["type"] !== "assistant") return;
    const message = row(entry["message"]);
    // one request is written as one entry per content block, all with the same message id
    const id = text(message?.["id"]);
    if (id === null || id !== state.lastMessage) state.turns += 1;
    state.lastMessage = id;
    for (const block of Array.isArray(message?.["content"]) ? message["content"] : []) if (row(block)?.["type"] === "tool_use") state.toolCalls += 1;
    const model = text(message?.["model"]);
    if (model !== null && !model.startsWith("<")) state.model = model;
    const usage = row(message?.["usage"]);
    if (usage !== null) {
      const parts = ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens"].map((name) => typeof usage[name] === "number" ? usage[name] : 0);
      state.tokens = parts.reduce((sum, part) => sum + part, 0);
    }
  }, state.skipping);
  budget.left -= read.offset - state.offset;
  state.hungry = read.offset === state.offset && read.more && limit < READ_BUDGET;
  state.offset = read.offset;
  state.skipping = read.skipping;
  state.behind = read.more;
  return state;
}

/** A new instruction resumes an agent; a tool result only continues its existing dispatch. */
function isDispatch(entry: Row): boolean {
  if (entry["type"] !== "user" || entry["isMeta"] === true || entry["isCompactSummary"] === true) return false;
  if (blocksIn(entry).some((block) => block.trimStart().startsWith("<task-notification>"))) return false;
  const content = row(entry["message"])?.["content"];
  return typeof content === "string" ? content.trim().length > 0
    : Array.isArray(content) && content.some((block) => row(block)?.["type"] === "text")
      && !content.some((block) => row(block)?.["type"] === "tool_result");
}

/** A message to an agent or a result for it starts its turn again; its own answer ends it, unless it goes on (streamed blocks, a tool call). */
function turnAfter(entry: Row, at: number | null, turnEndedAt: number | null): number | null {
  if (entry["type"] === "user") return null;
  if (entry["type"] !== "assistant") return turnEndedAt;
  return row(row(entry["message"]))?.["stop_reason"] === "end_turn" ? at : null;
}

function readBytes(path: string, from: number, length: number): Buffer | null {
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return null; }
  try {
    const buffer = Buffer.alloc(length);
    let got = 0;
    while (got < length) {
      const n = readSync(fd, buffer, got, length - got, from + got);
      if (n === 0) break;
      got += n;
    }
    return buffer.subarray(0, got);
  } catch { return null; } finally { closeSync(fd); }
}

/** What the end of an agent's file says of it: when it was last written, and whether its turn ended. */
interface Tail { known: boolean; firstAt: number | null; lastAt: number | null; dispatchAt: number | null; turnEndedAt: number | null }
const tails = new Map<string, { id: string; key: string; tail: Tail }>();

/**
 * The status of an agent must not wait for the whole of its file to be read, which takes calls:
 * its last TAIL_BYTES (back to a line start) hold the last entries, whatever they are, and the
 * first line its start. Read again only when the file changed; not counted against any budget.
 * `known` false: the tail holds no whole line of it (one very long entry, or a file being written).
 */
function readTail(path: string, stat: { size: number; mtimeMs: number; id: string }): Tail {
  const key = `${stat.size}:${stat.mtimeMs}`;
  const kept = tails.get(path);
  if (kept?.id === stat.id && kept.key === key) return kept.tail;
  const tail: Tail = { known: false, firstAt: kept?.id === stat.id ? kept.tail.firstAt : null, lastAt: null, dispatchAt: null, turnEndedAt: null };
  if (stat.size === 0) { tail.known = true; return tail; }
  const from = Math.max(0, stat.size - TAIL_BYTES);
  const chunk = readBytes(path, from, stat.size - from);
  if (chunk === null) return tail;
  const end = chunk.lastIndexOf(0x0a) + 1;
  const start = from === 0 ? 0 : chunk.indexOf(0x0a) + 1;
  let decisive = false;
  let lines = 0;
  if (end > start) {
    for (const line of chunk.subarray(start, end).toString("utf8").split("\n")) {
      let entry: Row | null;
      try { entry = row(JSON.parse(line)); } catch { continue; }
      if (entry === null) continue;
      lines += 1;
      const at = stamp(entry["timestamp"]);
      if (at !== null) { if (from === 0) tail.firstAt ??= at; tail.lastAt = at; }
      if (at !== null && isDispatch(entry)) tail.dispatchAt = at;
      if (entry["type"] === "user" || entry["type"] === "assistant") decisive = true;
      tail.turnEndedAt = turnAfter(entry, at, tail.turnEndedAt);
    }
  }
  tail.known = (from === 0 && end > 0) || decisive;
  if (tail.firstAt === null && from > 0) {
    const head = readBytes(path, 0, TAIL_BYTES);
    const newline = head?.indexOf(0x0a) ?? -1;
    if (head !== null && newline !== -1) { try { tail.firstAt = stamp(row(JSON.parse(head.subarray(0, newline).toString("utf8")))?.["timestamp"]); } catch { /* a long first line: no start yet */ } }
  }
  remember(tails, path, { id: stat.id, key, tail }, 4096);
  return tail;
}

const subagentsDir = (parentPath: string): string => join(parentPath.replace(/\.jsonl$/, ""), "subagents");

function folderVersion(dir: string): { sig: string; latestMs: number } {
  try {
    const stat = lstatSync(dir);
    return { sig: `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}`, latestMs: Math.max(stat.mtimeMs, stat.ctimeMs) };
  } catch { return { sig: "-", latestMs: 0 }; }
}

/**
 * The folder's listing, read again only when the folder changed. A folder's time is coarse: one
 * that changed within a second of the read may have changed again with the same time, so only a
 * listing read after the folder had been quiet for a second is kept.
 */
const listings = new Map<string, { sig: string; readAt: number; ids: string[] }>();
function agentIds(parentPath: string): string[] {
  const dir = subagentsDir(parentPath);
  const { sig, latestMs } = folderVersion(dir);
  if (sig === "-") { listings.delete(dir); return []; }
  const known = listings.get(dir);
  if (known?.sig === sig && known.readAt - latestMs >= 1000) return known.ids;
  let ids: string[];
  try {
    ids = readdirSync(dir).slice(0, MAX_NAMES).flatMap((name) => {
      const id = /^agent-(.+)\.meta\.json$/.exec(name)?.[1];
      return id !== undefined && AGENT_ID.test(id) ? [id] : [];
    });
  } catch { return []; }
  remember(listings, dir, { sig, readAt: Date.now(), ids }, 256);
  return ids;
}

/** What changes when a session's subagents may have: the folder, parent transcript and every watched agent's own file. */
export function subagentsSignature(parentPath: string, watch: readonly string[] = [], now = Date.now()): { sig: string; latestMs: number } {
  const dir = subagentsDir(parentPath);
  const folder = folderVersion(dir);
  // A file may grow in the same coarse mtime tick, or be replaced with one of the same size.
  const watched = [plain(parentPath), ...watch.map((id) => plain(join(dir, `agent-${id}.jsonl`)))];
  return {
    sig: `${folder.sig}:${watch.join(",")}:${watched.map((stat, index) => stat ? `${stat.id}:${stat.size}:${stat.mtimeMs}:${index > 0 && now - stat.mtimeMs > RECENT_MS}` : "-").join(",")}`,
    latestMs: Math.max(folder.latestMs, ...watched.map((stat) => stat?.mtimeMs ?? 0)),
  };
}

/** What a subagent's chat card takes from its files: what it was started with, which never changes. */
export interface SubagentDetail {
  title: string | null;
  agent: string | null;
}

/** The subagents named, by agent id, as their meta files say. An id that is not a plain word is none. */
export function subagentDetails(parentPath: string, ids: Iterable<string>): Map<string, SubagentDetail> {
  const found = new Map<string, SubagentDetail>();
  const dir = subagentsDir(parentPath);
  for (const id of new Set(ids)) {
    if (!AGENT_ID.test(id)) continue;
    const meta = readMeta(join(dir, `agent-${id}.meta.json`));
    if (meta !== null) found.set(id, { title: meta.title, agent: meta.agent });
  }
  return found;
}

const time = (value: string | null): number => value === null ? 0 : Date.parse(value) || 0;

/**
 * A session's subagents: running ones first (oldest first), then up to ten that ended in the last
 * day (newest first), as OmO's list is. `live`: the pane still runs Claude on this session; one
 * that does not leaves what was running as lost, ended when last heard of. `since`: when the
 * Claude process there started, when known; an agent last written before it died with the
 * process before (a resumed session appends to the same files). `settled`: nothing was left
 * unread, so the same answer stands until a file changes.
 */
/** what each session's last read said of each agent: kept while the transcript is read in parts */
const previous = new Map<string, Map<string, OmoTask>>();

export function claudeSubagentState(parentPath: string, live: boolean, now = Date.now(), since: number | null = null): { tasks: OmoTask[]; settled: boolean; watch: string[]; running: number; turnRunning: number; promptAt: number | null } {
  const dir = subagentsDir(parentPath);
  const files = agentIds(parentPath).flatMap((id) => {
    const stat = plain(join(dir, `agent-${id}.jsonl`));
    return stat !== null && now - stat.mtimeMs <= RECENT_MS ? [{ id, mtimeMs: stat.mtimeMs, stat }] : [];
  }).sort((a, b) => Number(works.get(join(dir, `agent-${b.id}.jsonl`))?.hungry ?? false) - Number(works.get(join(dir, `agent-${a.id}.jsonl`))?.hungry ?? false) || b.mtimeMs - a.mtimeMs).slice(0, MAX_AGENTS);
  // each has a budget of its own: a long transcript must not keep the agents from being read.
  // Read with no subagent too: the session's own background commands are in it
  const parent = scanParent(parentPath);
  if (parent === null && files.length === 0) return { tasks: [], settled: true, watch: [], running: 0, turnRunning: 0, promptAt: null };
  const budget = { left: READ_BUDGET };
  const running: OmoTask[] = [];
  const ended: OmoTask[] = [];
  const promptAt = parent?.promptAt ?? null;
  let turnRunning = 0;
  const all = new Map<string, OmoTask>();
  const sources: Commands[] = parent === null ? [] : [parent.commands];
  let settled = parent !== null && !parent.behind;
  for (const { id, stat } of files) {
    const meta = readMeta(join(dir, `agent-${id}.meta.json`));
    const work = scanWork(join(dir, `agent-${id}.jsonl`), budget);
    if (work !== null) sources.push(work.commands);
    // a file caught while it is written says nothing yet, and what was worked out without it is not final
    if (meta === null || work === null) { settled = false; continue; }
    if (work.behind) settled = false;
    // its status from the end of its file, which no budget holds back; the whole file only when that tells nothing
    const tail = readTail(join(dir, `agent-${id}.jsonl`), stat);
    const view = tail.known ? tail : work.behind ? null : work;
    // not told yet: neither running nor ended
    if (view === null) { settled = false; continue; }
    // what it did is counted from the whole file, and shown once it is
    const counted = !work.behind;
    const firstAt = tail.firstAt ?? work.firstAt;
    let status: OmoTask["status"] | null = null;
    let endedAt: number | null = null;
    // what ended it last: its notice, or the answer to its synchronous call
    const note = parent?.notes.get(id);
    const answer = meta.toolUseId !== null ? parent?.results.get(meta.toolUseId) : undefined;
    const told = note && (!answer || note.at >= answer.at) ? { at: note.at, status: note.status, turn: false } : answer ? { at: answer.at, status: answer.error ? "failed" as const : "completed" as const, turn: false } : null;
    // its own file can say it stopped (a teammate gets no notification, and a notice may not be written yet)
    const stopped = view.turnEndedAt !== null ? { at: view.turnEndedAt, status: "completed" as const, turn: true } : null;
    const end = told && (!stopped || told.at >= stopped.at) ? told : stopped;
    // an end older than the agent's last entry is from before it was resumed; its own last turn ended is that entry
    if (end && (end.turn || view.lastAt === null || view.lastAt <= end.at)) { status = end.status; endedAt = end.at; }
    else if (parent === null) continue;
    // the transcript is not read to its end: what an agent was last read as stands until it is
    else if (parent.behind) {
      const old = previous.get(parentPath)?.get(id);
      if (!old) continue;
      status = old.status === "lost" ? "running" : old.status;
      endedAt = status === "running" ? null : time(old.ended_at) || null;
    }
    // the part read starts after it went quiet: not known to run
    else if (parent.windowed && parent.firstAt !== null && (view.lastAt ?? 0) < parent.firstAt) continue;
    else status = "running";
    const orphan = status === "running" && since !== null && view.lastAt !== null && view.lastAt < since - START_SLACK_MS;
    const lost = status === "running" && (!live || orphan);
    const task: OmoTask = {
      id,
      title: meta.title ?? meta.agent ?? id,
      category: meta.agent,
      model: counted ? work.model : null,
      status: lost ? "lost" : status,
      started_at: iso(firstAt),
      ended_at: iso(status === "running" ? (lost ? view.lastAt : null) : endedAt),
      turns: counted ? work.turns : null,
      tool_calls: counted ? work.toolCalls : null,
      tokens: counted ? work.tokens : null,
    };
    keep(task, Math.max(tail.dispatchAt ?? 0, work.dispatchAt ?? 0, firstAt ?? 0));
  }
  // a command ends once, in whichever transcript was told first
  const ends = new Map<string, { at: number; status: OmoTask["status"] }>();
  for (const source of sources) for (const [id, end] of source.ends) if ((ends.get(id)?.at ?? Infinity) > end.at) ends.set(id, end);
  for (const source of sources) {
    for (const [id, launch] of source.launches) {
      if (all.has(id)) continue;
      const end = ends.get(id);
      const lost = !live || (since !== null && launch.at < since - START_SLACK_MS);
      keep({ id, title: launch.title, category: "shell", model: null, status: end?.status ?? (lost ? "lost" : "running"), started_at: iso(launch.at), ended_at: iso(end?.at ?? null), turns: null, tool_calls: null, tokens: null });
    }
  }
  remember(previous, parentPath, all, 256);
  running.sort((a, b) => time(a.started_at) - time(b.started_at));
  // a command lost with its process has no end of its own: its start stands for it
  const last = (task: OmoTask): number => time(task.ended_at) || time(task.started_at);
  ended.sort((a, b) => last(b) - last(a));
  return { tasks: [...running, ...ended.slice(0, RECENT_LIMIT)], settled, watch: files.map(({ id }) => id), running: running.length, turnRunning, promptAt };

  function keep(task: OmoTask, dispatched = time(task.started_at)): void {
    all.set(task.id, task);
    if (task.status === "running") {
      running.push(task);
      if (promptAt === null || dispatched >= promptAt) turnRunning += 1;
    }
    else {
      const at = time(task.ended_at) || time(task.started_at);
      if (at !== 0 && now - at <= RECENT_MS) ended.push(task);
    }
  }
}

export const claudeSubagents = (parentPath: string, live: boolean, now = Date.now(), since: number | null = null): OmoTask[] => claudeSubagentState(parentPath, live, now, since).tasks;

/** Forget every read kept between calls (tests compare against a cold read). */
export function forgetSubagents(): void {
  parents.clear();
  metas.clear();
  works.clear();
  tails.clear();
  listings.clear();
  previous.clear();
}

export interface ClaudeSubagentDeps {
  /** a Claude pane's transcript, and its Claude process (its pid and when it started); null while it has no transcript */
  resolve: (pane: HerdrPane) => Promise<{ path: string; startedAt: number | null; pid?: number | null } | null>;
  /** the pid of the pane's Claude process now: a restart under the same session id is another process */
  pid?: (pane: HerdrPane) => Promise<number | null>;
  /** Positive session/process replacement, never first discovery or a retry. Discard the old turn's transition evidence. */
  onReset?: (paneId: string) => void;
  /**
   * A pane's running subagents and background commands changed, or how many of them its turn
   * started (`turnRunning`, server/background-wait.ts): no turn started or ended.
   */
  onChange: (paneId: string, running: number, turnRunning: number, promptAt: number | null) => void;
  pollMs?: number;
  refreshMs?: number;
  now?: () => number;
}

/** `sig`: what the files looked like when the count was last worked out from them in full */
interface Tracked {
  key: string; path: string | null; startedAt: number | null; pid: number | null;
  /** when its transcript, and its process, were last looked for */
  at: number; pidAt: number;
  live: boolean; running: number; turnRunning: number; promptAt: number | null; sig: string | null;
  reset?: boolean;
  /** every observed agent, whose own file can end or resume its turn */
  watch: string[];
}

/**
 * The running subagents and background commands of every Claude pane, for the pane's count. Only a pane whose agent is
 * `claude` is looked at (an OmO pane is named `omo` by then, any other agent is not Claude's):
 * its transcript is found once per session, and polled for what changed since. A pane that is
 * not Claude any more keeps the transcript it had, so that its list can say what was left
 * running there is lost; its count is 0. A poll that finds the folder, parent transcript and
 * watched agent files as they were reads nothing. An agent's own file can end or resume it.
 */
export class ClaudeSubagentStatus {
  private readonly panes = new Map<string, Tracked>();
  /** Identity observations precede async resolution, including snapshots queued behind a lookup. */
  private readonly sessions = new Map<string, string | null>();
  /** The latest lookup claim; a newer pane/session observation cancels an older answer. */
  private readonly lookups = new Map<string, { key: string }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private refreshing: Promise<void> | null = null;
  private queued: HerdrPane[] | null = null;
  private readonly now: () => number;
  private readonly refreshMs: number;

  constructor(private readonly deps: ClaudeSubagentDeps) {
    this.now = deps.now ?? Date.now;
    this.refreshMs = deps.refreshMs ?? 5000;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.poll(), this.deps.pollMs ?? 2000);
    this.timer.unref?.();
  }

  stop(): void {
    this.lookups.clear();
    this.sessions.clear();
    this.queued = null;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  countOf(paneId: string): number {
    return this.panes.get(paneId)?.running ?? 0;
  }

  /** The transcript of the Claude session the pane holds, or last held, whether it still runs Claude, and when that process started. */
  sessionOf(paneId: string): { path: string; live: boolean; startedAt: number | null } | null {
    const tracked = this.panes.get(paneId);
    return tracked?.path ? { path: tracked.path, live: tracked.live, startedAt: tracked.startedAt } : null;
  }

  /** Finds the Claude panes of a snapshot and their transcripts; a lookup costs process calls, so a known one is not repeated. */
  refresh(panes: HerdrPane[]): Promise<void> {
    const ids = new Set(panes.map((pane) => pane.pane_id));
    for (const paneId of this.panes.keys()) if (!ids.has(paneId)) this.panes.delete(paneId);
    for (const paneId of this.lookups.keys()) if (!ids.has(paneId)) this.lookups.delete(paneId);
    for (const paneId of this.sessions.keys()) if (!ids.has(paneId)) this.sessions.delete(paneId);
    for (const pane of panes) {
      this.observeSession(pane);
      const key = `${pane.agent_session?.value ?? ""}\0${pane.cwd ?? ""}`;
      if (pane.agent !== "claude" || this.lookups.get(pane.pane_id)?.key !== key) this.lookups.delete(pane.pane_id);
      if (pane.agent !== "claude") {
        const tracked = this.panes.get(pane.pane_id);
        if (tracked) tracked.live = false;
      }
    }
    if (this.refreshing) { this.queued = panes; return this.refreshing; }
    this.refreshing = (async () => {
      try {
        for (let next: HerdrPane[] | null = panes; next !== null; next = this.queued) {
          this.queued = null;
          await Promise.all(next.map((pane) => this.ensure(pane)));
          this.poll();
        }
      } finally { this.refreshing = null; }
    })();
    return this.refreshing;
  }

  /** One pane's transcript, looked up now if it is not known (or not known to be this session's). */
  async ensure(pane: HerdrPane): Promise<void> {
    this.observeSession(pane);
    const tracked = this.panes.get(pane.pane_id);
    if (pane.agent !== "claude") {
      this.lookups.delete(pane.pane_id);
      if (tracked) tracked.live = false;
      return;
    }
    // a session known by its id is looked up when it changes; one found by process only, now and then
    const session = pane.agent_session?.value ?? "";
    const key = `${session}\0${pane.cwd ?? ""}`;
    const claim = { key };
    this.lookups.set(pane.pane_id, claim);
    const due = !tracked || tracked.key !== key || !tracked.live || tracked.path === null || (session === "" && this.now() - tracked.at >= 6 * this.refreshMs);
    let again = due;
    // Retry incomplete process identity too: a transient lookup failure is not a permanent boundary.
    if (!due && tracked && this.now() - tracked.pidAt >= this.refreshMs) {
      tracked.pidAt = this.now();
      const pid = this.deps.pid ? await this.deps.pid(pane).catch(() => null) : null;
      if (this.lookups.get(pane.pane_id) !== claim) return;
      again = tracked.startedAt === null || tracked.pid === null || (pid !== null && pid !== tracked.pid);
    }
    if (!again) return;
    if (tracked && tracked.key === key && tracked.path === null && this.now() - tracked.at < this.refreshMs) return;
    const found = await this.deps.resolve(pane).catch(() => null);
    if (this.lookups.get(pane.pane_id) !== claim) return;
    const current = this.panes.get(pane.pane_id);
    const same = current?.key === key;
    const reset = !!(found && current && ((current.path !== null && current.path !== found.path)
      || (current.pid !== null && found.pid != null && current.pid !== found.pid)
      || (current.startedAt !== null && found.startedAt !== null && current.startedAt !== found.startedAt)));
    if (reset) this.deps.onReset?.(pane.pane_id);
    // the count it had goes on from here: another session with none says so at the next poll
    this.panes.set(pane.pane_id, { key, path: found?.path ?? (same ? current.path : null), startedAt: found ? found.startedAt : same ? current.startedAt : null, pid: found ? found.pid ?? null : same ? current.pid : null, at: this.now(), pidAt: this.now(), live: true, running: current?.running ?? 0, turnRunning: current?.turnRunning ?? 0, promptAt: current?.promptAt ?? null, sig: null, watch: same && !found ? current.watch : [], reset });
  }

  private observeSession(pane: HerdrPane): void {
    const previous = this.sessions.get(pane.pane_id);
    const session = pane.agent === "claude" ? pane.agent_session?.value ?? "" : null;
    // Missing hook identity becoming known (or a cwd change) is not a new lifetime.
    const replaced = previous !== undefined && previous !== session
      && (previous === null || session === null || (previous !== "" && session !== ""));
    this.sessions.set(pane.pane_id, session === "" && previous != null ? previous : session);
    if (!replaced) return;
    this.lookups.delete(pane.pane_id);
    this.deps.onReset?.(pane.pane_id);
    const tracked = this.panes.get(pane.pane_id);
    if (!tracked) return;
    tracked.live = false;
    tracked.reset = true;
    // Leaving Claude retains the old transcript for the lost-task list, but a new Claude session cannot read it.
    if (session !== null) {
      tracked.path = null;
      tracked.startedAt = null;
      tracked.pid = null;
      tracked.at = -Infinity;
      tracked.watch = [];
      tracked.sig = null;
    }
    this.poll(pane.pane_id);
  }

  /** Reads what the files gained, of every pane or of one (a turn just ended there); a pane whose counts changed is told. */
  poll(only?: string): void {
    for (const [paneId, tracked] of this.panes) {
      if (only !== undefined && paneId !== only) continue;
      let running = 0;
      let turnRunning = 0;
      let promptAt: number | null = null;
      if (tracked.path !== null && tracked.live) {
        const scanAt = this.now();
        const before = subagentsSignature(tracked.path, tracked.watch, scanAt);
        if (`${before.sig}:${tracked.startedAt}` === tracked.sig) continue;
        const state = claudeSubagentState(tracked.path, true, this.now(), tracked.startedAt);
        ({ running, turnRunning, promptAt } = state);
        tracked.watch = state.watch;
        const after = subagentsSignature(tracked.path, tracked.watch, this.now());
        // Certify only the versions and dependency set read, never a concurrent append's newer signature.
        // Coarse file clocks require every input to have been quiet before the scan began.
        tracked.sig = state.settled && before.sig === after.sig && scanAt - before.latestMs >= 1000
          ? `${after.sig}:${tracked.startedAt}` : null;
      }
      if (!tracked.reset && running === tracked.running && turnRunning === tracked.turnRunning && promptAt === tracked.promptAt) continue;
      tracked.reset = false;
      tracked.running = running;
      tracked.turnRunning = turnRunning;
      tracked.promptAt = promptAt;
      this.deps.onChange(paneId, running, turnRunning, promptAt);
    }
  }
}

/** Waits for `work`, but not longer than `ms`: what a slow lookup finds is there for the next ask. */
export async function within(ms: number, work: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([work.catch(() => undefined), new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]);
  } finally { clearTimeout(timer); }
}
