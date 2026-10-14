import { expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { forgetTranscriptState } from "./conversation.ts";
import { gjcPidUnderShell, gjcSessionFile, gjcTranscriptForPane, isGjcProcess, parseGjcPs, recentProcessTable, storeRelative, terminalBreadcrumb, validateGjcSdkTranscript } from "./gjc-runtime.ts";

// Session paths come back canonical and the store root is passed in canonical; macOS's tmpdir is a symlink into /private.
const tempDir = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

it("recognizes native and interpreter-launched gjc, not look-alikes", () => {
  expect(isGjcProcess(["/home/u/.local/bin/gjc", "--resume"])).toBe(true);
  expect(isGjcProcess(["gjc"])).toBe(true);
  expect(isGjcProcess(["/usr/bin/node", "/opt/gjc/dist/gjc.mjs"])).toBe(true);
  expect(isGjcProcess(["bun", "./gjc.js"])).toBe(true);
  expect(isGjcProcess(["/bin/zsh"])).toBe(false);
  expect(isGjcProcess(["gjc-helper"])).toBe(false);
  expect(isGjcProcess(["node", "/tmp/gjc/server.js"])).toBe(false);
  expect(isGjcProcess([])).toBe(false);
});

it("reads macOS terminal/process identity without /proc", () => {
  expect(parseGjcPs("ttys003 Mon Sep 28 10:00:00 2026\n")?.id).toBe("ttys003");
  expect(parseGjcPs("?? Mon Sep 28 10:00:00 2026")).toBeNull();
  expect(parseGjcPs("ttys003 invalid")).toBeNull();
});

it("validates breadcrumbs against process age, canonical cwd and the native session store", () => {
  const home = tempDir("gjc-breadcrumb-");
  try {
    const store = join(home, ".gjc/agent/sessions/v2-project");
    const markers = join(home, ".gjc/agent/terminal-sessions");
    mkdirSync(store, { recursive: true }); mkdirSync(markers);
    const path = join(store, "session.jsonl"), marker = join(markers, "ttys003");
    writeFileSync(path, JSON.stringify({ type: "session", cwd: home }) + "\n");
    writeFileSync(marker, `${home}\n${path}\n`);
    const agent = join(home, ".gjc/agent");
    expect(terminalBreadcrumb(agent, home, "ttys003", Date.now() - 1000)).toBe(path);
    expect(terminalBreadcrumb(agent, "/", "ttys003", 0)).toBeNull();
    expect(terminalBreadcrumb(agent, home, "../sessions/session.jsonl", 0)).toBeNull();
    utimesSync(marker, new Date(0), new Date(0));
    expect(terminalBreadcrumb(agent, home, "ttys003", Date.now())).toBeNull();
    const outside = join(home, "outside.jsonl"), escape = join(store, "escape.jsonl");
    writeFileSync(outside, JSON.stringify({ type: "session", cwd: home })); symlinkSync(outside, escape);
    writeFileSync(marker, `${home}\n${escape}\n`);
    expect(terminalBreadcrumb(agent, home, "ttys003", 0)).toBeNull();
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it("reads a breadcrumb left on a subagent's file as the session that ran it", () => {
  const home = tempDir("gjc-subagent-");
  try {
    const root = join(home, ".gjc/agent/sessions"), store = join(root, "v2-project");
    const markers = join(home, ".gjc/agent/terminal-sessions");
    mkdirSync(join(store, "2026-09-29_session"), { recursive: true }); mkdirSync(markers, { recursive: true });
    const header = JSON.stringify({ type: "session", cwd: home }) + "\n";
    const session = join(store, "2026-09-29_session.jsonl"), subagent = join(store, "2026-09-29_session", "2-Worker.jsonl");
    writeFileSync(session, header); writeFileSync(subagent, header);
    writeFileSync(join(markers, "pts-3"), `${home}\n${subagent}\n`);
    expect(terminalBreadcrumb(join(home, ".gjc/agent"), home, "pts-3", 0)).toBe(session);
    expect(gjcSessionFile(root, session)).toBe(session);
    expect(gjcSessionFile(root, subagent)).toBe(session);
    rmSync(session);
    expect(terminalBreadcrumb(join(home, ".gjc/agent"), home, "pts-3", 0)).toBeNull();
    expect(gjcSessionFile(root, subagent)).toBeNull();
    expect(gjcSessionFile(root, join(root, "top.jsonl"))).toBeNull();
    expect(gjcSessionFile(root, join(store, "a", "b", "c.jsonl"))).toBeNull();
    expect(gjcSessionFile(root, join(store, "notes.txt"))).toBeNull();
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it("reads a store on a Windows PC, where paths come with backslashes", () => {
  const root = "C:\\Users\\u\\.gjc\\agent\\sessions";
  const session = `${root}\\v2-project\\2026-10-01_session.jsonl`;
  expect(gjcSessionFile(root, session, win32)).toBe(session);
  expect(storeRelative(root, session, win32)).toEqual(["v2-project", "2026-10-01_session.jsonl"]);
  expect(gjcSessionFile(root, `c${session.slice(1)}`, win32)).toBe(`c${session.slice(1)}`);
  for (const outside of [
    `${root}-evil\\v2-project\\session.jsonl`,
    `${root}\\..\\sessions-evil\\v2-project\\session.jsonl`,
    `${root}\\v2-project\\..\\..\\..\\elsewhere\\session.jsonl`,
    `D:${session.slice(2)}`,
    `\\\\server\\share\\.gjc\\agent\\sessions\\v2-project\\session.jsonl`,
    root,
  ]) {
    expect(storeRelative(root, outside, win32)).toBeNull();
    expect(gjcSessionFile(root, outside, win32)).toBeNull();
  }
  expect(gjcSessionFile(root, `${root}\\top.jsonl`, win32)).toBeNull();
  expect(gjcSessionFile(root, `${root}\\v2-project\\notes.txt`, win32)).toBeNull();
  expect(storeRelative(root, `${root}\\..project\\session.jsonl`, win32)).toEqual(["..project", "session.jsonl"]);
});

it("refuses a path that leaves the store on Linux and macOS too", () => {
  const root = "/home/u/.gjc/agent/sessions";
  expect(storeRelative(root, `${root}/v2-project/session.jsonl`)).toEqual(["v2-project", "session.jsonl"]);
  expect(storeRelative(root, `${root}-evil/v2-project/session.jsonl`)).toBeNull();
  expect(storeRelative(root, `${root}/../sessions-evil/v2-project/session.jsonl`)).toBeNull();
  expect(gjcSessionFile(root, `${root}/../sessions-evil/session.jsonl`)).toBeNull();
});

it("finds gjc under a Windows pane's shell, the only process herdr names there", async () => {
  const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const gjc = "C:\\Users\\u\\AppData\\Local\\gjc\\gjc.exe";
  const rows = [
    { pid: 100, parent: 4, path: powershell, commandLine: "powershell.exe" },
    { pid: 101, parent: 4, path: powershell, commandLine: "powershell.exe" },
    { pid: 150, parent: 100, path: "C:\\Windows\\System32\\conhost.exe", commandLine: "conhost.exe" },
    { pid: 300, parent: 200, path: gjc, commandLine: `${gjc} sdk broker-internal` },
    { pid: 200, parent: 100, path: gjc, commandLine: `"${gjc}" --resume` },
  ];
  const table = async () => rows;
  expect(await gjcPidUnderShell(100, "win32", table)).toEqual({ pid: 200, started: null });
  expect(await gjcPidUnderShell(101, "win32", table)).toBeNull();
  expect(await gjcPidUnderShell(undefined, "win32", table)).toBeNull();
  expect(await gjcPidUnderShell(100, "win32", async () => rows.map((row) => row.pid === 200 ? { ...row, started: 7 } : row))).toEqual({ pid: 200, started: 7 });
  expect(await gjcPidUnderShell(100, "win32", async () => [])).toBeUndefined();
  let asked = false;
  expect(await gjcPidUnderShell(100, "linux", async () => { asked = true; return rows; })).toBeNull();
  expect(asked).toBe(false);
});

it("validates an SDK-selected main transcript by canonical path and exact first-line identity", () => {
  const home = tempDir("gjc-sdk-file-");
  try {
    const cwd = join(home, "work"), otherCwd = join(home, "other");
    const agentDir = join(home, ".gjc", "agent"), project = join(agentDir, "sessions", "v2-project");
    mkdirSync(cwd); mkdirSync(otherCwd); mkdirSync(project, { recursive: true });
    const sessionId = "sdk-session-1";
    const header = (id: string, sessionCwd: string) => JSON.stringify({ type: "session", id, cwd: sessionCwd }) + "\n";
    const bind = (path: string, id = sessionId) => ({ sessionId: id, pid: 200, path, hostIncarnation: "host", endpointGeneration: 1 });
    const good = join(project, "main.jsonl");
    writeFileSync(good, header(sessionId, cwd));
    expect(validateGjcSdkTranscript(bind(good), cwd, agentDir)).toBe(realpathSync(good));

    const wrongId = join(project, "wrong-id.jsonl");
    writeFileSync(wrongId, header("another-session", cwd));
    expect(validateGjcSdkTranscript(bind(wrongId), cwd, agentDir)).toBeNull();
    const wrongCwd = join(project, "wrong-cwd.jsonl");
    writeFileSync(wrongCwd, header(sessionId, otherCwd));
    expect(validateGjcSdkTranscript(bind(wrongCwd), cwd, agentDir)).toBeNull();

    const outside = join(home, "outside.jsonl");
    writeFileSync(outside, header(sessionId, cwd));
    expect(validateGjcSdkTranscript(bind(outside), cwd, agentDir)).toBeNull();
    const symlink = join(project, "outside-link.jsonl");
    symlinkSync(outside, symlink);
    expect(validateGjcSdkTranscript(bind(symlink), cwd, agentDir)).toBeNull();

    const subagent = join(project, sessionId, "worker.jsonl");
    mkdirSync(join(project, sessionId));
    writeFileSync(subagent, header(sessionId, cwd));
    expect(validateGjcSdkTranscript(bind(subagent), cwd, agentDir)).toBeNull();
    const malformed = join(project, "malformed.jsonl");
    writeFileSync(malformed, "{not-json}\n");
    expect(validateGjcSdkTranscript(bind(malformed), cwd, agentDir)).toBeNull();
    const longHeader = join(project, "long-header.jsonl");
    writeFileSync(longHeader, JSON.stringify({ type: "session", id: sessionId, cwd, padding: "x".repeat(64 * 1024) }) + "\n");
    expect(validateGjcSdkTranscript(bind(longHeader), cwd, agentDir)).toBeNull();
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it("re-reads pane process info and birth identity before accepting the SDK binding", async () => {
  const home = tempDir("gjc-sdk-race-");
  try {
    const cwd = join(home, "work"), agentDir = join(home, ".gjc", "agent");
    const project = join(agentDir, "sessions", "v2-project"), path = join(project, "main.jsonl");
    mkdirSync(cwd); mkdirSync(project, { recursive: true });
    const sessionId = "sdk-session-race";
    writeFileSync(path, JSON.stringify({ type: "session", id: sessionId, cwd }) + "\n");
    const binding = { sessionId, pid: 200, path, hostIncarnation: "host", endpointGeneration: 1 };
    const info = (pid: number) => ({ process_info: { foreground_processes: [{ pid, argv: ["/usr/bin/gjc"] }] } });
    let reads = 0, births = 0;
    const options = {
      platform: "linux",
      processInfo: async () => { reads += 1; return info(reads === 1 ? 200 : 200); },
      processBirth: () => { births += 1; return births === 1 ? 1000 : 1000; },
      sdkTranscript: async (pids: readonly number[]) => { expect(pids).toEqual([200]); return binding; },
    };
    expect(await gjcTranscriptForPane("pane", cwd, home, options)).toBe(realpathSync(path));
    expect(reads).toBe(2);
    expect(births).toBe(2);

    reads = 0; births = 0;
    expect(await gjcTranscriptForPane("pane", cwd, home, {
      ...options,
      processInfo: async () => { reads += 1; return info(reads === 1 ? 200 : 201); },
    })).toBeNull();
    reads = 0; births = 0;
    expect(await gjcTranscriptForPane("pane", cwd, home, {
      ...options,
      processInfo: async () => { reads += 1; return info(200); },
      processBirth: () => { births += 1; return births === 1 ? 1000 : 2000; },
    })).toBeNull();
    // macOS: one process read either side of a second boundary is still that process
    births = 0;
    expect(await gjcTranscriptForPane("pane", cwd, home, {
      ...options,
      platform: "darwin",
      processBirth: () => { births += 1; return births === 1 ? 1900 : 2100; },
    })).toBe(realpathSync(path));
    births = 0;
    expect(await gjcTranscriptForPane("pane", cwd, home, {
      ...options,
      platform: "darwin",
      processBirth: () => { births += 1; return births === 1 ? 1000 : 2500; },
    })).toBeNull();
    reads = 0;
    expect(await gjcTranscriptForPane("pane", cwd, home, {
      ...options,
      processInfo: async () => ++reads === 1 ? info(200) : null,
    })).toBeNull();
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it("shares one SDK lookup between overlapping reads of a pane", async () => {
  const home = tempDir("gjc-sdk-single-flight-");
  try {
    const cwd = join(home, "work"), agentDir = join(home, ".gjc", "agent");
    const project = join(agentDir, "sessions", "v2-project"), path = join(project, "main.jsonl");
    mkdirSync(cwd); mkdirSync(project, { recursive: true });
    const sessionId = "sdk-session-flight";
    writeFileSync(path, JSON.stringify({ type: "session", id: sessionId, cwd }) + "\n");
    const binding = { sessionId, pid: 200, path, hostIncarnation: "host", endpointGeneration: 1 };
    let lookups = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let gated = true;
    const options = {
      platform: "linux",
      processInfo: async () => ({ process_info: { foreground_processes: [{ pid: 200, argv: ["/usr/bin/gjc"] }] } }),
      processBirth: () => 1000,
      sdkTranscript: async () => { lookups += 1; if (gated) await gate; return lookups > 6 ? null : binding; },
    };
    // regression (fails on main: 5 lookups): five overlapping reads of one pane share one lookup
    const burst = Array.from({ length: 5 }, () => gjcTranscriptForPane("pane", cwd, home, options));
    release();
    expect(await Promise.all(burst)).toEqual(Array(5).fill(realpathSync(path)));
    expect(lookups).toBe(1);
    // control: once it settles, the next read looks up again (nothing is retained)
    gated = false;
    expect(await gjcTranscriptForPane("pane", cwd, home, options)).toBe(realpathSync(path));
    expect(lookups).toBe(2);
    expect(await gjcTranscriptForPane("pane", cwd, home, options)).toBe(realpathSync(path));
    expect(lookups).toBe(3);
    // control: another pane is not joined
    gated = true;
    const [a, b] = [gjcTranscriptForPane("pane-a", cwd, home, options), gjcTranscriptForPane("pane-b", cwd, home, options)];
    release();
    await Promise.all([a, b]);
    expect(lookups).toBe(5);
    // control: a null answer is not kept, the next read asks again
    gated = false; lookups = 6;
    expect(await gjcTranscriptForPane("pane", cwd, home, options)).toBeNull();
    expect(lookups).toBe(7);
    lookups = 0;
    expect(await gjcTranscriptForPane("pane", cwd, home, options)).toBe(realpathSync(path));
    expect(lookups).toBe(1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it.each(["cwd", "home", "SDK callback"])("keeps overlapping pane reads separate when %s differs", async (context) => {
  forgetTranscriptState();
  const home = tempDir("gjc-sdk-flight-context-");
  const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
  try {
    // Given two valid sessions for the same live pane/process.
    const cwdA = join(home, "a"), cwdB = context === "cwd" ? join(home, "b") : cwdA;
    const homeB = context === "home" ? join(home, "other-home") : home;
    const projectA = join(home, ".gjc/agent/sessions/project");
    const projectB = join(homeB, ".gjc/agent/sessions/project");
    mkdirSync(cwdA); mkdirSync(cwdB, { recursive: true });
    mkdirSync(projectA, { recursive: true }); mkdirSync(projectB, { recursive: true });
    const pathA = join(projectA, "a.jsonl"), pathB = join(projectB, "b.jsonl");
    writeFileSync(pathA, JSON.stringify({ type: "session", id: "A", cwd: cwdA }) + "\n");
    writeFileSync(pathB, JSON.stringify({ type: "session", id: "B", cwd: cwdB }) + "\n");
    const bindingA = { sessionId: "A", pid: 200, path: pathA, hostIncarnation: "host", endpointGeneration: 1 };
    const bindingB = { ...bindingA, sessionId: "B", path: pathB };
    let lookups = 0;
    const options = {
      platform: "linux",
      processInfo: async () => ({ process_info: { foreground_processes: [{ pid: 200, argv: ["gjc"] }] } }),
      processBirth: () => 1000,
      sdkTranscript: async (_pids: readonly number[], cwd: string, agentDir: string) => {
        lookups += 1;
        if (cwd !== cwdA || agentDir !== join(home, ".gjc/agent")) return bindingB;
        entered.resolve();
        await gate.promise;
        return bindingA;
      },
    };
    // When a later snapshot arrives after the first SDK lookup has actually started.
    const first = gjcTranscriptForPane("pane", cwdA, home, options);
    await entered.promise;
    const equivalent = gjcTranscriptForPane("pane", cwdA, home, { ...options });
    const laterOptions = context === "SDK callback"
      ? { ...options, sdkTranscript: async () => { lookups += 1; return bindingB; } }
      : options;
    const later = gjcTranscriptForPane("pane", cwdB, homeB, laterOptions);
    gate.resolve();
    // Then only equivalent contexts join, and each directory/store receives its own session.
    expect(equivalent).toBe(first);
    expect(await Promise.all([first, equivalent, later])).toEqual([pathA, pathA, pathB]);
    expect(lookups).toBe(2);
  } finally {
    gate.resolve();
    forgetTranscriptState();
    rmSync(home, { recursive: true, force: true });
  }
}, 5000);

it("fails closed when the pane has no GJC process or its process info cannot be read", async () => {
  const home = tempDir("gjc-sdk-no-process-");
  try {
    const cwd = join(home, "work");
    mkdirSync(cwd);
    let sdkCalls = 0;
    const options = {
      platform: "linux",
      processInfo: async () => ({ process_info: { foreground_processes: [] } }),
      sdkTranscript: async () => { sdkCalls += 1; return null; },
    };
    expect(await gjcTranscriptForPane("pane", cwd, home, options)).toBeNull();
    expect(sdkCalls).toBe(0);
    expect(await gjcTranscriptForPane("pane", cwd, home, {
      ...options,
      processInfo: async () => null,
    })).toBeNull();
    expect(sdkCalls).toBe(0);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it("uses a fresh Windows process tree for the final process identity check", async () => {
  forgetTranscriptState();
  const home = tempDir("gjc-sdk-windows-race-");
  try {
    const cwd = join(home, "work"), agentDir = join(home, ".gjc", "agent");
    const project = join(agentDir, "sessions", "v2-project"), path = join(project, "main.jsonl");
    mkdirSync(cwd); mkdirSync(project, { recursive: true });
    const sessionId = "sdk-session-windows";
    writeFileSync(path, JSON.stringify({ type: "session", id: sessionId, cwd }) + "\n");
    const binding = { sessionId, pid: 200, path, hostIncarnation: "host", endpointGeneration: 1 };
    const gjc = "C:\\Users\\u\\AppData\\Local\\gjc\\gjc.exe";
    const rows = (started: number) => [{ pid: 200, parent: 100, path: gjc, commandLine: `"${gjc}" --resume`, started }];
    let tableReads = 0;
    const readProcessTable = async () => ++tableReads === 1 ? rows(1000) : rows(2000);
    const processInfo = async () => ({ process_info: { shell_pid: 100, foreground_processes: [] } });
    const result = await gjcTranscriptForPane("pane", cwd, home, {
      platform: "win32",
      processInfo,
      readProcessTable,
      sdkTranscript: async (pids: readonly number[]) => { expect(pids).toEqual([200]); return binding; },
    });
    expect(tableReads).toBe(2);
    expect(result).toBeNull();
  } finally { rmSync(home, { recursive: true, force: true }); forgetTranscriptState(); }
});

it("asks the Windows process table once for the polls of a few seconds", async () => {
  forgetTranscriptState();
  const rows = [{ pid: 100, parent: 4, path: null, commandLine: "powershell.exe" }];
  let asked = 0;
  const read = async () => { asked += 1; return rows; };
  expect(await recentProcessTable(read, 10_000)).toBe(rows);
  await Promise.all([recentProcessTable(read, 12_000), recentProcessTable(read, 14_000)]);
  expect(asked).toBe(1);
  await recentProcessTable(read, 16_000);
  expect(asked).toBe(2);
  forgetTranscriptState();
  let failed = 0;
  const unreadable = async () => { failed += 1; return []; };
  await recentProcessTable(unreadable, 20_000);
  await recentProcessTable(unreadable, 20_001);
  expect(failed).toBe(2);
});
