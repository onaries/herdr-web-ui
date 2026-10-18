import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { AmbiguousClaudeStore, claudeForegroundSession, claudeProcessSession, claudeSessionTempDir, claudeStoreKey, claudeProjectDir, claudeTranscriptFile, configDirInPsLine, forgetClaudeSessions, isClaudeProcess, processClaudeConfigDir } from "./claude-store.ts";
import type { ProcessRow } from "./windows-processes.ts";

const NATIVE = process.platform === "linux" || process.platform === "darwin";
const SESSION = "0b8e6f0e-8d3f-4c1a-9a53-6c2b7a1d9e42";

describe("claudeProcessSession", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  function nativeRecord(patch: Record<string, unknown> = {}): string {
    const home = mkdtempSync(join(tmpdir(), "herdr-claude-pid-"));
    roots.push(home);
    const dir = join(home, ".claude", "sessions");
    mkdirSync(dir, { recursive: true });
    // as Claude Code records it: month before day, whatever the user's locale
    const procStart = process.platform === "linux"
      ? readFileSync("/proc/self/stat", "utf8").split(") ").pop()?.split(" ")[19]
      : Bun.spawnSync(["/bin/ps", "-o", "lstart=", "-p", String(process.pid)], { env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }).stdout.toString().trim();
    writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify({
      pid: process.pid, sessionId: SESSION, procStart, kind: "interactive", ...patch,
    }));
    return home;
  }

  it.skipIf(!NATIVE)("reads an exact live PID's session without a cwd guess", async () => {
    const home = nativeRecord();
    expect(await claudeProcessSession(home, process.pid)).toBe(SESSION);
  });

  // the test process stands in for the pane's Claude; its own CLAUDE_CONFIG_DIR would name another store
  it.skipIf(!NATIVE || Boolean(process.env["CLAUDE_CONFIG_DIR"]))("reads the session a pane's one Claude process records, which /clear rewrites (#540)", async () => {
    const home = nativeRecord();
    const claude = { pid: process.pid, name: "claude", argv0: null, argv: null };
    expect(await claudeForegroundSession([claude], home)).toBe(SESSION);
    const cleared = "1c9e7f0e-8d3f-4c1a-9a53-6c2b7a1d9e43";
    const path = join(home, ".claude", "sessions", `${process.pid}.json`);
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), sessionId: cleared }));
    expect(await claudeForegroundSession([claude], home)).toBe(cleared);
    // control: no single Claude process, no session
    expect(await claudeForegroundSession([], home)).toBeNull();
    expect(await claudeForegroundSession([claude, { ...claude, pid: process.pid + 1 }], home)).toBeNull();
    expect(await claudeForegroundSession([{ ...claude, name: "bash" }], home)).toBeNull();
  });

  it.skipIf(process.platform !== "darwin")("reads it on a Mac whose locale puts the day first", async () => {
    const home = nativeRecord();
    const saved = process.env["LC_ALL"];
    // en_GB's ps prints "Fri  9 Oct …" for the "Fri Oct  9 …" Claude recorded
    process.env["LC_ALL"] = "en_GB.UTF-8";
    try {
      expect(await claudeProcessSession(home, process.pid)).toBe(SESSION);
    } finally {
      if (saved === undefined) delete process.env["LC_ALL"];
      else process.env["LC_ALL"] = saved;
    }
  });

  for (const [name, patch] of [
    ["another PID", { pid: process.pid + 1 }],
    ["a reused PID", { procStart: "1" }],
    ["an older record without start ticks", { procStart: null }],
    ["a noninteractive SDK session", { kind: "sdk" }],
    ["a path in place of a UUID", { sessionId: "../../other" }],
    ["a missing session ID", { sessionId: null }],
  ] satisfies [string, Record<string, unknown>][]) {
    it.skipIf(!NATIVE)(`rejects ${name}`, async () => {
      const home = nativeRecord(patch);
      expect(await claudeProcessSession(home, process.pid)).toBeNull();
    });
  }

  it.skipIf(!NATIVE)("returns no identity for absent, torn or oversized records", async () => {
    const home = nativeRecord();
    const path = join(home, ".claude", "sessions", `${process.pid}.json`);
    rmSync(path);
    expect(await claudeProcessSession(home, process.pid)).toBeNull();
    writeFileSync(path, "{");
    expect(await claudeProcessSession(home, process.pid)).toBeNull();
    writeFileSync(path, JSON.stringify({ padding: "x".repeat(16 * 1024) }));
    expect(await claudeProcessSession(home, process.pid)).toBeNull();
    expect(await claudeProcessSession(home, -1)).toBeNull();
  });

  it.skipIf(!NATIVE)("does not wait on a FIFO or follow a link in the record's place", async () => {
    const home = nativeRecord();
    const path = join(home, ".claude", "sessions", `${process.pid}.json`);
    const target = join(home, "elsewhere.json");
    renameSync(path, target);
    symlinkSync(target, path);
    expect(await claudeProcessSession(home, process.pid)).toBeNull();
    rmSync(path);
    expect(Bun.spawnSync(["mkfifo", path]).exitCode).toBe(0);
    const started = Date.now();
    expect(await claudeProcessSession(home, process.pid)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("claudeProjectDir", () => {
  it("encodes a cwd the way Claude Code names its project", () => {
    expect(claudeProjectDir("/home/u/project")).toBe("-home-u-project");
    expect(claudeProjectDir("/home/u/Development/test.com")).toBe("-home-u-Development-test-com");
    expect(claudeProjectDir("/home/u/my_project")).toBe("-home-u-my-project");
    expect(claudeProjectDir("/home/u/.dotfiles")).toBe("-home-u--dotfiles");
    expect(claudeProjectDir("/home/u/문서/app")).toBe("-home-u----app");
    expect(claudeProjectDir("/home/u/My Project")).toBe("-home-u-My-Project");
  });

  it("cuts a name past 200 characters and adds the hash of the whole path", () => {
    const cwd = `/home/u/${"deep/".repeat(45)}project`;
    expect(claudeProjectDir(cwd)).toBe(`${"-home-u-" + "deep-".repeat(38)}de-5cuwtt`);
    expect(claudeProjectDir(cwd).length).toBe(207);
  });
});

describe("claudeTranscriptFile", () => {
  const roots: string[] = [];
  afterEach(() => { forgetClaudeSessions(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  function home(): { home: string; projects: string } {
    const home = mkdtempSync(join(tmpdir(), "herdr-claude-store-"));
    roots.push(home);
    const projects = join(home, ".claude", "projects");
    mkdirSync(projects, { recursive: true });
    return { home, projects };
  }
  function transcript(projects: string, project: string): string {
    mkdirSync(join(projects, project), { recursive: true });
    const path = join(projects, project, `${SESSION}.jsonl`);
    writeFileSync(path, "{}\n");
    return path;
  }

  it("finds a session under a cwd with a dot, an underscore, a space or Korean", async () => {
    for (const cwd of ["/w/example.com", "/w/my_project", "/w/My Project", "/w/문서/app", "/w/.dotfiles"]) {
      const { home: dir, projects } = home();
      const path = transcript(projects, claudeProjectDir(cwd));
      expect(await claudeTranscriptFile(dir, SESSION, [cwd])).toBe(path);
    }
  });

  it("tries each cwd in turn, then finds the session in whichever project holds it", async () => {
    const { home: dir, projects } = home();
    const started = transcript(projects, claudeProjectDir("/w/started-here"));
    expect(await claudeTranscriptFile(dir, SESSION, ["/w/moved-on", null, "/w/started-here"])).toBe(started);
    // neither cwd names the project (Claude started elsewhere, or named it another way)
    renameSync(join(projects, claudeProjectDir("/w/started-here")), join(projects, "-some-other-name"));
    expect(await claudeTranscriptFile(dir, SESSION, ["/w/moved-on"])).toBe(join(projects, "-some-other-name", `${SESSION}.jsonl`));
    // a remembered file that has gone is looked up again, not answered
    rmSync(join(projects, "-some-other-name"), { recursive: true });
    expect(await claudeTranscriptFile(dir, SESSION, ["/w/moved-on"])).toBeNull();
  });

  it("keeps a session found by a scan to the store it was found in", async () => {
    const first = home(), second = home();
    transcript(first.projects, "-elsewhere");
    expect(await claudeTranscriptFile(first.home, SESSION, ["/w/project"])).toBe(join(first.projects, "-elsewhere", `${SESSION}.jsonl`));
    expect(await claudeTranscriptFile(second.home, SESSION, ["/w/project"])).toBeNull();
  });

  it("reports a store it cannot read instead of calling the transcript missing", async () => {
    if (process.getuid?.() === 0) return; // root reads anything
    const { home: dir, projects } = home();
    chmodSync(projects, 0o000);
    try { await expect(claudeTranscriptFile(dir, SESSION, [])).rejects.toThrow(); }
    finally { chmodSync(projects, 0o700); }
    // an unreadable project beside the one holding the session: the session is still found
    const hit = transcript(projects, "-readable");
    mkdirSync(join(projects, "-locked"));
    chmodSync(join(projects, "-locked"), 0o000);
    try { expect(await claudeTranscriptFile(dir, SESSION, [])).toBe(hit); }
    finally { chmodSync(join(projects, "-locked"), 0o700); }
    // and without a hit, the unreadable project is reported, not called missing
    forgetClaudeSessions();
    rmSync(hit);
    chmodSync(join(projects, "-locked"), 0o000);
    try { await expect(claudeTranscriptFile(dir, SESSION, [])).rejects.toThrow(); }
    finally { chmodSync(join(projects, "-locked"), 0o700); }
  });

  it("answers null without a projects store or a file for the session", async () => {
    const { home: dir } = home();
    expect(await claudeTranscriptFile(dir, SESSION, ["/w/project"])).toBeNull();
    expect(await claudeTranscriptFile(join(dir, "missing"), SESSION, ["/w/project"])).toBeNull();
  });

  it("follows Claude's continued-in chain to the active transcript", async () => {
    const { home: dir, projects } = home();
    const project = claudeProjectDir("/w/project");
    const folder = join(projects, project);
    const continued = "11111111-1111-4111-8111-111111111111";
    const activeId = "22222222-2222-4222-8222-222222222222";
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `${SESSION}.jsonl`), [
      { type: "last-prompt", sessionId: SESSION },
      { type: "continued-in", sessionId: SESSION, continuedInSessionId: continued },
    ].map((entry) => JSON.stringify(entry)).join("\n"));
    writeFileSync(join(folder, `${continued}.jsonl`), JSON.stringify({ type: "continued-in", sessionId: continued, continuedInSessionId: activeId }));
    const active = join(folder, `${activeId}.jsonl`);
    writeFileSync(active, [
      { type: "user", message: { content: "Prompt after continue" } },
      { type: "assistant", message: { content: [{ type: "text", text: "Answer after continue" }] } },
    ].map((entry) => JSON.stringify(entry)).join("\n"));
    expect(await claudeTranscriptFile(dir, SESSION, ["/w/project"])).toBe(active);
  });

  it("keeps a transcript whose continued-in record is followed by newer turns, or names no file", async () => {
    const { home: dir, projects } = home();
    const folder = join(projects, claudeProjectDir("/w/project"));
    const other = "33333333-3333-4333-8333-333333333333";
    const missing = "44444444-4444-4444-8444-444444444444";
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `${other}.jsonl`), JSON.stringify({ type: "user", message: { content: "old" } }));
    const original = join(folder, `${SESSION}.jsonl`);
    writeFileSync(original, [
      { type: "continued-in", sessionId: SESSION, continuedInSessionId: other },
      { type: "user", message: { content: "Newer prompt" } },
    ].map((entry) => JSON.stringify(entry)).join("\n"));
    expect(await claudeTranscriptFile(dir, SESSION, ["/w/project"])).toBe(original);
    writeFileSync(original, JSON.stringify({ type: "continued-in", sessionId: SESSION, continuedInSessionId: missing }));
    expect(await claudeTranscriptFile(dir, SESSION, ["/w/project"])).toBe(original);
  });

  describe("a /resume of a background session", () => {
    const PARKED = "e4159264-2222-4222-8222-222222222222";
    const BG = "8b80137e-f8fe-4aaa-8bbb-cccccccccccc";
    const resumed = (folder: string, jobId = "8b80137e") => {
      const original = join(folder, `${SESSION}.jsonl`);
      writeFileSync(original, [
        { type: "user", message: { content: "/resume" } },
        { type: "user", message: { content: `<local-command-stdout>Opening \"title\", running in the background (${jobId})</local-command-stdout>` } },
        { type: "continued-in", sessionId: SESSION, continuedInSessionId: PARKED },
      ].map((entry) => JSON.stringify(entry)).join("\n"));
      return original;
    };

    it("follows the output's job id to that job's transcript (regression: fails on main)", async () => {
      const { home: dir, projects } = home();
      const folder = join(projects, claudeProjectDir("/w/project"));
      mkdirSync(folder, { recursive: true });
      resumed(folder);
      const job = join(folder, `${BG}.jsonl`);
      writeFileSync(job, JSON.stringify({ type: "user", message: { content: "real conversation prompt" } }));
      expect(await claudeTranscriptFile(dir, SESSION, ["/w/project"])).toBe(job);
    });

    it("keeps the named transcript when no file, or more than one, matches the job id (control)", async () => {
      const { home: dir, projects } = home();
      const folder = join(projects, claudeProjectDir("/w/project"));
      mkdirSync(folder, { recursive: true });
      const original = resumed(folder);
      expect(await claudeTranscriptFile(dir, SESSION, ["/w/project"])).toBe(original);
      writeFileSync(join(folder, `${BG}.jsonl`), "{}");
      writeFileSync(join(folder, "8b80137e-0000-4000-8000-000000000000.jsonl"), "{}");
      expect(await claudeTranscriptFile(dir, SESSION, ["/w/project"])).toBe(original);
    });

    it("ignores an earlier /resume's job id when the active continuation has no job output (regression)", async () => {
      const { home: dir, projects } = home();
      const folder = join(projects, claudeProjectDir("/w/project"));
      mkdirSync(folder, { recursive: true });
      const original = join(folder, `${SESSION}.jsonl`);
      writeFileSync(original, [
        { type: "user", message: { content: "<local-command-stdout>Opening, running in the background (8b80137e)</local-command-stdout>" } },
        { type: "continued-in", sessionId: SESSION, continuedInSessionId: PARKED },
        { type: "continued-in", sessionId: SESSION, continuedInSessionId: PARKED },
      ].map((entry) => JSON.stringify(entry)).join("\n"));
      writeFileSync(join(folder, `${BG}.jsonl`), JSON.stringify({ type: "user", message: { content: "earlier job" } }));
      expect(await claudeTranscriptFile(dir, SESSION, ["/w/project"])).toBe(original);
    });

    it("checks the job's state.json when it names a transcript (regression: fails on main; mismatch is a control)", async () => {
      const { home: dir, projects } = home();
      const folder = join(projects, claudeProjectDir("/w/project"));
      mkdirSync(folder, { recursive: true });
      const original = resumed(folder);
      const job = join(folder, `${BG}.jsonl`);
      writeFileSync(job, "{}");
      const state = join(dir, ".claude", "jobs", "8b80137e");
      mkdirSync(state, { recursive: true });
      writeFileSync(join(state, "state.json"), JSON.stringify({ linkScanPath: join(folder, "other.jsonl") }));
      expect(await claudeTranscriptFile(dir, SESSION, ["/w/project"])).toBe(original);
      writeFileSync(join(state, "state.json"), JSON.stringify({ linkScanPath: job }));
      expect(await claudeTranscriptFile(dir, SESSION, ["/w/project"])).toBe(job);
    });
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("returns an unreadable transcript for its reader to report", async () => {
    const { home: dir, projects } = home();
    const folder = join(projects, claudeProjectDir("/w/project"));
    mkdirSync(folder, { recursive: true });
    const original = join(folder, `${SESSION}.jsonl`);
    writeFileSync(original, JSON.stringify({ type: "user", message: { content: "hi" } }));
    chmodSync(original, 0o000);
    try {
      expect(await claudeTranscriptFile(dir, SESSION, ["/w/project"])).toBe(original);
    } finally {
      chmodSync(original, 0o600);
    }
  });
});

describe("CLAUDE_CONFIG_DIR", () => {
  afterEach(() => forgetClaudeSessions());
  it("reads the last assignment of a ps line, through a path with spaces", () => {
    expect(configDirInPsLine("claude --resume HOME=/h CLAUDE_CONFIG_DIR=/Users/me/.cac/envs/work/.claude PATH=/bin")).toBe("/Users/me/.cac/envs/work/.claude");
    expect(configDirInPsLine("claude CLAUDE_CONFIG_DIR=/a b/.claude")).toBe("/a b/.claude");
    expect(configDirInPsLine("claude HOME=/h")).toBeNull();
  });

  it("finds a transcript in the given store instead of ~/.claude", async () => {
    forgetClaudeSessions();
    const home = mkdtempSync(join(tmpdir(), "herdr-claude-dir-"));
    try {
      const store = join(home, "env", ".claude");
      mkdirSync(join(store, "projects", claudeProjectDir("/work/app")), { recursive: true });
      const path = join(store, "projects", claudeProjectDir("/work/app"), `${SESSION}.jsonl`);
      writeFileSync(path, "{}\n");
      expect(await claudeTranscriptFile(home, SESSION, ["/work/app"])).toBeNull();
      expect(await claudeTranscriptFile(home, SESSION, ["/work/app"], store)).toBe(path);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== "linux" && process.platform !== "darwin")("reads a running process's own store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-claude-env-"));
    // macOS hides system binaries' environments; use a started user process, as Claude is.
    const sleeper = (env: Record<string, string | undefined>) => Bun.spawn(
      [process.execPath, "-e", "console.log('ready'); await Bun.sleep(5000)"], { env, stdout: "pipe" },
    );
    const child = sleeper({ ...process.env, CLAUDE_CONFIG_DIR: dir });
    const bare = sleeper({ PATH: process.env["PATH"] ?? "" });
    try {
      for (const process of [child, bare]) await process.stdout.getReader().read();
      expect(await processClaudeConfigDir(child.pid)).toBe(dir);
      expect(await processClaudeConfigDir(bare.pid)).toBeNull();
    } finally { child.kill(); bare.kill(); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("a Windows Claude's store", () => {
  // Windows lets no one read another process's environment: the store is the one holding the
  // live PID record. These run anywhere, with the process table handed in (windows-native.test.ts
  // checks the real one).
  const PID = 4242;
  const STARTED = 1_791_384_794_216;
  // what Claude writes: FILETIME, 100 ns since 1601, with the part of a millisecond the table drops
  const PROC_START = String((BigInt(STARTED) + 11_644_473_600_000n) * 10_000n + 8714n);
  const CLAUDE_EXE = "C:\\Users\\u\\.local\\bin\\claude.exe";
  const table = async (): Promise<ProcessRow[]> => [{ pid: PID, parent: 1, path: CLAUDE_EXE, commandLine: `"${CLAUDE_EXE}"`, started: STARTED }];
  const roots: string[] = [];
  let serverConfigDir: string | undefined;
  beforeEach(() => { serverConfigDir = process.env["CLAUDE_CONFIG_DIR"]; delete process.env["CLAUDE_CONFIG_DIR"]; });
  afterEach(() => {
    forgetClaudeSessions();
    if (serverConfigDir === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
    else process.env["CLAUDE_CONFIG_DIR"] = serverConfigDir;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function home(): string {
    const root = mkdtempSync(join(tmpdir(), "herdr-claude-win-"));
    roots.push(root);
    const home = join(root, "User With Spaces");
    mkdirSync(home);
    return home;
  }
  function record(store: string, patch: Record<string, unknown> = {}): void {
    mkdirSync(join(store, "sessions"), { recursive: true });
    writeFileSync(join(store, "sessions", `${PID}.json`), JSON.stringify({
      pid: PID, sessionId: SESSION, procStart: PROC_START, kind: "interactive", ...patch,
    }));
  }
  function transcript(store: string, cwd: string): string {
    const folder = join(store, "projects", claudeProjectDir(cwd));
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `${SESSION}.jsonl`), "{}\n");
    return join(folder, `${SESSION}.jsonl`);
  }
  const storeOf = (dir: string, rows = table) => processClaudeConfigDir(PID, [CLAUDE_EXE], dir, "win32", rows);

  it("knows Claude in herdr's Windows process info, and only Claude", () => {
    expect(isClaudeProcess({ name: "claude.exe", argv0: CLAUDE_EXE, argv: [CLAUDE_EXE] })).toBe(true);
    expect(isClaudeProcess({ name: "claude" })).toBe(true);
    expect(isClaudeProcess({ name: "node", argv0: "claude" })).toBe(true);
    expect(isClaudeProcess({ name: "node", argv: ["/usr/local/bin/claude", "--resume"] })).toBe(true);
    expect(isClaudeProcess({ name: "claude-helper.exe", argv0: "C:\\tools\\claude-helper.exe" })).toBe(false);
    expect(isClaudeProcess({ name: "notclaude.exe", argv: ["C:\\tools\\notclaude.exe"] })).toBe(false);
    expect(isClaudeProcess({ name: "node", argv: ["/usr/bin/node", "claude"] })).toBe(false);
    // Windows names files without case; POSIX keeps it
    expect(isClaudeProcess({ name: "Claude.EXE", argv0: "C:\\Tools\\Claude.EXE" })).toBe(true);
    expect(isClaudeProcess({ name: "node", argv: ["C:\\Tools\\CLAUDE"] })).toBe(true);
    expect(isClaudeProcess({ name: "Claude", argv: ["/usr/local/bin/Claude"] })).toBe(false);
  });

  it("finds a store whose name differs from ~/.claude-* only in case", async () => {
    const dir = home();
    record(join(dir, ".Claude-Work"));
    expect(await storeOf(dir)).toBe(join(dir, ".Claude-Work"));
  });

  it("keeps the default store for a Claude that writes there", async () => {
    const dir = home();
    record(join(dir, ".claude"));
    mkdirSync(join(dir, ".claude-second", "sessions"), { recursive: true });
    expect(await storeOf(dir)).toBe(join(dir, ".claude"));
    expect(await claudeProcessSession(dir, PID, join(dir, ".claude"), "win32", table)).toBe(SESSION);
  });

  it("finds a ~/.claude-* store by its live PID record, and the transcript in it before ~/.claude's", async () => {
    const dir = home();
    const second = join(dir, ".claude-second");
    const cwd = "D:\\work\\my app";
    // the same session id under the same project in both stores: only the PID record tells them apart
    transcript(join(dir, ".claude"), cwd);
    const own = transcript(second, cwd);
    record(second);
    const store = await storeOf(dir);
    expect(store).toBe(second);
    expect(await claudeProcessSession(dir, PID, store!, "win32", table)).toBe(SESSION);
    expect(await claudeTranscriptFile(dir, SESSION, [cwd], store!)).toBe(own);
  });

  it("prefers the live record over a stale one of the same PID in another store", async () => {
    const dir = home();
    record(join(dir, ".claude"), { procStart: String(BigInt(PROC_START) - 10_000_000n) });
    record(join(dir, ".claude-work"));
    expect(await storeOf(dir)).toBe(join(dir, ".claude-work"));
  });

  for (const [name, patch] of [
    ["another PID", { pid: PID + 4 }],
    ["a reused PID", { procStart: String(BigInt(PROC_START) + 10_000n) }],
    ["a start in another platform's form", { procStart: "Wed Oct  7 14:53:14 2026" }],
    ["an older record without a start", { procStart: null }],
    ["a noninteractive SDK session", { kind: "sdk" }],
    ["a path in place of a UUID", { sessionId: "..\\..\\other" }],
  ] satisfies [string, Record<string, unknown>][]) {
    it(`ignores a record with ${name}`, async () => {
      const dir = home();
      record(join(dir, ".claude-second"), patch);
      expect(await storeOf(dir)).toBeNull();
      expect(await claudeProcessSession(dir, PID, join(dir, ".claude-second"), "win32", table)).toBeNull();
    });
  }

  it("ignores a torn or oversized record, and a process the table cannot show", async () => {
    const dir = home();
    const path = join(dir, ".claude-second", "sessions", `${PID}.json`);
    record(join(dir, ".claude-second"));
    writeFileSync(path, "{");
    expect(await storeOf(dir)).toBeNull();
    writeFileSync(path, JSON.stringify({ padding: "x".repeat(16 * 1024) }));
    expect(await storeOf(dir)).toBeNull();
    record(join(dir, ".claude-second"));
    expect(await storeOf(dir, async () => [])).toBeNull();
  });

  it("is not misled by ~/.claude-* names that hold no store", async () => {
    const dir = home();
    writeFileSync(join(dir, ".claude-notes"), "a file, not a store");
    mkdirSync(join(dir, ".claude-empty"));
    mkdirSync(join(dir, ".claude-old", "sessions"), { recursive: true });
    expect(await storeOf(dir)).toBeNull();
    expect(await processClaudeConfigDir(PID, [CLAUDE_EXE], join(dir, "missing"), "win32", table)).toBeNull();
    record(join(dir, ".claude-second"));
    expect(await storeOf(dir)).toBe(join(dir, ".claude-second"));
  });

  it("refuses to pick a store when two stores both claim the process, rather than fall back to ~/.claude (#586)", async () => {
    const dir = home();
    record(join(dir, ".claude"));
    record(join(dir, ".claude-copy"));
    await expect(storeOf(dir)).rejects.toBeInstanceOf(AmbiguousClaudeStore);
    // and asks again: the copy may be removed
    rmSync(join(dir, ".claude-copy"), { recursive: true });
    expect(await storeOf(dir)).toBe(join(dir, ".claude"));
  });

  it("counts one store reached by two names once, rather than as two that claim the process (#586)", async () => {
    const dir = home();
    record(join(dir, ".claude"));
    // CLAUDE_CONFIG_DIR naming ~/.claude another way (on Windows its \\?\ spelling, or a junction to it)
    symlinkSync(join(dir, ".claude"), join(dir, "claude-link"));
    const before = process.env["CLAUDE_CONFIG_DIR"];
    process.env["CLAUDE_CONFIG_DIR"] = join(dir, "claude-link");
    try {
      expect(await storeOf(dir)).toBe(join(dir, "claude-link"));
    } finally {
      if (before === undefined) delete process.env["CLAUDE_CONFIG_DIR"]; else process.env["CLAUDE_CONFIG_DIR"] = before;
    }
  });

  it("knows a store without a file id by its spelling without the \\\\?\\ prefix or the drive letter's case (#586)", () => {
    const store = "C:\\Users\\u\\.claude";
    for (const id of [null, { dev: 7n, ino: 0n }]) {
      expect(claudeStoreKey(`\\\\?\\${store}`, id, win32)).toBe(claudeStoreKey(store, id, win32));
      expect(claudeStoreKey("\\\\?\\c:\\Users\\u\\.claude", id, win32)).toBe(claudeStoreKey(store, id, win32));
      // past the drive letter a case-sensitive directory may be another store: both are asked
      expect(claudeStoreKey("C:\\Users\\u\\.Claude", id, win32)).not.toBe(claudeStoreKey(store, id, win32));
      expect(claudeStoreKey("C:\\Users\\u\\.claude-Work", id, win32)).not.toBe(claudeStoreKey("C:\\Users\\u\\.claude-work", id, win32));
      expect(claudeStoreKey("\\\\?\\UNC\\host\\share\\.claude", id, win32)).toBe(claudeStoreKey("\\\\host\\share\\.claude", id, win32));
      expect(claudeStoreKey(`${store}-work`, id, win32)).not.toBe(claudeStoreKey(store, id, win32));
    }
    expect(claudeStoreKey("C:\\a", { dev: 7n, ino: 42n }, win32)).toBe(claudeStoreKey("\\\\?\\D:\\b", { dev: 7n, ino: 42n }, win32));
  });

  it("looks again after a miss, since Claude writes its record as it starts", async () => {
    const dir = home();
    expect(await storeOf(dir)).toBeNull();
    record(join(dir, ".claude-second"));
    expect(await storeOf(dir)).toBe(join(dir, ".claude-second"));
  });
});

describe("claudeSessionTempDir", () => {
  const session = "6b93e6b7-7279-449a-b4ab-66e91f7a21d9";
  const transcript = `/home/u/.claude/projects/-home-u-project/${session}.jsonl`;
  const uid = process.getuid?.();
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "claude-temp-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it.skipIf(uid === undefined)("finds the session's folder under the transcript's project", async () => {
    const dir = join(root, `claude-${uid}`, "-home-u-project", session);
    mkdirSync(join(dir, "scratchpad"), { recursive: true });
    expect(await claudeSessionTempDir(transcript, [join(root, "missing"), root], uid)).toBe(dir);
  });

  it.skipIf(uid === undefined)("is null without the folder, for another user's base, or for a name that is not a session", async () => {
    expect(await claudeSessionTempDir(transcript, [root], uid)).toBeNull();
    mkdirSync(join(root, `claude-${uid! + 1}`, "-home-u-project", session), { recursive: true });
    // the base exists but under another uid's name; and a base this user owns is not that uid's
    expect(await claudeSessionTempDir(transcript, [root], uid! + 1)).toBeNull();
    expect(await claudeSessionTempDir("/home/u/.claude/projects/-home-u-project/notes.jsonl", [root], uid)).toBeNull();
    expect(await claudeSessionTempDir(transcript, [root], undefined)).toBeNull();
  });
});
