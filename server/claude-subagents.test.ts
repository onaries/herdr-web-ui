import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HerdrPane } from "../shared/protocol.ts";
import { BackgroundWait, WAIT_LIMIT_MS } from "./background-wait.ts";
import { ClaudeSubagentStatus, claudeSubagentState, claudeSubagents, forgetSubagents, lineNotifications, readLines, remember, subagentDetails, taskNotification, within } from "./claude-subagents.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  forgetSubagents();
});

const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const at = (minutes: number): string => new Date(NOW - 60 * 60 * 1000 + minutes * 60 * 1000).toISOString();
const json = (value: unknown): string => `${JSON.stringify(value)}\n`;

function session() {
  const root = mkdtempSync(join(tmpdir(), "herdr-subagents-"));
  roots.push(root);
  const path = join(root, "projects", "p", "11111111-1111-4111-8111-111111111111.jsonl");
  const dir = join(root, "projects", "p", "11111111-1111-4111-8111-111111111111", "subagents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, json({ type: "user", timestamp: at(0), message: { role: "user", content: "go" } }));
  return {
    path,
    parent: (entry: unknown) => appendFileSync(path, json(entry)),
    /** the pair of files of one subagent, its transcript as (minute, usage) steps */
    agent(id: string, options: { description?: string; type?: string; toolUseId?: string; shape?: string; steps?: [number, number][] } = {}) {
      writeFileSync(join(dir, `agent-${id}.meta.json`), JSON.stringify({ agentType: options.type ?? "reviewer", description: options.description ?? `task ${id}`, toolUseId: options.toolUseId ?? `toolu_${id}`, spawnDepth: 1, requestShape: options.shape ?? "background" }));
      const file = join(dir, `agent-${id}.jsonl`);
      writeFileSync(file, "");
      for (const [minute, output] of options.steps ?? [[1, 10], [2, 20]]) this.work(id, minute, output);
      return file;
    },
    work(id: string, minute: number, output: number, tools = 1) {
      const file = join(dir, `agent-${id}.jsonl`);
      appendFileSync(file, json({ isSidechain: true, agentId: id, type: "user", timestamp: at(minute), message: { role: "user", content: "x" } }));
      appendFileSync(file, json({ isSidechain: true, agentId: id, type: "assistant", timestamp: at(minute), message: { id: `m${minute}`, model: "claude-opus-5", usage: { input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: output }, content: Array.from({ length: tools }, () => ({ type: "tool_use", id: "t", name: "Read", input: {} })) } }));
    },
    /** a Bash call sent to the background, by the session or (`file`) by a subagent */
    bash(taskId: string, minute: number, options: { description?: string; command?: string; file?: string } = {}) {
      const write = (entry: unknown) => options.file ? appendFileSync(options.file, json({ isSidechain: true, ...(entry as object) })) : this.parent(entry);
      write({ type: "assistant", timestamp: at(minute), message: { role: "assistant", content: [{ type: "tool_use", id: `toolu_${taskId}`, name: "Bash", input: { command: options.command ?? "bun test", ...(options.description === undefined ? {} : { description: options.description }), run_in_background: true } }] } });
      write({ type: "user", timestamp: at(minute), message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${taskId}`, content: `Command running in background with ID: ${taskId}.` }] }, toolUseResult: { stdout: "", stderr: "", interrupted: false, isImage: false, backgroundTaskId: taskId } });
    },
    /** a prompt the person typed; `origin` as Claude Code 2.1.2xx writes it, none (only the permission mode) as older ones do */
    prompt(minute: number, origin: string | null = "human") {
      this.parent({ type: "user", timestamp: at(minute), permissionMode: "default", ...(origin === null ? {} : { origin: { kind: origin } }), message: { role: "user", content: "next" } });
    },
    notify(id: string, minute: number, options: { status?: string; toolUseId?: string; summary?: string; carriers?: ("user" | "queue" | "attachment")[] } = {}) {
      const block = `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>${options.toolUseId ?? `toolu_${id}`}</tool-use-id>\n<status>${options.status ?? "completed"}</status>\n<summary>${options.summary ?? `Agent "task ${id}" finished`}</summary>\n<result>the answer</result>\n</task-notification>`;
      const timestamp = at(minute);
      for (const carrier of options.carriers ?? ["queue", "user", "attachment"]) {
        this.parent(carrier === "queue" ? { type: "queue-operation", operation: "enqueue", timestamp, content: block }
          : carrier === "user" ? { type: "user", timestamp, message: { role: "user", content: block } }
            : { type: "attachment", timestamp, attachment: { type: "queued_command", commandMode: "task-notification", prompt: block } });
      }
    },
  };
}

const ids = (path: string, live = true) => claudeSubagents(path, live, NOW).map((task) => `${task.id}:${task.status}`);

describe("claudeSubagents", () => {
  it("lists a subagent nothing has ended as running, with what its transcript says", () => {
    const s = session();
    s.agent("a1", { description: "Review the parser", type: "reviewer", steps: [[1, 10], [2, 30]] });
    expect(claudeSubagents(s.path, true, NOW)).toEqual([{
      id: "a1", title: "Review the parser", category: "reviewer", model: "claude-opus-5", status: "running",
      started_at: at(1), ended_at: null, turns: 2, tool_calls: 2,
      // the last request held 2 + 100 + 5 + 30 tokens: not the sum of both requests
      tokens: 137,
    }]);
  });

  it("counts a notification once however many records carry it", () => {
    const s = session();
    s.agent("a1");
    s.notify("a1", 3);
    expect(claudeSubagents(s.path, true, NOW)).toMatchObject([{ id: "a1", status: "completed", ended_at: at(3) }]);
  });

  it("reads the status a notification gives: failed, and stopped as cancelled", () => {
    const s = session();
    s.agent("a1");
    s.agent("a2");
    s.notify("a1", 3, { status: "failed" });
    s.notify("a2", 4, { status: "killed", summary: 'Agent "task a2" was stopped by Claude' });
    expect(ids(s.path)).toEqual(["a2:cancelled", "a1:failed"]);
  });

  it("does not take a background command's notification for an agent's", () => {
    const s = session();
    s.agent("a1");
    s.notify("a1", 3, { summary: 'Background command "sleep" completed (exit code 0)' });
    expect(ids(s.path)).toEqual(["a1:running"]);
  });

  it("reads a subagent whose file has entries after its notification as running again", () => {
    const s = session();
    s.agent("a1");
    s.notify("a1", 3);
    expect(ids(s.path)).toEqual(["a1:completed"]);
    // resumed with another message: it works again, and its next notification ends it again
    s.work("a1", 5, 40);
    expect(ids(s.path)).toEqual(["a1:running"]);
    s.notify("a1", 6, { toolUseId: "toolu_resume" });
    expect(claudeSubagents(s.path, true, NOW)).toMatchObject([{ id: "a1", status: "completed", ended_at: at(6), turns: 3 }]);
  });

  it("ends a synchronous call by its tool_result, and not a background one", () => {
    const s = session();
    s.agent("sync", { shape: "foreground", toolUseId: "toolu_sync" });
    s.agent("bad", { shape: "foreground", toolUseId: "toolu_bad" });
    s.agent("bg", { toolUseId: "toolu_bg" });
    s.parent({ type: "assistant", timestamp: at(1), message: { role: "assistant", content: ["sync", "bad", "bg"].map((id) => ({ type: "tool_use", id: `toolu_${id}`, name: "Agent", input: {} })) } });
    // the launch of a background agent is answered at once too
    s.parent({ type: "user", timestamp: at(1), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_bg", content: "Async agent launched successfully" }] } });
    expect(ids(s.path).sort()).toEqual(["bad:running", "bg:running", "sync:running"]);
    s.parent({ type: "user", timestamp: at(4), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_sync", content: "answer" }] } });
    s.parent({ type: "user", timestamp: at(5), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_bad", content: "boom", is_error: true }] } });
    expect(claudeSubagents(s.path, true, NOW).map((task) => `${task.id}:${task.status}:${task.ended_at}`).sort()).toEqual([`bad:failed:${at(5)}`, "bg:running:null", `sync:completed:${at(4)}`].sort());
  });

  it("reads what is running as lost once the pane no longer runs Claude on the session", () => {
    const s = session();
    s.agent("a1", { steps: [[1, 10], [7, 10]] });
    s.agent("a2");
    s.notify("a2", 3);
    expect(claudeSubagents(s.path, false, NOW).map((task) => [task.id, task.status, task.ended_at])).toEqual([["a1", "lost", at(7)], ["a2", "completed", at(3)]]);
  });

  it("lists running first and at most ten that ended in the last day, newest first", () => {
    const s = session();
    for (let n = 0; n < 12; n++) {
      s.agent(`e${n}`, { steps: [[1, 1]] });
      s.notify(`e${n}`, 10 + n);
    }
    s.agent("old", { steps: [[-2001, 1]] });
    s.notify("old", -2000);
    s.agent("run", { steps: [[1, 1]] });
    expect(ids(s.path)).toEqual(["run:running", ...Array.from({ length: 10 }, (_, n) => `e${11 - n}:completed`)]);
  });

  it("passes over a subagent whose file has been quiet for more than a day", () => {
    const s = session();
    const file = s.agent("stale");
    s.agent("fresh");
    const old = new Date(NOW - 25 * 60 * 60 * 1000);
    utimesSync(file, old, old);
    expect(ids(s.path)).toEqual(["fresh:running"]);
  });

  it("reads only what a file gained, and nothing of one that did not change", () => {
    const s = session();
    const file = s.agent("a1");
    expect(claudeSubagents(s.path, true, NOW)[0]?.turns).toBe(2);
    // a torn last line is read once it is whole
    appendFileSync(file, '{"type":"assistant","timestamp":"');
    expect(claudeSubagents(s.path, true, NOW)[0]?.turns).toBe(2);
    appendFileSync(file, `${at(9)}","message":{"id":"m9","content":[]}}\n`);
    expect(claudeSubagents(s.path, true, NOW)[0]?.turns).toBe(3);
    // the same answer from a cold read
    const warm = claudeSubagents(s.path, true, NOW);
    forgetSubagents();
    expect(claudeSubagents(s.path, true, NOW)).toEqual(warm);
  });

  it("reads a large subagent file over several calls, a budget at a time", () => {
    const s = session();
    const file = s.agent("big", { steps: [] });
    const line = json({ type: "assistant", timestamp: at(1), message: { id: "x", content: [], padding: "p".repeat(1000) } });
    const turn = (n: number) => line.replace('"id":"x"', `"id":"m${n}"`);
    // 10 MB of lines, each a request of its own
    writeFileSync(file, Array.from({ length: 10_000 }, (_, n) => turn(n)).join(""));
    const first = claudeSubagents(s.path, true, NOW)[0]!.turns;
    // a count that is not the whole is not shown as one
    expect(first).toBeNull();
    expect(claudeSubagents(s.path, true, NOW)[0]!.turns).toBe(10_000);
  });

  it("does not take an agent for running when the part of the transcript read starts after it went quiet", () => {
    const s = session();
    s.agent("quiet", { steps: [[1, 1]] });
    s.agent("busy", { steps: [[1, 1]] });
    // 17 MB of an older conversation is out of reach: only its last 16 MB is read
    writeFileSync(s.path, "");
    const filler = json({ type: "user", timestamp: at(2), message: { role: "user", content: "f".repeat(1000) } });
    writeFileSync(s.path, filler.repeat(17_000));
    s.parent({ type: "user", timestamp: at(30), message: { role: "user", content: "later" } });
    s.work("busy", 31, 1);
    s.notify("busy", 32);
    // the first read takes the whole window: no call before the notice is reached says "running"
    expect(ids(s.path)).toEqual(["busy:completed"]);
  });

  it("has nothing for a session with no subagents folder, or files that are not records", () => {
    const s = session();
    expect(ids(join(s.path, "..", "none.jsonl"))).toEqual([]);
    writeFileSync(join(s.path, "..", "11111111-1111-4111-8111-111111111111", "subagents", "agent-x.meta.json"), "{ torn");
    writeFileSync(join(s.path, "..", "11111111-1111-4111-8111-111111111111", "subagents", "agent-x.jsonl"), "not json\n");
    expect(ids(s.path)).toEqual([]);
  });
});

describe("subagentDetails", () => {
  it("answers for the agents asked about", () => {
    const s = session();
    s.agent("a1", { description: "Review the parser", type: "reviewer", steps: [[1, 10], [2, 30]] });
    s.agent("a2");
    expect([...subagentDetails(s.path, ["a1", "gone"])]).toEqual([["a1", { title: "Review the parser", agent: "reviewer" }]]);
  });
});

describe("taskNotification", () => {
  it("does not report a truncated envelope as completed", () => {
    expect(taskNotification('<task-notification><task-id>a1</task-id><status>completed</status><summary>Agent "review" finished</summary>')).toBeNull();
  });

  it("reads a block, its result to the last closing tag", () => {
    expect(taskNotification('<task-notification>\n<task-id>a</task-id>\n<status>stopped</status>\n<summary>Agent "x" was stopped by Claude</summary>\n<result>see </result> here</result>\n</task-notification>')).toEqual({
      taskId: "a", toolUseId: null, status: "cancelled", summary: 'Agent "x" was stopped by Claude', result: "see </result> here", agent: true,
    });
    expect(taskNotification("hello")).toBeNull();
  });
});

describe("ClaudeSubagentStatus", () => {
  const pane = (id: string, agent: string | null, session = "s1"): HerdrPane => ({ pane_id: id, agent, agent_session: { agent: agent ?? "", kind: "id", source: "hook", value: session }, cwd: "/work", agent_status: "idle", focused: false, revision: 1 }) as HerdrPane;

  it("adopts a delayed transcript without losing the observed rest or renewing its deadline", async () => {
    for (const order of ["early", "late", "baseline", "expired"] as const) {
      const s = session();
      s.prompt(1);
      s.bash("suite", 2);
      let now = NOW;
      const waits = new BackgroundWait(() => now);
      let resolve!: (value: { path: string; startedAt: null }) => void;
      const pending = new Promise<{ path: string; startedAt: null }>((done) => { resolve = done; });
      const status = new ClaudeSubagentStatus({ resolve: () => pending, now: () => now,
        onReset: (id) => waits.reset(id), onChange: (id, _, running, prompt) => { waits.running(id, running, prompt); } });
      waits.status("p1", order === "baseline" ? "done" : "working");
      const refresh = status.refresh([pane("p1", "claude")]);
      if (order === "early") { resolve({ path: s.path, startedAt: null }); await refresh; }
      status.poll("p1");
      waits.status("p1", "done");
      now += order === "expired" ? WAIT_LIMIT_MS : WAIT_LIMIT_MS - 1;
      if (order !== "early") { resolve({ path: s.path, startedAt: null }); await refresh; }
      waits.tick();
      expect(status.countOf("p1")).toBe(1);
      expect(waits.waiting("p1")).toBe(order === "early" || order === "late");
      now++;
      waits.tick();
      expect(waits.waiting("p1")).toBe(false);
      status.stop();
    }
  });

  it("forgets old transition evidence when a session changes during discovery, but keeps the new session's observations", async () => {
    const s = session();
    s.prompt(1);
    s.bash("suite", 2);
    const waits = new BackgroundWait(() => NOW);
    let resolve!: (value: { path: string; startedAt: null }) => void;
    const pending = new Promise<{ path: string; startedAt: null }>((done) => { resolve = done; });
    const status = new ClaudeSubagentStatus({ resolve: () => pending, now: () => NOW,
      onReset: (id) => waits.reset(id), onChange: (id, _, running, prompt) => { waits.running(id, running, prompt); } });
    const first = status.refresh([pane("p1", "claude", "s1")]);
    waits.status("p1", "working");
    waits.status("p1", "done");
    const next = status.refresh([pane("p1", "claude", "s2")]);
    resolve({ path: s.path, startedAt: null });
    await Promise.all([first, next]);
    expect(status.countOf("p1")).toBe(1);
    expect(waits.waiting("p1")).toBe(false);
    waits.status("p1", "working");
    waits.status("p1", "done");
    expect(waits.waiting("p1")).toBe(true);
    await status.refresh([pane("p1", "claude", "s3")]);
    expect(status.countOf("p1")).toBe(1);
    expect(waits.waiting("p1")).toBe(false);
  });

  it("retains the latest pane status, but no old hold, across asynchronous process replacement", async () => {
    for (const latest of ["working", "done"] as const) {
      const s = session();
      s.prompt(1);
      s.bash("suite", 2);
      let now = NOW;
      let pid = 1;
      const waits = new BackgroundWait(() => now);
      const replacement = Promise.withResolvers<{ path: string; startedAt: number; pid: number }>();
      const status = new ClaudeSubagentStatus({
        resolve: () => pid === 1 ? Promise.resolve({ path: s.path, startedAt: Date.parse(at(0)), pid }) : replacement.promise,
        pid: async () => pid, now: () => now, refreshMs: 1000,
        onReset: (id) => waits.reset(id),
        onChange: (id, _, running, prompt) => { waits.running(id, running, prompt); },
      });
      await status.refresh([pane("p1", "claude")]);
      waits.status("p1", "working");
      waits.status("p1", "done");
      expect(waits.waiting("p1")).toBe(true);
      now += 1000;
      pid = 2;
      const refreshing = status.refresh([pane("p1", "claude")]);
      waits.status("p1", latest);
      replacement.resolve({ path: s.path, startedAt: Date.parse(at(0)) + 1, pid });
      await refreshing;
      expect(status.countOf("p1")).toBe(1);
      expect(waits.waiting("p1")).toBe(false);
      waits.seed("p1", latest === "working" ? "done" : "working");
      now += 1000;
      waits.status("p1", "done");
      expect(waits.waiting("p1")).toBe(latest === "working");
      now += WAIT_LIMIT_MS - 1;
      waits.tick();
      expect(waits.waiting("p1")).toBe(latest === "working");
      now++;
      waits.tick();
      expect(waits.waiting("p1")).toBe(false);
    }
  });

  it("rereads a same-size replaced parent and a replaced subagent directory", async () => {
    const s = session();
    const old = new Date(Date.now() - 5000);
    const now = Date.now() + 5000;
    const launch = (id: string) => json({ type: "user", timestamp: at(1), toolUseResult: { backgroundTaskId: id }, message: { content: [] } });
    writeFileSync(s.path, launch("one"));
    utimesSync(s.path, old, old);
    const status = new ClaudeSubagentStatus({ resolve: async () => ({ path: s.path, startedAt: null }), onChange: () => {}, now: () => now });
    await status.refresh([pane("p1", "claude")]);
    status.poll();
    expect(status.countOf("p1")).toBe(1);
    writeFileSync(`${s.path}.new`, launch("two"));
    utimesSync(`${s.path}.new`, old, old);
    renameSync(`${s.path}.new`, s.path);
    status.poll();
    s.notify("two", 3, { summary: "Background command ended" });
    status.poll();
    expect(status.countOf("p1")).toBe(0);
    const dir = join(s.path.replace(/\.jsonl$/, ""), "subagents");
    s.agent("a1");
    utimesSync(dir, old, old);
    status.poll();
    status.poll();
    expect(status.countOf("p1")).toBe(1);
    renameSync(dir, `${dir}.old`);
    mkdirSync(dir);
    s.agent("a2");
    s.agent("a3");
    utimesSync(join(dir, "agent-a2.meta.json"), old, old);
    utimesSync(dir, old, old);
    status.poll();
    expect(status.countOf("p1")).toBe(2);
    s.parent({ type: "assistant", timestamp: at(1), message: { content: [{ type: "tool_use", id: "toolu_a2", name: "Agent", input: {} }] } });
    s.parent({ type: "user", timestamp: at(4), message: { content: [{ type: "tool_result", tool_use_id: "toolu_a2", content: "done" }] } });
    status.poll();
    expect(status.countOf("p1")).toBe(1);
    // Reuse the agent ID and metadata size/mtime, but not the completed call's identity.
    renameSync(dir, `${dir}.second`);
    mkdirSync(dir);
    s.agent("a2", { toolUseId: "toolu_b2" });
    s.agent("a3");
    utimesSync(join(dir, "agent-a2.meta.json"), old, old);
    utimesSync(dir, old, old);
    status.poll();
    expect(status.countOf("p1")).toBe(2);
    rmSync(join(dir, "agent-a2.meta.json"));
    status.poll();
    expect(status.countOf("p1")).toBe(1);
  });

  it("expires unchanged agent files exactly after a day, while newer agents remain counted", async () => {
    const s = session();
    const old = Date.now() - 5000;
    for (const [id, stamp] of [["old", old], ["new", old + 2000]] as const) {
      const file = s.agent(id);
      utimesSync(file, new Date(stamp), new Date(stamp));
    }
    let now = old + 10000;
    const status = new ClaudeSubagentStatus({ resolve: async () => ({ path: s.path, startedAt: null }), onChange: () => {}, now: () => now });
    await status.refresh([pane("p1", "claude")]);
    status.poll();
    expect(status.countOf("p1")).toBe(2);
    now = old + 24 * 60 * 60 * 1000;
    status.poll();
    expect(status.countOf("p1")).toBe(2);
    now++;
    status.poll();
    expect(status.countOf("p1")).toBe(1);
    expect(claudeSubagents(s.path, true, now).map((task) => task.id)).toEqual(["new"]);
  });

  it("counts a Claude pane's running subagents and says only when the count changes", async () => {
    const s = session();
    s.agent("a1", { steps: [[1, 1]] });
    s.agent("a2", { steps: [[1, 1]] });
    const told: [string, number][] = [];
    const looked: string[] = [];
    const status = new ClaudeSubagentStatus({ resolve: async (p) => { looked.push(p.pane_id); return { path: s.path, startedAt: null }; }, onChange: (paneId, running) => told.push([paneId, running]), now: () => NOW });
    await status.refresh([pane("p1", "claude"), pane("p2", "codex"), pane("p3", null)]);
    expect(told).toEqual([["p1", 2]]);
    expect(status.countOf("p1")).toBe(2);
    // the same session is not looked up again, and an unchanged count is not told again
    await status.refresh([pane("p1", "claude"), pane("p2", "codex")]);
    status.poll();
    s.notify("a1", 3);
    status.poll();
    expect(looked).toEqual(["p1"]);
    expect(told).toEqual([["p1", 2], ["p1", 1]]);
    expect(status.countOf("p2")).toBe(0);
    expect(status.sessionOf("p2")).toBeNull();
  });

  it("reads a pane that stopped running Claude as having nothing running, and its subagents as lost", async () => {
    const s = session();
    s.agent("a1", { steps: [[1, 1]] });
    const told: [string, number][] = [];
    const status = new ClaudeSubagentStatus({ resolve: async () => ({ path: s.path, startedAt: null }), onChange: (paneId, running) => told.push([paneId, running]), now: () => NOW });
    await status.refresh([pane("p1", "claude")]);
    expect(status.sessionOf("p1")).toEqual({ path: s.path, live: true, startedAt: null });
    await status.refresh([pane("p1", null)]);
    expect(told).toEqual([["p1", 1], ["p1", 0]]);
    expect(status.sessionOf("p1")).toEqual({ path: s.path, live: false, startedAt: null });
    // gone with the pane
    await status.refresh([]);
    expect(status.sessionOf("p1")).toBeNull();
  });

  it("looks again when the pane's session changes, and for a transcript that was not there yet", async () => {
    const s = session();
    s.agent("a1", { steps: [[1, 1]] });
    let calls = 0;
    let at = 0;
    const status = new ClaudeSubagentStatus({ resolve: async () => (++calls === 1 ? null : { path: s.path, startedAt: null }), onChange: () => undefined, now: () => at, refreshMs: 1000 });
    await status.refresh([pane("p1", "claude")]);
    expect([calls, status.sessionOf("p1")]).toEqual([1, null]);
    await status.refresh([pane("p1", "claude")]);
    expect(calls).toBe(1);
    at = 1000;
    await status.refresh([pane("p1", "claude")]);
    expect([calls, status.countOf("p1")]).toEqual([2, 1]);
    await status.refresh([pane("p1", "claude", "s2")]);
    expect([calls, status.countOf("p1")]).toEqual([3, 1]);
  });
});

describe("claudeSubagents reading", () => {
  const assistant = (id: string, pad = "") => json({ type: "assistant", timestamp: at(1), message: { id, model: "claude-opus-5", content: [], pad } });

  it("keeps a failed open or read unfinished instead of reporting the end of the file", () => {
    const s = session();
    for (const path of [join(s.path, "..", "missing.jsonl"), join(s.path, "..")]) {
      expect(readLines(path, 0, 10, 10, () => { throw new Error("no line should be read"); }, false)).toEqual({ offset: 0, skipping: false, more: true, failed: true });
    }
  });

  it("waits for a share of the budget that fits a file's first line, and never jumps to the end of it", () => {
    const s = session();
    const big = s.agent("big", { steps: [] });
    const next = s.agent("next", { steps: [] });
    // `big` takes all but a little of the budget; `next` starts with a line larger than what is left
    writeFileSync(big, Array.from({ length: 7_900 }, (_, n) => assistant(`b${n}`, "p".repeat(1000))).join(""));
    writeFileSync(next, assistant("n1", "q".repeat(400_000)));
    utimesSync(big, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    const turns = () => claudeSubagents(s.path, true, NOW).find((task) => task.id === "next")?.turns;
    // a whole file of one entry too long to tell its end from: not listed until it is read
    expect(turns()).toBeUndefined();
    expect(turns()).toBe(1);
    expect(claudeSubagents(s.path, true, NOW).find((task) => task.id === "next")?.model).toBe("claude-opus-5");
  });

  it("skips a line longer than the whole budget, and not what follows it", () => {
    const s = session();
    const file = s.agent("a1", { steps: [] });
    writeFileSync(file, assistant("m0", "x".repeat(9 * 1024 * 1024)) + assistant("m1"));
    claudeSubagents(s.path, true, NOW);
    expect(claudeSubagents(s.path, true, NOW)[0]?.turns).toBe(1);
    // the same of the parent: an 9 MB entry (an image) does not swallow the notice after it
    s.parent({ type: "user", timestamp: at(2), message: { role: "user", content: "i".repeat(9 * 1024 * 1024) } });
    s.notify("a1", 3);
    expect(ids(s.path)).toEqual(["a1:completed"]);
  });

  it("reads a synchronous agent's answer that quotes the tag, and an entry that holds an answer and a notice", () => {
    const s = session();
    for (const id of ["q", "batch", "bg"]) s.agent(id, { shape: id === "bg" ? "background" : "foreground", toolUseId: `toolu_${id}` });
    s.parent({ type: "assistant", timestamp: at(1), message: { role: "assistant", content: ["q", "batch"].map((id) => ({ type: "tool_use", id: `toolu_${id}`, name: "Agent", input: { note: "<task-notification>" } })) } });
    const quoted = '<task-notification>\n<task-id>x</task-id>\n<status>completed</status>\n<summary>Agent "x" finished</summary>\n</task-notification>';
    s.parent({ type: "user", timestamp: at(4), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_q", content: `it said ${quoted}` }] } });
    // one entry: the answer of one agent beside the notice of another
    s.parent({ type: "user", timestamp: at(5), message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "toolu_batch", content: "done" },
      { type: "text", text: quoted.replace("<task-id>x", "<task-id>bg").replace('"x"', '"task bg"') },
    ] } });
    expect(ids(s.path).sort()).toEqual(["batch:completed", "bg:completed", "q:completed"]);
  });

  it("takes whichever of the answer and the notice is newest, and the acknowledgement of a launch for neither", () => {
    const s = session();
    s.agent("sync", { shape: "foreground", toolUseId: "toolu_sync" });
    // no requestShape at all: the immediate acknowledgement does not end a background agent
    s.agent("noshape", { shape: "", toolUseId: "toolu_noshape" });
    s.parent({ type: "assistant", timestamp: at(1), message: { role: "assistant", content: ["sync", "noshape"].map((id) => ({ type: "tool_use", id: `toolu_${id}`, name: "Agent", input: {} })) } });
    s.parent({ type: "user", timestamp: at(1), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_noshape", content: [{ type: "text", text: "Async agent launched successfully.\nagentId: noshape" }] }] } });
    s.parent({ type: "user", timestamp: at(3), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_sync", content: "answer" }] } });
    expect(ids(s.path).sort()).toEqual(["noshape:running", "sync:completed"]);
    // resumed with a message: running again until it notifies, and then that notice is the end
    s.work("sync", 6, 5);
    expect(ids(s.path).sort()).toEqual(["noshape:running", "sync:running"]);
    s.notify("sync", 8, { toolUseId: "toolu_resumed" });
    expect(claudeSubagents(s.path, true, NOW).find((task) => task.id === "sync")).toMatchObject({ status: "completed", ended_at: at(8) });
  });

  it("reads an agent last written before the Claude process now in the pane started as lost", () => {
    const s = session();
    s.agent("old", { steps: [[1, 1], [7, 1]] });
    s.agent("new", { steps: [[1, 1], [12, 1]] });
    const states = (since: number | null) => claudeSubagents(s.path, true, NOW, since).map((task) => `${task.id}:${task.status}`).sort();
    expect(states(null)).toEqual(["new:running", "old:running"]);
    expect(states(Date.parse(at(10)))).toEqual(["new:running", "old:lost"]);
    expect(claudeSubagents(s.path, true, NOW, Date.parse(at(10))).find((task) => task.id === "old")?.ended_at).toBe(at(7));
  });

  it("never turns an id from a transcript into a path outside the folder", () => {
    const s = session();
    writeFileSync(join(s.path, "..", "secret.meta.json"), JSON.stringify({ description: "secret", agentType: "x" }));
    expect([...subagentDetails(s.path, ["x/../../../secret", "..", "a/b"])]).toEqual([]);
    const block = (id: string) => `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n<summary>Agent "x" finished</summary>\n</task-notification>`;
    expect(taskNotification(block("x/../../../secret"))).toBeNull();
    // a line that only mentions the tag, in a tool result, is no notification
    const result = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: block("fine") }] } });
    expect(lineNotifications(result)).toEqual([]);
    expect(lineNotifications(JSON.stringify({ type: "user", message: { role: "user", content: block("fine") } }))).toHaveLength(1);
  });

  it("sees an agent added to the folder", () => {
    const s = session();
    s.agent("a1");
    expect(ids(s.path)).toEqual(["a1:running"]);
    s.agent("a2");
    expect(ids(s.path).sort()).toEqual(["a1:running", "a2:running"]);
  });
});

describe("ClaudeSubagentStatus upkeep", () => {
  const pane = (agent: string | null, session = "s1"): HerdrPane => ({ pane_id: "p1", agent, agent_session: { agent: agent ?? "", kind: "id", source: "hook", value: session }, cwd: "/work", agent_status: "idle", focused: false, revision: 1 }) as HerdrPane;

  it("looks up new panes from the newest snapshot after an in-flight refresh", async () => {
    const one = session();
    const latest = session();
    latest.agent("a1");
    const lookup = Promise.withResolvers<{ path: string; startedAt: null }>();
    const looked: string[] = [];
    const status = new ClaudeSubagentStatus({
      resolve: (p) => {
        looked.push(p.pane_id);
        return p.pane_id === "p1" ? lookup.promise : Promise.resolve({ path: latest.path, startedAt: null });
      },
      onChange: () => undefined, now: () => NOW,
    });
    const original = pane("claude");
    const pending = status.refresh([original]);
    const superseded = status.refresh([original, { ...pane("claude", "s2"), pane_id: "p2" }]);
    const current = status.refresh([original, { ...pane("claude", "s3"), pane_id: "p3" }]);
    lookup.resolve({ path: one.path, startedAt: null });
    await Promise.all([pending, superseded, current]);
    expect(looked).toEqual(["p1", "p3"]);
    expect(status.sessionOf("p2")).toBeNull();
    expect(status.sessionOf("p3")?.path).toBe(latest.path);
    expect(status.countOf("p3")).toBe(1);
  });

  it("discards queued snapshots when the tracker stops", async () => {
    const s = session();
    const lookup = Promise.withResolvers<{ path: string; startedAt: null }>();
    const looked: string[] = [];
    const status = new ClaudeSubagentStatus({ resolve: (p) => { looked.push(p.pane_id); return lookup.promise; }, onChange: () => undefined });
    const pending = status.refresh([pane("claude")]);
    const queued = status.refresh([{ ...pane("claude", "s2"), pane_id: "p2" }]);
    status.stop();
    lookup.resolve({ path: s.path, startedAt: null });
    await Promise.all([pending, queued]);
    expect(looked).toEqual(["p1"]);
    expect(status.sessionOf("p1")).toBeNull();
    expect(status.sessionOf("p2")).toBeNull();
  });

  it("does not let an older lookup overwrite a newer session", async () => {
    const old = session();
    const current = session();
    const lookup = Promise.withResolvers<{ path: string; startedAt: null }>();
    const status = new ClaudeSubagentStatus({ resolve: (p) => p.agent_session?.value === "old" ? lookup.promise : Promise.resolve({ path: current.path, startedAt: null }), onChange: () => undefined });
    const pending = status.ensure(pane("claude", "old"));
    await status.ensure(pane("claude", "new"));
    lookup.resolve({ path: old.path, startedAt: null });
    await pending;
    expect(status.sessionOf("p1")?.path).toBe(current.path);
  });

  it("does not restore Claude after the pane changed agent during a lookup", async () => {
    const s = session();
    const lookup = Promise.withResolvers<{ path: string; startedAt: null }>();
    const status = new ClaudeSubagentStatus({ resolve: () => lookup.promise, onChange: () => undefined });
    const pending = status.ensure(pane("claude"));
    await status.ensure(pane("codex"));
    lookup.resolve({ path: s.path, startedAt: null });
    await pending;
    expect(status.sessionOf("p1")).toBeNull();
  });

  it("does not restore a closed pane when its snapshot lookup finishes", async () => {
    const s = session();
    const lookup = Promise.withResolvers<{ path: string; startedAt: null }>();
    const status = new ClaudeSubagentStatus({ resolve: () => lookup.promise, onChange: () => undefined });
    const pending = status.refresh([pane("claude")]);
    const closed = status.refresh([]);
    lookup.resolve({ path: s.path, startedAt: null });
    await Promise.all([pending, closed]);
    expect(status.sessionOf("p1")).toBeNull();
  });

  it("does not finish a pending lookup after the tracker stops", async () => {
    const s = session();
    const lookup = Promise.withResolvers<{ path: string; startedAt: null }>();
    const status = new ClaudeSubagentStatus({ resolve: () => lookup.promise, onChange: () => undefined });
    const pending = status.ensure(pane("claude"));
    status.stop();
    lookup.resolve({ path: s.path, startedAt: null });
    await pending;
    expect(status.sessionOf("p1")).toBeNull();
  });

  it("tells a drop to nothing when the pane moves to another session", async () => {
    const one = session();
    one.agent("a1", { steps: [[1, 1]] });
    const two = session();
    const told: number[] = [];
    let path = one.path;
    const status = new ClaudeSubagentStatus({ resolve: async () => ({ path, startedAt: null }), onChange: (_, running) => told.push(running), now: () => NOW });
    await status.refresh([pane("claude", "s1")]);
    path = two.path;
    await status.refresh([pane("claude", "s2")]);
    expect(told).toEqual([1, 0]);
    expect(status.countOf("p1")).toBe(0);
  });

  it("sees an agent that ended resume by its own file, though nothing else of the session was written", async () => {
    const s = session();
    const file = s.agent("a1", { steps: [[1, 1]] });
    s.notify("a1", 3);
    const now = Date.now();
    const old = new Date(now - 5000);
    const dir = join(s.path.replace(/\.jsonl$/, ""), "subagents");
    for (const path of [file, s.path, dir]) utimesSync(path, old, old);
    const told: number[] = [];
    const status = new ClaudeSubagentStatus({ resolve: async () => ({ path: s.path, startedAt: 42 }), onChange: (_, running) => told.push(running), now: () => now });
    await status.refresh([pane("claude")]);
    expect(status.sessionOf("p1")).toEqual({ path: s.path, live: true, startedAt: 42 });
    status.poll();
    expect(told).toEqual([]);
    // a message to it was written before, and the session is idle: only its own file moves
    s.work("a1", 5, 1);
    // An append can share the previous write's coarse filesystem clock tick.
    utimesSync(file, old, old);
    status.poll();
    expect(told).toEqual([1]);
  });

  it("sees a running agent end by its own file while the parent and folder stay quiet", async () => {
    const s = session();
    const file = s.agent("a1", { steps: [[1, 1]] });
    const now = Date.now();
    const old = new Date(now - 5000);
    const dir = join(s.path.replace(/\.jsonl$/, ""), "subagents");
    for (const path of [file, s.path, dir]) utimesSync(path, old, old);
    const told: number[] = [];
    const status = new ClaudeSubagentStatus({ resolve: async () => ({ path: s.path, startedAt: null }), onChange: (_, running) => told.push(running), now: () => now });
    await status.refresh([pane("claude")]);
    expect(told).toEqual([1]);
    appendFileSync(file, json({ type: "assistant", timestamp: at(3), message: { id: "end", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } }));
    utimesSync(file, old, old);
    status.poll();
    expect(told).toEqual([1, 0]);
  });

  it("does not read again while nothing it watches changed", async () => {
    const s = session();
    const file = s.agent("a1", { steps: [[1, 1]] });
    const now = Date.now();
    const old = new Date(now - 5000);
    for (const path of [file, s.path, join(s.path.replace(/\.jsonl$/, ""), "subagents")]) utimesSync(path, old, old);
    let looked = 0;
    const status = new ClaudeSubagentStatus({ resolve: async () => ({ path: s.path, startedAt: null }), onChange: () => { looked += 1; }, now: () => now });
    await status.refresh([pane("claude")]);
    expect(looked).toBe(1);
    // An unchanged poll does not notify again.
    status.poll();
    expect(looked).toBe(1);
  });

  it("finds a pane's transcript on demand", async () => {
    const s = session();
    const status = new ClaudeSubagentStatus({ resolve: async () => ({ path: s.path, startedAt: null }), onChange: () => undefined, now: () => NOW });
    expect(status.sessionOf("p1")).toBeNull();
    await status.ensure(pane("claude"));
    expect(status.sessionOf("p1")?.path).toBe(s.path);
    await status.ensure({ ...pane("codex"), pane_id: "p2" });
    expect(status.sessionOf("p2")).toBeNull();
  });
});

describe("remember", () => {
  it("drops the oldest entry over the cap, one at a time, and a touched one is the newest", () => {
    const map = new Map<string, number>();
    for (const key of ["a", "b", "c"]) remember(map, key, 1, 3);
    remember(map, "a", 2, 3);
    remember(map, "d", 1, 3);
    expect([...map.keys()]).toEqual(["c", "a", "d"]);
  });
});

describe("claudeSubagents reading, upkeep", () => {
  const assistant = (id: string, pad = "") => json({ type: "assistant", timestamp: at(1), message: { id, model: "claude-opus-5", content: [], pad } });

  it("reads the line after a skipped over-budget line from its start", () => {
    const s = session();
    s.agent("a1", { steps: [[1, 1]] });
    expect(ids(s.path)).toEqual(["a1:running"]);
    // a 10 MB entry, then a 7 MB notification that crosses the read after the skipped line's end
    s.parent({ type: "user", timestamp: at(2), message: { role: "user", content: "i".repeat(10 * 1024 * 1024) } });
    const block = `<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n<summary>Agent "task a1" finished</summary>\n<result>${"r".repeat(7 * 1024 * 1024)}</result>\n</task-notification>`;
    s.parent({ type: "queue-operation", operation: "enqueue", timestamp: at(3), content: block });
    ids(s.path);
    expect(ids(s.path)).toEqual(["a1:completed"]);
  });

  it("gives a file that waited for budget the whole of it next time, though others are newer and large", () => {
    const s = session();
    const big = s.agent("big", { steps: [] });
    const next = s.agent("next", { steps: [] });
    writeFileSync(big, Array.from({ length: 20_000 }, (_, n) => assistant(`b${n}`, "p".repeat(1000))).join(""));
    writeFileSync(next, assistant("n1", "q".repeat(400_000)));
    utimesSync(big, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    const turns = () => claudeSubagents(s.path, true, NOW).find((task) => task.id === "next")?.turns;
    // a whole file of one entry too long to tell its end from: not listed until it is read
    expect(turns()).toBeUndefined();
    expect(turns()).toBe(1);
  });

  it("keeps what an agent was read as while the transcript is read in parts", () => {
    const s = session();
    s.agent("a1", { steps: [[1, 1]] });
    s.agent("a2", { steps: [[1, 1]] });
    s.notify("a2", 3);
    expect(ids(s.path).sort()).toEqual(["a1:running", "a2:completed"]);
    // more than the first read takes arrives at once
    appendFileSync(s.path, json({ type: "user", timestamp: at(4), message: { role: "user", content: "f".repeat(1000) } }).repeat(30_000));
    const state = claudeSubagentState(s.path, true, NOW);
    expect(state.settled).toBe(false);
    expect(state.tasks.map((task) => `${task.id}:${task.status}`).sort()).toEqual(["a1:running", "a2:completed"]);
  });

  it("is not settled while a meta file is torn", () => {
    const s = session();
    s.agent("a1");
    const meta = join(s.path, "..", "11111111-1111-4111-8111-111111111111", "subagents", "agent-a1.meta.json");
    const whole = JSON.stringify({ agentType: "reviewer", description: "x", toolUseId: "toolu_a1" });
    writeFileSync(meta, whole.slice(0, 20));
    expect(claudeSubagentState(s.path, true, NOW).settled).toBe(false);
    writeFileSync(meta, whole);
    expect(claudeSubagentState(s.path, true, NOW).settled).toBe(true);
  });

  it("calls an agent lost by the process start only when it was quiet a minute before it", () => {
    const s = session();
    s.agent("a1", { steps: [[1, 1], [7, 1]] });
    const state = (since: number) => claudeSubagents(s.path, true, NOW, since)[0]?.status;
    expect(state(Date.parse(at(7)) + 30_000)).toBe("running");
    expect(state(Date.parse(at(7)) + 90_000)).toBe("lost");
  });

  it("answers within the time it is given", async () => {
    const started = Date.now();
    await within(50, new Promise(() => undefined));
    await within(1000, Promise.reject(new Error("slow herdr failed")));
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("ClaudeSubagentStatus process", () => {
  const pane = (): HerdrPane => ({ pane_id: "p1", agent: "claude", agent_session: { agent: "claude", kind: "id", source: "hook", value: "s1" }, cwd: "/work", agent_status: "idle", focused: false, revision: 1 }) as HerdrPane;

  it("recovers incomplete process boundaries, throttles failures, and keeps the known transcript", async () => {
    for (const identity of ["missing-pid", "missing-start", "resolver-only"] as const) {
      const s = session();
      s.agent("orphan", { steps: [[1, 1]] });
      let now = NOW;
      let attempts = 0;
      let recovered = false;
      const status = new ClaudeSubagentStatus({
        now: () => now, refreshMs: 1000, onChange: () => {},
        ...(identity === "resolver-only" ? {} : { pid: async () => 123 }),
        resolve: async () => {
          attempts++;
          if (recovered) return { path: s.path, pid: 123, startedAt: NOW };
          if (attempts > 1) throw new Error("temporarily unavailable");
          return { path: s.path, pid: identity === "missing-start" ? 123 : null, startedAt: null };
        },
      });
      await status.refresh([pane()]);
      expect(status.countOf("p1")).toBe(1);
      now += 999;
      await status.refresh([pane()]);
      expect(attempts).toBe(1);
      now++;
      await status.refresh([pane()]);
      expect(attempts).toBe(2);
      expect(status.sessionOf("p1")?.path).toBe(s.path);
      expect(status.countOf("p1")).toBe(1);
      recovered = true;
      await status.refresh([pane()]);
      expect(attempts).toBe(2);
      now += 1000;
      await status.refresh([pane()]);
      expect(status.sessionOf("p1")?.startedAt).toBe(NOW);
      expect(status.countOf("p1")).toBe(0);
      now += 1000;
      await status.refresh([pane()]);
      expect(attempts).toBe(3);
    }
  });

  it("looks the session up again when the pane's Claude process is another one", async () => {
    const s = session();
    let pid = 100;
    let at = 0;
    const starts = [1000, 2000];
    let calls = 0;
    const status = new ClaudeSubagentStatus({ resolve: async () => ({ path: s.path, startedAt: starts[calls++] ?? null, pid }), pid: async () => pid, onChange: () => undefined, now: () => at, refreshMs: 1000 });
    await status.refresh([pane()]);
    expect(status.sessionOf("p1")?.startedAt).toBe(1000);
    at = 1000;
    await status.refresh([pane()]);
    expect(calls).toBe(1);
    pid = 200;
    at = 2000;
    await status.refresh([pane()]);
    expect([calls, status.sessionOf("p1")?.startedAt]).toEqual([2, 2000]);
  });
});

describe("claudeSubagents, an agent's own turn", () => {
  const entry = (file: string, value: unknown) => appendFileSync(file, json({ isSidechain: true, ...(value as object) }));
  const assistant = (file: string, minute: number, stop: string | null, kind = "text") => entry(file, { type: "assistant", timestamp: at(minute), message: { id: `m${minute}${kind}`, model: "claude-haiku-4-5", stop_reason: stop, content: [{ type: kind, text: "x" }] } });
  /** a teammate: no notification, no toolUseId, a name of its own */
  const teammate = (s: ReturnType<typeof session>, id: string) => {
    writeFileSync(join(s.path, "..", "11111111-1111-4111-8111-111111111111", "subagents", `agent-${id}.meta.json`), JSON.stringify({ agentType: "local-harness-map", name: "local-harness-map", spawnDepth: 0, requestShape: "background", taskKind: "in_process_teammate", teamName: "session-1" }));
    const file = join(s.path, "..", "11111111-1111-4111-8111-111111111111", "subagents", `agent-${id}.jsonl`);
    writeFileSync(file, "");
    entry(file, { type: "user", timestamp: at(1), message: { role: "user", content: "map it" } });
    return file;
  };

  it("reads a teammate whose last turn ended as completed, at that entry's time, and titles it by its name", () => {
    const s = session();
    const file = teammate(s, "alocal-harness-map-f7b05717a4a23081");
    assistant(file, 2, null, "thinking");
    assistant(file, 3, "end_turn");
    // bookkeeping after the end is not a message to it
    entry(file, { type: "attachment", timestamp: at(4), attachment: { type: "queued_command" } });
    expect(claudeSubagents(s.path, true, NOW)).toMatchObject([{ id: "alocal-harness-map-f7b05717a4a23081", title: "local-harness-map", category: "local-harness-map", status: "completed", ended_at: at(3) }]);
  });

  it("reads one still streaming or calling a tool as running, and one sent a message after its end as running again", () => {
    const s = session();
    const streaming = teammate(s, "streaming");
    assistant(streaming, 2, null);
    const calling = teammate(s, "calling");
    assistant(calling, 2, "tool_use", "tool_use");
    const woken = teammate(s, "woken");
    assistant(woken, 2, "end_turn");
    expect(ids(s.path).sort()).toEqual(["calling:running", "streaming:running", "woken:completed"]);
    entry(woken, { type: "user", timestamp: at(5), message: { role: "user", content: "one more thing" } });
    expect(ids(s.path).sort()).toEqual(["calling:running", "streaming:running", "woken:running"]);
    assistant(woken, 6, "end_turn");
    expect(claudeSubagents(s.path, true, NOW).find((task) => task.id === "woken")).toMatchObject({ status: "completed", ended_at: at(6) });
  });

  it("takes a background agent that ended its turn as done before its notification is written, and the newest word among them", () => {
    const s = session();
    const file = s.agent("bg", { steps: [[1, 1]] });
    assistant(file, 2, "end_turn");
    expect(claudeSubagents(s.path, true, NOW)).toMatchObject([{ id: "bg", status: "completed", ended_at: at(2) }]);
    // its notice, written after, is newer and says it failed
    s.notify("bg", 3, { status: "failed" });
    expect(claudeSubagents(s.path, true, NOW)).toMatchObject([{ id: "bg", status: "failed", ended_at: at(3) }]);
  });

  it("titles by description, then name, then agent type, then id", () => {
    const s = session();
    const dir = join(s.path, "..", "11111111-1111-4111-8111-111111111111", "subagents");
    const titles: [string, object][] = [["d", { description: "D", name: "N", agentType: "T" }], ["n", { name: "N", agentType: "T" }], ["t", { agentType: "T" }], ["i", {}]];
    for (const [id, meta] of titles) {
      writeFileSync(join(dir, `agent-${id}.meta.json`), JSON.stringify(meta));
      writeFileSync(join(dir, `agent-${id}.jsonl`), json({ type: "user", timestamp: at(1), message: { role: "user", content: "x" } }));
    }
    expect(Object.fromEntries(claudeSubagents(s.path, true, NOW).map((task) => [task.id, task.title]))).toEqual({ d: "D", n: "N", t: "T", i: "i" });
  });
});

describe("claudeSubagents, background commands", () => {
  const command = (summary: string) => ({ summary: `Background command "${summary}`, carriers: ["queue" as const] });

  it("counts a resumed subagent for the new prompt without changing its original start", () => {
    const s = session();
    s.prompt(1);
    s.agent("review", { steps: [[2, 1]] });
    s.notify("review", 3);
    expect(claudeSubagentState(s.path, true, NOW).turnRunning).toBe(0);
    s.prompt(10);
    s.work("review", 11, 1);
    expect(claudeSubagentState(s.path, true, NOW)).toMatchObject({
      running: 1, turnRunning: 1, tasks: [{ id: "review", started_at: at(2), status: "running" }],
    });
    forgetSubagents();
    expect(claudeSubagentState(s.path, true, NOW).turnRunning).toBe(1);
  });

  it("does not count an old subagent's tool result as a new dispatch", () => {
    const s = session();
    s.prompt(1);
    const file = s.agent("review", { steps: [[2, 1]] });
    s.prompt(10);
    appendFileSync(file, json({ isSidechain: true, type: "user", timestamp: at(11), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "read complete" }] } }));
    expect(claudeSubagentState(s.path, true, NOW)).toMatchObject({ running: 1, turnRunning: 0 });
  });

  it.each(["compaction", "task notification"])("does not treat an old subagent's %s as a new dispatch on warm or cold reads", (kind) => {
    const s = session();
    s.prompt(1);
    const file = s.agent("review", { steps: [[2, 1]] });
    s.prompt(10);
    expect(claudeSubagentState(s.path, true, NOW).turnRunning).toBe(0);
    appendFileSync(file, json({
      isSidechain: true, type: "user", timestamp: at(11),
      ...(kind === "compaction" ? { isCompactSummary: true } : {}),
      message: { role: "user", content: kind === "compaction" ? "Earlier context summarized"
        : "<task-notification>\n<task-id>shell</task-id>\n<status>completed</status>\n<summary>Background command finished</summary>\n</task-notification>" },
    }));
    expect(claudeSubagentState(s.path, true, NOW)).toMatchObject({ running: 1, turnRunning: 0 });
    forgetSubagents();
    expect(claudeSubagentState(s.path, true, NOW)).toMatchObject({ running: 1, turnRunning: 0 });
  });

  it("keeps running after garbled lines or a failed stop, then accepts repeated successful stops once", () => {
    const s = session();
    s.prompt(1);
    s.bash("suite", 2);
    appendFileSync(s.path, '{garbled "task_id":"suite"\nnull\n');
    s.parent({ type: "user", timestamp: at(3), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "failed-stop", is_error: true, content: "Could not stop suite" }] }, toolUseResult: { task_id: "suite", task_type: "local_bash" } });
    expect(claudeSubagentState(s.path, true, NOW)).toMatchObject({ running: 1, turnRunning: 1 });
    for (const minute of [4, 5]) s.parent({ type: "user", timestamp: at(minute), message: { role: "user", content: [{ type: "tool_result", tool_use_id: `stop-${minute}`, content: "{}" }] }, toolUseResult: minute === 4 ? { task_id: "suite", task_type: "local_bash" } : { shell_id: "suite" } });
    expect(claudeSubagentState(s.path, true, NOW)).toMatchObject({ running: 0, turnRunning: 0, tasks: [{ id: "suite", status: "cancelled", ended_at: at(4) }] });
    forgetSubagents();
    expect(claudeSubagentState(s.path, true, NOW)).toMatchObject({ running: 0, turnRunning: 0, tasks: [{ id: "suite", status: "cancelled", ended_at: at(4) }] });
  });

  it("lists a command the session sent to the background as running, by its description, with no subagent folder", () => {
    const s = session();
    rmSync(join(s.path, "..", "11111111-1111-4111-8111-111111111111"), { recursive: true });
    s.bash("b1", 2, { description: "Run the full suite", command: "bun run test" });
    s.bash("b2", 3, { command: "sleep 30" });
    expect(claudeSubagents(s.path, true, NOW)).toEqual([
      { id: "b1", title: "Run the full suite", category: "shell", model: null, status: "running", started_at: at(2), ended_at: null, turns: null, tool_calls: null, tokens: null },
      { id: "b2", title: "sleep 30", category: "shell", model: null, status: "running", started_at: at(3), ended_at: null, turns: null, tool_calls: null, tokens: null },
    ]);
  });

  it("ends a command by its notice, whatever the status, and by TaskStop or KillShell", () => {
    const s = session();
    for (const id of ["ok", "bad", "killed", "stopped", "shell"]) s.bash(id, 2);
    s.notify("ok", 3, command('x" completed (exit code 0)'));
    s.notify("bad", 4, { status: "failed", ...command('x" failed with exit code 1') });
    s.notify("killed", 5, { status: "killed", ...command('x" was stopped after reaching its background time limit') });
    s.parent({ type: "user", timestamp: at(6), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_stop", content: "{}" }] }, toolUseResult: { message: "Successfully stopped task: stopped (sleep)", task_id: "stopped", task_type: "local_bash", command: "sleep" } });
    s.parent({ type: "user", timestamp: at(7), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_kill", content: "{}" }] }, toolUseResult: { message: "Successfully killed shell: shell", shell_id: "shell" } });
    expect(claudeSubagents(s.path, true, NOW).map((task) => `${task.id}:${task.status}:${task.ended_at === null ? "-" : task.ended_at.slice(14, 16)}`)).toEqual([
      "shell:cancelled:07", "stopped:cancelled:06", "killed:cancelled:05", "bad:failed:04", "ok:completed:03",
    ]);
  });

  it("reads a command a subagent started, ended by the notice the session got, and one ended in the subagent's own file", () => {
    const s = session();
    const file = s.agent("a1", { steps: [[1, 1]] });
    s.bash("bsub", 2, { description: "Run the suite for the review", file });
    s.bash("bown", 2, { file });
    appendFileSync(file, json({ isSidechain: true, type: "attachment", timestamp: at(3), attachment: { type: "queued_command", commandMode: "task-notification", prompt: `<task-notification>\n<task-id>bown</task-id>\n<status>completed</status>\n<summary>Background command "x" completed (exit code 0)</summary>\n</task-notification>` } }));
    s.notify("a1", 4);
    expect(ids(s.path)).toEqual(["bsub:running", "a1:completed", "bown:completed"]);
    s.notify("bsub", 9, command('Run the suite for the review" completed (exit code 0)'));
    expect(ids(s.path)).toEqual(["bsub:completed", "a1:completed", "bown:completed"]);
  });

  it("reads a command as lost once the pane no longer runs Claude, or when it was started before the Claude process there", () => {
    const s = session();
    s.bash("old", 2);
    s.bash("new", 50);
    expect(ids(s.path, false)).toEqual(["new:lost", "old:lost"]);
    expect(claudeSubagents(s.path, true, NOW, Date.parse(at(40))).map((task) => `${task.id}:${task.status}`)).toEqual(["new:running", "old:lost"]);
  });

  it("counts what still runs of the turn: what started since the last prompt the person gave, a notice's turn going on", () => {
    const s = session();
    s.bash("server", 2, { command: "bun run dev" });
    s.prompt(10);
    s.bash("suite", 11);
    const file = s.agent("a1", { steps: [[12, 1]] });
    s.bash("review", 13, { file });
    expect(claudeSubagentState(s.path, true, NOW)).toMatchObject({ running: 4, turnRunning: 3 });
    // the notice of one starts a turn of its own, which is the same work going on
    s.notify("suite", 20, command('x" completed (exit code 0)'));
    s.parent({ type: "user", timestamp: at(20), origin: { kind: "task-notification" }, message: { role: "user", content: "<task-notification>\n<task-id>suite</task-id>\n</task-notification>" } });
    expect(claudeSubagentState(s.path, true, NOW)).toMatchObject({ running: 3, turnRunning: 2 });
    // a prompt typed at rest, as older Claude Code writes it (no origin): a new turn
    s.prompt(30, null);
    expect(claudeSubagentState(s.path, true, NOW)).toMatchObject({ running: 3, turnRunning: 0 });
    // one typed while the turn works is handed to it on the way: the same turn
    s.bash("lint", 31);
    s.parent({ type: "attachment", timestamp: at(32), attachment: { type: "queued_command", commandMode: "prompt", prompt: "and the docs" } });
    // nor is another session's message, or an interruption: neither carries a permission mode
    s.parent({ type: "user", timestamp: at(33), message: { role: "user", content: "Another Claude session sent a message: <teammate-message>hi</teammate-message>" } });
    s.parent({ type: "user", timestamp: at(34), message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } });
    expect(claudeSubagentState(s.path, true, NOW)).toMatchObject({ running: 4, turnRunning: 1 });
  });

  it("tells the pane's running count and what of it is the turn's when either changes", async () => {
    const s = session();
    s.prompt(1);
    s.bash("b1", 2);
    const told: [string, number, number][] = [];
    const pane = { pane_id: "p1", agent: "claude", agent_session: { agent: "claude", kind: "id", source: "hook", value: "s1" }, cwd: "/work", agent_status: "idle", focused: false, revision: 1 } as HerdrPane;
    const status = new ClaudeSubagentStatus({ resolve: async () => ({ path: s.path, startedAt: null }), onChange: (paneId, running, turnRunning) => told.push([paneId, running, turnRunning]), now: () => NOW });
    await status.refresh([pane]);
    s.prompt(3);
    status.poll("p1");
    s.notify("b1", 4, command('x" completed (exit code 0)'));
    status.poll("p1");
    expect(told).toEqual([["p1", 1, 1], ["p1", 1, 0], ["p1", 0, 0]]);
    expect(status.countOf("p1")).toBe(0);
  });

  it("announces a new prompt even when one background task replaces another between polls", async () => {
    const s = session();
    s.prompt(1);
    s.bash("first", 2);
    const prompts: Array<number | null> = [];
    const pane = { pane_id: "p1", agent: "claude", cwd: "/work", agent_status: "idle", focused: false, revision: 1 } as HerdrPane;
    const status = new ClaudeSubagentStatus({
      resolve: async () => ({ path: s.path, startedAt: null }),
      onChange: (_paneId, _running, _turnRunning, promptAt) => prompts.push(promptAt),
      now: () => NOW,
    });
    await status.refresh([pane]);
    s.notify("first", 3, command('x" completed (exit code 0)'));
    s.prompt(4);
    s.bash("second", 5);
    status.poll();
    expect(prompts).toEqual([Date.parse(at(1)), Date.parse(at(4))]);
  });
});

describe("claudeSubagents, before the files are read through", () => {
  const body = (id: string, minute: number, stop: string | null) => json({ type: "assistant", timestamp: at(minute), message: { id, model: "claude-haiku-4-5", stop_reason: stop, usage: { output_tokens: 7 }, content: [{ type: "text", text: "x" }], pad: "p".repeat(1000) } });

  it("tells the status of every agent on the first call, whatever the budget has reached", () => {
    const s = session();
    // eight idle teammates of 1.5 MB each and one agent at work: 13 MB, more than a call reads
    for (let n = 0; n < 8; n++) {
      const file = s.agent(`idle${n}`, { steps: [] });
      writeFileSync(file, json({ type: "user", timestamp: at(1), message: { role: "user", content: "go" } }) + Array.from({ length: 1500 }, (_, i) => body(`m${i}`, 2, null)).join("") + body("last", 3, "end_turn"));
    }
    const busy = s.agent("busy", { steps: [] });
    writeFileSync(busy, json({ type: "user", timestamp: at(1), message: { role: "user", content: "go" } }) + Array.from({ length: 1500 }, (_, i) => body(`b${i}`, 2, null)).join(""));
    const first = claudeSubagents(s.path, true, NOW);
    expect(first.filter((task) => task.status === "running").map((task) => task.id)).toEqual(["busy"]);
    expect(first).toHaveLength(9);
    // started at once; what it did only once it is counted through
    expect(first.every((task) => task.started_at === at(1))).toBe(true);
    expect(first.some((task) => task.turns === null)).toBe(true);
    expect(first.find((task) => task.id === "idle0")).toMatchObject({ status: "completed", ended_at: at(3) });
    for (let call = 0; call < 3; call++) claudeSubagents(s.path, true, NOW);
    const done = claudeSubagents(s.path, true, NOW);
    expect(done.every((task) => task.turns !== null)).toBe(true);
    expect(done.find((task) => task.id === "idle0")?.turns).toBe(1501);
    expect(done.filter((task) => task.status === "running")).toHaveLength(1);
  });

  it("leaves out an agent whose status cannot be told yet, rather than showing it running", () => {
    const s = session();
    const file = s.agent("long", { steps: [] });
    // one entry larger than the tail, and more file than a call reads
    writeFileSync(file, Array.from({ length: 9000 }, (_, i) => body(`m${i}`, 2, null)).join("") + body("last", 3, "end_turn").replace('"pad":"', `"pad":"${"p".repeat(200_000)}`));
    expect(ids(s.path)).toEqual([]);
    // read through, it ended
    for (let call = 0; call < 3; call++) ids(s.path);
    expect(ids(s.path)).toEqual(["long:completed"]);
  });
});
