import type { HerdrPane, PlanStep, PlanSummary } from "../shared/protocol.ts";
import { plain, readLines, remember } from "./claude-subagents.ts";

/**
 * The plan an agent keeps for its session, read back from the session's transcript, for the
 * sidebar's progress and the plan panel. Nothing new is asked of the agent: Claude Code's task
 * list (`TaskCreate`/`TaskUpdate`, whose `blockedBy` gives the flow) and Codex's `update_plan`
 * checklist are already written there.
 *
 * Claude: a task is taken when its tool call is answered without an error, with the id Claude
 * gave it. Claude empties its list once every task in it is done, and so does this: the first
 * task created after that starts a new plan. A teammate of an agent team that changes a task
 * writes that in its own transcript, which is not read here.
 *
 * Codex: each explicit `update_plan` call sends the whole checklist, so the last one is the plan.
 * Code inside an `exec` call may quote a plan without calling the tool, and is ignored.
 *
 * A transcript is read from its start, PLAN_BUDGET bytes per call, then only what was appended;
 * until the first read has reached the end, no plan is told.
 */
const PLAN_BUDGET = 32 * 1024 * 1024;
const LINE_BUDGET = 8 * 1024 * 1024;
const MAX_STEPS = 200;
const MAX_FILES = 256;

export type PlanSource = "claude-transcript" | "codex-transcript";

type Row = Record<string, unknown>;
const row = (value: unknown): Row | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Row : null;
const words = (value: unknown): string | null => typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, 300) : null;
const idOf = (value: unknown): string | null => words(typeof value === "number" ? String(value) : value);
const stamp = (value: unknown): string | null => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const STATUSES = new Set<PlanStep["status"]>(["pending", "in_progress", "completed"]);

interface Read {
  id: string;
  offset: number;
  skipping: boolean;
  /** the first read has not reached the end of what was written yet */
  catching: boolean;
  /** the last read stopped for its budget: what follows has not been read */
  behind: boolean;
  steps: Map<string, PlanStep>;
  /** Claude's task calls still waiting for their answer, by tool_use id */
  calls: Map<string, { name: string; input: Row }>;
}
const reads = new Map<string, Read>();

/**
 * The plan in `path` now: its steps in the order they were made, null when there is none (or it
 * is still being read). `budget`: the bytes this read may take, shared by every read of one poll.
 */
export function readPlan(source: PlanSource, path: string, budget = { left: PLAN_BUDGET }): PlanStep[] | null {
  return planState(source, path, budget).steps;
}

function planState(source: PlanSource, path: string, budget: { left: number }): { steps: PlanStep[] | null; behind: boolean } {
  const stat = plain(path);
  if (stat === null) return { steps: null, behind: false };
  const key = `${source}\0${path}`;
  let state = reads.get(key);
  if (!state || state.id !== stat.id || state.offset > stat.size) {
    state = { id: stat.id, offset: 0, skipping: false, catching: true, behind: true, steps: new Map(), calls: new Map() };
  }
  remember(reads, key, state, MAX_FILES);
  const read = state;
  const each = source === "claude-transcript" ? (line: string) => claudeLine(read, line) : (line: string) => codexLine(read, line);
  read.behind = read.offset < stat.size;
  while (read.offset < stat.size && budget.left > 0) {
    const done = readLines(path, read.offset, stat.size, LINE_BUDGET, each, read.skipping);
    // the file could not be read this time (gone, out of descriptors): not caught up, tried again at the next poll
    if (done.failed) { read.behind = true; break; }
    const consumed = done.offset - read.offset;
    read.offset = done.offset;
    read.skipping = done.skipping;
    read.behind = done.more;
    budget.left -= consumed;
    // what is left is a line still being written: the next read takes it whole
    if (consumed === 0 || !done.more) break;
  }
  if (!read.behind) read.catching = false;
  return { steps: read.catching || read.steps.size === 0 ? null : [...read.steps.values()].map((step) => ({ ...step, blocked_by: [...step.blocked_by] })), behind: read.behind };
}

/** Forgets every read (tests). */
export function forgetPlans(): void {
  reads.clear();
}

function claudeLine(read: Read, line: string): void {
  const calling = line.includes('"name":"TaskCreate"') || line.includes('"name":"TaskUpdate"');
  const answering = read.calls.size > 0 && line.includes('"tool_result"');
  if (!calling && !answering) return;
  let entry: Row | null;
  try { entry = row(JSON.parse(line)); } catch { return; }
  const content = row(entry?.["message"])?.["content"];
  if (entry === null || !Array.isArray(content)) return;
  for (const value of content) {
    const block = row(value);
    if (block === null) continue;
    if (block["type"] === "tool_use" && (block["name"] === "TaskCreate" || block["name"] === "TaskUpdate") && typeof block["id"] === "string") {
      read.calls.set(block["id"], { name: block["name"], input: row(block["input"]) ?? {} });
      continue;
    }
    if (block["type"] !== "tool_result" || typeof block["tool_use_id"] !== "string") continue;
    const call = read.calls.get(block["tool_use_id"]);
    if (call === undefined) continue;
    read.calls.delete(block["tool_use_id"]);
    if (block["is_error"] === true) continue;
    const answer = row(entry["toolUseResult"]);
    const at = stamp(entry["timestamp"]);
    if (call.name === "TaskCreate") created(read, call.input, answer, block["content"], at);
    else updated(read, call.input, answer, at);
  }
  if (read.calls.size > MAX_STEPS) read.calls.clear();
}

function created(read: Read, input: Row, answer: Row | null, content: unknown, at: string | null): void {
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => row(part)?.["text"]).filter((part) => typeof part === "string").join("") : "";
  const id = idOf(row(answer?.["task"])?.["id"]) ?? text.match(/^Task #(\S+) created/)?.[1] ?? null;
  if (id === null) return;
  // Claude empties a list whose tasks are all done: the next task begins another plan
  if ([...read.steps.values()].every((step) => step.status === "completed")) read.steps.clear();
  if (read.steps.size >= MAX_STEPS) return;
  read.steps.set(id, { id, label: words(input["subject"]) ?? `#${id}`, active: words(input["activeForm"]), status: "pending", blocked_by: [], owner: null, started_at: null, ended_at: null });
}

function updated(read: Read, input: Row, answer: Row | null, at: string | null): void {
  if (answer?.["success"] === false) return;
  const id = idOf(input["taskId"]);
  const step = id === null ? undefined : read.steps.get(id);
  if (id === null || step === undefined) return;
  const status = input["status"];
  if (status === "deleted") {
    read.steps.delete(id);
    for (const other of read.steps.values()) other.blocked_by = other.blocked_by.filter((before) => before !== id);
    return;
  }
  if (typeof status === "string" && STATUSES.has(status as PlanStep["status"]) && status !== step.status) {
    step.status = status as PlanStep["status"];
    if (step.status === "in_progress") { step.started_at ??= at; step.ended_at = null; }
    if (step.status === "completed") step.ended_at = at;
    if (step.status === "pending") step.ended_at = null;
  }
  step.label = words(input["subject"]) ?? step.label;
  step.active = words(input["activeForm"]) ?? step.active;
  if (typeof input["owner"] === "string") step.owner = words(input["owner"]);
  const ids = (value: unknown): string[] => Array.isArray(value) ? value.flatMap((item) => { const other = idOf(item); return other !== null && other !== id && read.steps.has(other) ? [other] : []; }) : [];
  for (const before of ids(input["addBlockedBy"])) if (!step.blocked_by.includes(before)) step.blocked_by.push(before);
  for (const after of ids(input["addBlocks"])) {
    const other = read.steps.get(after)!;
    if (!other.blocked_by.includes(id)) other.blocked_by.push(id);
  }
}

function codexLine(read: Read, line: string): void {
  if (!line.includes("update_plan")) return;
  let entry: Row | null;
  try { entry = row(JSON.parse(line)); } catch { return; }
  const payload = row(entry?.["payload"]);
  if (entry === null || payload === null) return;
  if (payload["type"] !== "function_call" || payload["name"] !== "update_plan" || typeof payload["arguments"] !== "string") return;
  let args: unknown;
  try { args = JSON.parse(payload["arguments"]); } catch { return; }
  const items = row(args)?.["plan"];
  if (!Array.isArray(items)) return;
  const at = stamp(entry["timestamp"]);
  // a step keeps the times it had in the checklists before, found by its words
  const before = new Map([...read.steps.values()].map((step) => [step.label, step]));
  read.steps.clear();
  for (const item of items.slice(0, MAX_STEPS)) {
    const label = words(row(item)?.["step"]);
    const raw = row(item)?.["status"];
    if (label === null) continue;
    const status: PlanStep["status"] = typeof raw === "string" && STATUSES.has(raw as PlanStep["status"]) ? raw as PlanStep["status"] : "pending";
    const known = before.get(label);
    const id = String(read.steps.size + 1);
    const started = status === "pending" ? null : known?.started_at ?? at;
    read.steps.set(id, {
      id, label, active: null, status, owner: null,
      blocked_by: read.steps.size > 0 ? [String(read.steps.size)] : [],
      started_at: started,
      ended_at: status === "completed" ? known?.ended_at ?? at : null,
    });
  }
}

/** What the sidebar shows of a plan. */
export function planSummary(steps: readonly PlanStep[] | null): PlanSummary | null {
  if (steps === null || steps.length === 0) return null;
  const current = steps.find((step) => step.status === "in_progress");
  return { done: steps.filter((step) => step.status === "completed").length, total: steps.length, current: current ? current.active ?? current.label : null };
}

export interface SessionPlanDeps {
  /** a Claude pane's transcript as the subagent tracker found it (a lookup that costs nothing), null when not known yet */
  claudePath: (paneId: string) => string | null;
  /** a Codex pane's rollout: this costs process calls, so it is asked once per session and again every `relocateMs` */
  codexPath: (pane: HerdrPane) => Promise<string | null>;
  /** a pane's summary changed (null: it has no plan now) */
  onChange: (paneId: string, summary: PlanSummary | null) => void;
  now?: () => number;
  /** how soon a Codex pane whose rollout was not found is looked up again */
  retryMs?: number;
  /** how often a found rollout is checked (a new conversation in the same Codex writes another) */
  relocateMs?: number;
  pollMs?: number;
}

interface Tracked {
  key: string;
  at: number;
  where: { source: PlanSource; path: string } | null;
  /** the file's size and identity when it was last read: an unchanged file is not read again */
  sig: string | null;
  summary: PlanSummary | null;
}

/**
 * The plans of every Claude Code and Codex pane, for the sidebar. A pane's transcript is looked
 * up once per session (and again now and then while it is not found); a poll reads only a
 * transcript that grew, and tells a pane whose summary changed.
 */
export class SessionPlans {
  private readonly panes = new Map<string, Tracked>();
  /** the Claude Code and Codex panes of the last snapshot, by the session each runs: a lookup that ends after its pane left is dropped */
  private readonly wanted = new Map<string, string>();
  /** a snapshot has been seen: before one, a pane asked for by the endpoint is taken as it is */
  private refreshed = false;
  private readonly looking = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: SessionPlanDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.poll(), this.deps.pollMs ?? 2000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  summaryOf(paneId: string): PlanSummary | null {
    return this.panes.get(paneId)?.summary ?? null;
  }

  /**
   * The plan of the pane as herdr has it now (undefined: herdr did not say), as the poll last read it: null when it has
   * none, or its transcript is not known for the session it runs, or not read to its end yet.
   */
  planOf(pane: HerdrPane | undefined): PlanStep[] | null {
    const where = pane !== undefined && this.known(pane) ? this.panes.get(pane.pane_id)?.where : null;
    // a request reads nothing itself, however much was written since: the poll reads, in its shared budget
    return where ? readPlan(where.source, where.path, { left: 0 }) : null;
  }

  /** The pane's transcript is known, and was found for the session the pane runs now. */
  known(pane: HerdrPane): boolean {
    const tracked = this.panes.get(pane.pane_id);
    return tracked?.where != null && tracked.key === keyOf(pane);
  }

  /**
   * Follows the Claude Code and Codex panes of a snapshot; a pane that runs neither any more has
   * no plan. Nothing is read here: snapshots can come several times a second, reads come with the poll.
   */
  async refresh(panes: HerdrPane[]): Promise<void> {
    this.wanted.clear();
    this.refreshed = true;
    for (const pane of panes) if (pane.agent === "claude" || pane.agent === "codex") this.wanted.set(pane.pane_id, keyOf(pane));
    for (const [paneId, tracked] of this.panes) {
      if (this.wanted.has(paneId)) continue;
      this.panes.delete(paneId);
      if (tracked.summary !== null) this.deps.onChange(paneId, null);
    }
    await Promise.all(panes.map((pane) => this.ensure(pane)));
  }

  /**
   * One pane's transcript, looked up now if it is not known (or not known to be this session's).
   * `asked`: a request names the pane from a snapshot of its own, which the last refresh may not have seen yet.
   */
  async ensure(pane: HerdrPane, asked = false): Promise<void> {
    if (pane.agent !== "claude" && pane.agent !== "codex") return;
    const key = keyOf(pane);
    if (pane.agent === "claude") {
      const path = this.deps.claudePath(pane.pane_id);
      this.track(pane.pane_id, key, path === null ? null : { source: "claude-transcript", path });
      return;
    }
    const tracked = this.panes.get(pane.pane_id);
    const due = !tracked || tracked.key !== key || this.now() - tracked.at >= (tracked.where === null ? this.deps.retryMs ?? 15_000 : this.deps.relocateMs ?? 30_000);
    if (!due || this.looking.has(pane.pane_id)) return;
    this.looking.add(pane.pane_id);
    try {
      const path = await this.deps.codexPath(pane).catch(() => null);
      // the pane left, or runs another session, while it was looked up: what was found is not its
      if (!asked && this.refreshed && this.wanted.get(pane.pane_id) !== key) return;
      this.track(pane.pane_id, key, path === null ? null : { source: "codex-transcript", path });
    } finally {
      this.looking.delete(pane.pane_id);
    }
  }

  /** Where a pane's plan is now; what was read of the same file stands. */
  private track(paneId: string, key: string, where: { source: PlanSource; path: string } | null): void {
    const current = this.panes.get(paneId);
    const same = current !== undefined && current.where?.path === where?.path && current.where?.source === where?.source;
    this.panes.set(paneId, { key, at: this.now(), where, sig: same ? current.sig : null, summary: current?.summary ?? null });
  }

  /** Reads the transcripts that grew, PLAN_BUDGET bytes in all; a pane whose summary changed is told. */
  poll(): void {
    // ponytail: the budget goes to panes in the order they were first followed, so while a very large
    // transcript catches up the panes after it wait about size / PLAN_BUDGET polls; start each poll
    // where the last one stopped if that ever shows
    const budget = { left: PLAN_BUDGET };
    for (const [paneId, tracked] of this.panes) {
      let summary: PlanSummary | null = null;
      if (tracked.where !== null) {
        const stat = plain(tracked.where.path);
        const sig = stat === null ? null : `${stat.id}:${stat.size}`;
        if (sig !== null && sig === tracked.sig) continue;
        const read = planState(tracked.where.source, tracked.where.path, budget);
        // a file read only in part is read on at the next poll: its size is not taken as seen
        if (!read.behind) tracked.sig = sig;
        // still on its first read: what it shows is not known yet
        if (read.steps === null && read.behind) continue;
        summary = planSummary(read.steps);
      }
      if (JSON.stringify(summary) === JSON.stringify(tracked.summary)) continue;
      tracked.summary = summary;
      this.deps.onChange(paneId, summary);
    }
  }
}

const keyOf = (pane: HerdrPane): string => `${pane.agent}\0${pane.agent_session?.value ?? ""}\0${pane.cwd ?? ""}`;
