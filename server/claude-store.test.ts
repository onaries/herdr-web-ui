import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeProcessSession, claudeProjectDir, claudeTranscriptFile, configDirInPsLine, forgetClaudeSessions, isClaudeProcess, processClaudeConfigDir } from "./claude-store.ts";
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

  it("answers no store when two stores both claim the process", async () => {
    const dir = home();
    record(join(dir, ".claude"));
    record(join(dir, ".claude-copy"));
    expect(await storeOf(dir)).toBeNull();
  });

  it("looks again after a miss, since Claude writes its record as it starts", async () => {
    const dir = home();
    expect(await storeOf(dir)).toBeNull();
    record(join(dir, ".claude-second"));
    expect(await storeOf(dir)).toBe(join(dir, ".claude-second"));
  });
});
