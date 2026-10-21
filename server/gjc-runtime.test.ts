import { expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { forgetTranscriptState } from "./conversation.ts";
import { forgetGjcPane, forgetGjcState, gjcNativeSkills, gjcRetainedEntries, gjcPidUnderShell, gjcSessionFile, gjcTranscriptForPane, isGjcProcess, parseGjcPs, recentProcessTable, storeRelative, terminalBreadcrumb, validateGjcSdkTranscript } from "./gjc-runtime.ts";
import { GjcSdkLookupError } from "./gjc-sdk.ts";

// Session paths come back canonical and the store root is passed in canonical; macOS's tmpdir is a symlink into /private.
const tempDir = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

async function bounded<T>(event: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      event,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Missing SDK event: ${label}`)), 1000);
      }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

function sdkIndexRow(cwd: string, indexSeq: number, overrides: Record<string, unknown> = {}): string {
  const row = {
    version: 4, indexSeq, type: "host_heartbeat", sessionId: "unrelated-session",
    locator: { cwd, worktreeRoot: null, stateRoot: cwd },
    pid: 9999, processIncarnation: "other-host", hostIncarnation: "other-host",
    endpointGeneration: 1, activity: { state: "idle", at: 1000 }, ts: 1000,
    ...overrides,
  };
  return JSON.stringify({ ...row, checksum: createHash("sha256").update(JSON.stringify(row)).digest("hex") }) + "\n";
}

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
    const bind = (path: string, id = sessionId) => ({ sessionId: id, pid: 200, path, hostIncarnation: "host", endpointGeneration: 1, guardSessionIds: [id] });
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
    const binding = { sessionId, pid: 200, path, hostIncarnation: "host", endpointGeneration: 1, guardSessionIds: [sessionId] };
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
    const binding = { sessionId, pid: 200, path, hostIncarnation: "host", endpointGeneration: 1, guardSessionIds: [sessionId] };
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
    // control: once it settles, the next read looks up again (no session index to key a kept binding by)
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

it("avoids cross-pane SDK lookup bursts on unrelated heartbeats without extending the binding lifetime", async () => {
  forgetTranscriptState();
  const home = tempDir("gjc-sdk-heartbeats-");
  try {
    const agentDir = join(home, ".gjc", "agent"), indexDir = join(agentDir, "sdk", "sessions");
    mkdirSync(indexDir, { recursive: true });
    const index = join(indexDir, "index.jsonl");
    let seq = 1, clock = 0, lookups = 0;
    writeFileSync(index, sdkIndexRow(home, seq, { type: "host_registered" }));
    const readers = Array.from({ length: 4 }, (_, n) => {
      const cwd = join(home, `project-${n}`), store = join(agentDir, "sessions", `project-${n}`);
      mkdirSync(cwd); mkdirSync(store, { recursive: true });
      const path = join(store, "main.jsonl"), sessionId = `pane-session-${n}`, pid = 200 + n;
      writeFileSync(path, JSON.stringify({ type: "session", id: sessionId, cwd }) + "\n");
      const binding = {
        path, sessionId, pid, hostIncarnation: `host-${n}`, endpointGeneration: 1,
        guardSessionIds: [sessionId, `retired-${n}`],
      };
      const options = {
        platform: "linux", now: () => clock,
        processInfo: async () => ({ process_info: { foreground_processes: [{ pid, argv: ["gjc"] }] } }),
        processBirth: () => 1000,
        sdkTranscript: async () => { lookups += 1; return binding; },
      };
      return async () => expect(await gjcTranscriptForPane(`pane-${n}`, cwd, home, options)).toBe(path);
    });
    await Promise.all(readers.map((read) => read()));
    expect(lookups).toBe(4);
    for (let tick = 1; tick <= 12; tick++) {
      clock = tick * 1000;
      appendFileSync(index, sdkIndexRow(home, ++seq));
      await Promise.all(readers.map((read) => read()));
    }
    // Before the fix these 48 reads each re-entered the SDK despite unchanged pane ownership.
    expect(lookups).toBe(4);
    clock = 29_999;
    appendFileSync(index, sdkIndexRow(home, ++seq));
    await Promise.all(readers.map((read) => read()));
    expect(lookups).toBe(4);
    clock = 30_000;
    await Promise.all(readers.map((read) => read()));
    expect(lookups).toBe(8);

    // A stale same-pid session can revive even if its heartbeat carries a different pid.
    appendFileSync(index, sdkIndexRow(home, ++seq, { sessionId: "retired-0" }));
    await Promise.all(readers.map((read) => read()));
    expect(lookups).toBe(9);
    appendFileSync(index, sdkIndexRow(home, ++seq, { pid: 201 }));
    await Promise.all(readers.map((read) => read()));
    expect(lookups).toBe(10);
  } finally { forgetTranscriptState(); rmSync(home, { recursive: true, force: true }); }
});

it("does not absorb a session change written during an SDK lookup into the kept binding", async () => {
  forgetTranscriptState();
  const home = tempDir("gjc-sdk-index-race-");
  try {
    const cwd = join(home, "work"), agentDir = join(home, ".gjc", "agent");
    const store = join(agentDir, "sessions", "project"), indexDir = join(agentDir, "sdk", "sessions");
    mkdirSync(cwd); mkdirSync(store, { recursive: true }); mkdirSync(indexDir, { recursive: true });
    const index = join(indexDir, "index.jsonl");
    writeFileSync(index, sdkIndexRow(cwd, 1, { type: "host_registered", sessionId: "old", pid: 200 }));
    const binding = (sessionId: string) => {
      const path = join(store, `${sessionId}.jsonl`);
      writeFileSync(path, JSON.stringify({ type: "session", id: sessionId, cwd }) + "\n");
      return { sessionId, path, pid: 200, hostIncarnation: "host", endpointGeneration: 1, guardSessionIds: ["old", "new"] };
    };
    const old = binding("old"), fresh = binding("new");
    let lookups = 0;
    const options = {
      platform: "linux",
      processInfo: async () => ({ process_info: { foreground_processes: [{ pid: 200, argv: ["gjc"] }] } }),
      processBirth: () => 1000,
      sdkTranscript: async () => {
        lookups += 1;
        if (lookups !== 1) return fresh;
        appendFileSync(index, sdkIndexRow(cwd, 2, { type: "host_registered", sessionId: "new", pid: 200 }));
        return old;
      },
    };
    expect(await gjcTranscriptForPane("pane", cwd, home, options)).toBe(old.path);
    expect(await gjcTranscriptForPane("pane", cwd, home, options)).toBe(fresh.path);
    expect(lookups).toBe(2);
  } finally { forgetTranscriptState(); rmSync(home, { recursive: true, force: true }); }
});

it("shares a proven binding across alternating status and chat reads until the index or processes change", async () => {
  forgetTranscriptState();
  const home = tempDir("gjc-sdk-kept-");
  try {
    const cwd = join(home, "work"), agentDir = join(home, ".gjc", "agent");
    const project = join(agentDir, "sessions", "v2-project"), index = join(agentDir, "sdk", "sessions", "index.jsonl");
    mkdirSync(cwd); mkdirSync(project, { recursive: true }); mkdirSync(join(agentDir, "sdk", "sessions"), { recursive: true });
    const write = (name: string, id: string) => {
      const path = join(project, name);
      writeFileSync(path, JSON.stringify({ type: "session", id, cwd }) + "\n");
      return realpathSync(path);
    };
    const oldPath = write("old.jsonl", "old-session"), newPath = write("new.jsonl", "new-session");
    const row = (type: string, sessionId: string) => appendFileSync(index, JSON.stringify({ type, sessionId, pid: 200 }) + "\n");
    row("host_registered", "old-session");
    const oldBinding = { sessionId: "old-session", pid: 200, path: oldPath, hostIncarnation: "host", endpointGeneration: 1, guardSessionIds: ["old-session"] };
    const newBinding = { ...oldBinding, sessionId: "new-session", path: newPath, guardSessionIds: ["old-session", "new-session"] };
    let answer: typeof oldBinding | null = oldBinding, lookups = 0, pid = 200, birth = 1000, clock = 0, running = true;
    const options = {
      platform: "linux",
      processInfo: async () => ({ process_info: { foreground_processes: running ? [{ pid, argv: ["/usr/bin/gjc"] }] : [] } }),
      processBirth: () => birth,
      sdkTranscript: async () => { lookups += 1; return answer; },
      now: () => clock,
    };
    const read = () => gjcTranscriptForPane("pane", cwd, home, options);

    // regression (fails on main: every sequential read ran the SDK CLI): an unchanged index keeps the binding
    expect(await read()).toBe(oldPath);
    expect(await read()).toBe(oldPath);
    for (let tick = 0; tick < 5; tick++) {
      expect(await gjcTranscriptForPane("pane", cwd, home, { ...options, purpose: "status" })).toBe(oldPath);
      expect(await read()).toBe(oldPath);
    }
    expect(lookups).toBe(1);

    // /new keeps the pid and the old transcript but rewrites the index: the next read asks the broker again
    row("host_unregistered", "old-session"); row("host_registered", "new-session");
    answer = null; // the new session has no transcript until its first message
    expect(await read()).toBeNull();
    expect(lookups).toBe(2);
    // a null is never kept: the first message creates the transcript without a new index row
    answer = newBinding;
    expect(await read()).toBe(newPath);
    expect(lookups).toBe(3);
    expect(await read()).toBe(newPath);
    expect(lookups).toBe(3);

    // another gjc process (same pid, new birth) is not the one the broker proved
    birth = 2000;
    expect(await read()).toBe(newPath);
    expect(lookups).toBe(4);
    pid = 201;
    expect(await read()).toBeNull(); // the broker bound pid 200, not this one
    expect(lookups).toBe(5);
    pid = 200;
    expect(await read()).toBe(newPath);
    expect(lookups).toBe(6);

    // a transcript that no longer names the session is not reused
    writeFileSync(newPath, JSON.stringify({ type: "session", id: "other-session", cwd }) + "\n");
    answer = null;
    expect(await read()).toBeNull();
    expect(lookups).toBe(7);
    writeFileSync(newPath, JSON.stringify({ type: "session", id: "new-session", cwd }) + "\n");
    answer = newBinding;
    expect(await read()).toBe(newPath);
    expect(lookups).toBe(8);

    // a kept binding ages out even while the index stands still
    clock = 29_999;
    expect(await read()).toBe(newPath);
    expect(lookups).toBe(8);
    clock = 30_000;
    expect(await read()).toBe(newPath);
    expect(lookups).toBe(9);

    // a compacted index (a new snapshot) counts as a change too
    writeFileSync(join(agentDir, "sdk", "sessions", "index.snapshot.json"), "{}");
    expect(await read()).toBe(newPath);
    expect(lookups).toBe(10);

    // the pane's gjc leaving drops it, so a gjc started later is looked up afresh
    running = false;
    expect(await read()).toBeNull();
    running = true;
    expect(await read()).toBe(newPath);
    expect(lookups).toBe(11);
  } finally { forgetTranscriptState(); rmSync(home, { recursive: true, force: true }); }
});

it.each(["timeout", "unavailable"] as const)("propagates SDK %s without retaining an old transcript or a failed lookup", async (reason) => {
  const home = tempDir("gjc-sdk-failure-");
  try {
    const cwd = join(home, "work"), agentDir = join(home, ".gjc", "agent");
    const project = join(agentDir, "sessions", "project"), path = join(project, "main.jsonl");
    mkdirSync(cwd); mkdirSync(project, { recursive: true });
    const sessionId = "sdk-session-failure";
    writeFileSync(path, JSON.stringify({ type: "session", id: sessionId, cwd }) + "\n");
    const binding = { sessionId, pid: 200, path, hostIncarnation: "host", endpointGeneration: 1, guardSessionIds: [sessionId] };
    const failure = new GjcSdkLookupError(reason);
    let lookups = 0;
    const options = {
      platform: "linux",
      processInfo: async () => ({ process_info: { foreground_processes: [{ pid: 200, argv: ["gjc"] }] } }),
      processBirth: () => 1000,
      sdkTranscript: async () => {
        lookups += 1;
        if (lookups === 2) throw failure;
        return lookups === 3 ? null : binding;
      },
    };
    expect(await gjcTranscriptForPane("pane", cwd, home, options)).toBe(path);
    const failed = gjcTranscriptForPane("pane", cwd, home, options);
    const overlapping = gjcTranscriptForPane("pane", cwd, home, options);
    expect(overlapping).toBe(failed);
    await expect(failed).rejects.toBe(failure);
    await expect(overlapping).rejects.toBe(failure);
    expect(await gjcTranscriptForPane("pane", cwd, home, options)).toBeNull();
    expect(await gjcTranscriptForPane("pane", cwd, home, options)).toBe(path);
    expect(lookups).toBe(4);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it.each(["timeout", "unavailable"] as const)("caches status %s briefly while chat retries independently", async (reason) => {
  const home = tempDir("gjc-status-failure-");
  try {
    let clock = 0, lookups = 0;
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    const failure = new GjcSdkLookupError(reason);
    const options = {
      platform: "linux", now: () => clock,
      processInfo: async () => ({ process_info: { foreground_processes: [{ pid: 200, argv: ["gjc"] }] } }),
      processBirth: () => 1000,
      sdkTranscript: async () => { lookups += 1; entered.resolve(); await gate.promise; throw failure; },
    };
    const status = () => gjcTranscriptForPane("pane", home, home, { ...options, purpose: "status" });
    const first = status();
    await entered.promise;
    const chat = gjcTranscriptForPane("pane", home, home, options);
    expect(chat).not.toBe(first);
    const failed = first.catch((error: unknown) => error);
    const failedChat = chat.catch((error: unknown) => error);
    gate.resolve();
    expect(await failed).toBe(failure);
    expect(await failedChat).toBe(failure);
    clock = 29_999;
    await expect(status()).rejects.toBe(failure);
    expect(lookups).toBe(2);
    clock = 30_000;
    await expect(status()).rejects.toBe(failure);
    expect(lookups).toBe(3);
    await expect(gjcTranscriptForPane("pane", home, home, options)).rejects.toBe(failure);
    expect(lookups).toBe(4);
    await expect(status()).rejects.toBe(failure);
    expect(lookups).toBe(4);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it("keeps unresolved status lookups briefly but a successful chat retry clears them", async () => {
  const home = tempDir("gjc-status-null-");
  try {
    const store = join(home, ".gjc/agent/sessions/project"), path = join(store, "main.jsonl");
    mkdirSync(store, { recursive: true });
    writeFileSync(path, JSON.stringify({ type: "session", id: "retry", cwd: home }) + "\n");
    let lookups = 0;
    const options = {
      platform: "linux",
      processInfo: async () => ({ process_info: { foreground_processes: [{ pid: 200, argv: ["gjc"] }] } }),
      processBirth: () => 1000,
      sdkTranscript: async () => ++lookups === 1 ? null : ({
        sessionId: "retry", pid: 200, path, hostIncarnation: "host", endpointGeneration: 1, guardSessionIds: ["retry"],
      }),
    };
    const status = () => gjcTranscriptForPane("pane", home, home, { ...options, purpose: "status" });
    expect(await status()).toBeNull();
    expect(await status()).toBeNull();
    expect(lookups).toBe(1);
    expect(await gjcTranscriptForPane("pane", home, home, options)).toBe(path);
    expect(await status()).toBe(path);
    expect(lookups).toBe(3);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it.each(["RPC unavailable", "RPC exception", "no foreground"] as const)("does not cache a status miss before SDK execution: %s", async (missing) => {
  const home = tempDir("gjc-status-before-sdk-");
  try {
    const store = join(home, ".gjc/agent/sessions/project"), path = join(store, "main.jsonl");
    mkdirSync(store, { recursive: true });
    writeFileSync(path, JSON.stringify({ type: "session", id: "ready", cwd: home }) + "\n");
    let ready = false, lookups = 0, clock = 0;
    const options = {
      platform: "linux", now: () => clock, purpose: "status" as const,
      processInfo: async () => {
        if (!ready && missing === "RPC exception") throw new Error("fixture RPC failed");
        if (!ready && missing === "RPC unavailable") return null;
        return { process_info: { foreground_processes: ready ? [{ pid: 200, argv: ["gjc"] }] : [] } };
      },
      processBirth: () => 1000,
      sdkTranscript: async () => {
        lookups += 1;
        return { sessionId: "ready", pid: 200, path, hostIncarnation: "host", endpointGeneration: 1, guardSessionIds: ["ready"] };
      },
    };
    expect(await gjcTranscriptForPane("pane", home, home, options)).toBeNull();
    expect(lookups).toBe(0);
    ready = true; clock = 25_000;
    expect(await gjcTranscriptForPane("pane", home, home, options)).toBe(path);
    expect(lookups).toBe(1);
  } finally { forgetTranscriptState(); rmSync(home, { recursive: true, force: true }); }
});

it("does not cache a status miss from transcript validation after SDK resolution", async () => {
  const home = tempDir("gjc-status-invalid-header-");
  try {
    const store = join(home, ".gjc/agent/sessions/project"), path = join(store, "main.jsonl");
    mkdirSync(store, { recursive: true });
    const header = (id: string) => writeFileSync(path, JSON.stringify({ type: "session", id, cwd: home }) + "\n");
    header("wrong");
    let lookups = 0;
    const options = {
      platform: "linux", purpose: "status" as const,
      processInfo: async () => ({ process_info: { foreground_processes: [{ pid: 200, argv: ["gjc"] }] } }),
      processBirth: () => 1000,
      sdkTranscript: async () => {
        lookups += 1;
        return { sessionId: "ready", pid: 200, path, hostIncarnation: "host", endpointGeneration: 1, guardSessionIds: ["ready"] };
      },
    };
    expect(await gjcTranscriptForPane("pane", home, home, options)).toBeNull();
    header("ready");
    expect(await gjcTranscriptForPane("pane", home, home, options)).toBe(path);
    expect(lookups).toBe(2);
  } finally { forgetTranscriptState(); rmSync(home, { recursive: true, force: true }); }
});

it.each(["pid", "birth", "cwd", "pane", "index", "foreground gap", "RPC gap"] as const)("invalidates cached SDK failures after a change to %s", async (change) => {
  for (const result of ["null", "timeout"] as const) {
    const home = tempDir("gjc-status-identity-");
    try {
      const store = join(home, ".gjc/agent/sessions/project"), path = join(store, "main.jsonl");
      const indexDir = join(home, ".gjc/agent/sdk/sessions"), cwdB = join(home, "other");
      mkdirSync(store, { recursive: true }); mkdirSync(indexDir, { recursive: true }); mkdirSync(cwdB);
      const index = join(indexDir, "index.jsonl");
      writeFileSync(index, sdkIndexRow(home, 1, { type: "host_registered", pid: 200 }));
      let pid = 200, birth = 1000, cwd = home, pane = "pane", active = true, reachable = true, failing = true, lookups = 0;
      const failure = new GjcSdkLookupError("timeout");
      const options = {
        platform: "linux", purpose: "status" as const,
        processInfo: async () => reachable ? ({ process_info: { foreground_processes: active ? [{ pid, argv: ["gjc"] }] : [] } }) : null,
        processBirth: () => birth,
        sdkTranscript: async () => {
          lookups += 1;
          if (failing) { if (result === "timeout") throw failure; return null; }
          writeFileSync(path, JSON.stringify({ type: "session", id: "ready", cwd }) + "\n");
          return { sessionId: "ready", pid, path, hostIncarnation: "host", endpointGeneration: 1, guardSessionIds: ["ready"] };
        },
      };
      const read = () => gjcTranscriptForPane(pane, cwd, home, options).catch((error: unknown) => error);
      expect(await read()).toBe(result === "timeout" ? failure : null);
      expect(await read()).toBe(result === "timeout" ? failure : null);
      expect(lookups).toBe(1);
      switch (change) {
        case "pid": pid += 1; break;
        case "birth": birth += 1000; break;
        case "cwd": cwd = cwdB; break;
        case "pane": pane = "other-pane"; break;
        case "index": appendFileSync(index, sdkIndexRow(home, 2, { type: "host_registered", sessionId: "new", pid })); break;
        case "foreground gap": active = false; expect(await read()).toBeNull(); active = true; break;
        case "RPC gap": reachable = false; expect(await read()).toBeNull(); reachable = true; break;
      }
      failing = false;
      expect(await read()).toBe(path);
      expect(lookups).toBe(2);
    } finally { forgetTranscriptState(); rmSync(home, { recursive: true, force: true }); }
  }
});

it("retries a failed Windows status lookup with the fresh foreground process, not the cached table", async () => {
  forgetTranscriptState();
  const home = tempDir("gjc-status-windows-failure-");
  try {
    const store = join(home, ".gjc/agent/sessions/project"), path = join(store, "main.jsonl");
    mkdirSync(store, { recursive: true });
    writeFileSync(path, JSON.stringify({ type: "session", id: "ready", cwd: home }) + "\n");
    let pid = 200;
    const asked: number[][] = [];
    const options = {
      platform: "win32", purpose: "status" as const,
      processInfo: async () => ({ process_info: { shell_pid: 100 } }),
      readProcessTable: async () => [{ pid, parent: 100, path: "C:\\gjc.exe", commandLine: "C:\\gjc.exe", started: 1000 }],
      sdkTranscript: async (pids: readonly number[]) => {
        asked.push([...pids]);
        return asked.length === 1 ? null : { sessionId: "ready", pid, path, hostIncarnation: "host", endpointGeneration: 1, guardSessionIds: ["ready"] };
      },
    };
    expect(await gjcTranscriptForPane("pane", home, home, options)).toBeNull();
    pid = 201;
    expect(await gjcTranscriptForPane("pane", home, home, options)).toBe(path);
    expect(asked).toEqual([[200], [201]]);
  } finally { forgetTranscriptState(); rmSync(home, { recursive: true, force: true }); }
});

it.each(["null", "timeout"] as const)("does not reinstate an older status %s after a newer chat succeeds", async (result) => {
  const home = tempDir("gjc-status-success-order-");
  const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
  try {
    const store = join(home, ".gjc/agent/sessions/project"), path = join(store, "main.jsonl");
    mkdirSync(store, { recursive: true });
    writeFileSync(path, JSON.stringify({ type: "session", id: "ready", cwd: home }) + "\n");
    const failure = new GjcSdkLookupError("timeout");
    let lookups = 0;
    const options = {
      platform: "linux",
      processInfo: async () => ({ process_info: { foreground_processes: [{ pid: 200, argv: ["gjc"] }] } }),
      processBirth: () => 1000,
      sdkTranscript: async (_pids: readonly number[], _cwd: string, _agentDir: string, purpose: "chat" | "status" = "chat") => {
        lookups += 1;
        if (purpose === "status" && lookups === 1) {
          entered.resolve(); await gate.promise;
          if (result === "timeout") throw failure;
          return null;
        }
        return { sessionId: "ready", pid: 200, path, hostIncarnation: "host", endpointGeneration: 1, guardSessionIds: ["ready"] };
      },
    };
    const status = () => gjcTranscriptForPane("pane", home, home, { ...options, purpose: "status" });
    const older = status().catch((error: unknown) => error);
    await bounded(entered.promise, "older status entered");
    expect(await gjcTranscriptForPane("pane", home, home, options)).toBe(path);
    gate.resolve();
    expect(await older).toBe(result === "timeout" ? failure : null);
    // No readable index: the success cannot be kept as a binding, but must still invalidate the older failure.
    expect(await status()).toBe(path);
    expect(lookups).toBe(3);
  } finally { gate.resolve(); forgetTranscriptState(); rmSync(home, { recursive: true, force: true }); }
});

it.each(["chat", "status"] as const)("does not inherit the %s deadline in an overlapping lookup of the other purpose", async (purpose) => {
  const home = tempDir("gjc-budget-flight-");
  const entered = Promise.withResolvers<void>(), both = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
  try {
    const purposes: string[] = [];
    const options = {
      platform: "linux",
      processInfo: async () => ({ process_info: { foreground_processes: [{ pid: 200, argv: ["gjc"] }] } }),
      processBirth: () => 1000,
      sdkTranscript: async (_pids: readonly number[], _cwd: string, _agentDir: string, budget: "chat" | "status" = "chat") => {
        purposes.push(budget);
        entered.resolve();
        if (purposes.length === 2) both.resolve();
        await gate.promise;
        return null;
      },
    };
    const first = gjcTranscriptForPane("pane", home, home, { ...options, purpose });
    await bounded(entered.promise, "first lookup entered");
    const other = gjcTranscriptForPane("pane", home, home, { ...options, purpose: purpose === "chat" ? "status" : "chat" });
    await bounded(both.promise, "both purpose-specific lookups entered");
    expect(other).not.toBe(first);
    gate.resolve();
    await Promise.all([first, other]);
    expect(purposes.sort()).toEqual(["chat", "status"]);
  } finally { gate.resolve(); rmSync(home, { recursive: true, force: true }); }
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
    const bindingA = { sessionId: "A", pid: 200, path: pathA, hostIncarnation: "host", endpointGeneration: 1, guardSessionIds: ["A"] };
    const bindingB = { ...bindingA, sessionId: "B", path: pathB, guardSessionIds: ["B"] };
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
    const binding = { sessionId, pid: 200, path, hostIncarnation: "host", endpointGeneration: 1, guardSessionIds: [sessionId] };
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

// The broker is a fake gjc executable that counts its launches and answers each --query from a file.
function nativeFixture(answers: Record<string, string | null>) {
  const home = tempDir("gjc-native-");
  const cwd = join(home, "work"), agentDir = join(home, ".gjc", "agent");
  const project = join(agentDir, "sessions", "v2-project"), path = join(project, "main.jsonl");
  const bin = join(home, "bin"), answerDir = join(home, "answers"), count = join(home, "launches");
  for (const dir of [cwd, project, bin, answerDir, join(agentDir, "sdk", "sessions")]) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify({ type: "session", id: "native-session", cwd }) + "\n");
  appendFileSync(join(agentDir, "sdk", "sessions", "index.jsonl"), JSON.stringify({ type: "host_registered", sessionId: "native-session", pid: 200 }) + "\n");
  writeFileSync(count, "");
  writeFileSync(join(bin, "gjc"), `#!/bin/sh
echo x >> "${count}"
sid="$5"; q=""
while [ $# -gt 0 ]; do if [ "$1" = "--query" ]; then q="$2"; fi; shift; done
cat "${answerDir}/$sid.$(echo "$q" | tr '/' '_').json" 2>/dev/null || exit 1
`);
  chmodSync(join(bin, "gjc"), 0o755);
  for (const [query, body] of Object.entries(answers)) if (body !== null) writeFileSync(join(answerDir, `native-session.${query.replace("/", "_")}.json`), body);
  const binding = { sessionId: "native-session", pid: 200, path, hostIncarnation: "host", endpointGeneration: 1, guardSessionIds: ["native-session"] };
  let clock = 0, held: typeof binding | null = binding, calls = 0, gateAt = -1, gate: Promise<void> | null = null, reached: () => void = () => {};
  const transcript = {
    platform: "linux",
    processInfo: async () => { const n = ++calls; if (n === gateAt) { reached(); await gate; } return { process_info: { foreground_processes: [{ pid: 200, argv: ["/usr/bin/gjc"] }] } }; },
    processBirth: () => 1000,
    sdkTranscript: async () => held,
    now: () => clock,
  };
  const savedPath = process.env["PATH"];
  process.env["PATH"] = `${bin}:${savedPath ?? ""}`;
  return {
    home, cwd, count: () => readFileSync(count, "utf8").split("\n").length - 1,
    options: { home, platform: "linux", now: () => clock },
    prove: (pane = "pane") => gjcTranscriptForPane(pane, cwd, home, transcript),
    advance: (ms: number) => { clock += ms; },
    hold: (next: typeof binding | null) => { held = next; },
    // the second process read of the next lookup (its final identity check) waits for the returned release
    block: () => {
      let release!: () => void;
      gate = new Promise<void>((resolve) => { release = resolve; });
      const waiting = new Promise<void>((resolve) => { reached = resolve; });
      gateAt = calls + 2;
      return { release, waiting };
    },
    session: (id: string, answers: Record<string, string>) => {
      const file = join(project, `${id}.jsonl`);
      writeFileSync(file, JSON.stringify({ type: "session", id, cwd }) + "\n");
      for (const [query, body] of Object.entries(answers)) writeFileSync(join(answerDir, `${id}.${query.replace("/", "_")}.json`), body);
      return { ...binding, sessionId: id, path: realpathSync(file), guardSessionIds: [id] };
    },
    done: () => { process.env["PATH"] = savedPath; rmSync(home, { recursive: true, force: true }); },
  };
}
const capabilities = (operations: string[]) => JSON.stringify({ ok: true, page: { items: [{ operations }], complete: true, revision: "r" } });
const skillList = (items: unknown[], complete = true) => JSON.stringify({ ok: true, page: { items, complete, revision: "r" } });
const nativeIt = it.skipIf(process.platform === "win32");

nativeIt("serves kept native skill rows without starting a process on a request, refreshing once per period", async () => {
  forgetTranscriptState();
  const f = nativeFixture({
    "runtime.capabilities": capabilities(["skill.list/state"]),
    "skill.list/state": skillList([{ name: "review", description: "Review code" }, { name: "skill:plan" }, { name: "review" }, { name: "bad name" }, 7]),
  });
  try {
    // no binding yet: nothing to ask, nothing launched
    expect(gjcNativeSkills("pane", f.options)).toEqual({ rows: null });
    expect(f.count()).toBe(0);
    await f.prove();
    const first = gjcNativeSkills("pane", f.options);
    expect(first.rows).toBeNull();
    // a burst of requests shares the one background refresh
    const burst = Array.from({ length: 10 }, () => gjcNativeSkills("pane", f.options));
    expect(burst.every(({ rows }) => rows === null)).toBe(true);
    await first.refreshed;
    expect(f.count()).toBe(2); // capabilities and skill.list/state, once
    const served = Array.from({ length: 10 }, () => gjcNativeSkills("pane", f.options));
    expect(served.every(({ refreshed }) => refreshed === undefined)).toBe(true);
    expect(served[0]!.rows?.map(({ name, source, provenance }) => [name, source, provenance])).toEqual([
      ["skill:review", "skill", { transport: "native", verified: true }],
      ["skill:plan", "skill", { transport: "native", verified: true }],
    ]);
    expect(f.count()).toBe(2);
    // a period later the adapter's binding is proven again and one more refresh runs
    f.advance(31_000);
    expect(gjcNativeSkills("pane", f.options)).toEqual({ rows: null }); // the binding aged out
    await f.prove();
    const again = gjcNativeSkills("pane", f.options);
    expect(again.rows?.length).toBe(2); // the same session proven again keeps its rows while one refresh runs
    await again.refreshed;
    expect(f.count()).toBe(4);
    expect(gjcNativeSkills("pane", f.options).rows?.length).toBe(2);
  } finally { f.done(); }
});

nativeIt("launches nothing without a proven binding and backs off after a failed refresh", async () => {
  forgetTranscriptState();
  const f = nativeFixture({});
  try {
    f.hold(null); // the adapter cannot resolve a binding: the broker is unavailable to it
    await f.prove();
    for (let i = 0; i < 10; i++) expect(gjcNativeSkills("pane", f.options)).toEqual({ rows: null });
    expect(f.count()).toBe(0);

    forgetTranscriptState();
    const g = nativeFixture({ "runtime.capabilities": capabilities(["skill.list/state"]), "skill.list/state": null }); // the CLI exits 1
    try {
      await g.prove();
      const first = gjcNativeSkills("pane", g.options);
      await first.refreshed;
      for (let i = 0; i < 10; i++) expect(gjcNativeSkills("pane", g.options).rows).toBeNull();
      expect(g.count()).toBe(2);
    } finally { g.done(); }
  } finally { f.done(); }
});

nativeIt("keeps scan rows when runtime.capabilities does not offer skill.list/state or the list is partial", async () => {
  for (const answers of [
    { "runtime.capabilities": capabilities(["turn.result"]), "skill.list/state": skillList([{ name: "a" }]) },
    { "runtime.capabilities": capabilities(["skill.list/state"]), "skill.list/state": skillList([{ name: "a" }], false) },
  ]) {
    forgetTranscriptState();
    const f = nativeFixture(answers);
    try {
      await f.prove();
      await gjcNativeSkills("pane", f.options).refreshed;
      expect(gjcNativeSkills("pane", f.options).rows).toBeNull();
    } finally { f.done(); }
  }
});

nativeIt("drops a pane's binding and native rows when the pane ends, even from a refresh still running", async () => {
  forgetTranscriptState();
  const f = nativeFixture({
    "runtime.capabilities": capabilities(["skill.list/state"]),
    "skill.list/state": skillList([{ name: "review" }]),
  });
  try {
    await f.prove();
    const first = gjcNativeSkills("pane", f.options);
    await first.refreshed;
    expect(gjcNativeSkills("pane", f.options).rows?.length).toBe(1);
    const launches = f.count();
    forgetGjcPane("pane");
    for (let i = 0; i < 10; i++) expect(gjcNativeSkills("pane", f.options)).toEqual({ rows: null });
    expect(f.count()).toBe(launches);

    // a refresh running when the pane ends stores nothing afterwards
    f.advance(31_000);
    await f.prove();
    const running = gjcNativeSkills("pane", f.options);
    expect(running.refreshed).toBeDefined();
    forgetGjcPane("pane");
    await running.refreshed;
    expect(gjcNativeSkills("pane", f.options)).toEqual({ rows: null });
  } finally { f.done(); }
});

nativeIt("a lookup still running when its pane ends publishes no binding", async () => {
  forgetTranscriptState();
  const f = nativeFixture({ "runtime.capabilities": capabilities(["skill.list/state"]), "skill.list/state": skillList([{ name: "old" }]) });
  try {
    const { release, waiting } = f.block();
    const lookup = f.prove();
    await waiting;
    forgetGjcPane("pane");
    release();
    await lookup;
    for (let i = 0; i < 10; i++) expect(gjcNativeSkills("pane", f.options)).toEqual({ rows: null });
    expect(f.count()).toBe(0);
  } finally { f.done(); }
});

nativeIt("an older lookup never overwrites the binding of a reused pane id", async () => {
  forgetTranscriptState();
  const f = nativeFixture({});
  try {
    const old = f.session("old-session", { "runtime.capabilities": capabilities(["skill.list/state"]), "skill.list/state": skillList([{ name: "old" }]) });
    const fresh = f.session("new-session", { "runtime.capabilities": capabilities(["skill.list/state"]), "skill.list/state": skillList([{ name: "new" }]) });
    f.hold(old);
    const { release, waiting } = f.block();
    const stale = f.prove();
    await waiting;
    forgetGjcPane("pane");
    f.hold(fresh);
    await f.prove(); // the reused pane id gets its own binding while the old lookup waits
    release();
    await stale;
    await gjcNativeSkills("pane", f.options).refreshed;
    expect(gjcNativeSkills("pane", f.options).rows?.map(({ name }) => name)).toEqual(["skill:new"]);
  } finally { f.done(); }
});

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };

/** Lookups whose SDK answers wait for the test: `answers[n]` is what the n-th SDK call returns once `release(n)` runs. */
function gatedLookups(f: ReturnType<typeof nativeFixture>, answers: (() => unknown)[]) {
  const started = answers.map(deferred), gates = answers.map(deferred);
  let calls = 0;
  const options = {
    platform: "linux",
    processInfo: async () => ({ process_info: { foreground_processes: [{ pid: 200, argv: ["/usr/bin/gjc"] }] } }),
    processBirth: () => 1000,
    sdkTranscript: async () => { const n = calls++; started[n]!.resolve(); await gates[n]!.promise; return answers[n]!() as never; },
  };
  return {
    options, calls: () => calls,
    start: (purpose: "chat" | "status") => gjcTranscriptForPane("pane", f.cwd, f.home, { ...options, purpose }),
    started: (n: number) => started[n]!.promise, release: (n: number) => gates[n]!.resolve(),
    read: () => gjcTranscriptForPane("pane", f.cwd, f.home, { ...options, purpose: "chat" }),
  };
}

nativeIt("the newest of two overlapping lookups of a pane wins, whichever finishes last", async () => {
  for (const order of [[1, 0], [0, 1]] as const) {
    forgetTranscriptState();
    const f = nativeFixture({});
    try {
      const old = f.session("old-session", {}), fresh = f.session("new-session", {});
      const l = gatedLookups(f, [() => old, () => fresh]);
      const status = l.start("status");
      await l.started(0);
      const chat = l.start("chat");
      await l.started(1);
      for (const n of order) { l.release(n); await (n === 0 ? status : chat); }
      expect(await l.read()).toBe(fresh.path);
      expect(l.calls()).toBe(2); // the newer binding was kept, no third lookup
    } finally { f.done(); }
  }
});

nativeIt("a lookup released after a global reset restores nothing, whether it succeeded or timed out", async () => {
  for (const outcome of ["success", "timeout"] as const) {
    forgetTranscriptState();
    const f = nativeFixture({});
    try {
      const session = f.session("old-session", {});
      const l = gatedLookups(f, [() => { if (outcome === "timeout") throw new GjcSdkLookupError("timeout"); return session; }]);
      const lookup = l.start("status");
      await l.started(0);
      forgetGjcState();
      l.release(0);
      await lookup.catch(() => null);
      expect(gjcRetainedEntries()).toBe(0);
      expect(gjcNativeSkills("pane", f.options)).toEqual({ rows: null });
      expect(f.count()).toBe(0);
    } finally { f.done(); }
  }
});

nativeIt("keeps nothing about ended panes that never ran gjc", async () => {
  forgetTranscriptState();
  const f = nativeFixture({});
  try {
    const shell = { processInfo: async () => ({ process_info: { foreground_processes: [{ pid: 300, argv: ["/bin/zsh"] }] } }), processBirth: () => 1000, platform: "linux" };
    for (let i = 0; i < 40; i++) {
      await gjcTranscriptForPane(`shell-${i}`, f.cwd, f.home, shell);
      forgetGjcPane(`shell-${i}`);
    }
    expect(gjcRetainedEntries()).toBe(0);
  } finally { f.done(); }
});

nativeIt("a cancelled lookup never deletes a newer cached failure", async () => {
  forgetTranscriptState();
  const f = nativeFixture({});
  try {
    let pid = 200, mode: "timeout" | "null" = "timeout", sdkCalls = 0;
    const held = deferred(), reached = deferred();
    let hold = true;
    const options = {
      platform: "linux", purpose: "status" as const,
      processInfo: async () => {
        const mine = pid; // the pid this read saw, whenever it answers
        if (hold) { hold = false; reached.resolve(); await held.promise; }
        return { process_info: { foreground_processes: [{ pid: mine, argv: ["/usr/bin/gjc"] }] } };
      },
      processBirth: () => 1000,
      sdkTranscript: async () => { sdkCalls += 1; if (mode === "timeout") throw new GjcSdkLookupError("timeout"); return null; },
    };
    const read = () => gjcTranscriptForPane("pane", f.cwd, f.home, options);
    const old = read().catch(() => null); // sees pid 200 and waits
    await reached.promise;
    forgetGjcState();
    pid = 201;
    await read().then(() => { throw new Error("expected a timeout"); }, (error) => expect(error).toBeInstanceOf(GjcSdkLookupError));
    expect(sdkCalls).toBe(1);
    mode = "null";
    held.resolve();
    await old; // finds the newer failure, differs from it and must leave it alone
    const calls = sdkCalls;
    await read().then(() => { throw new Error("expected the cached timeout"); }, (error) => expect(error).toBeInstanceOf(GjcSdkLookupError));
    expect(sdkCalls).toBe(calls);
  } finally { f.done(); }
});

nativeIt("keeps native rows while a binding is momentarily absent during a reproof of the same session", async () => {
  forgetTranscriptState();
  const f = nativeFixture({ "runtime.capabilities": capabilities(["skill.list/state"]), "skill.list/state": skillList([{ name: "review" }]) });
  try {
    await f.prove();
    await gjcNativeSkills("pane", f.options).refreshed;
    expect(f.count()).toBe(2);
    // the index changes, so the next lookup asks the broker again and drops the kept binding first
    appendFileSync(join(f.home, ".gjc", "agent", "sdk", "sessions", "index.jsonl"), JSON.stringify({ type: "host_unregistered", sessionId: "native-session", pid: 200 }) + "\n");
    const { release, waiting } = f.block();
    const reproof = f.prove();
    await waiting;
    expect(gjcNativeSkills("pane", f.options)).toEqual({ rows: null });
    release();
    await reproof;
    expect(gjcNativeSkills("pane", f.options).rows?.map(({ name }) => name)).toEqual(["skill:review"]);
    expect(f.count()).toBe(2); // the same period: no second refresh
  } finally { f.done(); }
});

/** One pane proving sessions under two cwds: the fake broker answers by the cwd the lookup asked about. */
function twoCwds() {
  const f = nativeFixture({});
  const root = join(f.home, ".gjc", "agent", "sessions", "v2-project");
  const answer = (id: string, name: string, cwd: string) => {
    const file = join(root, `${id}.jsonl`);
    mkdirSync(cwd, { recursive: true });
    writeFileSync(file, JSON.stringify({ type: "session", id, cwd }) + "\n");
    for (const [query, body] of [["runtime.capabilities", capabilities(["skill.list/state"])], ["skill.list/state", skillList([{ name }])]] as const) {
      writeFileSync(join(f.home, "answers", `${id}.${query.replace("/", "_")}.json`), body);
    }
    return { sessionId: id, pid: 200, path: realpathSync(file), hostIncarnation: "host", endpointGeneration: 1, guardSessionIds: [id] };
  };
  const cwdA = join(f.home, "work-a"), cwdB = join(f.home, "work-b");
  const bindings: Record<string, ReturnType<typeof answer> | null> = { [cwdA]: answer("old-a", "old", cwdA), [cwdB]: answer("new-b", "new", cwdB) };
  // a lookup for `cwd` can be held in its SDK call, or at the process read that follows it (its final identity check)
  const timeouts = new Set<string>();
  const held = { sdk: null as null | { cwd: string; reached: () => void; gate: Promise<void> }, final: null as null | { reached: () => void; gate: Promise<void> }, armFinal: null as null | string };
  const options = {
    platform: "linux",
    processInfo: async () => {
      const hold = held.final;
      if (hold && held.armFinal === "taken") { held.final = null; hold.reached(); await hold.gate; }
      return { process_info: { foreground_processes: [{ pid: 200, argv: ["/usr/bin/gjc"] }] } };
    },
    processBirth: () => 1000,
    sdkTranscript: async (_pids: readonly number[], cwd: string) => {
      const real = realpathSync(cwd);
      if (timeouts.has(real)) throw new GjcSdkLookupError("timeout");
      if (held.sdk && held.sdk.cwd === real) { const hold = held.sdk; held.sdk = null; hold.reached(); await hold.gate; }
      if (held.final && held.armFinal === real) held.armFinal = "taken";
      return bindings[real] ?? null;
    },
  };
  const hold = (where: "sdk" | "final", cwd: string) => {
    let release!: () => void, reached!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const waiting = new Promise<void>((resolve) => { reached = resolve; });
    if (where === "sdk") held.sdk = { cwd, reached, gate };
    else { held.final = { reached, gate }; held.armFinal = cwd; }
    return { release, waiting };
  };
  return {
    f, cwdA: realpathSync(cwdA), cwdB: realpathSync(cwdB), bindings, hold, timeouts,
    prove: (cwd: string) => gjcTranscriptForPane("pane", cwd, f.home, options),
    index: (sessionId: string) => appendFileSync(join(f.home, ".gjc", "agent", "sdk", "sessions", "index.jsonl"), JSON.stringify({ type: "host_unregistered", sessionId, pid: 200 }) + "\n"),
  };
}

nativeIt("serves the session of the pane's most recent proof, even under another cwd", async () => {
  forgetTranscriptState();
  const t = twoCwds();
  try {
    await t.prove(t.cwdA);
    await t.prove(t.cwdB);
    const served = gjcNativeSkills("pane", t.f.options);
    await served.refreshed;
    expect(gjcNativeSkills("pane", t.f.options).rows?.map(({ name }) => name)).toEqual(["skill:new"]);
  } finally { t.f.done(); }
});

nativeIt("never falls back to an older proof of the pane when the newest one is null", async () => {
  forgetTranscriptState();
  const t = twoCwds();
  try {
    await t.prove(t.cwdA);
    await t.prove(t.cwdB);
    await gjcNativeSkills("pane", t.f.options).refreshed;
    const launches = t.f.count();
    // the index changes, so B is proven again, and the broker no longer names a session for it
    t.index("new-b");
    t.bindings[t.cwdB] = null;
    expect(await t.prove(t.cwdB)).toBeNull();
    for (let i = 0; i < 5; i++) expect(gjcNativeSkills("pane", t.f.options)).toEqual({ rows: null });
    expect(t.f.count()).toBe(launches); // old-a is never queried
  } finally { t.f.done(); }
});

nativeIt("a slow chat lookup still publishes its binding when a status lookup replaying a cached failure settles first", async () => {
  forgetTranscriptState();
  const f = nativeFixture({});
  try {
    const session = f.session("slow-session", {});
    const l = gatedLookups(f, [() => { throw new GjcSdkLookupError("timeout"); }, () => session]);
    const first = l.start("status");
    await l.started(0);
    l.release(0);
    await first.then(() => { throw new Error("expected a timeout"); }, (error) => expect(error).toBeInstanceOf(GjcSdkLookupError));
    const chat = l.start("chat");
    await l.started(1); // the chat proof is waiting on a slow broker
    // the newer status lookup only replays the cached failure and settles first: it must not overtake the chat proof
    await l.start("status").then(() => { throw new Error("expected the cached timeout"); }, (error) => expect(error).toBeInstanceOf(GjcSdkLookupError));
    expect(l.calls()).toBe(2); // replayed from the cache, no SDK call
    l.release(1);
    expect(await chat).toBe(session.path);
    expect(await l.read()).toBe(session.path);
    expect(l.calls()).toBe(2); // the chat binding was kept
  } finally { f.done(); }
});

for (const where of ["sdk", "final"] as const) {
  for (const newer of ["fresh", "null"] as const) {
    nativeIt(`an old lookup held ${where === "sdk" ? "in its SDK call" : "at its final process read"} publishes nothing once a newer lookup of the pane settled (${newer} proof)`, async () => {
      forgetTranscriptState();
      const t = twoCwds();
      try {
        if (newer === "null") await t.prove(t.cwdB); // an earlier proof of B, then B is reproved and the broker names nothing
        const held = t.hold(where, t.cwdA);
        const old = t.prove(t.cwdA);
        await held.waiting;
        if (newer === "null") { t.index("new-b"); t.bindings[t.cwdB] = null; }
        expect(await t.prove(t.cwdB)).toBe(newer === "null" ? null : t.bindings[t.cwdB]?.path ?? null);
        const launches = t.f.count();
        held.release();
        await old;
        const served = gjcNativeSkills("pane", t.f.options);
        if (newer === "null") {
          for (let i = 0; i < 5; i++) expect(gjcNativeSkills("pane", t.f.options)).toEqual({ rows: null });
          expect(t.f.count()).toBe(launches); // old-a is never queried
        } else {
          await served.refreshed;
          expect(gjcNativeSkills("pane", t.f.options).rows?.map(({ name }) => name)).toEqual(["skill:new"]);
        }
      } finally { t.f.done(); }
    });
  }
}

nativeIt("an older slow chat lookup still publishes when a newer status lookup of its own key times out fresh", async () => {
  forgetTranscriptState();
  const f = nativeFixture({});
  try {
    const session = f.session("slow-session", {});
    const l = gatedLookups(f, [() => session, () => { throw new GjcSdkLookupError("timeout"); }]);
    const chat = l.start("chat");
    await l.started(0); // the chat proof waits on a slow broker
    const status = l.start("status").then(() => { throw new Error("expected a timeout"); }, (error) => expect(error).toBeInstanceOf(GjcSdkLookupError));
    await l.started(1);
    l.release(1);
    await status; // a fresh failure, settled after the older chat lookup started
    l.release(0);
    expect(await chat).toBe(session.path);
    expect(await l.read()).toBe(session.path);
    expect(l.calls()).toBe(2); // the chat binding was kept
  } finally { f.done(); }
});

nativeIt("a fresh timeout under another cwd still stops an older lookup of the pane from publishing", async () => {
  forgetTranscriptState();
  const t = twoCwds();
  try {
    const held = t.hold("sdk", t.cwdA);
    const old = t.prove(t.cwdA);
    await held.waiting;
    t.timeouts.add(t.cwdB);
    await t.prove(t.cwdB).then(() => { throw new Error("expected a timeout"); }, (error) => expect(error).toBeInstanceOf(GjcSdkLookupError));
    const launches = t.f.count();
    held.release();
    await old;
    for (let i = 0; i < 5; i++) expect(gjcNativeSkills("pane", t.f.options)).toEqual({ rows: null });
    expect(t.f.count()).toBe(launches); // old-a is never queried
  } finally { t.f.done(); }
});
