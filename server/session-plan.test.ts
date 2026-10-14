import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync, chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HerdrPane, PlanSummary } from "../shared/protocol.ts";
import { paneAfterStatus } from "./machines.ts";
import { forgetPlans, planSummary, readPlan, SessionPlans } from "./session-plan.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  forgetPlans();
});

const at = (minute: number): string => new Date(Date.parse("2026-10-07T00:00:00.000Z") + minute * 60_000).toISOString();
const json = (value: unknown): string => `${JSON.stringify(value)}\n`;

function file(name = "s.jsonl"): { path: string; add: (entry: unknown) => void } {
  const root = mkdtempSync(join(tmpdir(), "herdr-plan-"));
  roots.push(root);
  const path = join(root, name);
  writeFileSync(path, json({ type: "user", timestamp: at(0), message: { role: "user", content: "go" } }));
  return { path, add: (entry) => appendFileSync(path, json(entry)) };
}

/** A Claude transcript: each task call is an assistant tool_use, answered by a user tool_result as Claude Code 2.1.28x writes them. */
function claude() {
  const f = file();
  let call = 0;
  let next = 0;
  const use = (name: string, input: unknown, minute: number) => {
    const id = `toolu_${++call}`;
    f.add({ type: "assistant", timestamp: at(minute), message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
    return id;
  };
  return {
    path: f.path,
    add: f.add,
    create(subject: string, minute = 1, extra: Record<string, unknown> = {}): string {
      const toolId = use("TaskCreate", { subject, description: `do ${subject}`, ...extra }, minute);
      const id = String(++next);
      f.add({ type: "user", timestamp: at(minute), message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: `Task #${id} created successfully: ${subject}` }] }, toolUseResult: { task: { id, subject } } });
      return id;
    },
    update(input: Record<string, unknown>, minute = 1, answer: Record<string, unknown> = { success: true }, error = false): void {
      const toolId = use("TaskUpdate", input, minute);
      f.add({ type: "user", timestamp: at(minute), message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: error ? "<tool_use_error>Task not found</tool_use_error>" : `Updated task #${String(input["taskId"])}`, ...(error ? { is_error: true } : {}) }] }, toolUseResult: answer });
    },
  };
}

const steps = (path: string) => (readPlan("claude-transcript", path) ?? []).map((step) => `${step.id}:${step.status}:${step.blocked_by.join(",")}`);

describe("readPlan (Claude Code task list)", () => {
  it("rebuilds the tasks, their order and their progress from the task calls", () => {
    const s = claude();
    const a = s.create("Study", 1, { activeForm: "Studying" });
    const b = s.create("Build", 1);
    const c = s.create("Ship", 1);
    s.update({ taskId: b, addBlockedBy: [a] }, 1);
    // `addBlocks` is the same edge seen from the other end
    s.update({ taskId: b, addBlocks: [c] }, 1);
    s.update({ taskId: a, status: "in_progress" }, 2);
    s.update({ taskId: a, status: "completed" }, 5);
    s.update({ taskId: b, status: "in_progress", activeForm: "Building it" }, 6);
    expect(readPlan("claude-transcript", s.path)).toEqual([
      { id: "1", label: "Study", active: "Studying", status: "completed", blocked_by: [], owner: null, started_at: at(2), ended_at: at(5) },
      { id: "2", label: "Build", active: "Building it", status: "in_progress", blocked_by: ["1"], owner: null, started_at: at(6), ended_at: null },
      { id: "3", label: "Ship", active: null, status: "pending", blocked_by: ["2"], owner: null, started_at: null, ended_at: null },
    ]);
    expect(planSummary(readPlan("claude-transcript", s.path))).toEqual({ done: 1, total: 3, current: "Building it" });
  });

  it("reads only what was appended since, and follows a renamed, reassigned or deleted task", () => {
    const s = claude();
    const a = s.create("One");
    const b = s.create("Two");
    s.update({ taskId: b, addBlockedBy: [a] });
    expect(steps(s.path)).toEqual(["1:pending:", "2:pending:1"]);
    s.update({ taskId: a, subject: "First", owner: "researcher" });
    s.update({ taskId: a, status: "deleted" });
    expect(readPlan("claude-transcript", s.path)).toEqual([{ id: "2", label: "Two", active: null, status: "pending", blocked_by: [], owner: null, started_at: null, ended_at: null }]);
  });

  it("takes nothing from a failed call, an unknown task or a call never answered", () => {
    const s = claude();
    const a = s.create("One");
    s.update({ taskId: a, status: "completed" }, 2, { success: false });
    s.update({ taskId: a, status: "completed" }, 2, {}, true);
    s.update({ taskId: "99", status: "completed" }, 2);
    s.add({ type: "assistant", timestamp: at(3), message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_x", name: "TaskUpdate", input: { taskId: a, status: "completed" } }] } });
    expect(steps(s.path)).toEqual(["1:pending:"]);
  });

  it("starts a new plan with the first task created after every task was done, as Claude empties its list", () => {
    const s = claude();
    const a = s.create("Old");
    s.update({ taskId: a, status: "completed" }, 2);
    // a finished plan is still shown until another begins
    expect(planSummary(readPlan("claude-transcript", s.path))).toEqual({ done: 1, total: 1, current: null });
    s.create("New A", 3);
    s.create("New B", 3);
    expect(steps(s.path)).toEqual(["2:pending:", "3:pending:"]);
  });

  it("takes the id from the answer's words when the structured result is missing, and numeric ids", () => {
    const s = claude();
    s.add({ type: "assistant", timestamp: at(1), message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_a", name: "TaskCreate", input: { subject: "Plain" } }] } });
    s.add({ type: "user", timestamp: at(1), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_a", content: [{ type: "text", text: "Task #7 created successfully: Plain" }] }] } });
    s.add({ type: "assistant", timestamp: at(2), message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_b", name: "TaskUpdate", input: { taskId: 7, status: "in_progress" } }] } });
    s.add({ type: "user", timestamp: at(2), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_b", content: "Updated task #7 status" }] } });
    expect(steps(s.path)).toEqual(["7:in_progress:"]);
  });

  it("has no plan for a session that never used the task tools, and starts over on another file at the same path", () => {
    const s = claude();
    expect(readPlan("claude-transcript", s.path)).toBeNull();
    s.create("One");
    expect(steps(s.path)).toEqual(["1:pending:"]);
    writeFileSync(s.path, json({ type: "user", timestamp: at(9), message: { role: "user", content: "fresh" } }));
    expect(readPlan("claude-transcript", s.path)).toBeNull();
  });
});

describe("readPlan (Codex checklist)", () => {
  it("takes the last explicit checklist, each step after the one before", () => {
    const f = file("rollout.jsonl");
    f.add({ timestamp: at(1), type: "response_item", payload: { type: "function_call", name: "update_plan", call_id: "c1", arguments: JSON.stringify({ plan: [{ step: "Read", status: "in_progress" }, { step: "Fix", status: "pending" }] }) } });
    expect((readPlan("codex-transcript", f.path) ?? []).map((step) => `${step.id}:${step.status}:${step.blocked_by.join(",")}:${step.label}`)).toEqual(["1:in_progress::Read", "2:pending:1:Fix"]);
    f.add({ timestamp: at(4), type: "response_item", payload: { type: "function_call", name: "update_plan", call_id: "c4", arguments: JSON.stringify({ plan: [{ step: "Read", status: "completed" }, { step: "Fix", status: "in_progress" }, { step: "Ship", status: "pending" }] }) } });
    expect(readPlan("codex-transcript", f.path)).toEqual([
      // a step keeps when it started across checklists, found by its words
      { id: "1", label: "Read", active: null, status: "completed", blocked_by: [], owner: null, started_at: at(1), ended_at: at(4) },
      { id: "2", label: "Fix", active: null, status: "in_progress", blocked_by: ["1"], owner: null, started_at: at(4), ended_at: null },
      { id: "3", label: "Ship", active: null, status: "pending", blocked_by: ["2"], owner: null, started_at: null, ended_at: null },
    ]);
  });

  it("leaves the plan as it was for malformed arguments", () => {
    const f = file("rollout.jsonl");
    f.add({ timestamp: at(1), type: "response_item", payload: { type: "function_call", name: "update_plan", arguments: JSON.stringify({ plan: [{ step: "Only", status: "in_progress" }] }) } });
    f.add({ timestamp: at(2), type: "response_item", payload: { type: "function_call", name: "update_plan", arguments: "{plan: nope}" } });
    expect((readPlan("codex-transcript", f.path) ?? []).map((step) => step.label)).toEqual(["Only"]);
  });
});

describe("SessionPlans", () => {
  const pane = (pane_id: string, agent: string, session = "s1"): HerdrPane => ({ pane_id, agent, cwd: "/w", agent_session: { kind: "id", value: session } } as unknown as HerdrPane);

  it("keeps a remote PC's plan as its frames say", () => {
    const frame = (plan?: PlanSummary | null) => ({ type: "pane-status" as const, pane_id: "p1", agent_status: "working" as const, ...(plan === undefined ? {} : { plan }) });
    const planned = paneAfterStatus({ ...pane("p1", "claude"), background_tasks: 1 }, frame({ done: 1, total: 2, current: "Two" }));
    expect(planned).toMatchObject({ background_tasks: 1, plan: { done: 1, total: 2, current: "Two" } });
    expect(paneAfterStatus(planned, frame())).toMatchObject({ plan: { done: 1, total: 2 } });
    expect("plan" in paneAfterStatus(planned, frame(null))).toBe(false);
  });

  it("tells a pane's summary as its plan moves, reads nothing while its transcript is as it was, and clears it when the pane runs something else", async () => {
    const s = claude();
    const changes: [string, PlanSummary | null][] = [];
    let codexLookups = 0;
    const plans = new SessionPlans({ claudePath: (id) => id === "p1" ? s.path : null, codexPath: async () => { codexLookups++; return null; }, onChange: (id, summary) => changes.push([id, summary]) });
    const a = s.create("One", 1, { activeForm: "Doing one" });
    s.create("Two");
    await plans.refresh([pane("p1", "claude"), pane("p2", "codex"), pane("p3", "shell")]);
    // a snapshot reads nothing: the poll does
    expect(changes).toEqual([]);
    plans.poll();
    expect(changes).toEqual([["p1", { done: 0, total: 2, current: null }]]);
    expect(codexLookups).toBe(1);
    s.update({ taskId: a, status: "in_progress" }, 2);
    plans.poll();
    plans.poll();
    expect(changes.at(-1)).toEqual(["p1", { done: 0, total: 2, current: "Doing one" }]);
    expect(changes).toHaveLength(2);
    expect(plans.planOf(pane("p1", "claude"))?.map((step) => step.status)).toEqual(["in_progress", "pending"]);
    // a Codex pane whose rollout was not found is not asked again at once
    await plans.refresh([pane("p1", "claude"), pane("p2", "codex")]);
    expect(codexLookups).toBe(1);
    await plans.refresh([pane("p1", "shell"), pane("p2", "codex")]);
    expect(changes.at(-1)).toEqual(["p1", null]);
    expect(plans.summaryOf("p1")).toBeNull();
  });

  it("looks a Codex pane's rollout up again when its session changes", async () => {
    const f = file("rollout.jsonl");
    f.add({ timestamp: at(1), type: "response_item", payload: { type: "function_call", name: "update_plan", call_id: "c1", arguments: JSON.stringify({ plan: [{ step: "Go", status: "completed" }] }) } });
    const looked: string[] = [];
    const changes: (PlanSummary | null)[] = [];
    const plans = new SessionPlans({ claudePath: () => null, codexPath: async (p) => { looked.push(p.agent_session?.value ?? ""); return f.path; }, onChange: (_id, summary) => changes.push(summary) });
    await plans.refresh([pane("p2", "codex", "t1")]);
    plans.poll();
    await plans.refresh([pane("p2", "codex", "t1")]);
    await plans.refresh([pane("p2", "codex", "t2")]);
    plans.poll();
    expect(looked).toEqual(["t1", "t2"]);
    expect(changes).toEqual([{ done: 1, total: 1, current: null }]);
  });

  it("drops a Codex lookup that ends after its pane left", async () => {
    const f = file("rollout.jsonl");
    f.add({ timestamp: at(1), type: "response_item", payload: { type: "function_call", name: "update_plan", call_id: "c1", arguments: JSON.stringify({ plan: [{ step: "Go", status: "pending" }] }) } });
    let answer: (path: string) => void = () => {};
    const changes: (PlanSummary | null)[] = [];
    const plans = new SessionPlans({ claudePath: () => null, codexPath: () => new Promise((resolve) => { answer = resolve; }), onChange: (_id, summary) => changes.push(summary) });
    const looking = plans.refresh([pane("p2", "codex")]);
    await plans.refresh([pane("p2", "shell")]);
    answer(f.path);
    await looking;
    plans.poll();
    expect(plans.known(pane("p2", "codex"))).toBe(false);
    expect(changes).toEqual([]);
  });

  it("keeps a lookup a request asked for, for a pane the last snapshot had not seen yet", async () => {
    const f = file("rollout.jsonl");
    const plans = new SessionPlans({ claudePath: () => null, codexPath: async () => f.path, onChange: () => {} });
    await plans.refresh([]);
    await plans.ensure(pane("p3", "codex"), true);
    expect(plans.known(pane("p3", "codex"))).toBe(true);
  });

  it("tells a request the plan as the poll last read it, and reads nothing for it", async () => {
    const s = claude();
    s.create("One");
    const plans = new SessionPlans({ claudePath: () => s.path, codexPath: async () => null, onChange: () => {} });
    await plans.refresh([pane("p1", "claude")]);
    // no poll has read the transcript yet: a request does not read it
    expect(plans.planOf(pane("p1", "claude"))).toBeNull();
    plans.poll();
    expect(plans.planOf(pane("p1", "claude"))?.map((step) => step.label)).toEqual(["One"]);
    // what was written since, however much, is the next poll's to read
    s.create("Two", 2);
    expect(plans.planOf(pane("p1", "claude"))?.map((step) => step.label)).toEqual(["One"]);
    plans.poll();
    expect(plans.planOf(pane("p1", "claude"))?.map((step) => step.label)).toEqual(["One", "Two"]);
  });

  it("tells a plan only for the pane as herdr has it now, in the session its transcript was found for", async () => {
    const s = claude();
    s.create("One");
    const plans = new SessionPlans({ claudePath: () => s.path, codexPath: async () => null, onChange: () => {} });
    await plans.refresh([pane("p1", "claude")]);
    plans.poll();
    expect(plans.planOf(pane("p1", "claude"))?.map((step) => step.label)).toEqual(["One"]);
    // herdr did not say in time, or no longer has the pane: what was read for it is not told
    expect(plans.planOf(undefined)).toBeNull();
    // the pane runs another session now, not looked up yet
    expect(plans.planOf(pane("p1", "claude", "s2"))).toBeNull();
  });

  it("knows a pane's transcript only for the session it was found for", async () => {
    const f = file("rollout.jsonl");
    const plans = new SessionPlans({ claudePath: () => null, codexPath: async () => f.path, onChange: () => {} });
    await plans.refresh([pane("p2", "codex", "t1")]);
    expect(plans.known(pane("p2", "codex", "t1"))).toBe(true);
    // the pane runs another session, not looked up yet: the rollout of the one before is not its plan
    expect(plans.known(pane("p2", "codex", "t2"))).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)("reads a transcript it could not open again at the next poll, though its size is the same", () => {
    const s = claude();
    s.create("One");
    const changes: (PlanSummary | null)[] = [];
    const plans = new SessionPlans({ claudePath: () => s.path, codexPath: async () => null, onChange: (_id, summary) => changes.push(summary) });
    void plans.refresh([pane("p1", "claude")]);
    chmodSync(s.path, 0o000);
    try { plans.poll(); } finally { chmodSync(s.path, 0o644); }
    expect(changes).toEqual([]);
    plans.poll();
    expect(changes).toEqual([{ done: 0, total: 1, current: null }]);
  });

  it("reads at most its budget in one poll, and the rest at the next; a request in between reads none of it", () => {
    const big = claude();
    big.create("Far");
    // past the poll's budget: the plan is told only once the read reaches the end
    big.add({ type: "user", timestamp: at(2), message: { role: "user", content: "x".repeat(33 * 1024 * 1024) } });
    big.create("Near", 3);
    const changes: (PlanSummary | null)[] = [];
    const plans = new SessionPlans({ claudePath: () => big.path, codexPath: async () => null, onChange: (_id, summary) => changes.push(summary) });
    void plans.refresh([pane("p1", "claude")]);
    plans.poll();
    expect(changes).toEqual([]);
    // the first read is the poll's, in its shared budget: a request does not read on with a budget of its own
    expect(plans.planOf(pane("p1", "claude"))).toBeNull();
    plans.poll();
    expect(changes).toEqual([{ done: 0, total: 2, current: null }]);
    expect(plans.planOf(pane("p1", "claude"))?.map((step) => step.label)).toEqual(["Far", "Near"]);
  });
});

describe("readPlan edges", () => {
  it("is caught up on a transcript that ends inside a line, and takes the line once it is whole", () => {
    const s = claude();
    s.create("One");
    appendFileSync(s.path, '{"type":"assistant","timestamp":"2026-10-07T00:09:00.000Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_z","name":"TaskCreate","input":{"subject":"Two"}}]}}');
    expect(steps(s.path)).toEqual(["1:pending:"]);
    appendFileSync(s.path, `\n${JSON.stringify({ type: "user", timestamp: at(9), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_z", content: "Task #2 created successfully: Two" }] }, toolUseResult: { task: { id: "2", subject: "Two" } } })}\n`);
    expect(steps(s.path)).toEqual(["1:pending:", "2:pending:"]);
  });

  it("ignores code-mode output and patches that mention update_plan", () => {
    const f = file("rollout.jsonl");
    const call = (name: string, input: string) => ({ timestamp: at(1), type: "response_item", payload: { type: "custom_tool_call", status: "completed", call_id: "c", name, input } });
    f.add(call("apply_patch", "+ tools.update_plan({plan:[{step:'fixture',status:'completed'}]})"));
    f.add(call("exec", "await tools.update_plan({plan:[{step:'real',status:'pending'}]});"));
    f.add({ timestamp: at(2), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "tools.update_plan({plan:[{step:'output',status:'pending'}]})" }] } });
    expect(readPlan("codex-transcript", f.path)).toBeNull();
  });
});
