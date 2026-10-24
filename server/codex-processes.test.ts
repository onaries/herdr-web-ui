import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asCodexTitle, codexOpenRollout, codexTranscriptPath, paneRunsCodex } from "./codex.ts";
import * as processStart from "./process-start.ts";
import { processStartedAt } from "./process-start.ts";

// Native stores and the real RPC client; only herdr's foreground metadata is synthetic.
// In particular, a real process supplies /proc/cmdline when that metadata omits argv.
const thread = "01a0c7a1-56d9-7e20-9f08-f7a2d973bc01";
const answer = "This specific native conversation belongs to the selected Codex process, not whichever session was updated last.";
let root: string;
let home: string;
let path: string;
let screen: string;
let peerScreens: Map<string, string | Error>;
let foreground: { pid: number; name?: string; argv?: string[] }[];
/** A pane's own foreground, where it is not [foreground]. */
let foregrounds: Map<string, { pid: number; name?: string; argv?: string[] }[]>;
let listener: ReturnType<typeof Bun.listen>;
let socketBefore: string | undefined;
/** The terminal title herdr reports for the pane (Codex's [tui].terminal_title), null for none. */
let title: string | null;
/** The pane's folders herdr reports. */
let agentFolders: { cwd?: string; foreground_cwd?: string };
const children: ReturnType<typeof Bun.spawn>[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ovis-codex-processes-"));
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
  title = null;
  agentFolders = {};
  peerScreens = new Map();
  foreground = [];
  foregrounds = new Map();
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
        const request = JSON.parse(socket.data.buffer) as { id: string; method: string; params?: { pane_id?: string } };
        const peerScreen = peerScreens.get(request.params?.pane_id ?? "");
        if (request.method === "pane.read" && peerScreen instanceof Error) {
          socket.end(`${JSON.stringify({ id: request.id, error: { code: "pane_not_found", message: peerScreen.message } })}\n`);
          return;
        }
        const result = request.method === "agent.get" ? { agent: { ...agentFolders, ...(title === null ? {} : { terminal_title: title, terminal_title_stripped: title }) } }
          : request.method === "pane.process_info" ? { process_info: { foreground_processes: foregrounds.get(request.params?.pane_id ?? "") ?? foreground } }
          : request.method === "pane.read" ? { read: { text: peerScreen ?? screen } }
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

it("native queue keys require an interactive Codex executable", async () => {
  for (const argv of [["/usr/bin/codex"], ["node", "--no-warnings", "/opt/codex.js", "resume", thread]]) {
    foreground = [{ pid: process.pid, argv }];
    expect(await paneRunsCodex(root)).toBe(true);
  }
  for (const argv of [["codex", "exec", "task"], ["codex", "app-server"], ["node", "-e", "codex"], ["sh", "-c", "codex"], ["cat", "codex"]]) {
    foreground = [{ pid: process.pid, argv }];
    expect(await paneRunsCodex(root)).toBe(false);
  }
});

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

it("gives a background reader the chat's binding only while no newer thread may have replaced it, and binds nothing itself", async () => {
  foreground = [{ pid: 2147483647, argv: ["/usr/bin/codex"] }];
  expect(await codexOpenRollout(root, root, home)).toBeNull();
  screen = answer;
  expect(await codexOpenRollout(root, root, home)).toBeNull();
  expect(await resolve()).toBe(path);
  screen = "";
  expect(await codexOpenRollout(root, root, home)).toBe(path);
  const db = new Database(join(home, "state_5.sqlite"));
  const now = Math.floor(Date.now() / 1000);
  db.query("INSERT INTO threads VALUES (?, ?, ?, 0, NULL, ?, ?, 'cli')").run(
    "01a0c7a1-56d9-7e20-9f08-f7a2d973bc02", join(home, "sessions", "missing.jsonl"), root, now, now,
  );
  db.close();
  expect(await codexOpenRollout(root, root, home)).toBeNull();
});

/** A thread of another folder, as `codex resume` (the picker) can open from this one (#896). */
const other = "01a16b22-7e1f-7072-8897-d5e46a0d5f1f";
const otherAnswer = "An answer of the other folder's conversation, which this pane resumed through the picker.";
function otherFolderThread(messages: { type: string; message: string }[] = [{ type: "agent_message", message: otherAnswer }]): string {
  const elsewhere = join(root, "elsewhere");
  mkdirSync(elsewhere, { recursive: true });
  const rollout = join(home, "sessions", `rollout-${other}.jsonl`);
  writeFileSync(rollout, [
    { type: "session_meta", payload: { id: other, cwd: elsewhere } },
    ...messages.map((payload) => ({ type: "event_msg", payload })),
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const db = new Database(join(home, "state_5.sqlite"));
  db.query("INSERT INTO threads (id, rollout_path, cwd, archived, agent_role, created_at, updated_at, source) VALUES (?, ?, ?, 0, NULL, 2, 2, 'cli')").run(other, rollout, elsewhere);
  db.close();
  return rollout;
}

/** The title Codex 0.163.0 sets with its thread-id item: the id shortened to 29 characters. */
const shortened = `Use the other folder | elsewhere | ${other.slice(0, 29)}...`;
const picker = [{ pid: 2147483647, argv: ["codex", "resume", "--all"] }];

it("cleans title text as Codex 0.163.0 does (tui/src/terminal_title.rs, its own test cases)", () => {
  expect(asCodexTitle("  Project\t|\nWorking\x1b\x07\u009D\u009C |  Thread  ")).toBe("Project | Working | Thread");
  expect(asCodexTitle("Pro\u202Ej\u2066e\u200Fc\u061Ct\u200B \uFEFFT\u2060itle")).toBe("Project Title");
  const mixed = " \u25cf \u2807 | \u011b[31m thread \u202e\x07| \u65e5\u672c\u8a9e \u0107af\u00e9  ";
  expect(asCodexTitle(mixed, true)).toBe("* | | ?[31m thread | ??? ?af?");
  expect(asCodexTitle(mixed)).toBe("\u25cf \u2807 | \u011b[31m thread | \u65e5\u672c\u8a9e \u0107af\u00e9");
  expect(asCodexTitle("\u65e5\u672c\u8a9e", true)).toBe("???");
  expect(asCodexTitle("\x07\x1b\u202E\uFEFF", true)).toBe("");
});

describe("the thread id a Codex pane's terminal title shows, from another folder (#896)", () => {
  it("is matched on screen like the pane's own threads, and the match then serves a background reader", async () => {
    const rollout = otherFolderThread();
    foreground = picker;
    title = shortened;
    screen = otherAnswer;
    expect(await resolve()).toBe(rollout);
    expect(await codexOpenRollout(root, root, home)).toBe(rollout);
  });

  it("is never taken on the title alone: a name that only looks like the id leaves the screen to decide", async () => {
    otherFolderThread();
    foreground = picker;
    title = `Working | ${other}`;
    expect(await resolve()).toBeNull();
    expect(await codexOpenRollout(root, root, home)).toBeNull();
    screen = answer;
    expect(await resolve()).toBe(path);
  });

  it("follows the title's thread over the one the command line resumed, as after /new", async () => {
    const rollout = otherFolderThread();
    foreground = [{ pid: 2147483647, argv: ["codex", "resume", thread] }];
    title = `\u280b ${other} | elsewhere`;
    screen = otherAnswer;
    expect(await resolve()).toBe(rollout);
  });

  /** `count` more exchanges of this folder's conversation, two turns each */
  const later = (from: number, count: number) => `\n${Array.from({ length: count }, (_, index) => [
    { type: "user_message", message: `Question ${from + index}` },
    { type: "agent_message", message: `Later answer number ${from + index} of this folder's own conversation.` },
  ].map((payload) => JSON.stringify({ type: "event_msg", payload })).join("\n")).join("\n")}`;

  it("takes no answer this folder's conversation gave too, however long ago", async () => {
    otherFolderThread([{ type: "agent_message", message: answer }]);
    foreground = picker;
    title = `Working | ${other}`;
    screen = answer;
    // past its last eight answers, then past the last hundred turns a chat shows
    for (const [from, count] of [[0, 8], [8, 60]] as const) {
      appendFileSync(path, later(from, count));
      expect(await resolve()).toBeNull();
      expect(await codexOpenRollout(root, root, home)).toBeNull();
    }
  });

  it("leaves an answer both conversations gave lately undecided, rather than this folder's by elimination", async () => {
    otherFolderThread([{ type: "agent_message", message: answer }]);
    foreground = picker;
    title = `Working | ${other}`;
    screen = answer;
    expect(await resolve()).toBeNull();
  });

  it("takes no id that a folder or a thread's name could have put in the title (R1)", async () => {
    // the pane really runs C, resumed from a folder named after B's id, with no thread-id title item:
    // the title's project name is B's id, and C and B gave the same answer
    otherFolderThread([{ type: "agent_message", message: answer }]);
    const named = join(root, `project-${other}`);
    mkdirSync(named, { recursive: true });
    const actual = "01a16b22-7e1f-7072-8897-cccccccccccc";
    const rollout = join(home, "sessions", `rollout-${actual}.jsonl`);
    writeFileSync(rollout, [
      { type: "session_meta", payload: { id: actual, cwd: named } },
      { type: "event_msg", payload: { type: "agent_message", message: answer } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const db = new Database(join(home, "state_5.sqlite"));
    db.query("INSERT INTO threads (id, rollout_path, cwd, archived, agent_role, created_at, updated_at, source) VALUES (?, ?, ?, 0, NULL, 2, 2, 'cli')").run(actual, rollout, named);
    db.close();
    writeFileSync(path, [
      { type: "session_meta", payload: { id: thread, cwd: root } },
      { type: "event_msg", payload: { type: "agent_message", message: "This folder's own conversation answered something else entirely, long enough to count." } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    foreground = picker;
    screen = answer;
    title = `Ask about the project | ${other}`;
    expect(await resolve()).toBeNull();
    expect(await codexOpenRollout(root, root, home)).toBeNull();
  });

  it("compares names as Codex writes them into the title, without the characters it drops (R2)", async () => {
    // C's name (then its folder) is B's id with invisible characters Codex strips from its title
    otherFolderThread([{ type: "agent_message", message: answer }]);
    const actual = "01a16b22-7e1f-7072-8897-cccccccccccc";
    const folder = join(root, "project");
    mkdirSync(folder, { recursive: true });
    const rollout = join(home, "sessions", `rollout-${actual}.jsonl`);
    writeFileSync(rollout, [
      { type: "session_meta", payload: { id: actual, cwd: folder } },
      { type: "event_msg", payload: { type: "agent_message", message: answer } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const db = new Database(join(home, "state_5.sqlite"));
    db.exec("ALTER TABLE threads ADD COLUMN name TEXT");
    db.query("INSERT INTO threads (id, rollout_path, cwd, archived, agent_role, created_at, updated_at, source) VALUES (?, ?, ?, 0, NULL, 2, 2, 'cli')")
      .run(actual, rollout, folder);
    db.close();
    writeFileSync(path, [
      { type: "session_meta", payload: { id: thread, cwd: root } },
      { type: "event_msg", payload: { type: "agent_message", message: "This folder's own conversation answered something else entirely, long enough to count." } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    foreground = picker;
    screen = answer;
    title = `${other} | project`;
    const found: [string, string | null, string | null][] = [];
    for (const name of [
      `${other.slice(0, 8)}\u200b${other.slice(8, 20)}\u2061\ufeff${other.slice(20)}`,
      // a NUL, which SQLite's text functions stop at
      `${other.slice(0, 8)}\u0000${other.slice(8)}`,
      // what Codex writes as "-" under GNU Screen (STY)
      `${other.slice(0, 8)}\u2839${other.slice(9, 13)}\u2826${other.slice(14)}`,
      // a space Codex drops when the name reaches its 240-character title cap
      `${other.slice(0, 35)} ${other.slice(35)}`,
    ]) {
      const named = new Database(join(home, "state_5.sqlite"));
      named.query("UPDATE threads SET name = ? WHERE id = ?").run(name, actual);
      named.close();
      found.push([JSON.stringify(name), await resolve(), await codexOpenRollout(root, root, home)]);
    }
    expect(found.filter(([, chat, reader]) => chat !== null || reader !== null).map(([name]) => name)).toEqual([]);
  });

  it("compares the pane's folders as Codex writes them into the title too (R2)", async () => {
    otherFolderThread();
    foreground = picker;
    screen = otherAnswer;
    title = `Working | ${other}`;
    agentFolders = { cwd: join(root, `${other.slice(0, 13)}\u00ad${other.slice(13)}`), foreground_cwd: root };
    expect(await resolve()).toBeNull();
  });

  it("counts an answer another conversation split into parts as given there too", async () => {
    otherFolderThread([{ type: "agent_message", message: answer }]);
    const half = answer.indexOf(" ", answer.length / 2);
    writeFileSync(path, [
      { type: "session_meta", payload: { id: thread, cwd: root } },
      { type: "event_msg", payload: { type: "agent_message", message: answer.slice(0, half) } },
      { type: "event_msg", payload: { type: "agent_message", message: answer.slice(half) } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    foreground = picker;
    title = shortened;
    screen = answer;
    expect(await resolve()).toBeNull();
  });

  it("drops a binding the title made once the title names another thread", async () => {
    const rollout = otherFolderThread();
    foreground = picker;
    title = shortened;
    screen = otherAnswer;
    expect(await resolve()).toBe(rollout);
    // the same Codex resumed another folder's thread through the picker; none of its answers shows yet
    const next = "01a16b22-7e1f-7072-8897-eeeeeeeeeeee";
    const nextRollout = join(home, "sessions", `rollout-${next}.jsonl`);
    writeFileSync(nextRollout, `${JSON.stringify({ type: "session_meta", payload: { id: next, cwd: join(root, "elsewhere") } })}\n`);
    const db = new Database(join(home, "state_5.sqlite"));
    db.query("INSERT INTO threads (id, rollout_path, cwd, archived, agent_role, created_at, updated_at, source) VALUES (?, ?, ?, 0, NULL, 3, 3, 'cli')").run(next, nextRollout, join(root, "elsewhere"));
    db.close();
    title = `Another one | elsewhere | ${next.slice(0, 29)}...`;
    screen = "";
    expect(await codexOpenRollout(root, root, home)).toBeNull();
    expect(await resolve()).toBeNull();
    title = shortened;
    expect(await codexOpenRollout(root, root, home)).toBeNull();
  });

  it("offers nothing from another folder without the id in the title, without a Codex process, or for an id the store does not hold", async () => {
    otherFolderThread();
    screen = otherAnswer;
    foreground = picker;
    title = "Use the other folder | elsewhere";
    expect(await resolve()).toBeNull();
    title = shortened;
    foreground = [{ pid: 2147483647, argv: ["bash"] }];
    expect(await resolve()).toBeNull();
    foreground = [];
    expect(await resolve()).toBeNull();
    foreground = picker;
    title = "Use the other folder | elsewhere | 01a16b22-7e1f-7072-8897-ffffffffffff";
    expect(await resolve()).toBeNull();
    // an id inside other text, or cut anywhere but where Codex cuts it, is no thread-id item
    for (const named of [`Use the other folder | proj-${other}`, `Use the other folder | ${other.slice(0, 30)}...`, `${other} | ${other.slice(0, 29)}...`]) {
      title = named;
      expect(await resolve()).toBeNull();
    }
  });
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
const shortIt = it.skipIf(process.platform !== "linux" && process.platform !== "darwin");

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

shortIt("resolves a submitted hello and short reply without requiring a longer answer", async () => {
  await shortSession();
  const db = new Database(join(home, "state_5.sqlite"));
  db.query("UPDATE threads SET first_user_message = 'hello'").run();
  db.close();
  shortRollout(path, "hello");
  screen = shortScreen.replace(shortPrompt, "hello");
  expect(await resolve()).toBe(path);
});

shortIt("resolves its exact first exchange beside a different same-directory conversation", async () => {
  const created = await shortSession();
  const other = join(home, "sessions", "other.jsonl");
  shortRollout(other, "Other fixture", "A different short reply.");
  addShortThread("other", other, created - 60_000, "Other fixture");
  peerScreens.set("peer", "OpenAI Codex (v1.0)\n› Other fixture\n• A different short reply.\n› ");
  expect(await codexTranscriptPath(root, root, home, [fixturePane(root), fixturePane("peer")])).toBe(path);
});

shortIt("rejects unknown or matching peer screens when a header has scrolled away", async () => {
  await shortSession();
  for (const peer of [shortScreen.replace("OpenAI Codex (v1.0)\n", ""), "", "Working…", new Error("fixture pane disappeared")]) {
    peerScreens.set("peer", peer);
    expect(await codexTranscriptPath(root, root, home, [fixturePane(root), fixturePane("peer")])).toBeNull();
  }
});

shortIt("accepts a headerless peer only with a substantial match to a different conversation", async () => {
  const created = await shortSession();
  const other = join(home, "sessions", "other.jsonl");
  shortRollout(other, "Other fixture", answer);
  addShortThread("other", other, created - 60_000, "Other fixture");
  peerScreens.set("peer", `› Other fixture\n• ${answer}\n› `);
  expect(await codexTranscriptPath(root, root, home, [fixturePane(root), fixturePane("peer")])).toBe(path);
  // A recognizable answer must not override an overlapping short exchange.
  for (const mixed of [
    `${shortScreen}\n• ${answer}`,
    `${shortScreen.replace("OpenAI Codex (v1.0)\n", "")}\n• ${answer}`,
    `• ${answer}\n${shortScreen.replace("OpenAI Codex (v1.0)\n", "")}`,
  ]) {
    peerScreens.set("peer", mixed);
    expect(await codexTranscriptPath(root, root, home, [fixturePane(root), fixturePane("peer")])).toBeNull();
  }
});

shortIt("leaves a short first exchange undecided while the title offers another folder's conversation with the same one (#896)", async () => {
  await shortSession();
  expect(await resolve()).toBe(path);
  otherFolderThread([{ type: "user_message", message: shortPrompt }, { type: "agent_message", message: shortAnswer }]);
  title = `${shortPrompt} | elsewhere | ${other}`;
  expect(await resolve()).toBeNull();
});

shortIt("resolves a seconds-only schema when creation is provably after process start", async () => {
  await shortSession(false);
  expect(await resolve()).toBe(path);
});

shortIt("rejects a thread made before its process could have started, and takes one made as it starts", async () => {
  await shortSession();
  // Put the start at a second boundary, independently of btime/ps rounding or fixture setup time.
  const started = 1_001_000;
  const bound = spyOn(processStart, "processStartLowerBound").mockReturnValue(started);
  const setCreated = (created: number) => {
    const db = new Database(join(home, "state_5.sqlite"));
    db.query("UPDATE threads SET created_at = ?, created_at_ms = ?").run(Math.floor(created / 1000), created);
    db.close();
  };
  try {
    setCreated(started - 1);
    expect(await resolve()).toBeNull();
    setCreated(started);
    expect(await resolve()).toBe(path);
  } finally { bound.mockRestore(); }
});

shortIt("takes a seconds-only thread made in its process's second", async () => {
  await shortSession(false);
  const bound = spyOn(processStart, "processStartLowerBound");
  try {
    // The same stored second must work at its first and last millisecond, but not the next second.
    const db = new Database(join(home, "state_5.sqlite"));
    db.query("UPDATE threads SET created_at = 1000").run();
    db.close();
    for (const started of [1_000_000, 1_000_999]) {
      bound.mockReturnValue(started);
      expect(await resolve()).toBe(path);
    }
    bound.mockReturnValue(1_001_000);
    expect(await resolve()).toBeNull();
  } finally { bound.mockRestore(); }
});

// --- after another pane's /new, this pane's one-word exchange still tells ---

const peerThread = "01a0c7a1-56d9-7e20-9f08-f7a2d973bc09";
const peerPrompt = "explain the cache layer";
const peerAnswer = "The cache layer keeps each rendered page for ten minutes, keyed by its route and the user's locale, and evicts the oldest first.";

/** The other pane's thread, begun after this pane's Codex started (its /new), answered [reply]. */
function peerNewThread(created: number, reply = peerAnswer): string {
  const file = join(home, "sessions", `rollout-${peerThread}.jsonl`);
  writeFileSync(file, [
    { type: "session_meta", payload: { id: peerThread, cwd: root } },
    { type: "event_msg", payload: { type: "user_message", message: peerPrompt } },
    { type: "event_msg", payload: { type: "agent_message", message: reply } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  addShortThread(peerThread, file, created, peerPrompt);
  return file;
}

const peerScreenOf = (reply: string) => `OpenAI Codex (v1.0)\n\n› ${peerPrompt}\n\n• ${reply}\n\n› `;

shortIt("leaves out a thread another pane shows a long answer of below its first prompt, and keeps it theirs", async () => {
  const created = await shortSession();
  peerNewThread(created + 1000);
  peerScreens.set("peer", peerScreenOf(peerAnswer));
  const panes = [fixturePane(root), fixturePane("peer")];
  expect(await codexTranscriptPath(root, root, home, panes)).toBe(path);
  // looked at again within seconds the other pane is not read again: it is bound to that thread now
  expect(await codexTranscriptPath(root, root, home, panes)).toBe(path);
});

shortIt("leaves out the rollout herdr reports for another pane", async () => {
  const created = await shortSession();
  const theirs = peerNewThread(created + 1000, "ok");
  peerScreens.set("peer", peerScreenOf("ok"));
  const peer = { ...fixturePane("peer"), agent_session: { source: "herdr:codex", agent: "codex", kind: "path", value: theirs } };
  expect(await codexTranscriptPath(root, root, home, [fixturePane(root), peer])).toBe(path);
});

shortIt("leaves out its only new thread when herdr reports it for another pane", async () => {
  await shortSession();
  // the other pane shows another exchange now; herdr says the thread is that pane's conversation
  peerScreens.set("peer", "OpenAI Codex (v1.0)\n› Other fixture\n• A different short reply.\n› ");
  const peer = { ...fixturePane("peer"), agent_session: { source: "herdr:codex", agent: "codex", kind: "path", value: path } };
  expect(await codexTranscriptPath(root, root, home, [fixturePane(root), peer])).toBeNull();
  // reported for nobody, the same screens tell it is this pane's
  expect(await codexTranscriptPath(root, root, home, [fixturePane(root), fixturePane("peer")])).toBe(path);
});

shortIt("still cannot tell when nothing ties the other thread to another pane", async () => {
  const created = await shortSession();
  // a one-word answer there too, nothing reported: either pane might have begun it
  peerNewThread(created + 1000, "ok");
  peerScreens.set("peer", peerScreenOf("ok"));
  expect(await codexTranscriptPath(root, root, home, [fixturePane(root), fixturePane("peer")])).toBeNull();
});

// --- the pane that started first, beside a later pane's short first exchange ---

it("tells the first-started pane's thread once the later pane shows its own first exchange", async () => {
  // A's Codex started at 1000 s and began its thread at 1001.3; B's started at 1005 and began
  // its own at 1006.7: both began after A started, so A tells only once B shows its own
  const starts = new Map([[900001, 1_000_000], [900002, 1_005_000]]);
  const bound = spyOn(processStart, "processStartLowerBound").mockImplementation((pid) => starts.has(pid) ? starts.get(pid)! : null);
  try {
    const db = new Database(join(home, "state_5.sqlite"));
    db.exec("ALTER TABLE threads ADD COLUMN first_user_message TEXT");
    db.exec("ALTER TABLE threads ADD COLUMN created_at_ms INTEGER");
    db.query("UPDATE threads SET created_at = 1001, created_at_ms = 1001300, first_user_message = ?").run(shortPrompt);
    db.close();
    shortRollout(path);
    const theirs = join(home, "sessions", "rollout-bravo.jsonl");
    writeFileSync(theirs, [
      { type: "session_meta", payload: { id: "bravo", cwd: root } },
      { type: "event_msg", payload: { type: "user_message", message: "Reply with exactly one word: bravo" } },
      { type: "event_msg", payload: { type: "agent_message", message: "bravo" } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    addShortThread("bravo", theirs, 1_006_700, "Reply with exactly one word: bravo");
    foregrounds.set(root, [{ pid: 900001, argv: [join(root, "codex")] }]);
    foregrounds.set("peer", [{ pid: 900002, argv: [join(root, "codex")] }]);
    screen = shortScreen;
    const bravo = "OpenAI Codex (v1.0)\n\n› Reply with exactly one word: bravo\n\n• bravo\n\n› ";
    peerScreens.set("peer", bravo);
    const panes = [fixturePane(root), fixturePane("peer")];
    expect(await codexTranscriptPath(root, root, home, panes)).toBe(path);
    expect(await codexTranscriptPath("peer", root, home, panes)).toBe(theirs);

    // unsure stays unavailable: B's start unknown, B scrolled past its header, or this
    // pane showing B's exchange as well
    starts.delete(900002);
    expect(await codexTranscriptPath(root, root, home, panes)).toBeNull();
    starts.set(900002, 1_005_000);
    peerScreens.set("peer", "› Reply with exactly one word: bravo\n\n• bravo\n\n› ");
    expect(await codexTranscriptPath(root, root, home, panes)).toBeNull();
    peerScreens.set("peer", bravo);
    screen = bravo;
    expect(await codexTranscriptPath(root, root, home, panes)).toBeNull();
    // a later exchange of this pane's own is no claim on B's: its first exchange is still its own
    screen = `${shortScreen}Reply with exactly one word: bravo\n\n• bravo\n\n› `;
    expect(await codexTranscriptPath(root, root, home, panes)).toBe(path);
  } finally { bound.mockRestore(); }
});

shortIt("claims nothing for a long answer another pane shows under some other prompt (pasted, quoted)", async () => {
  const created = await shortSession();
  peerNewThread(created + 1000);
  peerScreens.set("peer", `OpenAI Codex (v1.0)\n\n› what did the other pane say?\n\n• ${peerAnswer}\n\n› `);
  expect(await codexTranscriptPath(root, root, home, [fixturePane(root), fixturePane("peer")])).toBeNull();
});

shortIt("handles a Windows stored cwd prefix using a Linux fixture process", async () => {
  const cwd = "D:\\fixture\\app";
  await shortSession(true, `\\\\?\\${cwd}`);
  expect(await codexTranscriptPath(root, cwd, home, [fixturePane(root, cwd)])).toBe(path);
});

shortIt("requires a submitted first prompt and exact answer, not a composer or quote (control)", async () => {
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
  expect(await resolve()).toBe(path); // regression: a tiny but exact answer is sufficient
  shortRollout(path, shortPrompt, "");
  screen = shortScreen.replace(shortAnswer, "");
  expect(await resolve()).toBeNull(); // control: no answer is not a submitted exchange
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

shortIt("checks every exchange in a tool-heavy older thread instead of rejecting its file size", async () => {
  const created = await shortSession();
  const old = join(home, "sessions", "tool-heavy.jsonl");
  shortRollout(old, "Original request", "An unrelated original answer.");
  const output = JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "tool", output: "x".repeat(64 * 1024) } }) + "\n";
  appendFileSync(old, output.repeat(20));
  addShortThread("old", old, created - 60_000, "Original request");
  expect(await resolve()).toBe(path);
  appendFileSync(old, [
    { type: "event_msg", payload: { type: "user_message", message: shortPrompt } },
    { type: "event_msg", payload: { type: "agent_message", message: shortAnswer } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  expect(await resolve()).toBeNull();
});

shortIt("reads an older rollout once, then only what is appended to it", async () => {
  const created = await shortSession();
  const old = join(home, "sessions", "tool-heavy.jsonl");
  shortRollout(old, "Original request", "An unrelated original answer.");
  const output = JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "tool", output: "x".repeat(64 * 1024) } }) + "\n";
  appendFileSync(old, output.repeat(20));
  addShortThread("old", old, created - 60_000, "Original request");
  utimesSync(old, 1_700_000_000, 1_700_000_000);
  expect(await resolve()).toBe(path);
  // Same inode, size and mtime: a second read would hit this broken line and give up.
  const fd = openSync(old, "r+");
  writeSync(fd, "\"", statSync(old).size - 100);
  closeSync(fd);
  utimesSync(old, 1_700_000_000, 1_700_000_000);
  expect(await resolve()).toBe(path);
  // Grown: only the appended lines are read, so the broken line above stays unread.
  appendFileSync(old, output);
  expect(await resolve()).toBe(path);
  appendFileSync(old, [
    { type: "event_msg", payload: { type: "user_message", message: shortPrompt } },
    { type: "event_msg", payload: { type: "agent_message", message: shortAnswer } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  expect(await resolve()).toBeNull();
});

shortIt("rejects cumulative retained messages over the short matching limit", async () => {
  const created = await shortSession();
  const other = join(home, "sessions", "other.jsonl");
  shortRollout(other, "Other fixture", "A different short reply.");
  addShortThread("other", other, created - 60_000, "Other fixture");
  const message = JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "x".repeat(64 * 1024) } }) + "\n";
  appendFileSync(other, message.repeat(15));
  expect(await resolve()).toBe(path);
  appendFileSync(other, message.repeat(2));
  expect(await resolve()).toBeNull();
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

shortIt("rejects unavailable process starts and timestamps before the process could have started", async () => {
  const created = await shortSession();
  const started = processStartedAt(foreground[0]!.pid)!;
  const db = new Database(join(home, "state_5.sqlite"));
  // below the start's lower bound on every platform (a tick on Linux, ps's second on macOS)
  db.query("UPDATE threads SET created_at_ms = ?").run(started - 2500);
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

shortIt("finds a profile's short conversation after native completion footers", async () => {
  await shortSession();
  const db = new Database(join(home, "state_5.sqlite"));
  db.query("UPDATE threads SET source = 'vscode', first_user_message = 'hi'").run();
  db.close();
  shortRollout(path, "hi", "Hi! What would you like to work on?");
  appendFileSync(path, [
    { type: "event_msg", payload: { type: "user_message", message: "hi" } },
    { type: "event_msg", payload: { type: "agent_message", message: "Hi again! How can I help?" } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  screen = "OpenAI Codex (v0.163.0)\n• Model changed to gpt-6-luna medium\n\n"
    + "› hi\n\n• Hi! What would you like to work on?\n\n  Worked for 1s • 11:11 AM\n\n"
    + "› hi\n\n• Hi again! How can I help?\n\n  Worked for 2s • 11:11 AM\n\n› Ask Codex to do anything";
  expect(await resolve()).toBe(path);
});
