import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrPane, SessionSnapshot } from "../shared/protocol.ts";

import { forgetTranscriptState, paneConversation } from "./conversation.ts";
import * as herdr from "./herdr/client.ts";
import { terminalBreadcrumb } from "./gjc-runtime.ts";
import { isOmpHelper, isOmpProcess, ompAgentDir, ompHeldTranscript, ompLaunch, ompLaunchDir } from "./omp.ts";
import * as ompProbe from "./omp-process.ts";
import * as omo from "./omo.ts";

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
  // omp ignores a cwd option without its value, so it says nothing about the store
  expect(ompAgentDir(["omp", "--cwd"], null, home)).toBe("/home/u/.omp/agent");
  expect(ompAgentDir(["omp", "--cwd", "--profile", "work"], null, home)).toBe("/home/u/.omp/agent");
});

it("reads omp's cwd and store options from its argv the way omp does", () => {
  const cases: [string[], { profile: string | null; sessionDir: boolean; cwd: string | null } | null][] = [
    [["omp"], { profile: null, sessionDir: false, cwd: null }],
    // split and equal forms, the last one winning
    [["omp", "--cwd", "/a", "--cwd=/b"], { profile: null, sessionDir: false, cwd: "/b" }],
    [["omp", "--cwd=/b", "--cwd", "/a"], { profile: null, sessionDir: false, cwd: "/a" }],
    [["omp", "--cwd", "/a", "--profile=work", "--cwd", "rel/dir", "--profile", "home"], { profile: "home", sessionDir: false, cwd: "rel/dir" }],
    // nothing after the terminator is an option
    [["omp", "--cwd", "/a", "--", "--cwd", "/b"], { profile: null, sessionDir: false, cwd: "/a" }],
    [["omp", "--", "--cwd=/b", "--session-dir", "/s", "--profile", "work"], { profile: null, sessionDir: false, cwd: null }],
    // paths with spaces and shell metacharacters are literal words of argv
    [["omp", "--cwd", "/p/with space/$(rm -rf x);*|`y`"], { profile: null, sessionDir: false, cwd: "/p/with space/$(rm -rf x);*|`y`" }],
    [["omp", "--cwd=/a=b c"], { profile: null, sessionDir: false, cwd: "/a=b c" }],
    // an option's value is consumed with it, even one that looks like an option
    [["omp", "--cwd", "--profile", "work"], { profile: null, sessionDir: false, cwd: "--profile" }],
    [["omp", "--model", "--cwd", "/a"], { profile: null, sessionDir: false, cwd: null }],
    [["omp", "--system-prompt", "--cwd=/a", "--cwd", "/b"], { profile: null, sessionDir: false, cwd: "/b" }],
    [["omp", "--cwd", "--", "--cwd", "/b"], { profile: null, sessionDir: false, cwd: "/b" }],
    // `--plan` takes the next word too, once the profile options are out
    [["omp", "--plan", "--cwd", "/a"], { profile: null, sessionDir: false, cwd: null }],
    [["omp", "--plan", "--profile", "work", "--cwd", "/a"], { profile: "work", sessionDir: false, cwd: null }],
    [["omp", "--plan", "--", "--cwd", "/a"], { profile: null, sessionDir: false, cwd: "/a" }],
    // an optional value is never an option
    [["omp", "--resume", "--cwd", "/a"], { profile: null, sessionDir: false, cwd: "/a" }],
    [["omp", "-r", "abc", "--cwd", "/a"], { profile: null, sessionDir: false, cwd: "/a" }],
    // a message that mentions the option is one word, not the option
    [["omp", "fix --cwd /x", "--cwd", "/a"], { profile: null, sessionDir: false, cwd: "/a" }],
    // interpreter-launched: options start after omp's script
    [["bun", "/opt/omp/dist/omp.js", "--cwd", "/a"], { profile: null, sessionDir: false, cwd: "/a" }],
    [["omp", "--session-dir=/s", "--cwd", "/a"], { profile: null, sessionDir: true, cwd: "/a" }],
    // omp ignores a trailing cwd option and stays where it started on an empty one
    [["omp", "--cwd"], { profile: null, sessionDir: false, cwd: null }],
    [["omp", "--cwd", "/a", "--cwd"], { profile: null, sessionDir: false, cwd: "/a" }],
    [["omp", "--cwd="], { profile: null, sessionDir: false, cwd: null }],
    [["omp", "--cwd", ""], { profile: null, sessionDir: false, cwd: null }],
    [["omp", "--cwd", "/a", "--cwd="], { profile: null, sessionDir: false, cwd: null }],
    [["omp", "--cwd=", "--cwd", "/a"], { profile: null, sessionDir: false, cwd: "/a" }],
    [["omp", "--cwd", "", "/b"], { profile: null, sessionDir: false, cwd: null }],
    // omp refuses to start without a profile name
    [["omp", "--profile="], null],
    [["omp", "--profile"], null],
    [["omp", "--profile", "--cwd", "/a"], null],
  ];
  for (const [argv, expected] of cases) expect([argv, ompLaunch(argv)]).toEqual([argv, expected]);
});

it("names a launch directory only for an absolute cwd, never resolved against the server's own", () => {
  expect(ompLaunchDir(["omp", "--cwd", "/a/b/../c/"])).toBe("/a/c");
  expect(ompLaunchDir(["omp", "--cwd=/a", "--cwd", "rel"])).toBeNull();
  expect(ompLaunchDir(["omp", "--cwd", "../a"])).toBeNull();
  expect(ompLaunchDir(["omp", "--cwd", ""])).toBeNull();
  expect(ompLaunchDir(["omp"])).toBeNull();
});

it("tells omp's own package installs from an omp session", () => {
  expect(isOmpHelper(["/home/u/.bun/bin/omp", "add", "--cwd", "/home/u/.omp/cache/eval-js/environments/e1", "--ignore-scripts", "lodash"])).toBe(true);
  expect(isOmpHelper(["/home/u/.bun/bin/omp", "install", "--cwd", "/home/u/.omp/runtimes/tts", "--production"])).toBe(true);
  // its workers, from the compiled binary or from its script under an interpreter
  expect(isOmpHelper(["/home/u/.bun/bin/omp", "__omp_worker_tts"])).toBe(true);
  expect(isOmpHelper(["bun", "/opt/omp/dist/omp.js", "__omp_worker_stt"])).toBe(true);
  // a message that starts with the word, or another program's install, is no helper
  expect(isOmpHelper(["omp", "add", "tests"])).toBe(false);
  expect(isOmpHelper(["omp", "--cwd", "/a", "add"])).toBe(false);
  expect(isOmpHelper(["bun", "add", "--cwd", "/a"])).toBe(false);
  // a worker's name after an option is a session's message
  expect(isOmpHelper(["omp", "--cwd", "/a", "__omp_worker_tts"])).toBe(false);
  expect(isOmpHelper(["bun", "__omp_worker_tts"])).toBe(false);
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
  let processes: { pid: number; name?: string; argv?: string[] }[] = [];
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
    const rpc = spyOn(herdr, "herdrRpc").mockImplementation(async (method: string) => {
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

  /** A transcript in the default store whose header names `cwd`, from a session directory named after it. */
  const storeTranscript = (cwd: string, name = "2026-10-01_s1.jsonl") => {
    const store = join(home, ".omp/agent/sessions", cwd.replaceAll("/", "-"));
    mkdirSync(store, { recursive: true });
    const path = join(store, name);
    writeFileSync(path, transcript(cwd));
    return path;
  };
  /**
   * An omp stand-in that holds `held` open, started in `cwd` and then moved into `moveTo`, the way
   * omp changes into its `--cwd` or a resumed session's project, answering once it is ready.
   * Killed and reaped after the test.
   */
  const standIn = async (options: string[], held: string[], { cwd, moveTo, env }: { cwd?: string; moveTo?: string; env?: Record<string, string> } = {}) => {
    const script = join(home, "bin", "omp.js");
    mkdirSync(join(home, "bin"), { recursive: true });
    const move = moveTo === undefined ? "" : `process.chdir(${JSON.stringify(moveTo)}); `;
    writeFileSync(script, `${move}for (const file of ${JSON.stringify(held)}) require("node:fs").openSync(file, "a"); console.log("ready"); setInterval(() => {}, 1000);`);
    const argv = [process.execPath, script, ...options];
    const child = Bun.spawn(argv, { cwd, env: env ? { ...process.env, ...env } : undefined, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    reaped.push(async () => { child.kill(); await child.exited; });
    const first = await Promise.race([
      child.stdout.getReader().read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("omp stand-in did not start")), 5000)),
    ]);
    expect(new TextDecoder().decode(first.value)).toContain("ready");
    return { pid: child.pid, argv };
  };
  const reaped: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const reap of reaped.splice(0)) await reap(); });
  /** The directory herdr reports as a process's foreground cwd: its own, as procfs has it. */
  const liveDir = (pid: number) => readlinkSync(`/proc/${pid}/cwd`);
  const chat = async () => {
    forgetTranscriptState();
    const answer = await paneConversation(pane.pane_id);
    expect(answer.source).toBe("omp-transcript");
    return answer.turns.map((turn) => turn.parts[0]);
  };
  const synthetic = [{ kind: "text" as const, text: "synthetic question" }, { kind: "text" as const, text: "synthetic answer" }];
  const otherAgent = { agent: "claude", kind: "id", value: "a-claude-session" };

  it.skipIf(process.platform !== "linux")("a relative --cwd finds the session in the directory omp moved into", async () => {
    const a = join(home, "A"), rel = join(a, "rel");
    mkdirSync(rel, { recursive: true });
    const path = storeTranscript(rel);
    const omp = await standIn(["--cwd", "rel"], [path], { cwd: a, moveTo: rel });
    processes = [{ pid: omp.pid, name: "omp", argv: omp.argv }];
    pane.cwd = a;
    pane.foreground_cwd = liveDir(omp.pid);
    expect(pane.foreground_cwd).toBe(rel);
    for (const session of [undefined, otherAgent]) {
      agentSession = session;
      expect(await chat()).toEqual(synthetic);
    }
    // without herdr's directory nothing proves where omp started, so no base is guessed for it
    pane.foreground_cwd = null;
    agentSession = undefined;
    forgetTranscriptState();
    await expect(paneConversation(pane.pane_id)).rejects.toThrow("no_session_path");
  });

  it.skipIf(process.platform !== "linux")("an absolute --cwd follows omp into a resumed session's project", async () => {
    const x = join(home, "X"), y = join(home, "Y");
    mkdirSync(x); mkdirSync(y);
    // the session it started with, no longer open
    storeTranscript(x, "2026-10-01_first.jsonl");
    const path = storeTranscript(y);
    const omp = await standIn(["--cwd", x], [path], { moveTo: y });
    processes = [{ pid: omp.pid, name: "omp", argv: omp.argv }];
    pane.foreground_cwd = liveDir(omp.pid);
    expect(pane.foreground_cwd).toBe(y);
    expect(await chat()).toEqual(synthetic);
    // the same through the breadcrumb omp rewrote for the resumed session
    for (const reap of reaped.splice(0)) await reap();
    const crumb = await standIn(["--cwd", x], [], { moveTo: y, env: { TMUX: "/tmp/tmux-1/default,1,0", TMUX_PANE: "%4244" } });
    mkdirSync(join(home, ".omp/agent/terminal-sessions"));
    writeFileSync(join(home, ".omp/agent/terminal-sessions/tmux-%4244"), `${y}\n${path}\n`);
    processes = [{ pid: crumb.pid, name: "omp", argv: crumb.argv }];
    expect(await chat()).toEqual(synthetic);
  });

  it.skipIf(process.platform !== "linux")("an absolute --cwd finds the session when herdr's directory is not omp's own", async () => {
    const target = join(home, "B");
    mkdirSync(target);
    const path = storeTranscript(target);
    // a session of the pane's own directory is no answer for this process
    storeTranscript(pane.cwd!, "2026-10-02_decoy.jsonl");
    for (const options of [
      ["--cwd", "/elsewhere", `--cwd=${target}`],
      ["--cwd=/elsewhere", "--cwd", `${target}/`, "--", "--cwd", pane.cwd!],
    ]) {
      const omp = await standIn(options, [path], { moveTo: target });
      processes = [{ pid: omp.pid, name: "omp", argv: omp.argv }];
      // herdr reports the directory of a wrapper that started omp, or none
      for (const foreground of [pane.cwd, null]) {
        pane.foreground_cwd = foreground;
        for (const session of [undefined, otherAgent]) {
          agentSession = session;
          expect(await chat()).toEqual(synthetic);
        }
      }
      for (const reap of reaped.splice(0)) await reap();
    }
    // the same through the terminal breadcrumb of a process that holds nothing open
    const omp = await standIn(["--cwd", "/elsewhere", `--cwd=${target}`], [], { moveTo: target, env: { TMUX: "/tmp/tmux-1/default,1,0", TMUX_PANE: "%4243" } });
    mkdirSync(join(home, ".omp/agent/terminal-sessions"));
    writeFileSync(join(home, ".omp/agent/terminal-sessions/tmux-%4243"), `${target}\n${path}\n`);
    processes = [{ pid: omp.pid, name: "omp", argv: omp.argv }];
    pane.foreground_cwd = pane.cwd;
    agentSession = undefined;
    expect(await chat()).toEqual(synthetic);
    expect(await ompHeldTranscript(pane.pane_id, pane.cwd!)).toBe(path);
  });

  it.skipIf(process.platform !== "linux")("an empty or trailing --cwd leaves omp where it started", async () => {
    const path = storeTranscript(pane.cwd!);
    for (const options of [["--cwd"], ["--cwd="], ["--cwd", ""], ["--cwd", "/elsewhere", "--cwd="], ["--cwd", "", "/elsewhere"]]) {
      const omp = await standIn(options, [path], { cwd: pane.cwd! });
      // herdr's argv, and none (WSL), where the empty operand is read back from procfs
      for (const argv of [omp.argv, undefined]) {
        processes = [{ pid: omp.pid, name: "omp", argv }];
        expect(await chat()).toEqual(synthetic);
      }
      for (const reap of reaped.splice(0)) await reap();
    }
    // an empty operand read back from procfs never turns the message after it into a directory
    const b = join(home, "B");
    mkdirSync(b);
    const omp = await standIn(["--cwd", "", b], [storeTranscript(b)], { cwd: pane.cwd! });
    processes = [{ pid: omp.pid, name: "omp" }];
    expect(await ompHeldTranscript(pane.pane_id, pane.cwd!)).toBeNull();
  });

  it.skipIf(process.platform !== "linux")("omp processes that started in different directories show no chat", async () => {
    const b = join(home, "B"), c = join(home, "C");
    mkdirSync(b); mkdirSync(c);
    const first = await standIn(["--cwd", b], [storeTranscript(b)]);
    const second = await standIn([`--cwd=${c}`], [storeTranscript(c)]);
    const plain = await standIn([], []);
    for (const pair of [[first, second], [first, plain]]) {
      processes = pair.map((omp) => ({ pid: omp.pid, name: "omp", argv: omp.argv }));
      forgetTranscriptState();
      await expect(paneConversation(pane.pane_id)).rejects.toThrow("no_session_path");
    }
    // two sessions of the live directory are no answer either
    const one = await standIn([], [storeTranscript(pane.cwd!)]);
    const other = await standIn([], [storeTranscript(pane.cwd!, "2026-10-02_s2.jsonl")]);
    processes = [one, other].map((omp) => ({ pid: omp.pid, name: "omp", argv: omp.argv }));
    expect(await ompHeldTranscript(pane.pane_id, pane.cwd!)).toBeNull();
  });

  it.skipIf(process.platform !== "linux")("omp's own package installs leave the chat as it was", async () => {
    const binary = join(home, "bin", "omp");
    const env = join(home, ".omp/cache/eval-js/environments/e1"), runtime = join(home, ".omp/runtimes/tts");
    mkdirSync(env, { recursive: true }); mkdirSync(runtime, { recursive: true });
    const install = await standIn([], [], { cwd: env });
    const helpers = [
      { pid: install.pid, name: "omp", argv: [binary, "add", "--cwd", env, "--ignore-scripts", "lodash"] },
      { pid: install.pid, name: "omp", argv: [binary, "install", "--cwd", runtime, "--production"] },
      { pid: install.pid, name: "omp", argv: [binary, "__omp_worker_tts"] },
    ];
    // a plain omp in the pane's directory
    const plain = await standIn([], [storeTranscript(pane.cwd!)]);
    for (const helper of helpers) {
      processes = [{ pid: plain.pid, name: "omp", argv: plain.argv }, helper];
      expect(await chat()).toEqual(synthetic);
    }
    // an absolute --cwd that herdr's directory does not show, listed after the helper
    const target = join(home, "B");
    mkdirSync(target);
    const launched = await standIn(["--cwd", target], [storeTranscript(target)], { moveTo: target });
    for (const helper of helpers) {
      processes = [helper, { pid: launched.pid, name: "omp", argv: launched.argv }];
      expect(await chat()).toEqual(synthetic);
    }
  });

  it.skipIf(process.platform !== "linux")("on WSL a helper whose argv only procfs has leaves the chat as it was", async () => {
    const binary = join(home, "bin", "omp");
    const env = join(home, ".omp/cache/eval-js/environments/e1");
    mkdirSync(env, { recursive: true });
    const install = await standIn([], [], { cwd: env });
    const target = join(home, "B");
    mkdirSync(target);
    const launched = await standIn(["--cwd", target], [storeTranscript(target)], { moveTo: target });
    let helperArgv: string[] = [];
    const wsl = spyOn(ompProbe, "isWsl").mockReturnValue(true);
    const probe = spyOn(ompProbe, "ompProcessMemory").mockImplementation(async (pid: number) =>
      ({ argv: pid === install.pid ? helperArgv : launched.argv, environ: [] }));
    restores.push(() => wsl.mockRestore(), () => probe.mockRestore());
    for (const argv of [[binary, "add", "--cwd", env, "--ignore-scripts", "lodash"], [binary, "__omp_worker_tts"]]) {
      helperArgv = argv;
      // herdr leaves out the argv of a process it takes for an agent, so the helper is read back
      processes = [{ pid: install.pid, name: "omp" }, { pid: launched.pid, name: "omp", argv: launched.argv }];
      probe.mockClear();
      expect(await chat()).toEqual(synthetic);
      expect(probe).toHaveBeenCalledWith(install.pid, true);
    }
  });

  it.skipIf(process.platform !== "linux")("two sessions in herdr's directory show no chat, even with one under the --cwd", async () => {
    const target = join(home, "B");
    mkdirSync(target);
    const held = [storeTranscript(pane.cwd!), storeTranscript(pane.cwd!, "2026-10-02_s2.jsonl"), storeTranscript(target)];
    const omp = await standIn(["--cwd", target], held, { moveTo: target });
    processes = [{ pid: omp.pid, name: "omp", argv: omp.argv }];
    expect(await ompHeldTranscript(pane.pane_id, pane.cwd!)).toBeNull();
    forgetTranscriptState();
    await expect(paneConversation(pane.pane_id)).rejects.toThrow("no_session_path");
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

  it("leaves an unwritten session's model unknown without reading its status line", async () => {
    // omp names its file at start and writes it with the first answer; `/switch` writes nothing
    const store = join(home, ".omp/agent/sessions/-project");
    mkdirSync(store, { recursive: true });
    agentSession = { agent: "omp", kind: "path", value: join(store, "2026-10-19_s2.jsonl") };
    const read = spyOn(herdr, "paneRead");
    restores.push(() => read.mockRestore());
    const started = await paneConversation(pane.pane_id);
    expect(started).toMatchObject({ source: "omp-transcript", turns: [], metadata: { model: null, reasoning_effort: null } });
    expect(started.screen).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
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

  for (const [profile, includeArgv] of [["personal", true], [null, false], ["personal", false]] as const) it.skipIf(process.platform !== "linux")(`reads the open ${profile ?? "default"} omp transcript when herdr ${includeArgv ? "supplies" : "omits"} argv`, async () => {
    const agentDir = profile === null ? join(home, ".omp/agent") : join(home, ".omp/profiles", profile, "agent");
    const store = join(agentDir, "sessions/-project");
    mkdirSync(store, { recursive: true });
    const path = join(store, "2026-10-01_s1.jsonl");
    writeFileSync(path, transcript(pane.cwd!));
    const bin = join(home, "bin");
    mkdirSync(bin);
    const script = join(bin, "omp.js");
    writeFileSync(script, `require("node:fs").openSync(${JSON.stringify(path)}, "a"); console.log("ready"); setInterval(() => {}, 1000);`);
    const argv = [process.execPath, script, ...(profile === null ? [] : ["--profile", profile])];
    const child = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    try {
      const reader = child.stdout.getReader();
      const first = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("omp stand-in did not start")), 5000)),
      ]);
      expect(new TextDecoder().decode(first.value)).toContain("ready");
      processes = [{ pid: child.pid, name: "omp", ...(includeArgv ? { argv } : {}) }];
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

  it.skipIf(process.platform !== "linux")("does not trust the omp name when its argv is inaccessible or belongs to another executable", async () => {
    for (const pid of [2147483647, process.pid]) {
      processes = [{ pid, name: "omp" }];
      await expect(paneConversation(pane.pane_id)).rejects.toThrow("no_session_path");
    }
  });

  it.skipIf(process.platform !== "linux")("on WSL a failed probe with supplied argv never falls back to a synchronous environment read", async () => {
    const wsl = spyOn(ompProbe, "isWsl").mockReturnValue(true);
    const probe = spyOn(ompProbe, "ompProcessMemory").mockResolvedValue(null);
    restores.push(() => wsl.mockRestore());
    const environ = spyOn(omo, "processEnviron").mockImplementation(() => { throw new Error("unsafe synchronous read"); });
    restores.push(() => probe.mockRestore(), () => environ.mockRestore());
    processes = [{ pid: process.pid, argv: ["omp"] }];
    expect(await ompHeldTranscript(pane.pane_id, pane.cwd!)).toBeNull();
    expect(probe).toHaveBeenCalledWith(process.pid, false);
    expect(environ).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform !== "linux")("a native Linux pane whose argv herdr supplies keeps the direct read and spawns no helper", async () => {
    const wsl = spyOn(ompProbe, "isWsl").mockReturnValue(false);
    const probe = spyOn(ompProbe, "ompProcessMemory");
    restores.push(() => wsl.mockRestore(), () => probe.mockRestore());
    processes = [{ pid: process.pid, argv: ["omp"] }];
    expect(await ompHeldTranscript(pane.pane_id, pane.cwd!)).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform !== "linux")("a successful probe's environment finds the tmux breadcrumb with no synchronous environ read", async () => {
    const agentDir = join(home, ".omp/agent");
    const store = join(agentDir, "sessions/-project");
    mkdirSync(store, { recursive: true });
    const path = join(store, "2026-10-01_s1.jsonl");
    writeFileSync(path, transcript(pane.cwd!));
    mkdirSync(join(agentDir, "terminal-sessions"));
    writeFileSync(join(agentDir, "terminal-sessions", "tmux-%4242"), `${pane.cwd}\n${path}\n`);
    const probe = spyOn(ompProbe, "ompProcessMemory").mockResolvedValue({ argv: ["omp"], environ: ["TMUX=/tmp/tmux-1/default,1,0", "TMUX_PANE=%4242"] });
    const environ = spyOn(omo, "processEnviron").mockImplementation(() => { throw new Error("unsafe synchronous read"); });
    const read = fs.readFileSync;
    const files = spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) => {
      if (String(file).endsWith("/environ")) throw new Error(`unsafe synchronous read of ${String(file)}`);
      return read(file, options as never);
    }) as typeof fs.readFileSync);
    restores.push(() => probe.mockRestore(), () => environ.mockRestore(), () => files.mockRestore());
    processes = [{ pid: process.pid, name: "omp" }];
    expect(await ompHeldTranscript(pane.pane_id, pane.cwd!)).toBe(path);
    expect(probe).toHaveBeenCalledWith(process.pid, true);
    expect(environ).not.toHaveBeenCalled();
    expect(files.mock.calls.some(([file]) => String(file).endsWith("/environ"))).toBe(false);
  });
});
