import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrPane, SessionSnapshot } from "../shared/protocol.ts";

import { forgetTranscriptState, paneConversation } from "./conversation.ts";
import * as herdr from "./herdr/client.ts";
import { terminalBreadcrumb } from "./gjc-runtime.ts";
import { isOmpProcess, ompAgentDir } from "./omp.ts";

it("recognizes native and interpreter-launched omp, not look-alikes", () => {
  expect(isOmpProcess(["omp", "--profile", "personal", "--resume"])).toBe(true);
  expect(isOmpProcess(["/home/u/.local/bin/omp"])).toBe(true);
  expect(isOmpProcess(["bun", "/opt/omp/dist/omp.js"])).toBe(true);
  expect(isOmpProcess(["C:\\Users\\u\\bin\\omp.exe"])).toBe(true);
  expect(isOmpProcess(["omo"])).toBe(false);
  expect(isOmpProcess(["omp-helper"])).toBe(false);
  expect(isOmpProcess(["node", "/tmp/omp/server.js"])).toBe(false);
  expect(isOmpProcess([])).toBe(false);
});

it("keeps a process's sessions where its profile puts them, and nowhere it cannot tell", () => {
  const home = "/home/u";
  expect(ompAgentDir(["omp", "--continue"], null, home)).toBe("/home/u/.omp/agent");
  expect(ompAgentDir(["omp", "--profile", "personal", "--resume"], null, home)).toBe("/home/u/.omp/profiles/personal/agent");
  expect(ompAgentDir(["omp", "--profile=work"], null, home)).toBe("/home/u/.omp/profiles/work/agent");
  expect(ompAgentDir(["omp"], ["PATH=/bin", "OMP_PROFILE=personal"], home)).toBe("/home/u/.omp/profiles/personal/agent");
  // the flag wins over the environment; an empty variable is no profile
  expect(ompAgentDir(["omp", "--profile", "work"], ["OMP_PROFILE=personal"], home)).toBe("/home/u/.omp/profiles/work/agent");
  expect(ompAgentDir(["omp"], ["OMP_PROFILE="], home)).toBe("/home/u/.omp/agent");
  // a store moved anywhere, or a name that leaves the profiles folder, is not trusted
  expect(ompAgentDir(["omp", "--session-dir", "/tmp/s"], null, home)).toBeNull();
  expect(ompAgentDir(["omp", "--session-dir=/tmp/s"], null, home)).toBeNull();
  expect(ompAgentDir(["omp", "--profile", ".."], null, home)).toBeNull();
  expect(ompAgentDir(["omp", "--profile", "a/../../x"], null, home)).toBeNull();
  expect(ompAgentDir(["omp", "--profile"], null, home)).toBeNull();
});

it("reads omp's breadcrumb, whose transcript starts with a title record before the header", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "omp-breadcrumb-")));
  try {
    const agent = join(home, ".omp/profiles/personal/agent");
    const store = join(agent, "sessions/-project"), markers = join(agent, "terminal-sessions");
    mkdirSync(join(store, "2026-10-04_session"), { recursive: true }); mkdirSync(markers);
    const session = join(store, "2026-10-04_session.jsonl"), advisor = join(store, "2026-10-04_session", "__advisor.scribe.jsonl");
    const records = [{ type: "title", v: 1, title: "Fix the metrics", pad: " ".repeat(120) }, { type: "session", version: 3, cwd: home }];
    writeFileSync(session, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
    writeFileSync(advisor, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
    // omp's breadcrumb carries more lines than the cwd and the path
    writeFileSync(join(markers, "pts-7"), `${home}\n${session}\nfresh\ncwdstat 1 2\n`);
    expect(terminalBreadcrumb(agent, home, "pts-7", 0)).toBe(session);
    // an advisor's file stands for the session it runs in
    writeFileSync(join(markers, "pts-7"), `${home}\n${advisor}\n`);
    expect(terminalBreadcrumb(agent, home, "pts-7", 0)).toBe(session);
    // a title with no header after it is not a transcript
    writeFileSync(session, JSON.stringify(records[0]) + "\n");
    writeFileSync(join(markers, "pts-7"), `${home}\n${session}\n`);
    expect(terminalBreadcrumb(agent, home, "pts-7", 0)).toBeNull();
  } finally { rmSync(home, { recursive: true, force: true }); }
});

describe("an omp pane's chat", () => {
  let home = "";
  let savedHome: string | undefined;
  let agentSession: unknown;
  let processes: { pid: number; argv: string[] }[] = [];
  let pane: HerdrPane;
  const restores: Array<() => void> = [];
  const transcript = (cwd: string) => [
    JSON.stringify({ type: "title", v: 1, title: "t" }),
    JSON.stringify({ type: "session", version: 3, id: "s1", cwd }),
    JSON.stringify({ type: "message", timestamp: "2026-10-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "synthetic question" }] } }),
    JSON.stringify({ type: "message", timestamp: "2026-10-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "synthetic answer" }] } }),
  ].join("\n") + "\n";

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "herdr-omp-pane-")));
    savedHome = process.env["HOME"];
    process.env["HOME"] = home;
    const cwd = join(home, "project");
    mkdirSync(cwd);
    pane = { pane_id: "pane-omp", cwd, foreground_cwd: cwd, agent: "omp" } as HerdrPane;
    const snapshot = spyOn(herdr, "sessionSnapshot").mockImplementation(async () => ({ panes: [pane] } as SessionSnapshot));
    const rpc = spyOn(herdr, "herdrRpc").mockImplementation(async (method) => {
      if (method === "agent.get") return { agent: { agent_session: agentSession } } as never;
      if (method === "pane.process_info") return { process_info: { foreground_processes: processes } } as never;
      throw new Error(`unexpected RPC: ${method}`);
    });
    restores.push(() => snapshot.mockRestore(), () => rpc.mockRestore());
  });
  afterEach(() => {
    for (const restore of restores.splice(0)) restore();
    if (savedHome === undefined) delete process.env["HOME"]; else process.env["HOME"] = savedHome;
    rmSync(home, { recursive: true, force: true });
    agentSession = undefined;
    processes = [];
    forgetTranscriptState();
  });

  it("reads the transcript herdr names in an `omp --profile` store", async () => {
    const store = join(home, ".omp/profiles/personal/agent/sessions/-project");
    mkdirSync(store, { recursive: true });
    const path = join(store, "2026-10-01_s1.jsonl");
    writeFileSync(path, transcript(pane.cwd!));
    agentSession = { agent: "omp", kind: "path", value: path };
    const answer = await paneConversation(pane.pane_id);
    expect(answer.source).toBe("omp-transcript");
    expect(answer.turns.map((turn) => turn.parts[0])).toEqual([
      { kind: "text", text: "synthetic question" }, { kind: "text", text: "synthetic answer" },
    ]);
  });

  it("refuses a transcript in an omp profile store that links outside it", async () => {
    const store = join(home, ".omp/profiles/personal/agent/sessions/-project");
    mkdirSync(store, { recursive: true });
    const outside = join(home, "elsewhere.jsonl");
    writeFileSync(outside, transcript(pane.cwd!));
    const path = join(store, "2026-10-01_s1.jsonl");
    symlinkSync(outside, path);
    agentSession = { agent: "omp", kind: "path", value: path };
    await expect(paneConversation(pane.pane_id)).rejects.toThrow("no_session_path");
  });

  it.skipIf(process.platform !== "linux")("reads the transcript the pane's omp process holds open when herdr names none", async () => {
    const store = join(home, ".omp/agent/sessions/-project");
    mkdirSync(store, { recursive: true });
    const path = join(store, "2026-10-01_s1.jsonl");
    writeFileSync(path, transcript(pane.cwd!));
    const bin = join(home, "bin");
    mkdirSync(bin);
    const script = join(bin, "omp.js");
    writeFileSync(script, `require("node:fs").openSync(${JSON.stringify(path)}, "a"); console.log("ready"); setInterval(() => {}, 1000);`);
    const child = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    try {
      const reader = child.stdout.getReader();
      const first = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("omp stand-in did not start")), 5000)),
      ]);
      expect(new TextDecoder().decode(first.value)).toContain("ready");
      processes = [{ pid: child.pid, argv: [process.execPath, script] }];
      for (const session of [undefined, { agent: "claude", kind: "id", value: "a-claude-session" }]) {
        agentSession = session;
        forgetTranscriptState();
        const answer = await paneConversation(pane.pane_id);
        expect(answer.source).toBe("omp-transcript");
        expect(answer.turns.map((turn) => turn.parts[0])).toEqual([
          { kind: "text", text: "synthetic question" }, { kind: "text", text: "synthetic answer" },
        ]);
      }
    } finally { child.kill(); await child.exited; }
  });
});
