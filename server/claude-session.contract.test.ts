import { afterAll, beforeAll, expect, it } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { forgetTranscriptState } from "./conversation.ts";
import { claudeProjectDir } from "./claude-store.ts";
import { herdrRpc, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import type { ConversationResponse } from "../shared/protocol.ts";

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

function transcript(id: string, store = join(root, ".claude"), answer = `Answer ${id}`): void {
  const folder = join(store, "projects", claudeProjectDir(root));
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${id}.jsonl`), [
    { type: "user", message: { content: `Prompt ${id}` } },
    { type: "assistant", message: { content: [{ type: "text", text: answer }] } },
  ].map((entry) => JSON.stringify(entry)).join("\n"));
}

async function pane(id: string, configDir?: string): Promise<{ pane: string; pid: number }> {
  const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-claude-session" });
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
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state") });
});

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
