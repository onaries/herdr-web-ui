import { afterAll, beforeAll, expect, it } from "bun:test";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { forgetTranscriptState } from "./conversation.ts";
import { claudeProjectDir } from "./claude-store.ts";
import { startFakePushService } from "./push.fake.ts";
import { herdrRpc, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import type { ConversationResponse, HerdrPane, OmoActivity, ServerMessage, SessionSnapshot } from "../shared/protocol.ts";

// Real foreground processes and native PID records, without hooks or a model request.
const root = mkdtempSync(join(tmpdir(), "herdr-claude-session-"));
const originalHome = process.env["HOME"];
const originalConfigDir = process.env["CLAUDE_CONFIG_DIR"];
const NATIVE = process.platform === "linux" || process.platform === "darwin";
const workspaces: string[] = [];
const FIRST = "8d8f7d39-6788-49f3-b071-e3ba985c163c";
const SECOND = "f2f55dc4-50ad-478c-a641-bf21268a1bba";
const NEXT = "9343d82a-890c-4a39-a4a7-33c017d496f1";
const UNWRITTEN = "5b0c7f1e-3d2a-4c8b-9e6f-0a1b2c3d4e5f";
const project = join(root, ".claude", "projects", claudeProjectDir(root));
let server: ReturnType<typeof createServer>;
let first: { pane: string; pid: number };
let second: { pane: string; pid: number };
let statusClock = Date.now();

function makeServer() {
  return createServer({
    port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"),
    pushLoopbackHttp: true, statusNow: () => statusClock,
    alertTiming: { short: 0, long: 0, longTurn: 1000 },
    backgroundWait: { grace: 1500, limit: 60_000 },
  });
}

async function bounded<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), 10_000);
    })]);
  } finally { clearTimeout(timer); }
}

class Frames {
  readonly seen: ServerMessage[] = [];
  readonly socket: WebSocket;

  constructor(port: number) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.socket.addEventListener("message", (event) => this.seen.push(JSON.parse(String(event.data))));
  }

  wait(check: (frame: ServerMessage) => boolean, from = this.seen.length): Promise<ServerMessage> {
    const known = this.seen.slice(from).find(check);
    if (known) return Promise.resolve(known);
    return new Promise((resolve, reject) => {
      const finish = (frame?: ServerMessage) => {
        clearTimeout(timer);
        this.socket.removeEventListener("message", receive);
        if (frame) resolve(frame);
        else reject(new Error(`Frame timed out: ${JSON.stringify(this.seen.slice(-5))}`));
      };
      const receive = (event: MessageEvent) => {
        const frame: ServerMessage = JSON.parse(String(event.data));
        if (check(frame)) finish(frame);
      };
      const timer = setTimeout(() => finish(), 10_000);
      this.socket.addEventListener("message", receive);
    });
  }

  static async connect(port: number): Promise<Frames> {
    const frames = new Frames(port);
    await frames.wait((frame) => frame.type === "snapshot", 0);
    return frames;
  }
}

function transcript(id: string, store = join(root, ".claude"), answer = `Answer ${id}`): void {
  const folder = join(store, "projects", claudeProjectDir(root));
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${id}.jsonl`), [
    { type: "user", message: { content: `Prompt ${id}` } },
    { type: "assistant", message: { content: [{ type: "text", text: answer }] } },
  ].map((entry) => JSON.stringify(entry)).join("\n"));
}

async function pane(id: string, configDir?: string): Promise<{ pane: string; pid: number }> {
  const created = await herdrRpc<Awaited<ReturnType<typeof workspaceCreate>>>("workspace.create", { cwd: root, label: "herdr-web-ui-test-claude-session", focus: false });
  workspaces.push(created.workspace.workspace_id);
  const paneId = created.root_pane.pane_id;
  let ready: (pid: number) => void = () => {};
  const signal = new Promise<number>((resolve) => { ready = resolve; });
  const listener = Bun.listen({
    hostname: "127.0.0.1", port: 0,
    socket: { data(socket, data) { ready(Number(data.toString())); socket.end(); } },
  });
  const node = configDir ? join(root, "claude") : Bun.which("node");
  if (!node) throw new Error("Claude session contract needs Node");
  const timeout = setTimeout(() => ready(0), 10_000);
  try {
    await herdrRpc("pane.send_text", {
      pane_id: paneId, text: `exec env ${configDir ? `CLAUDE_CONFIG_DIR=${JSON.stringify(configDir)}` : "-u CLAUDE_CONFIG_DIR"} ${JSON.stringify(node)} ${JSON.stringify(join(root, "claude.cjs"))} ${JSON.stringify(root)} ${id} ${listener.port}\n`,
    });
    const pid = await signal;
    if (!pid) throw new Error("Claude stand-in did not signal readiness");
    await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "claude", state: "idle" });
    return { pane: paneId, pid };
  } finally { clearTimeout(timeout); listener.stop(true); }
}

beforeAll(async () => {
  if (!NATIVE) return;
  delete process.env["CLAUDE_CONFIG_DIR"];
  forgetTranscriptState();
  const node = Bun.which("node");
  if (!node) throw new Error("Claude session contract needs Node");
  // A native executable keeps its environment visible on macOS. Node's process.title setter
  // erases the environment that ps can see there, so use the renamed executable for that case.
  // Bun is self-contained on macOS; a copied Homebrew Node needs its original dylib location.
  copyFileSync(process.platform === "darwin" ? process.execPath : node, join(root, "claude"));
  mkdirSync(project, { recursive: true });
  mkdirSync(join(root, ".claude", "sessions"), { recursive: true });
  for (const id of [FIRST, SECOND, NEXT]) transcript(id);
  writeFileSync(join(root, "claude.cjs"), `
const fs = require("node:fs");
const net = require("node:net");
const [home, sessionId, port] = process.argv.slice(2);
if (process.platform === "linux" || !process.env.CLAUDE_CONFIG_DIR) process.title = "claude";
const procStart = process.platform === "linux"
  ? fs.readFileSync("/proc/self/stat", "utf8").split(") ").pop().split(" ")[19]
  : require("node:child_process").execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(process.pid)], { env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, encoding: "utf8" }).trim();
const store = process.env.CLAUDE_CONFIG_DIR || home + "/.claude";
fs.mkdirSync(store + "/sessions", { recursive: true });
fs.writeFileSync(store + "/sessions/" + process.pid + ".json", JSON.stringify({
  pid: process.pid, sessionId, cwd: home, procStart, kind: "interactive",
}));
net.connect(Number(port), "127.0.0.1", function () { this.end(String(process.pid)); });
process.stdin.resume();
`);
  first = await pane(FIRST);
  second = await pane(SECOND);
  process.env["HOME"] = root;
  // alerts and the hold on a turn's background work wait moments, not minutes: a test sees what goes out, and what does not
  server = makeServer();
  await bounded(server.statusReady, "Initial status subscription");
}, 15_000);

afterAll(async () => {
  server?.stop();
  forgetTranscriptState();
  if (originalConfigDir === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
  else process.env["CLAUDE_CONFIG_DIR"] = originalConfigDir;
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  for (const workspace of workspaces) await workspaceClose(workspace);
  rmSync(root, { recursive: true, force: true });
});

async function read(paneId: string): Promise<ConversationResponse> {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`);
  expect(response.status).toBe(200);
  return await response.json();
}

it.skipIf(!NATIVE)("reads each hookless Claude pane's own conversation in a shared cwd", async () => {
  // The pane has no session id from Herdr; cwd and recency cannot distinguish these.
  const info = await herdrRpc<{ agent: { agent_session?: unknown } }>("agent.get", { target: first.pane });
  expect(info.agent.agent_session).toBeUndefined();
  const a = await read(first.pane);
  const b = await read(second.pane);
  expect(a.source).toBe("claude-transcript");
  expect(a.turns.at(-1)?.parts[0]).toMatchObject({ text: `Answer ${FIRST}` });
  expect(b.source).toBe("claude-transcript");
  expect(b.turns.at(-1)?.parts[0]).toMatchObject({ text: `Answer ${SECOND}` });
});

it.skipIf(!NATIVE)("lists a Claude pane's subagents, counts the running ones and pushes the count without a status", async () => {
  const base = `http://127.0.0.1:${server.port}`;
  const tasks = async (paneId: string): Promise<OmoActivity> => await (await fetch(`${base}/api/pane/omo-tasks?pane_id=${encodeURIComponent(paneId)}`)).json();
  const counted = async (paneId: string): Promise<number | undefined> => {
    const { snapshot } = await (await fetch(`${base}/api/session`)).json() as { snapshot: { panes: { pane_id: string; background_tasks?: number }[] } };
    return snapshot.panes.find((entry) => entry.pane_id === paneId)?.background_tasks;
  };
  const frames = await Frames.connect(server.port);
  const countedFrame = frames.wait((frame) => frame.type === "pane-status" && frame.pane_id === second.pane && frame.background_tasks === 1);
  const folder = join(project, SECOND, "subagents");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "agent-a1.meta.json"), JSON.stringify({ agentType: "reviewer", description: "Review the parser", toolUseId: "toolu_a1", requestShape: "background" }));
  writeFileSync(join(folder, "agent-a1.jsonl"), `${JSON.stringify({ isSidechain: true, agentId: "a1", type: "user", timestamp: new Date().toISOString(), message: { role: "user", content: "go" } })}\n`);

  // a device that wants every alert: a count that changes alone must not reach it
  const device = await startFakePushService();
  try {
    const subscribed = await fetch(`${base}/api/push/subscribe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscription: device.subscription, alerts: { input: true, done: "always" } }) });
    expect(subscribed.status).toBe(204);
    // asked first, before the server has had a snapshot to look for the pane's transcript with: it finds it itself
    expect((await tasks(second.pane)).tasks).toMatchObject([{ id: "a1", status: "running" }]);
    await countedFrame;
    expect(await counted(second.pane)).toBe(1);
    expect(await tasks(second.pane)).toMatchObject({ tasks: [{ id: "a1", title: "Review the parser", category: "reviewer", status: "running" }], runs: [] });
    // a pane with no subagents has no count and no list
    expect(await counted(first.pane)).toBeUndefined();
    expect((await tasks(first.pane)).tasks).toEqual([]);

    // the agent ends: its notification is written to the session's transcript
    const notice = "<task-notification>\n<task-id>a1</task-id>\n<tool-use-id>toolu_a1</tool-use-id>\n<status>completed</status>\n<summary>Agent \"Review the parser\" finished</summary>\n<result>fine</result>\n</task-notification>";
    const endedFrame = frames.wait((frame) => frame.type === "pane-status" && frame.pane_id === second.pane && frame.background_tasks === 0);
    appendFileSync(join(project, `${SECOND}.jsonl`), `\n${JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: new Date(Date.now() + 1000).toISOString(), content: notice })}\n`);
    await endedFrame;
    expect(await counted(second.pane)).toBeUndefined();
    expect((await tasks(second.pane)).tasks).toMatchObject([{ id: "a1", status: "completed" }]);
    // pushed as a count alone: the pane's status is the one it had, and it counts as no turn
    const pushed = frames.seen.filter((frame) => frame.type === "pane-status" && frame.pane_id === second.pane && frame.background_tasks !== undefined);
    expect(pushed.at(-1)).toMatchObject({ background_tasks: 0, agent_status: expect.stringMatching(/^(idle|done)$/) });
    const conversation = await read(second.pane);
    expect(conversation.source).toBe("claude-transcript");
    expect(conversation.turns.flatMap((turn) => turn.parts).filter((part) => part.kind === "task_result")).toMatchObject([{ kind: "task_result", tasks: [{ id: "a1", status: "completed", result: "fine" }] }]);
    // A later collector alert waits through the same delivery queue as any earlier alert.
    const barrier = device.waitFor((push) => push.payload.pane_id === first.pane, "input alert barrier", 10_000);
    await herdrRpc("pane.report_agent", { pane_id: first.pane, source: "manual", agent: "claude", state: "blocked" });
    await barrier;
    expect(device.received.map((push) => push.payload.pane_id)).toEqual([first.pane]);
  } finally {
    frames.socket.close();
    await fetch(`${base}/api/push/subscribe`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: device.subscription.endpoint }) }).catch(() => undefined);
    await herdrRpc("pane.report_agent", { pane_id: first.pane, source: "manual", agent: "claude", state: "idle" });
    device.stop();
  }
}, 15_000);

/** Each hold owns its pane, transcript and bridge, so running one test never needs an earlier one. */
async function backgroundTurn(taskId: string) {
  server.stop();
  forgetTranscriptState();
  const sessionId = crypto.randomUUID();
  transcript(sessionId);
  const target = await pane(sessionId);
  statusClock = Date.now();
  server = makeServer();
  await bounded(server.statusReady, "Background status subscription");
  const base = `http://127.0.0.1:${server.port}`;
  const device = await startFakePushService();
  const frames = await Frames.connect(server.port);
  const status = (frame: ServerMessage): frame is Extract<ServerMessage, { type: "pane-status" }> => frame.type === "pane-status" && frame.pane_id === target.pane;
  const shown = async (): Promise<HerdrPane | undefined> => {
    const response = await fetch(`${base}/api/session`);
    expect(response.status).toBe(200);
    const { snapshot }: { snapshot: SessionSnapshot } = await response.json();
    return snapshot.panes.find((entry) => entry.pane_id === target.pane);
  };
  const report = async (state: "working" | "idle") => {
    const frame = frames.wait((frame) => status(frame) && (state === "working" ? frame.agent_status === "working" : frame.agent_status === "done"));
    await herdrRpc("pane.report_agent", { pane_id: target.pane, source: "manual", agent: "claude", state });
    return await frame;
  };
  const write = (...entries: unknown[]) => appendFileSync(join(project, `${sessionId}.jsonl`), "\n" + entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  // Prompt association compares transcript time with observed rest: both use the injected clock.
  const now = () => new Date(statusClock).toISOString();
  const close = async () => {
    frames.socket.close();
    const removed = await fetch(`${base}/api/push/subscribe`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: device.subscription.endpoint }) });
    expect(removed.status).toBe(204);
    await server.alertsSettled();
    server.stop();
    device.stop();
    forgetTranscriptState();
    server = makeServer();
    await bounded(server.statusReady, "Restored status subscription");
  };
  try {
    // Resolve the native session before the status event's synchronous transcript poll.
    const tasks = await fetch(`${base}/api/pane/omo-tasks?pane_id=${encodeURIComponent(target.pane)}`);
    expect(tasks.status).toBe(200);
    const subscribed = await fetch(`${base}/api/push/subscribe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscription: device.subscription, alerts: { input: true, done: "long" } }) });
    expect(subscribed.status).toBe(204);
    await report("working");
    statusClock += 1500;
    write({ type: "user", timestamp: now(), origin: { kind: "human" }, permissionMode: "default", message: { role: "user", content: "run the suite and ship" } },
      { type: "assistant", timestamp: now(), message: { role: "assistant", content: [{ type: "tool_use", id: `toolu_${taskId}`, name: "Bash", input: { command: "bun test", description: "Run the full suite", run_in_background: true } }] } },
      { type: "user", timestamp: now(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${taskId}`, content: `Command running in background with ID: ${taskId}.` }] }, toolUseResult: { stdout: "", stderr: "", interrupted: false, isImage: false, backgroundTaskId: taskId } });
    const held = await report("idle");
    expect(held).toMatchObject({ agent_status: "done", background_tasks: 1, background_wait: true });
    expect(await shown()).toMatchObject({ background_tasks: 1, background_wait: true });
    const alerts = () => device.received.filter((push) => push.payload.pane_id === target.pane);
    await server.alertsSettled();
    expect(alerts()).toEqual([]);
    return {
      shown, frames, status, report, alerts, close,
      alerted: () => device.waitFor((push) => push.payload.pane_id === target.pane, "Background finish", 10_000),
      end: async () => {
        const counted = frames.wait((frame) => status(frame) && frame.background_tasks === 0);
        write({ type: "queue-operation", operation: "enqueue", timestamp: now(), content: `<task-notification>\n<task-id>${taskId}</task-id>\n<status>completed</status>\n<summary>Background command completed (exit code 0)</summary>\n</task-notification>` });
        await counted;
      },
    };
  } catch (error) { await close(); throw error; }
}

it.skipIf(!NATIVE)("holds a turn that ended on its background command, and alerts once, for the whole turn, when the turn its notice starts ends", async () => {
  const turn = await backgroundTurn("bsuite");
  try {
    await turn.end();
    expect((await turn.shown())?.background_wait).toBe(true);
    await turn.report("working");
    const alerted = turn.alerted();
    await turn.report("idle");
    await alerted;
    await server.alertsSettled();
    expect(turn.alerts().map((push) => push.payload.body)).toEqual(["work finished"]);
    expect((await turn.shown())?.background_wait).toBeUndefined();
  } finally { await turn.close(); }
}, 15_000);

it.skipIf(!NATIVE)("lets go of a turn whose work ended when no turn follows, with one frame that says so and one alert", async () => {
  const turn = await backgroundTurn("blint");
  try {
    await turn.end();
    const from = turn.frames.seen.length;
    const released = turn.frames.wait((frame) => turn.status(frame) && frame.background_wait !== true);
    const alerted = turn.alerted();
    statusClock += 1500;
    await released;
    await alerted;
    await server.alertsSettled();
    expect(turn.alerts().map((push) => push.payload.body)).toEqual(["work finished"]);
    const atRest = turn.frames.seen.slice(from).filter(turn.status);
    expect(atRest).toHaveLength(1);
    expect(atRest[0]).toMatchObject({ agent_status: "done" });
    expect(atRest[0]).not.toHaveProperty("background_wait");
    expect((await turn.shown())?.background_wait).toBeUndefined();
  } finally { await turn.close(); }
}, 15_000);
it.skipIf(!NATIVE)("follows the current PID record without retaining a previous session", async () => {
  const path = join(root, ".claude", "sessions", `${first.pid}.json`);
  const previous = readFileSync(path, "utf8");
  try {
    const record = JSON.parse(previous);
    writeFileSync(path, JSON.stringify({ ...record, sessionId: NEXT }));
    const response = await read(first.pane);
    expect(response.source).toBe("claude-transcript");
    expect(response.turns.at(-1)?.parts[0]).toMatchObject({ text: `Answer ${NEXT}` });
  } finally { writeFileSync(path, previous); }
});

it.skipIf(!NATIVE)("refuses a reused PID record rather than selecting another same-cwd session", async () => {
  const path = join(root, ".claude", "sessions", `${first.pid}.json`);
  const previous = readFileSync(path, "utf8");
  try {
    writeFileSync(path, JSON.stringify({ ...JSON.parse(previous), procStart: "1" }));
    expect(await read(first.pane)).toEqual({ source: "scrollback", turns: [] });
  } finally { writeFileSync(path, previous); }
});

it.skipIf(!NATIVE)("answers a session Claude has not written yet as an empty conversation, then follows the file it writes", async () => {
  const fresh = await pane(UNWRITTEN);
  const blank = await read(fresh.pane);
  expect(blank).toMatchObject({ source: "claude-transcript", turns: [], cursor: null, history_id: `unwritten:${UNWRITTEN}` });
  transcript(UNWRITTEN);
  const written = await read(fresh.pane);
  expect(written.source).toBe("claude-transcript");
  expect(written.history_id).not.toBe(`unwritten:${UNWRITTEN}`);
  expect(written.turns.at(-1)?.parts[0]).toMatchObject({ text: `Answer ${UNWRITTEN}` });
  rmSync(join(project, `${UNWRITTEN}.jsonl`));
  expect(await read(fresh.pane)).toEqual({ source: "scrollback", turns: [] });
});

it.skipIf(!NATIVE)("keeps the existing Herdr hook path when no native PID record is available", async () => {
  const hooked = await pane(SECOND);
  rmSync(join(root, ".claude", "sessions", `${hooked.pid}.json`));
  await herdrRpc("pane.report_agent_session", {
    pane_id: hooked.pane, source: "herdr:claude", agent: "claude", seq: 1, agent_session_id: FIRST,
  });
  const response = await read(hooked.pane);
  expect(response.source).toBe("claude-transcript");
  expect(response.turns.at(-1)?.parts[0]).toMatchObject({ text: `Answer ${FIRST}` });
});

it.skipIf(!NATIVE)("uses each process's config dir before the server's store, with and without a hook", async () => {
  const ownStore = join(root, "environment with spaces", ".claude");
  const serverStore = join(root, "server-store");
  // Same session id and cwd in all stores: only the process environment selects the right one.
  transcript(FIRST, ownStore, "Pane's own answer");
  transcript(FIRST, serverStore, "Server's other answer");
  const custom = await pane(FIRST, ownStore);
  process.env["CLAUDE_CONFIG_DIR"] = serverStore;
  try {
    const native = await read(custom.pane);
    expect(native.source).toBe("claude-transcript");
    expect(native.turns.at(-1)?.parts[0]).toMatchObject({ text: "Pane's own answer" });
    rmSync(join(ownStore, "sessions", `${custom.pid}.json`));
    await herdrRpc("pane.report_agent_session", {
      pane_id: custom.pane, source: "herdr:claude", agent: "claude", seq: 1, agent_session_id: FIRST,
    });
    expect((await read(custom.pane)).turns.at(-1)?.parts[0]).toMatchObject({ text: "Pane's own answer" });
    // A process without the variable retains the server-level fallback.
    const fallback = await pane(FIRST);
    await herdrRpc("pane.report_agent_session", {
      pane_id: fallback.pane, source: "herdr:claude", agent: "claude", seq: 1, agent_session_id: FIRST,
    });
    expect((await read(fallback.pane)).turns.at(-1)?.parts[0]).toMatchObject({ text: "Server's other answer" });
  } finally { delete process.env["CLAUDE_CONFIG_DIR"]; }
});
