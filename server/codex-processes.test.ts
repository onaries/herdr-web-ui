import { afterEach, beforeEach, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexTranscriptPath } from "./codex.ts";
import { processStartedAt } from "./process-start.ts";

// Native stores and the real RPC client; only herdr's foreground metadata is synthetic.
// In particular, a real process supplies /proc/cmdline when that metadata omits argv.
const thread = "01a0c7a1-56d9-7e20-9f08-f7a2d973bc01";
const answer = "This specific native conversation belongs to the selected Codex process, not whichever session was updated last.";
let root: string;
let home: string;
let path: string;
let screen: string;
let foreground: { pid: number; name?: string; argv?: string[] }[];
let listener: ReturnType<typeof Bun.listen>;
let socketBefore: string | undefined;
const children: ReturnType<typeof Bun.spawn>[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "herdr-web-ui-codex-processes-"));
  home = join(root, "codex");
  mkdirSync(join(home, "sessions"), { recursive: true });
  path = join(home, "sessions", `rollout-${thread}.jsonl`);
  writeFileSync(path, [
    { type: "session_meta", payload: { id: thread, cwd: root } },
    { type: "event_msg", payload: { type: "agent_message", message: answer } },
  ].map((entry) => JSON.stringify(entry)).join("\n"));
  const db = new Database(join(home, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT, archived INTEGER, agent_role TEXT, created_at INTEGER, updated_at INTEGER, source TEXT)");
  db.query("INSERT INTO threads VALUES (?, ?, ?, 0, NULL, 1, 1, 'cli')").run(thread, path, root);
  db.close();
  screen = "";
  foreground = [];
  socketBefore = process.env["HERDR_SOCKET"];
  const socket = join(root, "herdr.sock");
  process.env["HERDR_SOCKET"] = socket;
  listener = Bun.listen<{ buffer: string }>({
    unix: socket,
    socket: {
      open(socket) { socket.data = { buffer: "" }; },
      data(socket, chunk) {
        socket.data.buffer += chunk.toString();
        if (!socket.data.buffer.includes("\n")) return;
        const request = JSON.parse(socket.data.buffer) as { id: string; method: string };
        const result = request.method === "agent.get" ? { agent: {} }
          : request.method === "pane.process_info" ? { process_info: { foreground_processes: foreground } }
          : request.method === "pane.read" ? { read: { text: screen } }
          : null;
        if (result === null) throw new Error(`unexpected RPC ${request.method}`);
        socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
      },
    },
  });
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill();
    await child.exited;
  }
  listener.stop(true);
  if (socketBefore === undefined) delete process.env["HERDR_SOCKET"];
  else process.env["HERDR_SOCKET"] = socketBefore;
  rmSync(root, { recursive: true, force: true });
});

const resolve = () => codexTranscriptPath(root, root, home, [{
  pane_id: root, workspace_id: root, tab_id: root, terminal_id: root,
  agent: "codex", agent_status: "working", cwd: root, focused: false, revision: 0,
}]);

/** A ready, owned process with Codex's argv[0], no rollout descriptor and no timer. */
async function runningCodex(resume = false): Promise<ReturnType<typeof Bun.spawn>> {
  const node = Bun.which("node");
  if (node === null) throw new Error("node is required for the Codex process fixture");
  const child = Bun.spawn([
    "/bin/bash", "-c", 'exec -a "$1" "$2" -e \'process.stdout.write("READY\\n"); process.stdin.resume()\' "${@:3}"',
    "fixture", join(root, "codex"), node, ...(resume ? ["resume", thread] : []),
  ], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  children.push(child);
  const reader = child.stdout.getReader();
  const ready = await reader.read();
  reader.releaseLock();
  expect(new TextDecoder().decode(ready.value)).toBe("READY\n");
  return child;
}

it.skipIf(process.platform !== "linux")("selects the resumed rollout when Linux foreground metadata omits argv", async () => {
  const child = await runningCodex(true);
  foreground = [{ pid: child.pid, name: "codex" }];
  expect(await resolve()).toBe(path);
});

it("selects the resumed rollout for the observed native executable alias", async () => {
  foreground = [{ pid: 2147483647, argv: ["/home/user/.local/bin/codex.opencodex-real", "resume", thread] }];
  expect(await resolve()).toBe(path);
});

it.skipIf(process.platform !== "linux")("keeps the screen binding with recovered argv while the same process runs", async () => {
  const child = await runningCodex();
  foreground = [{ pid: child.pid, name: "codex" }];
  screen = answer;
  expect(await resolve()).toBe(path);
  screen = "";
  expect(await resolve()).toBe(path);
});

it.skipIf(process.platform !== "linux")("drops the recovered binding when its process has exited", async () => {
  const child = await runningCodex();
  foreground = [{ pid: child.pid, name: "codex" }];
  screen = answer;
  expect(await resolve()).toBe(path);
  child.kill();
  await child.exited;
  screen = "";
  expect(await resolve()).toBeNull();
});

it("finds the threads of a Windows cwd that Codex stored with the \\\\?\\ prefix (#518)", async () => {
  const cwd = "D:\\work\\app";
  const db = new Database(join(home, "state_5.sqlite"));
  db.query("UPDATE threads SET cwd = ?").run(`\\\\?\\${cwd}`);
  db.close();
  screen = answer;
  expect(await codexTranscriptPath(root, cwd, home, [{
    pane_id: root, workspace_id: root, tab_id: root, terminal_id: root,
    agent: "codex", agent_status: "working", cwd, focused: false, revision: 0,
  }])).toBe(path);
});

it("does not guess a session when argv and proc data are unavailable", async () => {
  foreground = [{ pid: 2147483647, name: "codex" }];
  expect(await resolve()).toBeNull();
});

it("does not trust the Codex name when recovered argv belongs to another executable", async () => {
  foreground = [{ pid: process.pid, name: "codex" }];
  expect(await resolve()).toBeNull();
});

it("does not use an alias resume after a newer interactive thread starts", async () => {
  foreground = [{ pid: 2147483647, argv: ["/usr/bin/codex.opencodex-real", "resume", thread] }];
  expect(await resolve()).toBe(path);
  const db = new Database(join(home, "state_5.sqlite"));
  db.query("INSERT INTO threads VALUES (?, ?, ?, 0, NULL, 2, 2, 'cli')").run(
    "01a0c7a1-56d9-7e20-9f08-f7a2d973bc02", join(home, "sessions", "missing.jsonl"), root,
  );
  db.close();
  expect(await resolve()).toBeNull();
});

const shortPrompt = "Check fixture";
const shortAnswer = "The fixture is ready for inspection.";
const shortScreen = `OpenAI Codex (v1.0)\n\n› ${shortPrompt}\n\n• ${shortAnswer}\n\n› `;
const shortIt = it.skipIf(process.platform !== "linux");

function shortRollout(file: string, prompt = shortPrompt, reply = shortAnswer): void {
  writeFileSync(file, [
    { type: "session_meta", payload: { id: thread, cwd: root } },
    { type: "event_msg", payload: { type: "user_message", message: prompt } },
    { type: "event_msg", payload: { type: "agent_message", message: reply } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}

/** Owned process and temporary native store; no Codex or paid model is invoked. */
async function shortSession(milliseconds = true, cwd = root): Promise<number> {
  const child = await runningCodex();
  foreground = [{ pid: child.pid, argv: [join(root, "codex")] }];
  const started = processStartedAt(child.pid);
  if (started === null) throw new Error("fixture process start is unavailable");
  // Keep both timestamp schemas beyond the conservative one-second start threshold.
  const created = Math.max(
    Math.ceil(Date.now() / 1000) * 1000,
    Math.ceil((started + 1000) / 1000) * 1000 + 1000,
  );
  const db = new Database(join(home, "state_5.sqlite"));
  db.exec("ALTER TABLE threads ADD COLUMN first_user_message TEXT");
  if (milliseconds) db.exec("ALTER TABLE threads ADD COLUMN created_at_ms INTEGER");
  db.query("UPDATE threads SET cwd = ?, created_at = ?, first_user_message = ?")
    .run(cwd, Math.floor(created / 1000), shortPrompt);
  if (milliseconds) db.query("UPDATE threads SET created_at_ms = ?").run(created);
  db.close();
  shortRollout(path);
  screen = shortScreen;
  return created;
}

function addShortThread(id: string, file: string, created: number, prompt = "Other fixture", source = "cli", role: string | null = null, archived = 0): void {
  const db = new Database(join(home, "state_5.sqlite"));
  db.query("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, file, root, archived, role, Math.floor(created / 1000), 2, source, prompt, created);
  db.close();
}

const fixturePane = (id: string, cwd = root) => ({
  pane_id: id, workspace_id: root, tab_id: root, terminal_id: id,
  agent: "codex" as const, agent_status: "working" as const, cwd, focused: false, revision: 0,
});

shortIt("resolves one submitted short exchange without keeping a screenless binding", async () => {
  await shortSession();
  expect(await resolve()).toBe(path);
  screen = "• The fixture is ready for inspection.";
  expect(await resolve()).toBeNull();
});

shortIt("resolves a seconds-only schema when creation is provably after process start", async () => {
  await shortSession(false);
  expect(await resolve()).toBe(path);
});

shortIt("requires a full second after the estimated process start", async () => {
  await shortSession();
  const startedAt = processStartedAt(foreground[0]!.pid)!;
  const beforeThreshold = new Database(join(home, "state_5.sqlite"));
  beforeThreshold.query("UPDATE threads SET created_at = ?, created_at_ms = ?")
    .run(Math.floor((startedAt + 999) / 1000), startedAt + 999);
  beforeThreshold.close();
  expect(await resolve()).toBeNull();

  const atThreshold = new Database(join(home, "state_5.sqlite"));
  atThreshold.query("UPDATE threads SET created_at = ?, created_at_ms = ?")
    .run(Math.floor((startedAt + 1000) / 1000), startedAt + 1000);
  atThreshold.close();
  expect(await resolve()).toBe(path);
});

shortIt("handles a Windows stored cwd prefix using a Linux fixture process", async () => {
  const cwd = "D:\\fixture\\app";
  await shortSession(true, `\\\\?\\${cwd}`);
  expect(await codexTranscriptPath(root, cwd, home, [fixturePane(root, cwd)])).toBe(path);
});

shortIt("requires a submitted first prompt and substantive answer, not a composer or quote", async () => {
  await shortSession();
  for (const shown of [
    `OpenAI Codex (v1.0)\n› ${shortPrompt}`,
    shortScreen.replace(`› ${shortPrompt}`, `    › ${shortPrompt}`),
    shortScreen.replace(shortPrompt, "Check-fixture"),
    shortScreen.replace(shortPrompt, "Check fixture again"),
    shortScreen.replace(`› ${shortPrompt}`, `› Earlier request\n• Earlier answer\n› ${shortPrompt}`),
    shortScreen.replace(shortAnswer, "Ready"),
  ]) {
    screen = shown;
    expect(await resolve()).toBeNull();
  }
  shortRollout(path, shortPrompt, "Ready");
  screen = shortScreen.replace(shortAnswer, "Ready");
  expect(await resolve()).toBeNull();
});

shortIt("retains older resumed later turns as competitors to a new first prompt", async () => {
  const created = await shortSession();
  const old = join(home, "sessions", "old.jsonl");
  shortRollout(old, "Original request", "Original answer");
  appendFileSync(old, [
    { type: "event_msg", payload: { type: "user_message", message: shortPrompt } },
    { type: "event_msg", payload: { type: "agent_message", message: shortAnswer } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  addShortThread("old", old, created - 60_000, "Original request");
  expect(await resolve()).toBeNull();
});

shortIt("allows a readable older thread whose exchange cannot explain the screen", async () => {
  const created = await shortSession();
  const old = join(home, "sessions", "old.jsonl");
  shortRollout(old, "Original request", "An unrelated original answer.");
  addShortThread("old", old, created - 60_000, "Original request");
  expect(await resolve()).toBe(path);
});

shortIt("does not erase unreadable older or new threads to manufacture uniqueness", async () => {
  const created = await shortSession();
  const missing = join(home, "sessions", "missing.jsonl");
  addShortThread("missing", missing, created - 60_000);
  expect(await resolve()).toBeNull();
  const db = new Database(join(home, "state_5.sqlite"));
  db.query("UPDATE threads SET created_at_ms = ? WHERE id = 'missing'").run(created);
  db.close();
  expect(await resolve()).toBeNull();
});

shortIt("rejects two new readable threads even when only one exchange matches", async () => {
  const created = await shortSession();
  const other = join(home, "sessions", "other.jsonl");
  shortRollout(other, "Other fixture", "Another unrelated answer.");
  addShortThread("other", other, created);
  expect(await resolve()).toBeNull();
});

shortIt("rejects candidate overflow instead of hiding ambiguity past the limit", async () => {
  const created = await shortSession();
  for (let index = 0; index < 34; index++) {
    addShortThread(`other-${index}`, join(home, "sessions", `missing-${index}.jsonl`), created);
  }
  expect(await resolve()).toBeNull();
});

shortIt("excludes exec, subagent and archived rows from interactive uniqueness", async () => {
  const created = await shortSession();
  for (const [source, role, archived] of [["exec", null, 0], ["cli", "worker", 0], ["cli", null, 1]] as const) {
    addShortThread(`excluded-${source}-${role}-${archived}`, join(home, "sessions", "missing.jsonl"), created, shortPrompt, source, role, archived);
  }
  expect(await resolve()).toBe(path);
});

shortIt("rejects unsafe, incomplete, malformed and history-derived rollouts", async () => {
  await shortSession();
  const outside = join(root, "outside.jsonl");
  shortRollout(outside);
  rmSync(path);
  symlinkSync(outside, path);
  expect(await resolve()).toBeNull();
  rmSync(path);
  shortRollout(path);
  appendFileSync(path, '{"type":');
  expect(await resolve()).toBeNull();
  shortRollout(path);
  appendFileSync(path, "not json\n");
  expect(await resolve()).toBeNull();
  shortRollout(path);
  appendFileSync(path, " ".repeat(1024 * 1024));
  expect(await resolve()).toBeNull();
  writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { id: thread, history_base: { path: outside } } }) + "\n");
  expect(await resolve()).toBeNull();
});

shortIt("does not borrow another same-directory pane's thread, even without a binding", async () => {
  await shortSession();
  const panes = [fixturePane(root), fixturePane("peer")];
  expect(await codexTranscriptPath(root, root, home, panes)).toBeNull();
  expect(await codexTranscriptPath("peer", root, home, panes)).toBeNull();
});

shortIt("rejects a thread already bound to another pane outside this directory", async () => {
  await shortSession();
  const panes = [fixturePane(root), fixturePane("peer", join(root, "elsewhere"))];
  // A long answer establishes the existing strong binding; then use short evidence.
  shortRollout(path, shortPrompt, answer);
  screen = answer;
  expect(await codexTranscriptPath("peer", root, home, panes)).toBe(path);
  shortRollout(path);
  screen = shortScreen;
  expect(await codexTranscriptPath(root, root, home, panes)).toBeNull();
});

shortIt("rejects unavailable process starts and timestamps before the actual process", async () => {
  const created = await shortSession();
  const started = processStartedAt(foreground[0]!.pid)!;
  const db = new Database(join(home, "state_5.sqlite"));
  db.query("UPDATE threads SET created_at_ms = ?").run(started - 1);
  db.close();
  expect(await resolve()).toBeNull();
  const restored = new Database(join(home, "state_5.sqlite"));
  restored.query("UPDATE threads SET created_at_ms = ?").run(created);
  restored.close();
  foreground = [{ pid: 2147483647, argv: [join(root, "codex")] }];
  expect(await resolve()).toBeNull();
});

for (const argv of [
  ["echo", "/usr/bin/codex", "resume", thread],
  ["node", "-e", "/usr/bin/codex", "resume", thread],
  ["python", "/usr/bin/codex.js", "resume", thread],
  ["/bin/sh", "-c", "/usr/bin/codex", "resume", thread],
  ["node", "--eval", "/usr/bin/codex", "resume", thread],
  ["node", "--require", "/usr/bin/codex", "resume", thread],
  ["node", "--no-warnings", "-e", "/usr/bin/codex", "resume", thread],
  ["node", "--eval=setInterval(()=>{},1000)", "/usr/bin/codex", "resume", thread],
  ["node", "--title", "/usr/bin/codex", "--eval=setInterval(()=>{},1000)", "resume", thread],
  ["node", "--import=./hook.mjs", "/usr/bin/codex", "resume", thread],
  ["/usr/bin/not-codex", "resume", thread],
]) {
  it(`ignores unrelated executable or command arguments: ${argv.slice(0, 3).join(" ")}`, async () => {
    foreground = [{ pid: 2147483647, argv }];
    expect(await resolve()).toBeNull();
  });
}

for (const executable of [
  ["/usr/bin/codex"],
  ["node", "/usr/lib/codex.js"],
  ["/bin/sh", "/usr/bin/codex"],
  ["bun", "/usr/lib/codex.js"],
  ["node", "--no-warnings", "/usr/bin/codex"],
  ["bash", "--", "/usr/bin/codex"],
  ["zsh", "/usr/bin/codex"],
  ["node", "--max-old-space-size=4096", "--no-warnings", "/usr/lib/codex.js"],
  ["node", "--title=codex", "--enable-source-maps", "/usr/lib/codex.js"],
  ["C:\\tools\\codex.exe"],
  ["C:\\tools\\node.exe", "C:\\tools\\codex.js"],
]) {
  it(`preserves resume selection for ${executable.join(" ")}`, async () => {
    foreground = [{ pid: 2147483647, argv: [...executable, "resume", thread] }];
    expect(await resolve()).toBe(path);
  });
}
