import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, SUBMIT_DEADLINE_MS, SUBMIT_DELAY_MS } from "./index.ts";
import { herdrRpc } from "./herdr/client.ts";
import * as herdr from "./herdr/client.ts";

/**
 * Contract test for the composer's "submit" frame, against the real herdr server.
 * Each pane runs a raw-mode recorder that logs every chunk of input it reads with its
 * arrival time, so the test sees what the agent's TUI would: the text, then its Enter
 * as a separate keypress. One recorder is a plain program (the send_text path), the
 * other runs under the name `claude` and is reported as that agent (herdr's
 * agent.prompt path).
 */
const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-submit-"));
let server: { port: number; stop: () => void };
const workspaces: string[] = [];

const RECORDER = `
const { appendFileSync, writeFileSync } = require("node:fs");
const out = process.argv[2];
process.stdin.setRawMode(true);
process.stdin.resume();
// bracketed paste on, as agent TUIs have it: herdr passes the paste markers through;
// then what the TUI would show, when asked to (argv[3])
process.stdout.write("\\u001b[?2004h" + (process.argv[3] ?? ""), () => writeFileSync(out, ""));
process.stdin.on("data", (chunk) => appendFileSync(out, JSON.stringify({ at: Date.now(), data: chunk.toString("utf8") }) + "\\n"));
`;

interface Chunk { at: number; data: string }
interface Recorder { pane: string; log: string }
let shell: Recorder;
let agent: Recorder;
let codex: Recorder;
let codexApproval: Recorder;
let claudeQueue: Recorder;

const chunks = (recorder: Recorder): Chunk[] =>
  readFileSync(recorder.log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Chunk);
const typed = (recorder: Recorder, from: number) => chunks(recorder).slice(from).map((chunk) => chunk.data).join("");

/** the chunks read since `from`, once their bytes hold `count` Enters */
async function received(recorder: Recorder, from: number, count: number): Promise<Chunk[]> {
  for (let i = 0; i < 100; i++) {
    if (typed(recorder, from).split("\r").length > count) return chunks(recorder).slice(from);
    await Bun.sleep(50);
  }
  throw new Error(`no ${count} Enter(s) within 5s: ${JSON.stringify(chunks(recorder).slice(from))}`);
}

async function recorder(label: string, program: string, screen = ""): Promise<Recorder> {
  const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
    "workspace.create", { label: `herdr-web-ui-test-submit-${label}`, cwd: root, focus: false },
  );
  workspaces.push(created.workspace.workspace_id);
  const log = join(root, `${label}.jsonl`);
  const shown = screen ? ` '${screen.replace(/\n/g, "\r\n")}'` : "";
  await herdrRpc("pane.send_text", { pane_id: created.root_pane.pane_id, text: `exec '${program}' '${join(root, "record.js")}' '${log}'${shown}\n` });
  for (let i = 0; i < 200 && !existsSync(log); i++) await Bun.sleep(50);
  expect(existsSync(log)).toBe(true);
  return { pane: created.root_pane.pane_id, log };
}

class Socket {
  readonly seen: any[] = [];
  private readonly ws: WebSocket;
  private constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener("message", (event) => this.seen.push(JSON.parse(String((event as MessageEvent).data))));
  }
  static async connect(port = server.port): Promise<Socket> {
    const socket = new Socket(`ws://localhost:${port}/ws`);
    await new Promise<void>((resolve) => socket.ws.addEventListener("open", () => resolve()));
    await socket.waitFor((message) => message.type === "snapshot");
    return socket;
  }
  async waitFor(predicate: (message: any) => boolean, ms = 15_000): Promise<any> {
    for (let waited = 0; waited < ms; waited += 25) {
      const found = this.seen.find(predicate);
      if (found) return found;
      await Bun.sleep(25);
    }
    throw new Error(`frame not received within ${ms}ms`);
  }
  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }
  result(id: number): Promise<any> {
    return this.waitFor((message) => message.type === "submit-result" && message.id === id);
  }
  close(): void {
    this.ws.close();
  }
}

const paste = (text: string) => `\u001b[200~${text}\u001b[201~`;

/** A promise the test settles itself: it orders a server's step against the test's own. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}

const claudeRule = "─".repeat(60);
const claudeInputScreen = (input: string) => `${claudeRule}\r\n${input}\r\n${claudeRule}`;

function mockClaudeInput(paneId: string, screen: string) {
  const originalRead = herdr.paneRead;
  const read = spyOn(herdr, "paneRead").mockImplementation(async (options, socketPath) => {
    const result = await originalRead(options, socketPath);
    return options.paneId === paneId ? { ...result, text: screen } : result;
  });
  const scroll = spyOn(herdr, "paneScrollInfo").mockResolvedValue(null);
  return { read, scroll };
}

/** Attaches `socket` to `pane` and waits until it may type there; the frames from then on start at the returned mark. */
async function attached(socket: Socket, pane: string): Promise<number> {
  const mark = socket.seen.length;
  socket.send({ type: "attach", pane_id: pane, cols: 80, rows: 24 });
  await socket.waitFor((message) => socket.seen.indexOf(message) >= mark && message.type === "input-ready" && message.pane_id === pane);
  return mark;
}
const collapsedCodexScreen = "\n• Queued follow-up inputs\n  ? 1 question\n    alt+↑ to answer\n› Ask Codex to do anything\n";

beforeAll(async () => {
  server = createServer({ port: 0, stateDir: join(root, "push") });
  writeFileSync(join(root, "record.js"), RECORDER);
  // herdr's agent.prompt checks that the pane's foreground process is the agent
  copyFileSync(process.execPath, join(root, "claude"));
  chmodSync(join(root, "claude"), 0o755);
  copyFileSync(process.execPath, join(root, "codex"));
  chmodSync(join(root, "codex"), 0o755);
  shell = await recorder("shell", process.execPath);
  agent = await recorder("agent", join(root, "claude"));
  await herdrRpc("pane.report_agent", { pane_id: agent.pane, source: "manual", agent: "claude", state: "idle" });
  // Codex with a question waiting collapsed in its queue: herdr calls it blocked
  const queue = "\n• Queued follow-up inputs\n  ? 1 question\n    alt+↑ to answer\n";
  codex = await recorder("codex", join(root, "codex"), `${queue}› Ask Codex to do anything\n`);
  await herdrRpc("pane.report_agent", { pane_id: codex.pane, source: "manual", agent: "codex", state: "blocked" });
  // the queue above an approval: the approval holds the input, and y / Enter would answer it
  codexApproval = await recorder("codex-approval", join(root, "codex"), `${queue}\nWould you like to run the following command?\n\n$ rm -rf junk\n\n› 1. Yes, proceed (y)\n  2. No, and tell Codex what to do differently (esc)\n\nPress enter to confirm or esc to cancel\n`);
  await herdrRpc("pane.report_agent", { pane_id: codexApproval.pane, source: "manual", agent: "codex", state: "blocked" });
  // the same text in a pane whose agent is not Codex
  claudeQueue = await recorder("claude-queue", join(root, "claude"), `${queue}› Ask Codex to do anything\n`);
  await herdrRpc("pane.report_agent", { pane_id: claudeQueue.pane, source: "manual", agent: "claude", state: "blocked" });
}, 30_000);

afterAll(async () => {
  server?.stop();
  for (const id of workspaces) await herdrRpc("workspace.close", { workspace_id: id }).catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
});

describe("WebSocket submit", () => {
  it("lists the submit feature in the first snapshot", async () => {
    const socket = await Socket.connect();
    try {
      // a pane-status can arrive first: the snapshot is found by its type
      expect(socket.seen.find((message) => message.type === "snapshot")?.features).toContain("submit");
      expect(socket.seen.find((message) => message.type === "snapshot")?.features).toContain("pending-input");
    } finally {
      socket.close();
    }
  });

  it("types the payload into a pane without an agent, then its own Enter SUBMIT_DELAY_MS later, and says so", async () => {
    const socket = await Socket.connect();
    try {
      const from = chunks(shell).length;
      socket.send({ type: "submit", id: 1, pane_id: shell.pane, text: "hello", payload: paste("hello") });
      expect(await socket.result(1)).toMatchObject({ ok: true, pane_id: shell.pane });
      const read = await received(shell, from, 1);
      const enter = read.findIndex((chunk) => chunk.data.includes("\r"));
      expect(read.slice(0, enter).map((chunk) => chunk.data).join("")).toBe(paste("hello"));
      expect(read[enter]!.data).toBe("\r");
      expect(read[enter]!.at - read[enter - 1]!.at).toBeGreaterThanOrEqual(SUBMIT_DELAY_MS - 20);
    } finally {
      socket.close();
    }
  }, 30_000);

  it("closes a trailing @file mention inside the paste markers of a payload typed without agent.prompt", async () => {
    const socket = await Socket.connect();
    try {
      const from = chunks(shell).length;
      socket.send({ type: "submit", id: 21, pane_id: shell.pane, text: "look at @/tmp/shot.png", payload: paste("look at @/tmp/shot.png") });
      expect(await socket.result(21)).toMatchObject({ ok: true });
      const read = await received(shell, from, 1);
      const enter = read.findIndex((chunk) => chunk.data.includes("\r"));
      expect(read.slice(0, enter).map((chunk) => chunk.data).join("")).toBe(paste("look at @/tmp/shot.png "));
    } finally {
      socket.close();
    }
  }, 30_000);

  it("hands an agent the message through herdr's agent.prompt: the paste, then Enter apart", async () => {
    const socket = await Socket.connect();
    try {
      const from = chunks(agent).length;
      socket.send({ type: "submit", id: 2, pane_id: agent.pane, text: "line one\nline two", payload: "unused" });
      expect(await socket.result(2)).toMatchObject({ ok: true });
      const read = await received(agent, from, 1);
      const enter = read.findIndex((chunk) => chunk.data.includes("\r"));
      expect(read.slice(0, enter).map((chunk) => chunk.data).join("")).toBe(paste("line one\nline two"));
      expect(read[enter]!.data).toBe("\r");
      expect(read[enter]!.at - read[enter - 1]!.at).toBeGreaterThanOrEqual(SUBMIT_DELAY_MS);
    } finally {
      socket.close();
    }
  }, 30_000);

  it("refuses an immediate Claude chat send over a live draft without calling agent.prompt or typing", async () => {
    const socket = await Socket.connect();
    const screen = mockClaudeInput(agent.pane, claudeInputScreen("❯ still typing"));
    const prompt = spyOn(herdr, "agentPrompt").mockResolvedValue(undefined);
    const sendText = spyOn(herdr, "paneSendText").mockResolvedValue(undefined);
    const sendKeys = spyOn(herdr, "paneSendKeys").mockResolvedValue(undefined);
    try {
      socket.send({ type: "submit", id: 27, pane_id: agent.pane, text: "chat message", payload: "chat message" });
      expect(await socket.result(27)).toMatchObject({
        ok: false,
        code: "input_draft",
        message: "Claude Code's input box is not empty (a draft, bash mode, or a box that could not be read); send or clear it in the terminal, then send this message",
      });
      expect(prompt).not.toHaveBeenCalled();
      expect(sendText).not.toHaveBeenCalled();
      expect(sendKeys).not.toHaveBeenCalled();
    } finally {
      sendKeys.mockRestore();
      sendText.mockRestore();
      prompt.mockRestore();
      screen.scroll.mockRestore();
      screen.read.mockRestore();
      socket.close();
    }
  }, 30_000);

  it("refuses an immediate Claude chat send in bash mode", async () => {
    const socket = await Socket.connect();
    const screen = mockClaudeInput(agent.pane, claudeInputScreen("! echo unfinished"));
    const prompt = spyOn(herdr, "agentPrompt").mockResolvedValue(undefined);
    const sendText = spyOn(herdr, "paneSendText").mockResolvedValue(undefined);
    const sendKeys = spyOn(herdr, "paneSendKeys").mockResolvedValue(undefined);
    try {
      socket.send({ type: "submit", id: 28, pane_id: agent.pane, text: "chat message", payload: "chat message" });
      expect(await socket.result(28)).toMatchObject({ ok: false, code: "input_draft" });
      expect(prompt).not.toHaveBeenCalled();
      expect(sendText).not.toHaveBeenCalled();
      expect(sendKeys).not.toHaveBeenCalled();
    } finally {
      sendKeys.mockRestore();
      sendText.mockRestore();
      prompt.mockRestore();
      screen.scroll.mockRestore();
      screen.read.mockRestore();
      socket.close();
    }
  }, 30_000);

  it("allows an immediate Claude chat send when its input box is empty", async () => {
    const socket = await Socket.connect();
    const screen = mockClaudeInput(agent.pane, claudeInputScreen("❯\u00a0"));
    const prompt = spyOn(herdr, "agentPrompt").mockResolvedValue(undefined);
    const sendText = spyOn(herdr, "paneSendText").mockResolvedValue(undefined);
    const sendKeys = spyOn(herdr, "paneSendKeys").mockResolvedValue(undefined);
    try {
      socket.send({ type: "submit", id: 29, pane_id: agent.pane, text: "chat message", payload: "chat message" });
      expect(await socket.result(29)).toMatchObject({ ok: true, pane_id: agent.pane });
      expect(prompt).toHaveBeenCalledWith(agent.pane, "chat message");
      expect(sendText).not.toHaveBeenCalled();
      expect(sendKeys).not.toHaveBeenCalled();
    } finally {
      sendKeys.mockRestore();
      sendText.mockRestore();
      prompt.mockRestore();
      screen.scroll.mockRestore();
      screen.read.mockRestore();
      socket.close();
    }
  }, 30_000);

  it("rechecks authorization after reading Claude's input box", async () => {
    const socket = await Socket.connect();
    const entered = deferred();
    const gate = deferred();
    const originalRead = herdr.paneRead;
    const read = spyOn(herdr, "paneRead").mockImplementation(async (options, socketPath) => {
      const result = await originalRead(options, socketPath);
      if (options.paneId !== agent.pane) return result;
      if (options.source === "detection") { entered.resolve(); await gate.promise; }
      return { ...result, text: claudeInputScreen("❯\u00a0") };
    });
    const prompt = spyOn(herdr, "agentPrompt").mockResolvedValue(undefined);
    const sendText = spyOn(herdr, "paneSendText").mockResolvedValue(undefined);
    const sendKeys = spyOn(herdr, "paneSendKeys").mockResolvedValue(undefined);
    try {
      socket.send({ type: "submit", id: 31, pane_id: agent.pane, text: "chat message", payload: "chat message" });
      await entered.promise;
      socket.send({ type: "role", mode: "observe" });
      await socket.waitFor((message) => message.type === "role-ack" && message.mode === "observe");
      gate.resolve();
      expect(await socket.result(31)).toMatchObject({ ok: false, code: "read_only" });
      expect(prompt).not.toHaveBeenCalled();
      expect(sendText).not.toHaveBeenCalled();
      expect(sendKeys).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      sendKeys.mockRestore();
      sendText.mockRestore();
      prompt.mockRestore();
      read.mockRestore();
      socket.close();
    }
  }, 30_000);

  it("rechecks the submit deadline after reading Claude's input box", async () => {
    const socket = await Socket.connect();
    const entered = deferred();
    const gate = deferred();
    const realNow = Date.now.bind(Date);
    let offset = 0;
    const clock = spyOn(Date, "now").mockImplementation(() => realNow() + offset);
    const originalRead = herdr.paneRead;
    const read = spyOn(herdr, "paneRead").mockImplementation(async (options, socketPath) => {
      const result = await originalRead(options, socketPath);
      if (options.paneId === agent.pane && options.source === "detection") {
        entered.resolve();
        await gate.promise;
        return { ...result, text: claudeInputScreen("❯\u00a0") };
      }
      return options.paneId === agent.pane ? { ...result, text: claudeInputScreen("❯\u00a0") } : result;
    });
    const prompt = spyOn(herdr, "agentPrompt").mockResolvedValue(undefined);
    try {
      socket.send({ type: "submit", id: 32, pane_id: agent.pane, text: "chat message", payload: "chat message" });
      await entered.promise;
      offset = SUBMIT_DEADLINE_MS + 1;
      gate.resolve();
      expect(await socket.result(32)).toMatchObject({ ok: false, code: "submit_timeout" });
      expect(prompt).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      prompt.mockRestore();
      read.mockRestore();
      clock.mockRestore();
      socket.close();
    }
  }, 30_000);

  it("preserves immediate non-Claude chat sends without reading the terminal input box", async () => {
    const socket = await Socket.connect();
    const originalRead = herdr.paneRead;
    const read = spyOn(herdr, "paneRead").mockImplementation((options, socketPath) => originalRead(options, socketPath));
    const prompt = spyOn(herdr, "agentPrompt").mockResolvedValue(undefined);
    try {
      socket.send({ type: "submit", id: 30, pane_id: codex.pane, text: "follow up", payload: "unused" });
      expect(await socket.result(30)).toMatchObject({ ok: true, pane_id: codex.pane });
      expect(prompt).toHaveBeenCalledWith(codex.pane, "follow up");
      expect(read).not.toHaveBeenCalled();
    } finally {
      prompt.mockRestore();
      read.mockRestore();
      socket.close();
    }
  }, 30_000);

  it("closes a trailing @file mention with a space, so the Enter sends rather than takes a file suggestion", async () => {
    const socket = await Socket.connect();
    try {
      const from = chunks(agent).length;
      socket.send({ type: "submit", id: 20, pane_id: agent.pane, text: "what is in @/tmp/shot.png", payload: "unused" });
      expect(await socket.result(20)).toMatchObject({ ok: true });
      const read = await received(agent, from, 1);
      const enter = read.findIndex((chunk) => chunk.data.includes("\r"));
      expect(read.slice(0, enter).map((chunk) => chunk.data).join("")).toBe(paste("what is in @/tmp/shot.png "));
    } finally {
      socket.close();
    }
  }, 30_000);

  it("refuses a message while the agent waits for an answer, typing nothing", async () => {
    const socket = await Socket.connect();
    await herdrRpc("pane.report_agent", { pane_id: agent.pane, source: "manual", agent: "claude", state: "blocked" });
    try {
      const from = chunks(agent).length;
      socket.send({ type: "submit", id: 3, pane_id: agent.pane, text: "yes", payload: "yes" });
      expect(await socket.result(3)).toMatchObject({ ok: false, code: "agent_blocked" });
      await Bun.sleep(SUBMIT_DELAY_MS * 3);
      expect(chunks(agent).slice(from)).toEqual([]);
    } finally {
      await herdrRpc("pane.report_agent", { pane_id: agent.pane, source: "manual", agent: "claude", state: "idle" });
      socket.close();
    }
  }, 30_000);

  it("types the terminal's input line into a waiting agent like the keyboard, then its Enter", async () => {
    const socket = await Socket.connect();
    await herdrRpc("pane.report_agent", { pane_id: agent.pane, source: "manual", agent: "claude", state: "blocked" });
    try {
      const from = chunks(agent).length;
      socket.send({ type: "submit", id: 12, pane_id: agent.pane, text: "2", payload: "2", typed: true });
      expect(await socket.result(12)).toMatchObject({ ok: true });
      const read = await received(agent, from, 1);
      expect(typed(agent, from)).toBe("2\r");
      // the Enter keeps its own gap after the text, as a composer message's does
      const enter = read.findIndex((chunk) => chunk.data.includes("\r"));
      // the pane's recorder stamps each read when it gets it: a text read that comes a moment late
      // shortens the gap it sees (119 on CI), so this takes the tolerance the shell case has
      if (enter > 0) expect(read[enter]!.at - read[enter - 1]!.at).toBeGreaterThanOrEqual(SUBMIT_DELAY_MS - 20);
    } finally {
      await herdrRpc("pane.report_agent", { pane_id: agent.pane, source: "manual", agent: "claude", state: "idle" });
      socket.close();
    }
  }, 30_000);

  it("still hands a message to a Codex blocked only by questions waiting collapsed in its queue", async () => {
    const socket = await Socket.connect();
    try {
      const from = chunks(codex).length;
      socket.send({ type: "submit", id: 9, pane_id: codex.pane, text: "stop, do not touch prod", payload: paste("stop, do not touch prod") });
      expect(await socket.result(9)).toMatchObject({ ok: true });
      await received(codex, from, 1);
      expect(typed(codex, from)).toBe(`${paste("stop, do not touch prod")}\r`);
    } finally {
      socket.close();
    }
  }, 30_000);

  it("never types a message into an approval under the queue, nor for an agent other than Codex", async () => {
    const socket = await Socket.connect();
    try {
      for (const [id, recorder] of [[10, codexApproval], [11, claudeQueue]] as const) {
        const from = chunks(recorder).length;
        socket.send({ type: "submit", id, pane_id: recorder.pane, text: "y", payload: "y" });
        expect(await socket.result(id)).toMatchObject({ ok: false, code: "agent_blocked" });
        await Bun.sleep(SUBMIT_DELAY_MS * 3);
        expect(chunks(recorder).slice(from)).toEqual([]);
      }
    } finally {
      socket.close();
    }
  }, 30_000);

  it("ignores a collapsed Codex queue in scrollback while a live approval waits", async () => {
    const socket = await Socket.connect();
    const originalRead = herdr.paneRead;
    const read = spyOn(herdr, "paneRead").mockImplementation(async (options, socketPath) => {
      const result = await originalRead(options, socketPath);
      // The owned pane really waits at an approval. Its scrolled viewport shows an older queue.
      return options.paneId === codexApproval.pane && options.source === "visible" ? { ...result, text: collapsedCodexScreen } : result;
    });
    try {
      const from = chunks(codexApproval).length;
      socket.send({ type: "submit", id: 20, pane_id: codexApproval.pane, text: "y", payload: "y" });
      expect(await socket.result(20)).toMatchObject({ ok: false, code: "agent_blocked" });
      expect(chunks(codexApproval).slice(from)).toEqual([]);
      expect(read.mock.calls.filter(([options]) => options.paneId === codexApproval.pane).map(([options]) => options.source)).toEqual(["detection"]);
    } finally {
      read.mockRestore();
      socket.close();
    }
  }, 30_000);

  it("allows a live collapsed Codex queue even when the viewport shows earlier output", async () => {
    const socket = await Socket.connect();
    const originalRead = herdr.paneRead;
    const read = spyOn(herdr, "paneRead").mockImplementation(async (options, socketPath) => {
      const result = await originalRead(options, socketPath);
      return options.paneId === codex.pane && options.source === "visible" ? { ...result, text: "Earlier output" } : result;
    });
    try {
      const from = chunks(codex).length;
      socket.send({ type: "submit", id: 21, pane_id: codex.pane, text: "follow up", payload: paste("follow up") });
      expect(await socket.result(21)).toMatchObject({ ok: true });
      await received(codex, from, 1);
      expect(typed(codex, from)).toBe(`${paste("follow up")}\r`);
      expect(read.mock.calls.filter(([options]) => options.paneId === codex.pane).map(([options]) => options.source)).toEqual(["detection"]);
    } finally {
      read.mockRestore();
      socket.close();
    }
  }, 30_000);

  it("keeps other input behind a message in flight: a Stop right after Send lands after its Enter", async () => {
    const socket = await Socket.connect();
    try {
      socket.send({ type: "attach", pane_id: shell.pane, cols: 100, rows: 30 });
      await socket.waitFor((message) => message.type === "pty-data" && message.pane_id === shell.pane);
      const from = chunks(shell).length;
      socket.send({ type: "submit", id: 4, pane_id: shell.pane, text: "one", payload: "one" });
      socket.send({ type: "input", pane_id: shell.pane, text: "\u001b" });
      socket.send({ type: "submit", id: 5, pane_id: shell.pane, text: "two", payload: "two" });
      await socket.result(5);
      await received(shell, from, 2);
      expect(typed(shell, from)).toBe("one\r\u001btwo\r");
    } finally {
      socket.close();
    }
  }, 30_000);

  it("sends a message typed right after a Stop only once the Stop reached the pane", async () => {
    const socket = await Socket.connect();
    try {
      socket.send({ type: "attach", pane_id: shell.pane, cols: 100, rows: 30 });
      await socket.waitFor((message) => message.type === "pty-data" && message.pane_id === shell.pane);
      await Bun.sleep(300);
      const from = chunks(shell).length;
      socket.send({ type: "input", pane_id: shell.pane, text: "\u001b" });
      socket.send({ type: "submit", id: 8, pane_id: shell.pane, text: "after", payload: "after" });
      await socket.result(8);
      await received(shell, from, 1);
      expect(typed(shell, from)).toBe("\u001bafter\r");
    } finally {
      socket.close();
    }
  }, 30_000);

  it("types nothing of a message that waited past its deadline behind another", async () => {
    // the second message waits a second behind the first one's gap, twice its deadline; the first
    // has the whole 500ms to start, which a busy runner did not always give it out of 50 (#450)
    const hurried = createServer({ port: 0, stateDir: join(root, "push-hurried"), submitDeadlineMs: 500, submitDelayMs: 1000 });
    const ws = new WebSocket(`ws://localhost:${hurried.port}/ws`);
    const seen: any[] = [];
    ws.addEventListener("message", (event) => seen.push(JSON.parse(String((event as MessageEvent).data))));
    try {
      await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));
      for (let i = 0; i < 100 && !seen.some((message) => message.type === "snapshot"); i++) await Bun.sleep(50);
      const from = chunks(shell).length;
      ws.send(JSON.stringify({ type: "submit", id: 1, pane_id: shell.pane, text: "first", payload: "first" }));
      ws.send(JSON.stringify({ type: "submit", id: 2, pane_id: shell.pane, text: "late", payload: "late" }));
      let late: any;
      for (let i = 0; i < 100 && !(late = seen.find((message) => message.type === "submit-result" && message.id === 2)); i++) await Bun.sleep(50);
      expect(seen.find((message) => message.type === "submit-result" && message.id === 1)).toMatchObject({ ok: true });
      expect(late).toMatchObject({ ok: false, code: "submit_timeout" });
      await Bun.sleep(SUBMIT_DELAY_MS * 3);
      expect(typed(shell, from)).toBe("first\r");
    } finally {
      ws.close();
      hurried.stop();
    }
  }, 30_000);

  it("still sends the Enter after the sender is gone", async () => {
    const socket = await Socket.connect();
    const from = chunks(shell).length;
    // closed right after the tap, as a phone that locks: the server finishes the send
    socket.send({ type: "submit", id: 6, pane_id: shell.pane, text: "gone", payload: "gone" });
    await Bun.sleep(20);
    socket.close();
    await received(shell, from, 1);
    expect(typed(shell, from)).toBe("gone\r");
  }, 30_000);

  it("sends nothing typed or keyed by a connection that closed while it waited behind a message", async () => {
    const gone = await Socket.connect();
    const socket = await Socket.connect();
    try {
      gone.send({ type: "attach", pane_id: shell.pane, cols: 100, rows: 30 });
      await gone.waitFor((message) => message.type === "pty-data" && message.pane_id === shell.pane);
      const from = chunks(shell).length;
      // the message is finished for a sender that left; the Stop and the Enter behind it are not
      gone.send({ type: "submit", id: 30, pane_id: shell.pane, text: "one", payload: "one" });
      gone.send({ type: "input", pane_id: shell.pane, text: "\u001b" });
      gone.send({ type: "keys", pane_id: shell.pane, keys: ["Enter"] });
      gone.close();
      await received(shell, from, 1);
      socket.send({ type: "submit", id: 31, pane_id: shell.pane, text: "two", payload: "two" });
      await socket.result(31);
      await received(shell, from, 2);
      expect(typed(shell, from)).toBe("one\rtwo\r");
    } finally {
      gone.close();
      socket.close();
    }
  }, 30_000);

  it("answers a submit from an observe connection with read_only, typing nothing", async () => {
    const socket = await Socket.connect();
    try {
      const from = chunks(shell).length;
      socket.send({ type: "role", mode: "observe" });
      await socket.waitFor((message) => message.type === "role-ack");
      socket.send({ type: "submit", id: 7, pane_id: shell.pane, text: "nope", payload: "nope" });
      expect(await socket.result(7)).toMatchObject({ ok: false, code: "read_only" });
      await Bun.sleep(SUBMIT_DELAY_MS * 3);
      expect(chunks(shell).slice(from)).toEqual([]);
    } finally {
      socket.close();
    }
  }, 30_000);
});

describe("a herdr without terminal attach (Windows)", () => {
  let bare: { port: number; stop: () => void };
  beforeAll(() => { bare = createServer({ port: 0, stateDir: join(root, "push-bare"), terminalAttach: false }); });
  afterAll(() => bare?.stop());

  it("mirrors the pane's screen: the pane's own grid first, then each changed screen, until the pane ends", async () => {
    const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
      "workspace.create", { label: "herdr-web-ui-test-submit-mirror", cwd: root, focus: false },
    );
    workspaces.push(created.workspace.workspace_id);
    const pane = created.root_pane.pane_id;
    const socket = await Socket.connect(bare.port);
    try {
      socket.send({ type: "attach", pane_id: pane, cols: 33, rows: 7, flow_control: "ack" });
      const geometry = await socket.waitFor((message) => message.type === "pane-geometry" && message.pane_id === pane);
      // the grid is herdr's, not the 33x7 this client asked for
      expect(geometry.fixed).toBe(true);
      expect([geometry.cols, geometry.rows]).not.toEqual([33, 7]);
      const first = await socket.waitFor((message) => message.type === "pty-data" && message.pane_id === pane);
      expect(socket.seen.indexOf(geometry)).toBeLessThan(socket.seen.indexOf(first));
      expect(first.data.startsWith("\u001b[?25l\u001b[0m\u001b[H\u001b[2J")).toBe(true);
      // typing goes through herdr, and what the shell prints comes back as a new screen
      socket.send({ type: "resize", pane_id: pane, cols: 33, rows: 7 });
      socket.send({ type: "input", pane_id: pane, text: "echo mirror-$((40+2))\r" });
      await socket.waitFor((message) => message.type === "pty-data" && message.pane_id === pane && message.data.includes("mirror-42"));
      expect(socket.seen.filter((message) => message.type === "pane-geometry" && message.cols === 33)).toEqual([]);
      // a second viewer gets the grid, then the current screen at once
      const late = await Socket.connect(bare.port);
      try {
        late.send({ type: "attach", pane_id: pane, cols: 80, rows: 24 });
        const screen = await late.waitFor((message) => message.type === "pty-data" && message.pane_id === pane);
        expect(screen.data).toContain("mirror-42");
      } finally {
        late.close();
      }
      await herdrRpc("workspace.close", { workspace_id: created.workspace.workspace_id });
      await socket.waitFor((message) => message.type === "pty-exit" && message.pane_id === pane);
    } finally {
      socket.close();
    }
  }, 30_000);

  it("hands several lines for an agent on a mirrored pane over as one paste, typed or sent, and bare where no agent is", async () => {
    const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
      "workspace.create", { label: "herdr-web-ui-test-submit-mirror-paste", cwd: root, focus: false },
    );
    workspaces.push(created.workspace.workspace_id);
    const pane = created.root_pane.pane_id;
    const socket = await Socket.connect(bare.port);
    const shows = (text: string) => socket.waitFor((message) => message.type === "pty-data" && message.pane_id === pane && message.data.includes(text));
    try {
      socket.send({ type: "attach", pane_id: pane, cols: 80, rows: 24 });
      await socket.waitFor((message) => message.type === "pty-data" && message.pane_id === pane);
      // a program that shows every byte it is sent, the escape of a paste marker as ^[
      socket.send({ type: "input", pane_id: pane, text: "cat -v\r" });
      await shows("cat -v");
      // no agent on the pane: the lines go as they came (#267: a program without paste support must get them bare)
      socket.send({ type: "input", pane_id: pane, text: "bare one\rbare two\r" });
      const bare = await shows("bare two");
      expect(bare.data).not.toContain("200~");
      // herdr names an agent on it: the same shape of block is one bracketed paste, on both paths
      await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "claude", state: "idle" });
      socket.send({ type: "input", pane_id: pane, text: "typed one\rtyped two" });
      await shows("^[[200~typed one");
      await shows("typed two^[[201~");
      socket.send({ type: "submit", id: 31, pane_id: pane, text: "sent one\nsent two", payload: "sent one\rsent two", typed: true });
      expect(await socket.result(31)).toMatchObject({ ok: true });
      await shows("^[[200~sent one");
      await shows("sent two^[[201~");
    } finally {
      socket.close();
    }
  }, 30_000);

  it("keeps unattached typing behind a message in flight: a Stop right after Send lands after its Enter", async () => {
    const socket = await Socket.connect(bare.port);
    try {
      const from = chunks(shell).length;
      socket.send({ type: "submit", id: 21, pane_id: shell.pane, text: "one", payload: "one" });
      socket.send({ type: "input", pane_id: shell.pane, text: "\u001b" });
      socket.send({ type: "submit", id: 22, pane_id: shell.pane, text: "two", payload: "two" });
      await socket.result(22);
      await received(shell, from, 2);
      expect(typed(shell, from)).toBe("one\r\u001btwo\r");
    } finally {
      socket.close();
    }
  }, 30_000);
});

describe("typing without terminal attach, at the edges", () => {
  it("takes its turn before herdr has said what it can do: a message sent meanwhile does not overtake it", async () => {
    let answer!: (attach: boolean) => void;
    const asked = new Promise<boolean>((resolve) => { answer = resolve; });
    const unsure = createServer({ port: 0, stateDir: join(root, "push-unsure"), terminalAttach: () => asked });
    const socket = await Socket.connect(unsure.port);
    try {
      const from = chunks(shell).length;
      socket.send({ type: "submit", id: 23, pane_id: shell.pane, text: "one", payload: "one" });
      socket.send({ type: "input", pane_id: shell.pane, text: "\u001b" });
      socket.send({ type: "submit", id: 24, pane_id: shell.pane, text: "two", payload: "two" });
      await socket.result(23);
      answer(false);
      await socket.result(24);
      await received(shell, from, 2);
      expect(typed(shell, from)).toBe("one\r\u001btwo\r");
    } finally {
      answer(false);
      socket.close();
      unsure.stop();
    }
  }, 30_000);

  it("sends nothing typed by a connection that closed while it waited its turn", async () => {
    const bare = createServer({ port: 0, stateDir: join(root, "push-gone"), terminalAttach: false });
    const gone = await Socket.connect(bare.port);
    const socket = await Socket.connect(bare.port);
    try {
      const from = chunks(shell).length;
      gone.send({ type: "submit", id: 25, pane_id: shell.pane, text: "one", payload: "one" });
      gone.send({ type: "input", pane_id: shell.pane, text: "\u001b" });
      gone.close();
      await received(shell, from, 1);
      socket.send({ type: "submit", id: 26, pane_id: shell.pane, text: "two", payload: "two" });
      await socket.result(26);
      await received(shell, from, 2);
      expect(typed(shell, from)).toBe("one\rtwo\r");
    } finally {
      socket.close();
      bare.stop();
    }
  }, 30_000);

  it("sends nothing typed into a mirrored pane that was left, or left and attached again, before its turn came (#546)", async () => {
    const bare = createServer({ port: 0, stateDir: join(root, "push-left"), terminalAttach: false, submitDelayMs: 1000 });
    const socket = await Socket.connect(bare.port);
    const since = (mark: number, predicate: (message: any) => boolean) =>
      socket.waitFor((message) => socket.seen.indexOf(message) >= mark && predicate(message));
    try {
      for (const [id, again] of [[41, false], [43, true]] as const) {
        const mark = socket.seen.length;
        socket.send({ type: "attach", pane_id: shell.pane, cols: 80, rows: 24 });
        await since(mark, (message) => message.type === "pty-data" && message.pane_id === shell.pane);
        const from = chunks(shell).length;
        // the message holds the pane's turn while the typing waits behind it and the pane is left
        socket.send({ type: "submit", id, pane_id: shell.pane, text: "one", payload: "one" });
        socket.send({ type: "input", pane_id: shell.pane, text: "typed" });
        socket.send({ type: "detach", pane_id: shell.pane });
        if (again) socket.send({ type: "attach", pane_id: shell.pane, cols: 80, rows: 24 });
        expect(await socket.result(id)).toMatchObject({ ok: true });
        socket.send({ type: "submit", id: id + 1, pane_id: shell.pane, text: "two", payload: "two" });
        await socket.result(id + 1);
        await received(shell, from, 2);
        expect(typed(shell, from)).toBe("one\rtwo\r");
        await since(mark, (message) => message.type === "error" && message.code === "input_failed" && message.pane_id === shell.pane);
        if (again) socket.send({ type: "detach", pane_id: shell.pane });
      }
    } finally {
      socket.close();
      bare.stop();
    }
  }, 30_000);

  it("sends nothing typed by a sender that left and rejoined a mirrored pane another client kept open, before its turn came", async () => {
    const bare = createServer({ port: 0, stateDir: join(root, "push-rejoin"), terminalAttach: false });
    const sender = await Socket.connect(bare.port);
    const keeper = await Socket.connect(bare.port);
    const gate = deferred();
    const entered = deferred();
    const originalSend = herdr.paneSendText;
    // the message's text waits at herdr until the sender has left and rejoined: the typing queued behind it
    // then finds the same attachment, kept open by the other client, with the sender a member again
    const send = spyOn(herdr, "paneSendText").mockImplementation(async (paneId, text, socketPath) => {
      if (paneId === shell.pane && text === "one") { entered.resolve(); await gate.promise; }
      return originalSend(paneId, text, socketPath);
    });
    try {
      for (const socket of [keeper, sender]) await attached(socket, shell.pane);
      const from = chunks(shell).length;
      sender.send({ type: "submit", id: 51, pane_id: shell.pane, text: "one", payload: "one" });
      await entered.promise;
      sender.send({ type: "input", pane_id: shell.pane, text: "typed" });
      sender.send({ type: "detach", pane_id: shell.pane });
      const mark = await attached(sender, shell.pane);
      gate.resolve();
      expect(await sender.result(51)).toMatchObject({ ok: true });
      await sender.waitFor((message) => sender.seen.indexOf(message) >= mark && message.type === "error" && message.code === "input_failed" && message.pane_id === shell.pane);
      keeper.send({ type: "submit", id: 52, pane_id: shell.pane, text: "two", payload: "two" });
      await keeper.result(52);
      await received(shell, from, 2);
      expect(typed(shell, from)).toBe("one\rtwo\r");
    } finally {
      gate.resolve();
      send.mockRestore();
      sender.close();
      keeper.close();
      bare.stop();
    }
  }, 30_000);

  it("enters no secret for a sender that left and rejoined a mirrored pane another client kept open, while the screen was read", async () => {
    const bare = createServer({ port: 0, stateDir: join(root, "push-rejoin-secret"), terminalAttach: false });
    const sender = await Socket.connect(bare.port);
    const keeper = await Socket.connect(bare.port);
    const gate = deferred();
    const entered = deferred();
    const originalRead = herdr.paneRead;
    let held = false;
    // the secret's live-screen check waits until the sender has left and rejoined, then finds the prompt
    const read = spyOn(herdr, "paneRead").mockImplementation(async (options, socketPath) => {
      const screen = await originalRead(options, socketPath);
      if (held || options.paneId !== shell.pane || options.source !== "detection" || options.format !== "text") return screen;
      held = true;
      entered.resolve();
      await gate.promise;
      return { ...screen, text: "Password:" };
    });
    try {
      for (const socket of [keeper, sender]) await attached(socket, shell.pane);
      const from = chunks(shell).length;
      sender.send({ type: "secret", id: 61, pane_id: shell.pane, prompt: "Password:", secret: "sensitive" });
      await entered.promise;
      sender.send({ type: "detach", pane_id: shell.pane });
      await attached(sender, shell.pane);
      gate.resolve();
      expect(await sender.waitFor((message) => message.type === "secret-result" && message.id === 61)).toMatchObject({ ok: false, code: "not_attached" });
      keeper.send({ type: "submit", id: 62, pane_id: shell.pane, text: "two", payload: "two" });
      await keeper.result(62);
      await received(shell, from, 1);
      expect(typed(shell, from)).toBe("two\r");
    } finally {
      gate.resolve();
      read.mockRestore();
      sender.close();
      keeper.close();
      bare.stop();
    }
  }, 30_000);

  it("presses no chord for a sender that switched to observe and back while herdr was being reached (#545)", async () => {
    const bare = createServer({ port: 0, stateDir: join(root, "push-role-keys"), terminalAttach: false });
    const sender = await Socket.connect(bare.port);
    const keeper = await Socket.connect(bare.port);
    const gate = deferred();
    const entered = deferred();
    const originalKeys = herdr.paneSendKeys;
    // every check before the RPC has passed; the sender watches and comes back before herdr is written to
    const keys = spyOn(herdr, "paneSendKeys").mockImplementation(async (paneId, sent, socketPath, guard) => {
      if (paneId === shell.pane) { entered.resolve(); await gate.promise; }
      return originalKeys(paneId, sent, socketPath, guard);
    });
    try {
      for (const socket of [keeper, sender]) await attached(socket, shell.pane);
      const from = chunks(shell).length;
      sender.send({ type: "keys", pane_id: shell.pane, keys: ["Enter"] });
      await entered.promise;
      sender.send({ type: "role", mode: "observe" });
      await sender.waitFor((message) => message.type === "role-ack" && message.mode === "observe");
      sender.send({ type: "role", mode: "interact" });
      await sender.waitFor((message) => message.type === "role-ack" && message.mode === "interact");
      gate.resolve();
      await sender.waitFor((message) => message.type === "error" && message.code === "input_failed" && message.pane_id === shell.pane);
      keeper.send({ type: "submit", id: 65, pane_id: shell.pane, text: "two", payload: "two" });
      await keeper.result(65);
      await received(shell, from, 1);
      expect(typed(shell, from)).toBe("two\r");
    } finally {
      gate.resolve();
      keys.mockRestore();
      sender.close();
      keeper.close();
      bare.stop();
    }
  }, 30_000);

  it("enters no secret for a sender that switched to observe and back while the screen was read (#589)", async () => {
    const bare = createServer({ port: 0, stateDir: join(root, "push-role-secret"), terminalAttach: false });
    const sender = await Socket.connect(bare.port);
    const keeper = await Socket.connect(bare.port);
    const gate = deferred();
    const entered = deferred();
    const originalRead = herdr.paneRead;
    let held = false;
    // the secret's live-screen check waits until the sender has watched and come back, then finds the prompt
    const read = spyOn(herdr, "paneRead").mockImplementation(async (options, socketPath) => {
      const screen = await originalRead(options, socketPath);
      if (held || options.paneId !== shell.pane || options.source !== "detection" || options.format !== "text") return screen;
      held = true;
      entered.resolve();
      await gate.promise;
      return { ...screen, text: "Password:" };
    });
    try {
      for (const socket of [keeper, sender]) await attached(socket, shell.pane);
      const from = chunks(shell).length;
      sender.send({ type: "secret", id: 63, pane_id: shell.pane, prompt: "Password:", secret: "sensitive" });
      await entered.promise;
      sender.send({ type: "role", mode: "observe" });
      await sender.waitFor((message) => message.type === "role-ack" && message.mode === "observe");
      sender.send({ type: "role", mode: "interact" });
      await sender.waitFor((message) => message.type === "role-ack" && message.mode === "interact");
      gate.resolve();
      expect(await sender.waitFor((message) => message.type === "secret-result" && message.id === 63)).toMatchObject({ ok: false, code: "read_only" });
      keeper.send({ type: "submit", id: 64, pane_id: shell.pane, text: "two", payload: "two" });
      await keeper.result(64);
      await received(shell, from, 1);
      expect(typed(shell, from)).toBe("two\r");
    } finally {
      gate.resolve();
      read.mockRestore();
      sender.close();
      keeper.close();
      bare.stop();
    }
  }, 30_000);
});

describe("herdr unreachable when a terminal is asked for", () => {
  it("answers the attach with an in-band error and attaches once herdr is back", async () => {
    const asking = createServer({ port: 0, stateDir: join(root, "push-asking") });
    const socket = await Socket.connect(asking.port);
    const reachable = process.env["HERDR_SOCKET"];
    try {
      process.env["HERDR_SOCKET"] = join(root, "no-herdr-here.sock");
      socket.send({ type: "attach", pane_id: shell.pane, cols: 100, rows: 30 });
      const refused = await socket.waitFor((message) => message.type === "error");
      expect(refused.code).toBe("connect_failed");
      process.env["HERDR_SOCKET"] = reachable;
      socket.send({ type: "attach", pane_id: shell.pane, cols: 100, rows: 30 });
      await socket.waitFor((message) => message.type === "pty-data" && message.pane_id === shell.pane);
    } finally {
      process.env["HERDR_SOCKET"] = reachable;
      socket.close();
      asking.stop();
    }
  }, 30_000);
});
