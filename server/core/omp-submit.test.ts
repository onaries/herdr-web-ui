import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSubmitText } from "./composer.ts";

// The real RPC client against a unix socket this test owns; only herdr's answers are synthetic.
let root: string;
let listener: ReturnType<typeof Bun.listen>;
let socketBefore: string | undefined;
let homeBefore: string | undefined;
let integration: string;
let agent: string;
/** whether herdr's omp integration has reported the pane's session (omp's session_start) */
let reported: boolean;
let ompPid: number;
let calls: { method: string; params: Record<string, unknown> }[];
let onPaneGet: (() => void) | undefined;
/** a process started just now, standing in for an omp that is still starting */
let fresh: ReturnType<typeof Bun.spawn> | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "herdr-web-ui-omp-submit-"));
  agent = "omp";
  reported = false;
  ompPid = 1;
  calls = [];
  onPaneGet = undefined;
  // the omp stand-ins and this process share a home with herdr's omp integration installed
  homeBefore = process.env["HOME"];
  process.env["HOME"] = root;
  integration = join(root, ".omp", "agent", "extensions", "herdr-omp-agent-state.ts");
  mkdirSync(join(root, ".omp", "agent", "extensions"), { recursive: true });
  writeFileSync(integration, "// installed by herdr\n");
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
        const request = JSON.parse(socket.data.buffer) as { id: string; method: string; params?: Record<string, unknown> };
        calls.push({ method: request.method, params: request.params ?? {} });
        if (request.method === "pane.get") onPaneGet?.();
        const session = reported ? { agent_session: { agent: "omp", kind: "path", source: "herdr:omp", value: join(root, "session.jsonl") } } : {};
        const result = request.method === "pane.get"
          ? { pane: { pane_id: "w:p1", workspace_id: "w", tab_id: "w:t1", terminal_id: "w:p1", cwd: root, focused: false, revision: 0, agent, ...session } }
          : request.method === "pane.process_info" ? { process_info: { foreground_processes: [{ pid: ompPid, argv: ["omp"], cwd: root }] } }
          : request.method === "agent.prompt" || request.method === "pane.send_keys" ? {}
          : null;
        if (result === null) throw new Error(`unexpected RPC ${request.method}`);
        socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
      },
    },
  });
});

afterEach(() => {
  fresh?.kill();
  fresh = undefined;
  listener.stop(true);
  if (socketBefore === undefined) delete process.env["HERDR_SOCKET"];
  else process.env["HERDR_SOCKET"] = socketBefore;
  if (homeBefore === undefined) delete process.env["HOME"];
  else process.env["HOME"] = homeBefore;
  rmSync(root, { recursive: true, force: true });
});

const submitter = () => createSubmitText({
  options: { submitDelayMs: 0, ompReportPollMs: 5 }, lastTyped: new Map(), attachments: new Map(), terminalAttach: async () => false,
  SUBMIT_DEADLINE_MS: 20_000, TYPED_SETTLE_MS: 0, DRAFT_CLEAR_WAIT_MS: 0, DRAFT_CLEAR_POLL_MS: 0, SUBMIT_DELAY_MS: 0,
});
const count = (method: string): number => calls.filter((call) => call.method === method).length;
const startedNow = (): number => {
  fresh = Bun.spawn(["sleep", "60"], { env: { ...process.env, HOME: root } });
  return fresh.pid;
};
async function until(what: string, done: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}
const posix = process.platform !== "win32";

describe("a message sent to omp", () => {
  it("is sent at once to an omp whose integration has reported its session", async () => {
    reported = true;
    ompPid = posix ? startedNow() : 1;
    await submitter()("w:p1", "/effort", "/effort", Date.now());
    expect(count("agent.prompt")).toBe(1);
    expect(count("pane.process_info")).toBe(0);
  });

  it.skipIf(!posix)("waits while an omp started moments ago has not reported, then sends once and presses nothing", async () => {
    ompPid = startedNow();
    const sent = submitter()("w:p1", "/effort", "/effort", Date.now());
    await until("a few looks at the starting omp", () => count("pane.get") >= 3);
    expect(count("agent.prompt"), "nothing is sent before omp takes input").toBe(0);
    reported = true;
    await sent;
    expect(count("agent.prompt")).toBe(1);
    expect(count("pane.send_keys")).toBe(0);
  });

  it.skipIf(!posix)("sends at once to a starting omp without herdr's integration, which nothing would report", async () => {
    rmSync(integration);
    ompPid = startedNow();
    await submitter()("w:p1", "/effort", "/effort", Date.now());
    expect(count("agent.prompt")).toBe(1);
    expect(count("pane.get")).toBe(1);
  });

  it("sends at once to an omp that has run for long, which may have no integration", async () => {
    ompPid = 1;
    await submitter()("w:p1", "/effort", "/effort", Date.now());
    expect(count("agent.prompt")).toBe(1);
    expect(count("pane.get")).toBe(1);
  });

  it.skipIf(!posix)("stops waiting once the sender may no longer send, and sends nothing", async () => {
    ompPid = startedNow();
    let permitted = true;
    const sent = submitter()("w:p1", "/effort", "/effort", Date.now(), false, () => { if (!permitted) throw new Error("revoked"); });
    await until("a look at the starting omp", () => count("pane.get") >= 2);
    permitted = false;
    await expect(sent).rejects.toThrow("revoked");
    expect(count("agent.prompt")).toBe(0);
  });

  it.skipIf(!posix)("sends nothing when the sender lost access while the last look was answered", async () => {
    ompPid = startedNow();
    let permitted = true;
    onPaneGet = () => {
      if (count("pane.get") < 3) return;
      reported = true;
      permitted = false;
    };
    const sent = submitter()("w:p1", "/effort", "/effort", Date.now(), false, () => { if (!permitted) throw new Error("revoked"); });
    await expect(sent).rejects.toThrow("revoked");
    expect(count("agent.prompt")).toBe(0);
  });

  it.skipIf(!posix)("sends nothing when the pane is restarted into another omp while it is waited for", async () => {
    ompPid = startedNow();
    const sent = submitter()("w:p1", "/effort", "/effort", Date.now());
    await until("a look at the starting omp", () => count("pane.get") >= 2);
    const replacement = Bun.spawn(["sleep", "60"], { env: { ...process.env, HOME: root } });
    try {
      ompPid = replacement.pid;
      reported = true;
      await expect(sent).rejects.toThrow("was replaced");
      expect(count("agent.prompt")).toBe(0);
    } finally {
      replacement.kill();
    }
  });

  it.skipIf(!posix)("sends nothing when the wait runs out on another omp the pane was restarted into", async () => {
    ompPid = startedNow();
    const replacement = Bun.spawn(["sleep", "60"], { env: { ...process.env, HOME: root } });
    try {
      const sent = createSubmitText({
        // past processStartedAt's up to one second of boot-time rounding, so the wait really runs
        options: { submitDelayMs: 0, ompReportPollMs: 5, ompStartupMs: 2_500 }, lastTyped: new Map(), attachments: new Map(), terminalAttach: async () => false,
        SUBMIT_DEADLINE_MS: 20_000, TYPED_SETTLE_MS: 0, DRAFT_CLEAR_WAIT_MS: 0, DRAFT_CLEAR_POLL_MS: 0, SUBMIT_DELAY_MS: 0,
      })("w:p1", "/effort", "/effort", Date.now());
      await until("a look at the starting omp", () => count("pane.get") >= 2);
      ompPid = replacement.pid;
      await expect(sent).rejects.toThrow("was replaced");
      expect(count("agent.prompt")).toBe(0);
    } finally {
      replacement.kill();
    }
  });

  it.skipIf(!posix)("sends nothing when omp stops while it is waited for", async () => {
    ompPid = startedNow();
    const sent = submitter()("w:p1", "/effort", "/effort", Date.now());
    await until("a look at the starting omp", () => count("pane.get") >= 2);
    agent = "";
    await expect(sent).rejects.toThrow("stopped while it started");
    expect(count("agent.prompt") + count("pane.send_text") + count("pane.send_keys")).toBe(0);
  });

  it.skipIf(!posix)("does not wait for another agent", async () => {
    agent = "codex";
    ompPid = startedNow();
    await submitter()("w:p1", "/effort", "/effort", Date.now());
    expect(count("agent.prompt")).toBe(1);
    expect(count("pane.get"), "no look at a starting omp").toBe(1);
  });
});
