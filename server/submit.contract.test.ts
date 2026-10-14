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
  private readonly subscribers = new Set<(message: Record<string, unknown>) => void>();
  private constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener("message", (event) => {
      const message: Record<string, unknown> = JSON.parse(String((event as MessageEvent).data));
      this.seen.push(message);
      for (const subscriber of this.subscribers) subscriber(message);
    });
  }
  static async connect(port = server.port): Promise<Socket> {
    const socket = new Socket(`ws://localhost:${port}/ws`);
    await new Promise<void>((resolve) => socket.ws.addEventListener("open", () => resolve()));
    await socket.waitFor((message) => message.type === "snapshot");
    return socket;
  }
  async waitFor(predicate: (message: any) => boolean, ms = 15_000): Promise<any> {
    const found = this.seen.find(predicate);
    if (found) return found;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.subscribers.delete(subscriber);
        reject(new Error(`frame not received within ${ms}ms`));
      }, ms);
      const subscriber = (message: Record<string, unknown>) => {
        if (!predicate(message)) return;
        clearTimeout(timeout);
        this.subscribers.delete(subscriber);
        resolve(message);
      };
      this.subscribers.add(subscriber);
    });
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

let draftRequestId = -1;
async function nameDraft(socket: Socket, draft: string): Promise<void> {
  const id = draftRequestId--;
  socket.send({ type: "submit", id, pane_id: agent.pane, text: "chat message", payload: "chat message" });
  expect(await socket.result(id)).toMatchObject({ ok: false, code: "input_draft", draft });
}

/** Every read of `paneId` shows `screen`; a function gives the screen as it is at each read. */
function mockClaudeInput(paneId: string, screen: string | (() => string)) {
  const originalRead = herdr.paneRead;
  const read = spyOn(herdr, "paneRead").mockImplementation(async (options, socketPath) => {
    const result = await originalRead(options, socketPath);
    return options.paneId === paneId ? { ...result, text: typeof screen === "string" ? screen : screen() } : result;
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
  for (const failure of ["read", "menu", "clear", "keys", "send"] as const) {
    it(`reports a partial outcome for a ${failure} failure after clearing starts`, async () => {
      const socket = await Socket.connect();
      let mutated = false;
      let now = 1_800_000_000_000;
      const clock = spyOn(Date, "now").mockImplementation(() => now);
      const screen = mockClaudeInput(agent.pane, () => {
        if (!mutated) return claudeInputScreen("❯ named draft");
        if (failure === "read") throw new herdr.HerdrError("connect_failed", "read failed");
        if (failure === "clear") { now += 2_000; return claudeInputScreen("❯ named draft"); }
        return claudeInputScreen("❯\u00a0") + (failure === "menu" ? "\r\nPassword:" : "");
      });
      const keys = spyOn(herdr, "paneSendKeys").mockImplementation(async (_pane, _keys, _socket, allowed) => {
        expect(allowed?.()).toBe(true);
        mutated = true;
        if (failure === "keys") throw new herdr.HerdrError("connect_failed", "second key failed");
      });
      const prompt = spyOn(herdr, "agentPrompt").mockRejectedValue(new herdr.HerdrError("agent_not_ready", "Claude left"));
      const text = spyOn(herdr, "paneSendText").mockResolvedValue(undefined);
      try {
        await nameDraft(socket, "named draft");
        socket.send({ type: "submit", id: 820, pane_id: agent.pane, text: "keep composer text", payload: "keep composer text", clear_draft: "named draft" });
        expect(await socket.result(820)).toMatchObject({ ok: false, code: "submit_partial" });
        expect(keys).toHaveBeenCalledTimes(1);
        expect(text).not.toHaveBeenCalled();
        if (failure !== "send") expect(prompt).not.toHaveBeenCalled();
      } finally {
        text.mockRestore(); prompt.mockRestore(); keys.mockRestore();
        screen.scroll.mockRestore(); screen.read.mockRestore(); clock.mockRestore(); socket.close();
      }
    }, 30_000);
  }

  it("never falls back to a shell or another agent for a Claude clear request", async () => {
    const socket = await Socket.connect();
    const prompt = spyOn(herdr, "agentPrompt").mockRejectedValue(new herdr.HerdrError("agent_not_found", "no agent"));
    const text = spyOn(herdr, "paneSendText").mockResolvedValue(undefined);
    const keys = spyOn(herdr, "paneSendKeys").mockResolvedValue(undefined);
    try {
      socket.send({ type: "submit", id: 810, pane_id: shell.pane, text: "echo hello", payload: "echo hello", clear_draft: "named draft" });
      expect(await socket.result(810)).toMatchObject({ ok: false, code: "pending_target_changed" });
      expect(text).not.toHaveBeenCalled();
      expect(keys).not.toHaveBeenCalled();
      expect(prompt).not.toHaveBeenCalled();
    } finally {
      keys.mockRestore(); text.mockRestore(); prompt.mockRestore(); socket.close();
    }
  }, 30_000);

  for (const changed of ["terminal", "session", "shell", "agent"] as const) {
    it(`refuses the named draft when Claude's ${changed} identity changed`, async () => {
      const socket = await Socket.connect();
      const screen = mockClaudeInput(agent.pane, claudeInputScreen("❯ named draft"));
      const original = herdr.paneGet;
      let replaced = false;
      const get = spyOn(herdr, "paneGet").mockImplementation(async (paneId, socketPath) => {
        const pane = await original(paneId, socketPath);
        if (paneId !== agent.pane || !replaced) return pane;
        if (changed === "terminal") return { ...pane, terminal_id: "replacement-terminal" };
        if (changed === "session") return { ...pane, agent_session: { kind: "session_id", source: "cli", value: "replacement-session", agent: "claude" } };
        return { ...pane, agent: changed === "shell" ? null : "codex", agent_session: null };
      });
      const keys = spyOn(herdr, "paneSendKeys").mockResolvedValue(undefined);
      try {
        socket.send({ type: "submit", id: 811, pane_id: agent.pane, text: "chat", payload: "chat" });
        expect(await socket.result(811)).toMatchObject({ ok: false, code: "input_draft", draft: "named draft" });
        replaced = true;
        socket.send({ type: "submit", id: 812, pane_id: agent.pane, text: "chat", payload: "chat", clear_draft: "named draft" });
        expect(await socket.result(812)).toMatchObject({ ok: false, code: "pending_target_changed" });
        expect(keys).not.toHaveBeenCalled();
      } finally {
        keys.mockRestore(); get.mockRestore();
        screen.scroll.mockRestore(); screen.read.mockRestore(); socket.close();
      }
    }, 30_000);
  }

  for (const [label, tail] of [
    ["secret prompt", "\r\nPassword:"],
    ["approval", "\r\nBash command\r\n\r\n  curl -I https://example.com\r\n  Fetch HTTP headers.\r\n\r\nThis command requires approval\r\n\r\nDo you want to proceed?\r\n❯ 1. Yes\r\n  2. Yes, and don’t ask again for: curl *\r\n  3. No\r\n\r\nEsc to cancel · Tab to amend · ctrl+e to explain"],
    ["model list", "\r\nEnter to set as default · s to use this session only · Esc to cancel"],
  ]) {
    it(`refuses clearing when a ${label} owns input below the named box`, async () => {
      const socket = await Socket.connect();
      let shown = claudeInputScreen("❯ named draft");
      const screen = mockClaudeInput(agent.pane, () => shown);
      const prompt = spyOn(herdr, "agentPrompt").mockResolvedValue(undefined);
      const keys = spyOn(herdr, "paneSendKeys").mockResolvedValue(undefined);
      try {
        await nameDraft(socket, "named draft");
        shown += tail;
        socket.send({ type: "submit", id: 800, pane_id: agent.pane, text: "chat", payload: "chat", clear_draft: "named draft" });
        expect(await socket.result(800)).toMatchObject({ ok: false, code: "agent_blocked" });
        expect(keys).not.toHaveBeenCalled();
        expect(prompt).not.toHaveBeenCalled();
      } finally {
        keys.mockRestore(); prompt.mockRestore();
        screen.scroll.mockRestore(); screen.read.mockRestore(); socket.close();
      }
    }, 30_000);
  }

  it("refuses clearing when a prompt opens while the pane's state is read", async () => {
    const socket = await Socket.connect();
    let shown = claudeInputScreen("❯ named draft");
    const screen = mockClaudeInput(agent.pane, () => shown);
    const original = herdr.paneGet;
    let armed = false;
    let reads = 0;
    const get = spyOn(herdr, "paneGet").mockImplementation(async (paneId, socketPath) => {
      const pane = await original(paneId, socketPath);
      // the last state read before the clearing keys: the prompt opens while it is answered
      if (paneId === agent.pane && armed && ++reads === 3) shown = claudeInputScreen("❯ named draft") + "\r\nPassword:";
      return pane;
    });
    const keys = spyOn(herdr, "paneSendKeys").mockResolvedValue(undefined);
    try {
      await nameDraft(socket, "named draft");
      armed = true;
      socket.send({ type: "submit", id: 802, pane_id: agent.pane, text: "chat", payload: "chat", clear_draft: "named draft" });
      expect(await socket.result(802)).toMatchObject({ ok: false, code: "agent_blocked" });
      expect(keys).not.toHaveBeenCalled();
    } finally {
      keys.mockRestore(); get.mockRestore();
      screen.scroll.mockRestore(); screen.read.mockRestore(); socket.close();
    }
  }, 30_000);

  it("refuses clearing when Claude reports blocked despite an ordinary named box", async () => {
    const socket = await Socket.connect();
    const screen = mockClaudeInput(agent.pane, claudeInputScreen("❯ named draft"));
    const original = herdr.paneGet;
    let blocked = false;
    const get = spyOn(herdr, "paneGet").mockImplementation(async (paneId, socketPath) => {
      const pane = await original(paneId, socketPath);
      return paneId === agent.pane && blocked ? { ...pane, agent_status: "blocked" } : pane;
    });
    const keys = spyOn(herdr, "paneSendKeys").mockResolvedValue(undefined);
    try {
      await nameDraft(socket, "named draft");
      blocked = true;
      socket.send({ type: "submit", id: 801, pane_id: agent.pane, text: "chat", payload: "chat", clear_draft: "named draft" });
      expect(await socket.result(801)).toMatchObject({ ok: false, code: "agent_blocked" });
      expect(keys).not.toHaveBeenCalled();
    } finally {
      keys.mockRestore(); get.mockRestore();
      screen.scroll.mockRestore(); screen.read.mockRestore(); socket.close();
    }
  }, 30_000);

  it("does not submit after clearing when no ordinary input box can be confirmed", async () => {
    const socket = await Socket.connect();
    let shown = claudeInputScreen("❯ named draft");
    const screen = mockClaudeInput(agent.pane, () => shown);
    const keys = spyOn(herdr, "paneSendKeys").mockImplementation(async () => { shown = "redrawing"; });
    const prompt = spyOn(herdr, "agentPrompt").mockResolvedValue(undefined);
    try {
      await nameDraft(socket, "named draft");
      socket.send({ type: "submit", id: 802, pane_id: agent.pane, text: "chat", payload: "chat", clear_draft: "named draft" });
      expect(await socket.result(802)).toMatchObject({ ok: false });
      expect(keys).toHaveBeenCalledTimes(1);
      expect(prompt).not.toHaveBeenCalled();
    } finally {
      prompt.mockRestore(); keys.mockRestore();
      screen.scroll.mockRestore(); screen.read.mockRestore(); socket.close();
    }
  }, 30_000);

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
        draft: "still typing",
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
      const refused = await socket.result(28);
      expect(refused).toMatchObject({ ok: false, code: "input_draft" });
      // bash mode is not a draft the chat clears
      expect(refused.draft).toBeUndefined();
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

  it("clears the draft a refusal named, once asked to, and sends when the box reads empty", async () => {
    const socket = await Socket.connect();
    let shown = claudeInputScreen("❯ ㅔ");
    const screen = mockClaudeInput(agent.pane, () => shown);
    const order: string[] = [];
    const prompt = spyOn(herdr, "agentPrompt").mockImplementation(async () => { order.push("prompt"); });
    const sendText = spyOn(herdr, "paneSendText").mockResolvedValue(undefined);
    // The clearing step changes the box before the following read.
    const sendKeys = spyOn(herdr, "paneSendKeys").mockImplementation(async (_pane, keys) => {
      order.push(keys.join(" "));
      shown = claudeInputScreen("❯\u00a0");
    });
    try {
      socket.send({ type: "submit", id: 66, pane_id: agent.pane, text: "이 스킬 pr 올려줘", payload: "이 스킬 pr 올려줘" });
      expect(await socket.result(66)).toMatchObject({ ok: false, code: "input_draft", draft: "ㅔ" });
      expect(sendKeys).not.toHaveBeenCalled();
      socket.send({ type: "submit", id: 67, pane_id: agent.pane, text: "이 스킬 pr 올려줘", payload: "이 스킬 pr 올려줘", clear_draft: "ㅔ" });
      expect(await socket.result(67)).toMatchObject({ ok: true, pane_id: agent.pane });
      expect(sendKeys).toHaveBeenCalledWith(agent.pane, ["ctrl+k", "ctrl+u"], undefined, expect.any(Function));
      expect(prompt).toHaveBeenCalledWith(agent.pane, "이 스킬 pr 올려줘");
      expect(order).toEqual(["ctrl+k ctrl+u", "prompt"]);
      expect(sendText).not.toHaveBeenCalled();
    } finally {
      sendKeys.mockRestore();
      sendText.mockRestore();
      prompt.mockRestore();
      screen.scroll.mockRestore();
      screen.read.mockRestore();
      socket.close();
    }
  }, 30_000);

  it("leaves the named draft untouched when too little submit budget remains", async () => {
    const hurried = createServer({ port: 0, stateDir: join(root, "push-named-hurried"), submitDeadlineMs: 1_000 });
    const socket = await Socket.connect(hurried.port);
    const clock = spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    let shown = claudeInputScreen("❯ named draft");
    const screen = mockClaudeInput(agent.pane, () => shown);
    const prompt = spyOn(herdr, "agentPrompt").mockResolvedValue(undefined);
    const sendKeys = spyOn(herdr, "paneSendKeys").mockImplementation(async () => {
      shown = claudeInputScreen("❯\u00a0");
    });
    try {
      await nameDraft(socket, "named draft");
      socket.send({ type: "submit", id: 73, pane_id: agent.pane, text: "chat message", payload: "chat message", clear_draft: "named draft" });
      expect(await socket.result(73)).toMatchObject({ ok: false, code: "submit_timeout" });
      expect(sendKeys).not.toHaveBeenCalled();
      expect(prompt).not.toHaveBeenCalled();
    } finally {
      sendKeys.mockRestore();
      prompt.mockRestore();
      screen.scroll.mockRestore();
      screen.read.mockRestore();
      clock.mockRestore();
      socket.close();
      hurried.stop();
    }
  }, 30_000);

  it("reports a partial outcome rather than nothing typed when the deadline expires after clearing", async () => {
    const socket = await Socket.connect();
    let shown = claudeInputScreen("❯ named draft");
    let now = 1_800_000_000_000;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const screen = mockClaudeInput(agent.pane, () => shown);
    const prompt = spyOn(herdr, "agentPrompt").mockResolvedValue(undefined);
    const sendKeys = spyOn(herdr, "paneSendKeys").mockImplementation(async () => {
      shown = claudeInputScreen("❯\u00a0");
      now += SUBMIT_DEADLINE_MS + 1;
    });
    try {
      await nameDraft(socket, "named draft");
      socket.send({ type: "submit", id: 74, pane_id: agent.pane, text: "chat message", payload: "chat message", clear_draft: "named draft" });
      expect(await socket.result(74)).toMatchObject({ ok: false, code: "submit_partial" });
      expect(sendKeys).toHaveBeenCalledTimes(1);
      expect(prompt).not.toHaveBeenCalled();
    } finally {
      sendKeys.mockRestore();
      prompt.mockRestore();
      screen.scroll.mockRestore();
      screen.read.mockRestore();
      clock.mockRestore();
      socket.close();
    }
  }, 30_000);

  it("clears nothing when the named draft gained trailing whitespace", async () => {
    const socket = await Socket.connect();
    let shown = claudeInputScreen("❯ named draft");
    const screen = mockClaudeInput(agent.pane, () => shown);
    const prompt = spyOn(herdr, "agentPrompt").mockResolvedValue(undefined);
    const sendKeys = spyOn(herdr, "paneSendKeys").mockResolvedValue(undefined);
    try {
      await nameDraft(socket, "named draft");
      shown = claudeInputScreen("❯ named draft ");
      socket.send({ type: "submit", id: 75, pane_id: agent.pane, text: "chat message", payload: "chat message", clear_draft: "named draft" });
      expect(await socket.result(75)).toMatchObject({ ok: false, code: "input_draft", draft: "named draft " });
      expect(sendKeys).not.toHaveBeenCalled();
      expect(prompt).not.toHaveBeenCalled();
    } finally {
      sendKeys.mockRestore();
      prompt.mockRestore();
      screen.scroll.mockRestore();
      screen.read.mockRestore();
      socket.close();
    }
  }, 30_000);

  it("rechecks the named draft immediately before clearing when text changes after the first observation", async () => {
    const socket = await Socket.connect();
    let reads = 0;
    let cleared = false;
    const screen = mockClaudeInput(agent.pane, () => cleared ? claudeInputScreen("❯\u00a0")
      : claudeInputScreen(++reads <= 3 ? "❯ named draft" : "❯ typed since"));
    const prompt = spyOn(herdr, "agentPrompt").mockResolvedValue(undefined);
    const sendKeys = spyOn(herdr, "paneSendKeys").mockImplementation(async () => { cleared = true; });
    try {
      await nameDraft(socket, "named draft");
      reads = 0;
      socket.send({ type: "submit", id: 76, pane_id: agent.pane, text: "chat message", payload: "chat message", clear_draft: "named draft" });
      expect(await socket.result(76)).toMatchObject({ ok: false, code: "input_draft", draft: "typed since" });
      expect(sendKeys).not.toHaveBeenCalled();
      expect(prompt).not.toHaveBeenCalled();
    } finally {
      sendKeys.mockRestore();
      prompt.mockRestore();
      screen.scroll.mockRestore();
      screen.read.mockRestore();
      socket.close();
    }
  }, 30_000);

  it("clears nothing when the box holds another draft than the one named, and names the new one", async () => {
    const socket = await Socket.connect();
    let shown = claudeInputScreen("❯ ㅔ");
    const screen = mockClaudeInput(agent.pane, () => shown);
    const prompt = spyOn(herdr, "agentPrompt").mockResolvedValue(undefined);
    const sendText = spyOn(herdr, "paneSendText").mockResolvedValue(undefined);
    const sendKeys = spyOn(herdr, "paneSendKeys").mockResolvedValue(undefined);
    try {
      await nameDraft(socket, "ㅔ");
      shown = claudeInputScreen("❯ typed since");
      socket.send({ type: "submit", id: 68, pane_id: agent.pane, text: "chat message", payload: "chat message", clear_draft: "ㅔ" });
      expect(await socket.result(68)).toMatchObject({ ok: false, code: "input_draft", draft: "typed since" });
      expect(sendKeys).not.toHaveBeenCalled();
      expect(prompt).not.toHaveBeenCalled();
      expect(sendText).not.toHaveBeenCalled();
    } finally {
      sendKeys.mockRestore();
      sendText.mockRestore();
      prompt.mockRestore();
      screen.scroll.mockRestore();
      screen.read.mockRestore();
      socket.close();
    }
  }, 30_000);

  it("types nothing when the cleared box does not read empty", async () => {
    const socket = await Socket.connect();
    const screen = mockClaudeInput(agent.pane, claudeInputScreen("❯ ㅔ"));
    const prompt = spyOn(herdr, "agentPrompt").mockResolvedValue(undefined);
    const sendText = spyOn(herdr, "paneSendText").mockResolvedValue(undefined);
    const sendKeys = spyOn(herdr, "paneSendKeys").mockResolvedValue(undefined);
    try {
      await nameDraft(socket, "ㅔ");
      socket.send({ type: "submit", id: 69, pane_id: agent.pane, text: "chat message", payload: "chat message", clear_draft: "ㅔ" });
      expect(await socket.result(69)).toMatchObject({ ok: false, code: "submit_partial" });
      expect(sendKeys).toHaveBeenCalledTimes(1);
      expect(prompt).not.toHaveBeenCalled();
      expect(sendText).not.toHaveBeenCalled();
    } finally {
      sendKeys.mockRestore();
      sendText.mockRestore();
      prompt.mockRestore();
      screen.scroll.mockRestore();
      screen.read.mockRestore();
      socket.close();
    }
  }, 30_000);

  it("clears a terminal draft only for a chat message sent at once", async () => {
    const socket = await Socket.connect();
    const sendKeys = spyOn(herdr, "paneSendKeys").mockResolvedValue(undefined);
    try {
      socket.send({ type: "submit", id: 70, pane_id: agent.pane, text: "chat message", payload: "chat message", delivery: "queue", clear_draft: "ㅔ" });
      expect(await socket.result(70)).toMatchObject({ ok: false, code: "invalid_delivery" });
      socket.send({ type: "submit", id: 71, pane_id: agent.pane, text: "chat message", payload: "chat message", typed: true, clear_draft: "ㅔ" });
      expect(await socket.result(71)).toMatchObject({ ok: false, code: "invalid_delivery" });
      socket.send({ type: "submit", id: 72, pane_id: agent.pane, text: "chat message", payload: "chat message", clear_draft: "" });
      expect(await socket.result(72)).toMatchObject({ ok: false, code: "invalid_delivery" });
      expect(sendKeys).not.toHaveBeenCalled();
    } finally {
      sendKeys.mockRestore();
      socket.close();
    }
  }, 30_000);

  it("clears the chat's own last message Claude put back in its box after a cancel, then sends", async () => {
    const socket = await Socket.connect();
    let shown = claudeInputScreen("❯\u00a0");
    const originalRead = herdr.paneRead;
    const read = spyOn(herdr, "paneRead").mockImplementation(async (options, socketPath) => {
      const result = await originalRead(options, socketPath);
      return options.paneId === agent.pane ? { ...result, text: shown } : result;
    });
    const scroll = spyOn(herdr, "paneScrollInfo").mockResolvedValue(null);
    const prompt = spyOn(herdr, "agentPrompt").mockResolvedValue(undefined);
    const sendText = spyOn(herdr, "paneSendText").mockResolvedValue(undefined);
    const sendKeys = spyOn(herdr, "paneSendKeys").mockImplementation(async (paneId, keys) => {
      // Claude's Esc on its own restored copy empties the box
      if (paneId === agent.pane && keys?.[0] === "esc") shown = claudeInputScreen("❯\u00a0");
    });
    try {
      // the first send is what the box's copy is compared against
      socket.send({ type: "submit", id: 40, pane_id: agent.pane, text: "chat message", payload: "chat message" });
      expect(await socket.result(40)).toMatchObject({ ok: true });
      // as on a cancel right after it: Claude removes the turn and puts the text back, typed
      shown = claudeInputScreen("❯ chat message");
      socket.send({ type: "submit", id: 41, pane_id: agent.pane, text: "second message", payload: "second message" });
      expect(await socket.result(41)).toMatchObject({ ok: true });
      // each Esc asks the sender's right again right before herdr is written to
      expect(sendKeys.mock.calls).toEqual([[agent.pane, ["esc"], undefined, expect.any(Function)], [agent.pane, ["esc"], undefined, expect.any(Function)]]);
      expect(prompt).toHaveBeenLastCalledWith(agent.pane, "second message");
      expect(sendText).not.toHaveBeenCalled();
    } finally {
      sendKeys.mockRestore();
      sendText.mockRestore();
      prompt.mockRestore();
      scroll.mockRestore();
      read.mockRestore();
      socket.close();
    }
  }, 30_000);

  it("leaves Claude's restored copy alone when too little of the send's deadline is left to clear it and send", async () => {
    // a deadline shorter than clearing takes: the Esc presses would erase the copy, then the send time out
    const hurried = createServer({ port: 0, stateDir: join(root, "push-restored-hurried"), submitDeadlineMs: 1_000 });
    const socket = await Socket.connect(hurried.port);
    let shown = claudeInputScreen("\u276f\u00a0");
    const originalRead = herdr.paneRead;
    const read = spyOn(herdr, "paneRead").mockImplementation(async (options, socketPath) => {
      const result = await originalRead(options, socketPath);
      return options.paneId === agent.pane ? { ...result, text: shown } : result;
    });
    const scroll = spyOn(herdr, "paneScrollInfo").mockResolvedValue(null);
    const prompt = spyOn(herdr, "agentPrompt").mockResolvedValue(undefined);
    const sendText = spyOn(herdr, "paneSendText").mockResolvedValue(undefined);
    const sendKeys = spyOn(herdr, "paneSendKeys").mockResolvedValue(undefined);
    try {
      socket.send({ type: "submit", id: 44, pane_id: agent.pane, text: "chat message", payload: "chat message" });
      expect(await socket.result(44)).toMatchObject({ ok: true });
      shown = claudeInputScreen("\u276f chat message");
      socket.send({ type: "submit", id: 45, pane_id: agent.pane, text: "second message", payload: "second message" });
      expect(await socket.result(45)).toMatchObject({ ok: false, code: "submit_timeout" });
      expect(sendKeys).not.toHaveBeenCalled();
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(sendText).not.toHaveBeenCalled();
    } finally {
      sendKeys.mockRestore();
      sendText.mockRestore();
      prompt.mockRestore();
      scroll.mockRestore();
      read.mockRestore();
      socket.close();
      hurried.stop();
    }
  }, 30_000);

  it("still refuses an immediate Claude chat send over a draft that is not the chat's own message", async () => {
    const socket = await Socket.connect();
    let shown = claudeInputScreen("❯\u00a0");
    const originalRead = herdr.paneRead;
    const read = spyOn(herdr, "paneRead").mockImplementation(async (options, socketPath) => {
      const result = await originalRead(options, socketPath);
      return options.paneId === agent.pane ? { ...result, text: shown } : result;
    });
    const scroll = spyOn(herdr, "paneScrollInfo").mockResolvedValue(null);
    const prompt = spyOn(herdr, "agentPrompt").mockResolvedValue(undefined);
    const sendText = spyOn(herdr, "paneSendText").mockResolvedValue(undefined);
    const sendKeys = spyOn(herdr, "paneSendKeys").mockResolvedValue(undefined);
    try {
      socket.send({ type: "submit", id: 42, pane_id: agent.pane, text: "chat message", payload: "chat message" });
      expect(await socket.result(42)).toMatchObject({ ok: true });
      // the copy back in the box, typed on: the user's now, so it refuses and never presses Esc
      shown = claudeInputScreen("❯ chat message, edited");
      socket.send({ type: "submit", id: 43, pane_id: agent.pane, text: "second message", payload: "second message" });
      expect(await socket.result(43)).toMatchObject({ ok: false, code: "input_draft" });
      expect(sendKeys).not.toHaveBeenCalled();
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(sendText).not.toHaveBeenCalled();
    } finally {
      sendKeys.mockRestore();
      sendText.mockRestore();
      prompt.mockRestore();
      scroll.mockRestore();
      read.mockRestore();
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
