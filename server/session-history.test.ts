import { afterAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, opendirSync, readdirSync, type BigIntStats, type Dir, type Dirent, type Stats, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import type { SessionHistoryAgent, SessionSnapshot } from "../shared/protocol.ts";
import { HEAD_BYTES, listSessions, MAX_ENTRIES, MAX_ROWS, MAX_STATS, MAX_WALK, SESSION_HISTORY_AGENTS } from "./session-history.ts";
import { handleSessionHistoryRequest, workspaceFolder } from "./session-history-routes.ts";
import { claudeProjectDir } from "./claude-store.ts";
import { codexRolloutPath } from "./codex.ts";
import rolloutHeaders from "./fixtures/codex-rollout-headers.json";

/** A stat as the listing asks for it: with `bigint`, the identity an NTFS file ID above 2^53 keeps exactly. */
const statAs = (path: string, bigint?: boolean): Stats | BigIntStats => bigint ? statSync(path, { bigint: true }) : statSync(path);
const FIXTURES = join(import.meta.dir, "fixtures", "session-history");
const WINDOWS = process.platform === "win32";
const CWD = WINDOWS ? "C:\\work\\project" : "/work/project";
const ID = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
/** The folder each agent names after CWD, as the agent itself spells it. */
const FOLDERS: Partial<Record<SessionHistoryAgent, string>> = WINDOWS
  ? { claude: "C--work-project", pi: "--C--work-project--", omo: "--C--work-project--", omp: "--C--work-project--", gjc: "--C--work-project--", grok: "C%3A%5Cwork%5Cproject" }
  : { claude: "-work-project", pi: "--work-project--", omo: "--work-project--", omp: "--work-project--", gjc: "--work-project--", cmd: "work-project", grok: "%2Fwork%2Fproject" };
const EXPECTED: Record<SessionHistoryAgent, [string, string]> = {
  claude: [ID(2), ID(1)], codex: [ID(2), ID(1)], pi: [ID(2), ID(1)], omp: [ID(2), ID(1)], gjc: [ID(2), ID(1)], cmd: [ID(2), ID(1)],
  omo: [ID(2), ID(1)], grok: [ID(2), ID(1)], agy: [ID(2), ID(1)],
  opencode: ["ses_fixture0002", "ses_fixture0001"],
  hermes: ["20261002_090000_fx0002", "20261001_090000_fx0001"],
  devin: ["fixture-0002", "fixture-0001"],
};

const root = mkdtempSync(join(tmpdir(), "ovis-session-history-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let homes = 0;
const newHome = () => { const home = join(root, `home-${++homes}`); mkdirSync(home); return home; };

const sql = (value: string) => `'${value.replaceAll("'", "''")}'`;
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)]);
}

function install(agent: SessionHistoryAgent, home: string): void {
  const source = join(FIXTURES, agent);
  for (const file of filesUnder(source)) {
    const rel = relative(source, file).split(/[/\\]/).map((part, at) => part === "@folder" ? FOLDERS[agent]! : at === 0 && part.startsWith("dot-") ? `.${part.slice(4)}` : part);
    const target = join(home, ...rel);
    mkdirSync(dirname(target), { recursive: true });
    const text = readFileSync(file, "utf8").replaceAll('"{{CWD}}"', JSON.stringify(CWD));
    if (target.endsWith(".sql")) {
      const db = new Database(target.replace(/\.sql$/, ".db"), { create: true });
      // one transaction: a statement each would sync the disk each time, seconds on a loaded machine
      db.transaction(() => db.exec(text.replaceAll(":cwd", sql(CWD)).replaceAll(":uris", sql(JSON.stringify([pathToFileURL(CWD).href])))))();
      db.close();
      continue;
    }
    writeFileSync(target, text);
    const seconds = Date.parse("2026-10-01T00:00:00Z") / 1000 + (/0002|0004/.test(target) ? 2000 : 1000);
    utimesSync(target, seconds, seconds);
  }
}

/** Whether this machine lets a test make symlinks (Windows needs Developer Mode or elevation). */
function canSymlink(): boolean {
  const probe = join(root, "probe-link");
  try { symlinkSync(root, probe, "dir"); rmSync(probe); return true; }
  catch (error) { if (WINDOWS && (error as NodeJS.ErrnoException).code === "EPERM") return false; throw error; }
}
const SYMLINKS = canSymlink();

const piHeader = (id: string, cwd = CWD, padding = "") => `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-01T09:00:00.000Z", cwd, ...(padding ? { padding } : {}) })}\n`;
const piPrompt = (text: string) => `${JSON.stringify({ type: "message", message: { role: "user", content: text } })}\n`;
const piStore = (home: string) => join(home, ".pi", "agent", "sessions", FOLDERS.pi!);

describe("listSessions", () => {
  for (const agent of SESSION_HISTORY_AGENTS) {
    // Command Code's slug keeps a Windows drive's colon, which no Windows folder name may hold
    it.skipIf(agent === "cmd" && WINDOWS)(`lists ${agent}'s own sessions of the folder, newest first, with its resume command`, () => {
      const home = newHome();
      install(agent, home);
      const rows = listSessions(agent, CWD, { home, env: {} });
      expect(rows.map((row) => row.id)).toEqual(EXPECTED[agent]);
      expect(rows.map((row) => row.firstMessage)).toEqual([`Fixture ${agent} prompt 2`, `Fixture ${agent} prompt 1`]);
      for (const row of rows) {
        expect(row.resume?.argv[0]).toBe(agent);
        expect(row.resume?.argv.at(-1)).toBe(row.id);
        expect(row.startedAt).not.toBeNull();
        expect(Number.isNaN(Date.parse(row.updatedAt))).toBe(false);
      }
      expect(Date.parse(rows[0]!.updatedAt)).toBeGreaterThan(Date.parse(rows[1]!.updatedAt));
    });
  }

  it("lists nothing from a store that is not there", () => {
    const home = newHome();
    for (const agent of SESSION_HISTORY_AGENTS) expect(listSessions(agent, CWD, { home, env: {} })).toEqual([]);
  });

  it.skipIf(!SYMLINKS)("refuses a session file or folder that a link puts outside the store", () => {
    const home = newHome();
    install("pi", home);
    const outside = join(root, `outside-${homes}`);
    mkdirSync(outside);
    writeFileSync(join(outside, "escaped.jsonl"), piHeader(ID(9)) + piPrompt("outside the store"));
    symlinkSync(join(outside, "escaped.jsonl"), join(piStore(home), "escaped.jsonl"));
    install("codex", home);
    mkdirSync(join(outside, "day"));
    writeFileSync(join(outside, "day", `rollout-2026-10-09T09-00-00-${ID(9)}.jsonl`),
      `${JSON.stringify({ type: "session_meta", payload: { id: ID(9), cwd: CWD, source: "cli" } })}\n`);
    symlinkSync(join(outside, "day"), join(home, ".codex", "sessions", "2026", "10", "09"), "dir");
    expect(listSessions("pi", CWD, { home, env: {} }).map((row) => row.id)).toEqual(EXPECTED.pi);
    expect(listSessions("codex", CWD, { home, env: {} }).map((row) => row.id)).toEqual(EXPECTED.codex);
  });

  it(`returns at most ${MAX_ROWS} sessions, the newest`, () => {
    const home = newHome();
    mkdirSync(piStore(home), { recursive: true });
    for (let n = 0; n < MAX_ROWS + 10; n++) {
      const path = join(piStore(home), `session-${String(n).padStart(3, "0")}.jsonl`);
      writeFileSync(path, piHeader(`session-${n}`) + piPrompt(`prompt ${n}`));
      utimesSync(path, 1_790_000_000 + n, 1_790_000_000 + n);
    }
    const rows = listSessions("pi", CWD, { home, env: {} });
    expect(rows).toHaveLength(MAX_ROWS);
    expect(rows[0]!.id).toBe(`session-${MAX_ROWS + 9}`);
    expect(rows.at(-1)!.id).toBe("session-10");
  });

  it("reads only the head of a 10 MB session file", () => {
    const home = newHome();
    mkdirSync(piStore(home), { recursive: true });
    const path = join(piStore(home), "large.jsonl");
    writeFileSync(path, piHeader(ID(5)) + piPrompt("large prompt") + `${JSON.stringify({ type: "message", message: { role: "assistant", content: "x".repeat(10 * 1024 * 1024) } })}\n`);
    expect(statSync(path).size).toBeGreaterThan(10 * 1024 * 1024);
    let bytes = 0;
    const rows = listSessions("pi", CWD, {
      home, env: {},
      readHead: (fd, max) => {
        const buffer = Buffer.alloc(max);
        const read = readSync(fd, buffer, 0, max, 0);
        bytes += read;
        return buffer.subarray(0, read);
      },
    });
    expect(rows.map((row) => [row.id, row.firstMessage])).toEqual([[ID(5), "large prompt"]]);
    expect(bytes).toBe(HEAD_BYTES);
  });

  /** A Codex store holding the shared fixture table's rollouts; returns the day folder and how many bytes each listing reads. */
  const codexTable = (home: string) => {
    const day = join(home, ".codex", "sessions", "2026", "10", "20");
    mkdirSync(day, { recursive: true });
    rolloutHeaders.cases.forEach((fixture, at) => {
      const path = join(day, fixture.file);
      writeFileSync(path, `${JSON.stringify({ type: "session_meta", payload: fixture.payload }).replaceAll('"{{CWD}}"', JSON.stringify(CWD))}\n`
        + `${JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: fixture.name } })}\n`);
      utimesSync(path, 1_790_000_000 + at, 1_790_000_000 + at);
    });
    return day;
  };
  const countingReads = () => {
    const reads = { files: 0, bytes: 0 };
    const readHead = (fd: number, max: number) => {
      const buffer = Buffer.alloc(max);
      const read = readSync(fd, buffer, 0, max, 0);
      reads.files++; reads.bytes += read;
      return buffer.subarray(0, read);
    };
    return { reads, readHead };
  };

  it("live and history share interactive rollout eligibility", () => {
    const home = newHome();
    const day = codexTable(home);
    const { reads, readHead } = countingReads();
    const rows = listSessions("codex", CWD, { home, env: {}, readHead });
    const eligible = rolloutHeaders.cases.filter((fixture) => fixture.interactive);
    // newest first, each with the prompt and the resume command of its own verified id
    expect(rows.map((row) => [row.id, row.firstMessage, row.resume?.argv])).toEqual([...eligible].reverse()
      .map((fixture) => [String(fixture.payload.id), fixture.name, ["codex", "resume", String(fixture.payload.id)]]));
    // the same files, and only they, are the live reader's
    for (const fixture of rolloutHeaders.cases) {
      expect([fixture.name, codexRolloutPath(join(day, fixture.file), join(home, ".codex")) !== null]).toEqual([fixture.name, fixture.interactive]);
    }
    // refusing a child or a contradiction reads nothing past each file's one head read
    expect(reads.files).toBe(rolloutHeaders.cases.length);
  });

  it("legacy omitted identities remain interactive", () => {
    const home = newHome();
    const day = join(home, ".codex", "sessions", "2026", "10", "20");
    mkdirSync(day, { recursive: true });
    const thread = "01a0d000-0000-7000-8000-0000000000dd";
    const legacy = { id: thread, timestamp: "2026-10-20T09:00:00.000Z", cwd: CWD, originator: "codex_cli_rs", cli_version: "0.0.0-fixture" };
    const path = join(day, `rollout-2026-10-20T09-00-00-${thread}.jsonl`);
    writeFileSync(path, `${JSON.stringify({ type: "session_meta", payload: legacy })}\n`);
    expect(listSessions("codex", CWD, { home, env: {} }).map((row) => [row.id, row.resume?.argv])).toEqual([[thread, ["codex", "resume", thread]]]);
    expect(codexRolloutPath(path, join(home, ".codex"))).toBe(path);
    // no id at all: nothing contradicts the file, and the live reader still takes it; the
    // history has no id to resume it by
    writeFileSync(path, `${JSON.stringify({ type: "session_meta", payload: { ...legacy, id: undefined } })}\n`);
    expect(codexRolloutPath(path, join(home, ".codex"))).toBe(path);
    expect(listSessions("codex", CWD, { home, env: {} })).toEqual([]);
  });

  it("refuses an explicit null identity in live and history alike", () => {
    const home = newHome();
    const day = join(home, ".codex", "sessions", "2026", "10", "20");
    mkdirSync(day, { recursive: true });
    const thread = "01a0d000-0000-7000-8000-0000000000dd";
    const path = join(day, `rollout-2026-10-20T09-00-00-${thread}.jsonl`);
    const base = { id: thread, session_id: thread, cwd: CWD, source: "cli", thread_source: "user" };
    const eligible = (payload: unknown) => {
      writeFileSync(path, `${JSON.stringify({ type: "session_meta", payload })}\n`);
      return [codexRolloutPath(path, join(home, ".codex")) !== null, listSessions("codex", CWD, { home, env: {} }).map((row) => row.resume?.argv)];
    };
    expect(eligible(base)).toEqual([true, [["codex", "resume", thread]]]);
    // a null id or session_id is present and not a thread: neither path takes it
    expect(eligible({ ...base, session_id: null })).toEqual([false, []]);
    expect(eligible({ ...base, id: null })).toEqual([false, []]);
  });

  it("lists a genuine fork apart from any child, as a thread of its own", () => {
    const home = newHome();
    const day = join(home, ".codex", "sessions", "2026", "10", "20");
    mkdirSync(day, { recursive: true });
    const fork = "01a0d000-0000-7000-8000-0000000000ee";
    writeFileSync(join(day, `rollout-2026-10-20T09-00-00-${fork}.jsonl`), `${JSON.stringify({ type: "session_meta", payload: {
      id: fork, session_id: fork, forked_from_id: rolloutHeaders.parent, cwd: CWD, source: "cli", thread_source: "user",
      history_base: { thread_id: rolloutHeaders.parent, end_ordinal_exclusive: 3, end_byte_offset: 400 } } })}\n`);
    expect(listSessions("codex", CWD, { home, env: {} }).map((row) => row.id)).toEqual([fork]);
  });

  it("a cut header cannot hide a child marker", () => {
    const home = newHome();
    const day = join(home, ".codex", "sessions", "2026", "10", "01");
    mkdirSync(day, { recursive: true });
    const path = join(day, `rollout-2026-10-01T09-00-00-${ID(1)}.jsonl`);
    const prompt = `${JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "cut prompt" } })}\n`;
    /** A header line of exactly `length` bytes, the marker (when asked) at its end. */
    const header = (length: number, marker: boolean) => {
      const line = (padding: string) => JSON.stringify({ type: "session_meta", payload: {
        id: ID(1), timestamp: "2026-10-01T09:00:00.000Z", cwd: CWD, source: "cli", base_instructions: { text: padding }, ...(marker ? { thread_source: "subagent" } : {}) } });
      const text = line("i".repeat(length - Buffer.byteLength(line(""))));
      expect(Buffer.byteLength(text)).toBe(length);
      return text;
    };
    const listed = (body: string) => {
      writeFileSync(path, body);
      const { reads, readHead } = countingReads();
      const ids = listSessions("codex", CWD, { home, env: {}, readHead }).map((row) => row.id);
      // never more than the one head read
      expect(reads).toEqual({ files: 1, bytes: Math.min(HEAD_BYTES, Buffer.byteLength(body)) });
      return ids;
    };
    // the marker past the read: the header is not listed, and neither is one without it
    expect(listed(`${header(2 * HEAD_BYTES, true)}\n${prompt}`)).toEqual([]);
    expect(listed(`${header(2 * HEAD_BYTES, false)}\n${prompt}`)).toEqual([]);
    // byte boundaries: a header whose newline is the read's last byte is whole and checked
    expect(listed(`${header(HEAD_BYTES - 1, false)}\n${prompt}`)).toEqual([ID(1)]);
    expect(listed(`${header(HEAD_BYTES - 1, true)}\n${prompt}`)).toEqual([]);
    // one byte longer fills the read without its newline: not listed
    expect(listed(`${header(HEAD_BYTES, false)}\n${prompt}`)).toEqual([]);
    // a file that is only its header, without a newline, ends within the read
    expect(listed(header(HEAD_BYTES - 1, false))).toEqual([ID(1)]);
    // a malformed first line, or a first record that is not session_meta, is no rollout
    expect(listed(`{"type":"session_meta","payload":\n${prompt}`)).toEqual([]);
    expect(listed(`${JSON.stringify({ type: "event_msg", payload: { id: ID(1), cwd: CWD, source: "cli" } })}\n${prompt}`)).toEqual([]);
  });

  it.skipIf(!SYMLINKS)("refuses a SQLite store that a link puts outside the store", () => {
    for (const [agent, dir, db] of [["hermes", [".hermes"], "state.db"], ["opencode", [".local", "share", "opencode"], "opencode.db"]] as const) {
      const home = newHome();
      install(agent, home);
      const outside = join(root, `outside-db-${homes}`);
      mkdirSync(outside);
      renameSync(join(home, ...dir, db), join(outside, db));
      symlinkSync(join(outside, db), join(home, ...dir, db));
      expect(listSessions(agent, CWD, { home, env: {} })).toEqual([]);
    }
  });

  it(`looks at no more than ${MAX_STATS} paths for one listing`, () => {
    const home = newHome();
    const group = join(home, ".grok", "sessions", FOLDERS.grok!);
    for (let n = 0; n < MAX_STATS + 50; n++) {
      const dir = join(group, `session-${n}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "summary.json"), JSON.stringify({ info: { id: `session-${n}`, cwd: CWD }, updated_at: "2026-10-01T09:00:00Z" }));
    }
    let stats = 0;
    const rows = listSessions("grok", CWD, { home, env: {}, stat: (path, bigint) => { stats++; return statAs(path, bigint); } });
    expect(stats).toBeGreaterThan(MAX_ROWS);
    expect(stats).toBeLessThanOrEqual(MAX_STATS);
    expect(rows).toHaveLength(MAX_ROWS);
  });

  it.skipIf(!SYMLINKS)(`counts every path resolution against the ${MAX_STATS} checks, whether it resolves, fails or lands outside`, () => {
    const home = newHome();
    mkdirSync(piStore(home), { recursive: true });
    const outside = join(root, `outside-links-${homes}`);
    mkdirSync(outside);
    writeFileSync(join(outside, "elsewhere.jsonl"), piHeader(ID(9)) + piPrompt("outside the store"));
    for (let n = 0; n < 2000; n++) symlinkSync(join(outside, `gone-${n}.jsonl`), join(piStore(home), `dangling-${String(n).padStart(4, "0")}.jsonl`));
    for (let n = 0; n < 100; n++) symlinkSync(join(outside, "elsewhere.jsonl"), join(piStore(home), `outside-${n}.jsonl`));
    let resolutions = 0;
    let stats = 0;
    const rows = listSessions("pi", CWD, {
      home, env: {},
      resolve: (path) => { resolutions++; return realpathSync(path); },
      stat: (path, bigint) => { stats++; return statAs(path, bigint); },
    });
    expect(rows).toEqual([]);
    expect(resolutions).toBeGreaterThan(MAX_ROWS);
    expect(resolutions + stats).toBeLessThanOrEqual(MAX_STATS);
  });

  it.skipIf(!SYMLINKS)("reads nothing from a session file swapped for a link out of the store after it was checked", () => {
    const home = newHome();
    mkdirSync(piStore(home), { recursive: true });
    const outside = join(root, `outside-swap-${homes}`);
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.jsonl"), piHeader(ID(9)) + piPrompt("outside the store"));
    const session = join(piStore(home), "session.jsonl");
    writeFileSync(session, piHeader(ID(1)) + piPrompt("inside the store"));
    const checked = realpathSync(session);
    const rows = listSessions("pi", CWD, {
      home, env: {},
      // the file is checked, then swapped for a link out of the store before it is opened
      stat: (path, bigint) => {
        const stat = statAs(path, bigint);
        if (path === checked) { rmSync(path); symlinkSync(join(outside, "secret.jsonl"), path); }
        return stat;
      },
    });
    expect(rows.map((row) => row.firstMessage)).not.toContain("outside the store");
    expect(rows).toEqual([]);
  });

  // a session file is one check (its resolution with its stat). On Windows a session of another
  // folder also spends two on its folder's file IDs, so this many of them would use the budget there
  it.skipIf(WINDOWS)("lists a folder's older Codex rollouts behind about 300 newer rollouts of other folders", () => {
    const home = newHome();
    const rollout = (day: string, n: number, at: number, cwd: string) => {
      const dir = join(home, ".codex", "sessions", "2026", "10", day);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `rollout-2026-10-${day}T09-00-00-${n.toString(16).padStart(12, "0")}.jsonl`);
      writeFileSync(path, `${JSON.stringify({ type: "session_meta", payload: { id: `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`, cwd, source: "cli" } })}\n`);
      utimesSync(path, at, at);
    };
    for (let n = 0; n < 300; n++) rollout(String(20 + (n % 3)), 0x1000 + n, 1_790_100_000 + n, "/elsewhere");
    rollout("01", 1, 1_790_000_000, CWD);
    rollout("01", 2, 1_790_000_001, CWD);
    let resolutions = 0;
    const rows = listSessions("codex", CWD, { home, env: {}, resolve: (path) => { resolutions++; return realpathSync(path); } });
    expect(rows.map((row) => row.id)).toEqual([ID(2), ID(1)]);
    expect(resolutions).toBeLessThanOrEqual(MAX_STATS);
  });

  it.skipIf(!SYMLINKS)("reads nothing from a SQLite store swapped for a link to another database after it was checked", () => {
    const home = newHome();
    install("hermes", home);
    const elsewhere = newHome();
    install("hermes", elsewhere);
    const outside = new Database(join(elsewhere, ".hermes", "state.db"));
    outside.exec("UPDATE messages SET content = 'outside the store' WHERE role = 'user'");
    outside.close();
    const checked = realpathSync(join(home, ".hermes", "state.db"));
    let swapped = false;
    const rows = listSessions("hermes", CWD, {
      home, env: {},
      // the database is checked, then swapped for a link to another one before it is opened
      stat: (path, bigint) => {
        const stat = statAs(path, bigint);
        if (path === checked && !swapped) { swapped = true; rmSync(path); symlinkSync(join(elsewhere, ".hermes", "state.db"), path); }
        return stat;
      },
    });
    expect(swapped).toBe(true);
    expect(rows.map((row) => row.firstMessage)).not.toContain("outside the store");
    expect(rows).toEqual([]);
  });

  it.skipIf(!SYMLINKS)("gives a reader only the checked file, so no reader can read a file swapped in after the check", () => {
    const home = newHome();
    mkdirSync(piStore(home), { recursive: true });
    const outside = join(root, `outside-reader-${homes}`);
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.jsonl"), piHeader(ID(9)) + piPrompt("outside the store"));
    const session = join(piStore(home), "session.jsonl");
    writeFileSync(session, piHeader(ID(1)) + piPrompt("inside the store"));
    const checked = realpathSync(session);
    const rows = listSessions("pi", CWD, {
      home, env: {},
      stat: (path, bigint) => {
        const stat = statAs(path, bigint);
        if (path === checked) { rmSync(path); symlinkSync(join(outside, "secret.jsonl"), path); }
        return stat;
      },
      // a reader that does no check of its own: given a path it would follow the link
      readHead: ((target: number | string, max: number) => typeof target === "number"
        ? (() => { const buffer = Buffer.alloc(max); return buffer.subarray(0, readSync(target, buffer, 0, max, 0)); })()
        : readFileSync(target).subarray(0, max)) as never,
    });
    expect(rows.map((row) => row.firstMessage)).not.toContain("outside the store");
    expect(rows).toEqual([]);
  });

  // NTFS file IDs often pass 2^53: two that differ only in their low bits round to one number
  const NEAR = 2n ** 60n;
  const withIno = <T extends Stats | BigIntStats>(stat: T, ino: bigint): T =>
    Object.assign(Object.create(Object.getPrototypeOf(stat) as object) as T, stat, { ino: typeof stat.ino === "bigint" ? ino : Number(ino) });

  it("refuses a session file whose opened identity differs from the checked one only past 2^53", () => {
    const home = newHome();
    mkdirSync(piStore(home), { recursive: true });
    const session = join(piStore(home), "session.jsonl");
    writeFileSync(session, piHeader(ID(1)) + piPrompt("inside the store"));
    const checked = realpathSync(session);
    const listed = (opened: bigint) => listSessions("pi", CWD, {
      home, env: {},
      stat: (path, bigint) => path === checked ? withIno(statAs(path, bigint), NEAR + 1n) : statAs(path, bigint),
      fstat: (fd, bigint) => withIno(bigint ? fstatSync(fd, { bigint: true }) : fstatSync(fd), opened),
    }).map((row) => row.id);
    expect(listed(NEAR + 1n)).toEqual([ID(1)]);
    expect(listed(NEAR + 2n)).toEqual([]);
  });

  it("refuses a SQLite store whose opened descriptor differs from the checked one only past 2^53", () => {
    const home = newHome();
    install("hermes", home);
    const checked = realpathSync(join(home, ".hermes", "state.db"));
    const listed = (opened: bigint) => listSessions("hermes", CWD, {
      home, env: {},
      stat: (path, bigint) => path === checked ? withIno(statAs(path, bigint), NEAR + 1n) : statAs(path, bigint),
      fstat: (fd, bigint) => withIno(bigint ? fstatSync(fd, { bigint: true }) : fstatSync(fd), opened),
    }).length;
    expect(listed(NEAR + 1n)).toBe(2);
    expect(listed(NEAR + 2n)).toBe(0);
  });

  it("reads nothing from a SQLite store swapped for another database and swapped back between its two checks", () => {
    const home = newHome();
    install("hermes", home);
    const elsewhere = newHome();
    install("hermes", elsewhere);
    const outside = new Database(join(elsewhere, ".hermes", "state.db"));
    outside.exec("UPDATE messages SET content = 'outside the store' WHERE role = 'user'");
    outside.close();
    const checked = realpathSync(join(home, ".hermes", "state.db"));
    const kept = `${checked}.kept`;
    let seen = 0;
    const rows = listSessions("hermes", CWD, {
      home, env: {},
      stat: (path, bigint) => {
        if (path !== checked) return statAs(path, bigint);
        // at its check the database is swapped for another one (a file, which no link check sees), and
        // swapped back before the next look, so both looks see the checked file
        if (seen++ === 0) {
          const stat = statAs(path, bigint);
          renameSync(checked, kept); copyFileSync(join(elsewhere, ".hermes", "state.db"), checked);
          return stat;
        }
        if (seen === 2) { rmSync(checked); renameSync(kept, checked); }
        return statAs(path, bigint);
      },
    });
    expect(rows.map((row) => row.firstMessage)).not.toContain("outside the store");
    expect(rows).toEqual([]);
  });

  const sideFiles = (dir: string) => readdirSync(dir).filter((name) => /-(wal|shm)$/.test(name)).sort();

  it("writes no -wal or -shm into a WAL store it reads", () => {
    const home = newHome();
    install("hermes", home);
    const db = join(home, ".hermes", "state.db");
    const writer = new Database(db);
    writer.exec("PRAGMA journal_mode = WAL");
    writer.close();
    const before = sideFiles(dirname(db));
    let reads = 0;
    expect(listSessions("hermes", CWD, { home, env: {}, opened: () => { reads++; } }).map((row) => row.id)).toEqual(EXPECTED.hermes);
    expect(sideFiles(dirname(db))).toEqual(before);
    // nobody wrote meanwhile: the immutable read stands, and the store is read once
    expect(reads).toBe(1);
  });

  it("reads a WAL store once more, as it is being written, when a writer checkpoints into it during an immutable read", () => {
    const home = newHome();
    install("hermes", home);
    const db = join(home, ".hermes", "state.db");
    const setup = new Database(db);
    setup.exec("PRAGMA journal_mode = WAL");
    setup.close();
    let writer: Database | undefined;
    let reads = 0;
    try {
      const rows = listSessions("hermes", CWD, {
        home, env: {},
        // between the immutable open and the query, another connection writes and checkpoints into the
        // main file (an agent opening its store, writing, checkpointing); it stays open, as a writer does
        opened: (_path, immutable) => {
          reads++;
          if (!immutable || writer) return;
          writer = new Database(db);
          writer.exec("PRAGMA wal_autocheckpoint = 0");
          writer.transaction(() => {
            writer!.query("INSERT INTO sessions VALUES ('20261005_090000_fx0005', 'cli', NULL, 1791190800, NULL, ?, 'Fresh hermes title', 1791194400)").run(CWD);
            writer!.exec("INSERT INTO messages (session_id, role, content, timestamp) VALUES ('20261005_090000_fx0005', 'user', 'fresh prompt', 1791190801)");
            writer!.exec("UPDATE messages SET content = 'rewritten prompt' WHERE role = 'user' AND session_id != '20261005_090000_fx0005'");
            for (let n = 0; n < 6000; n++) writer!.query("INSERT INTO messages (session_id, role, content, timestamp) VALUES ('20261004_090000_fx0004', 'assistant', ?, 1791104401)").run(`filler ${n} ${"x".repeat(200)}`);
          })();
          writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        },
      });
      expect(rows.map((row) => [row.id, row.firstMessage])).toEqual([
        ["20261005_090000_fx0005", "fresh prompt"],
        ["20261002_090000_fx0002", "rewritten prompt"],
        ["20261001_090000_fx0001", "rewritten prompt"],
      ]);
      // the immutable read, then the one read as SQLite reads a store being written
      expect(reads).toBe(2);
    } finally { writer?.close(); }
  });

  it("reads a WAL store immutable once more, writing nothing into it, when its writer came and went during the read", () => {
    const home = newHome();
    install("hermes", home);
    const db = join(home, ".hermes", "state.db");
    const setup = new Database(db);
    setup.exec("PRAGMA journal_mode = WAL");
    setup.close();
    let reads = 0;
    let afterWriter: string[] | undefined;
    const rows = listSessions("hermes", CWD, {
      home, env: {},
      // between the immutable open and the query an agent opens the store, writes, checkpoints and
      // closes: its last close takes its side files with it
      opened: (_path, immutable) => {
        reads++;
        if (!immutable || afterWriter) return;
        const writer = new Database(db);
        writer.exec("UPDATE messages SET content = 'rewritten prompt' WHERE role = 'user'");
        writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        writer.close();
        afterWriter = sideFiles(dirname(db));
      },
    });
    // the listing made no side file of its own
    expect(sideFiles(dirname(db))).toEqual(afterWriter!);
    expect(rows.map((row) => row.firstMessage)).toEqual(["rewritten prompt", "rewritten prompt"]);
    expect(reads).toBe(2);
  });

  it("lists nothing, and writes nothing into it, from a WAL store whose first read failed with no writer", () => {
    const home = newHome();
    install("hermes", home);
    const db = join(home, ".hermes", "state.db");
    const setup = new Database(db);
    setup.exec("PRAGMA journal_mode = WAL");
    setup.close();
    const before = sideFiles(dirname(db));
    let reads = 0;
    const rows = listSessions("hermes", CWD, {
      home, env: {},
      // the first read fails (its connection is gone) while nobody writes: nothing changed, so it is not read again
      opened: (_path, immutable, opened) => { if (reads++ === 0 && immutable) opened.close(); },
    });
    expect(sideFiles(dirname(db))).toEqual(before);
    expect(rows).toEqual([]);
    expect(reads).toBe(1);
  });

  it("reads a restored WAL store whose -wal has no -shm immutable, writing nothing into it", () => {
    const home = newHome();
    install("hermes", home);
    const db = join(home, ".hermes", "state.db");
    const writer = new Database(db);
    writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; PRAGMA wal_checkpoint(TRUNCATE)");
    writer.exec("UPDATE messages SET content = 'only in the log' WHERE session_id = '20261002_090000_fx0002' AND role = 'user'");
    // a store restored from a copy: its main file and a valid -wal, no -shm
    const restored = newHome();
    mkdirSync(join(restored, ".hermes"));
    copyFileSync(db, join(restored, ".hermes", "state.db"));
    copyFileSync(`${db}-wal`, join(restored, ".hermes", "state.db-wal"));
    writer.close();
    const store = join(restored, ".hermes");
    const before = sideFiles(store);
    expect(before).toEqual(["state.db-wal"]);
    const rows = listSessions("hermes", CWD, { home: restored, env: {} });
    expect(sideFiles(store)).toEqual(before);
    // immutable reads the main file alone: what only the log holds is not seen
    expect(rows.map((row) => row.firstMessage)).toEqual(["Fixture hermes prompt 2", "Fixture hermes prompt 1"]);
  });

  it("lists nothing from a SQLite store whose path names another file once SQLite has opened it", () => {
    for (const wal of [false, true]) {
      const home = newHome();
      install("hermes", home);
      const db = join(home, ".hermes", "state.db");
      if (wal) { const setup = new Database(db); setup.exec("PRAGMA journal_mode = WAL"); setup.close(); }
      const checked = realpathSync(db);
      let opened = false;
      const listed = listSessions("hermes", CWD, {
        home, env: {},
        opened: () => { opened = true; },
        // once SQLite has opened the store, its path reports another file
        stat: (path, bigint) => path === checked && opened ? withIno(statAs(path, bigint), NEAR + 9n) : statAs(path, bigint),
      });
      expect([wal, listed]).toEqual([wal, []]);
    }
  });

  it("never reads a crashed writer's uncommitted change from a rollback-journal store", () => {
    const home = newHome();
    mkdirSync(join(home, ".hermes"));
    const db = join(home, ".hermes", "state.db");
    const writer = new Database(db, { create: true });
    // a writer whose uncommitted pages reach the main file (a tiny cache spills them), then a crash:
    // the main file and its hot -journal, as they are on disk
    writer.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = OFF");
    // Setup needs no disk syncs; eight padded rows still spill beyond the crash's one-page cache.
    writer.transaction(() => {
      writer.exec(readFileSync(join(FIXTURES, "hermes", "dot-hermes", "state.sql"), "utf8").replaceAll(":cwd", sql(CWD)));
      for (let n = 0; n < 8; n++) writer.query("INSERT INTO messages (session_id, role, content, timestamp) VALUES ('20261004_090000_fx0004', 'assistant', ?, 1791104401)").run(`pad ${"x".repeat(500)}`);
    })();
    writer.exec("PRAGMA synchronous = FULL; PRAGMA cache_spill = ON; PRAGMA cache_size = 1");
    writer.exec("BEGIN; UPDATE messages SET content = 'uncommitted prompt' WHERE role = 'user'");
    writer.exec(`UPDATE messages SET content = '${"y".repeat(500)}' WHERE role = 'assistant'`);
    const crashed = newHome();
    mkdirSync(join(crashed, ".hermes"));
    copyFileSync(db, join(crashed, ".hermes", "state.db"));
    expect(existsSync(`${db}-journal`)).toBe(true);
    copyFileSync(`${db}-journal`, join(crashed, ".hermes", "state.db-journal"));
    writer.exec("ROLLBACK");
    writer.close();
    const rows = listSessions("hermes", CWD, { home: crashed, env: {} });
    expect(rows.map((row) => row.firstMessage)).not.toContain("uncommitted prompt");
  });

  it("lists a session still in a WAL store's log while its agent writes", () => {
    const home = newHome();
    install("hermes", home);
    const db = join(home, ".hermes", "state.db");
    const writer = new Database(db);
    try {
      writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; PRAGMA wal_checkpoint(TRUNCATE)");
      // written after the last checkpoint: only the -wal holds it (an immutable open would miss it)
      writer.exec("UPDATE messages SET content = 'only in the log' WHERE session_id = '20261002_090000_fx0002' AND role = 'user'");
      const before = sideFiles(dirname(db));
      const rows = listSessions("hermes", CWD, { home, env: {} });
      expect(rows.map((row) => row.firstMessage)).toContain("only in the log");
      expect(sideFiles(dirname(db))).toEqual(before);
    } finally { writer.close(); }
  });

  it(`lists a database whose check is the ${MAX_STATS}th: its identity after the open is part of that check`, () => {
    const home = newHome();
    install("hermes", home);
    // a Hermes listing spends 6 checks up to its database's identity: the cwd's canonical form, the
    // store's stat and resolution, the database's and its folder's resolutions, then the identity
    const listed = (spent: number) => listSessions("hermes", CWD, { home, env: {}, spent }).length;
    expect(listed(MAX_STATS - 7)).toBe(2);
    expect(listed(MAX_STATS - 6)).toBe(2);
    // one check further and the identity is past the bound: nothing is listed
    expect(listed(MAX_STATS - 5)).toBe(0);
  });

  // the entries a listing walks, taken or passed over, as the opendir seam counts them
  const walking = () => {
    const seen = { walked: 0, lstats: 0 };
    const opendir = (dir: string): Dir => {
      const handle = opendirSync(dir);
      return Object.assign(Object.create(Object.getPrototypeOf(handle) as object) as Dir, {
        readSync: () => { const entry = handle.readSync(); if (entry !== null) seen.walked++; return entry; },
        closeSync: () => handle.closeSync(),
      });
    };
    return { seen, opendir, lstat: (path: string) => { seen.lstats++; return lstatSync(path); } };
  };

  it(`walks at most ${MAX_WALK} entries of a folder, entries passed over included, and times at most ${MAX_ENTRIES}`, () => {
    const home = newHome();
    const project = join(home, ".claude", "projects", claudeProjectDir(CWD));
    mkdirSync(project, { recursive: true });
    // a project of folders the listing passes over (Claude's per-session folders), and a few sessions
    for (let n = 0; n < MAX_ENTRIES + 4000; n++) mkdirSync(join(project, `folder-${n}`));
    for (let n = 0; n < 10; n++) writeFileSync(join(project, `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000.jsonl`), "");
    const { seen, opendir, lstat } = walking();
    try { listSessions("claude", CWD, { home, env: {}, opendir, lstat }); }
    finally { rmSync(home, { recursive: true, force: true }); }
    expect(seen.walked).toBeGreaterThan(MAX_ENTRIES);
    expect(seen.walked).toBeLessThanOrEqual(MAX_WALK);
    expect(seen.lstats).toBeLessThanOrEqual(MAX_ENTRIES);
  }, 60_000);

  it(`counts every lstat a Grok session folder takes within the ${MAX_ENTRIES} timed`, () => {
    const home = newHome();
    const group = join(home, ".grok", "sessions", FOLDERS.grok!);
    for (let n = 0; n < 6000; n++) {
      const dir = join(group, `s-${n}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "summary.json"), "{}");
      writeFileSync(join(dir, "updates.jsonl"), "");
    }
    const { seen, opendir, lstat } = walking();
    try { listSessions("grok", CWD, { home, env: {}, opendir, lstat }); }
    finally { rmSync(home, { recursive: true, force: true }); }
    expect(seen.lstats).toBeGreaterThan(MAX_STATS);
    expect(seen.lstats).toBeLessThanOrEqual(MAX_ENTRIES);
    expect(seen.walked).toBeLessThanOrEqual(MAX_WALK);
  }, 60_000);

  it("keeps the newest 50 of 16,000 Claude sessions with their per-session folders", () => {
    const home = newHome();
    const project = join(home, ".claude", "projects", claudeProjectDir(CWD));
    mkdirSync(project, { recursive: true });
    const written: { id: string; at: number }[] = [];
    const count = 16000;
    try {
      for (let n = 0; n < count; n++) {
        const id = `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
        const path = join(project, `${id}.jsonl`);
        writeFileSync(path, `${JSON.stringify({ type: "user", cwd: CWD, message: { role: "user", content: `prompt ${n}` } })}\n`);
        const at = (n * 7919) % count;
        utimesSync(path, 1_790_000_000 + at, 1_790_000_000 + at);
        mkdirSync(join(project, id));
        written.push({ id, at });
      }
      const newest = written.sort((a, b) => b.at - a.at).slice(0, MAX_ROWS).map((entry) => entry.id);
      expect(listSessions("claude", CWD, { home, env: {} }).map((row) => row.id)).toEqual(newest);
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 240_000);

  it(`stops walking a folder at ${MAX_WALK} entries, however many it holds`, () => {
    const home = newHome();
    const project = join(home, ".claude", "projects", claudeProjectDir(CWD));
    mkdirSync(project, { recursive: true });
    // a folder of more entries than the walk takes, all passed over, made up by the opendir seam
    let walked = 0;
    const opendir = (dir: string): Dir => {
      if (dir !== project) return opendirSync(dir);
      let n = 0;
      return Object.assign(Object.create(null) as Dir, {
        readSync: () => { if (n >= 4 * MAX_WALK) return null; walked++; const name = `folder-${n++}`; return { name, isDirectory: () => true, isFile: () => false } as unknown as Dirent; },
        closeSync: () => {},
      });
    };
    expect(listSessions("claude", CWD, { home, env: {}, opendir })).toEqual([]);
    expect(walked).toBe(MAX_WALK);
  });

  it(`reads at most ${MAX_ENTRIES} entries of a folder, however many it holds`, () => {
    const home = newHome();
    mkdirSync(piStore(home), { recursive: true });
    for (let n = 0; n < MAX_ENTRIES + 500; n++) writeFileSync(join(piStore(home), `s-${n}.jsonl`), "");
    let looked = 0;
    try {
      listSessions("pi", CWD, { home, env: {}, lstat: (path) => { looked++; return lstatSync(path); } });
    } finally {
      // removed here, inside this test's own time: on NTFS making and removing them takes seconds
      rmSync(home, { recursive: true, force: true });
    }
    expect(looked).toBeGreaterThan(MAX_STATS);
    expect(looked).toBeLessThanOrEqual(MAX_ENTRIES);
  }, 60_000);

  it(`lists the newest sessions of a folder that holds more than ${MAX_STATS}, whatever their names`, () => {
    const home = newHome();
    const project = join(home, ".claude", "projects", claudeProjectDir(CWD));
    mkdirSync(project, { recursive: true });
    // Claude names a session by a random id: the names say nothing of the times
    const written: { id: string; at: number }[] = [];
    for (let n = 0; n < 500; n++) {
      const id = `${(n * 7919 % 500).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
      const path = join(project, `${id}.jsonl`);
      writeFileSync(path, `${JSON.stringify({ type: "user", cwd: CWD, message: { role: "user", content: `prompt ${n}` } })}\n`);
      utimesSync(path, 1_790_000_000 + n, 1_790_000_000 + n);
      written.push({ id, at: n });
    }
    const newest = written.sort((a, b) => b.at - a.at).slice(0, MAX_ROWS).map((entry) => entry.id);
    expect(listSessions("claude", CWD, { home, env: {} }).map((row) => row.id)).toEqual(newest);
  });

  // more entries than the 4096 the listing once took: which ones it saw followed readdir order
  for (const [count, folders] of [[2500, true], [5000, false]] as const) {
    it(`keeps the newest ${MAX_ROWS} of ${count} Claude sessions${folders ? " with their per-session folders" : ""}, whatever the readdir order`, () => {
      const home = newHome();
      const project = join(home, ".claude", "projects", claudeProjectDir(CWD));
      mkdirSync(project, { recursive: true });
      const written: { id: string; at: number }[] = [];
      for (let n = 0; n < count; n++) {
        const id = `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
        const path = join(project, `${id}.jsonl`);
        writeFileSync(path, `${JSON.stringify({ type: "user", cwd: CWD, message: { role: "user", content: `prompt ${n}` } })}\n`);
        // the times follow neither the names nor the order the files were made in
        const at = (n * 7919) % count;
        utimesSync(path, 1_790_000_000 + at, 1_790_000_000 + at);
        // Claude keeps a folder of subagent transcripts beside a session
        if (folders) mkdirSync(join(project, id));
        written.push({ id, at });
      }
      const newest = written.sort((a, b) => b.at - a.at).slice(0, MAX_ROWS).map((entry) => entry.id);
      expect(listSessions("claude", CWD, { home, env: {} }).map((row) => row.id)).toEqual(newest);
    }, 30_000);
  }

  it("checks the Grok session written last first, by its files' times rather than its folder's", () => {
    const home = newHome();
    const group = join(home, ".grok", "sessions", FOLDERS.grok!);
    const session = (id: string, updated: number, folder: number) => {
      const dir = join(group, id);
      mkdirSync(dir, { recursive: true });
      for (const name of ["summary.json", "updates.jsonl"]) {
        const path = join(dir, name);
        writeFileSync(path, name === "summary.json" ? JSON.stringify({ info: { id, cwd: CWD }, updated_at: new Date(updated * 1000).toISOString() }) : "");
        utimesSync(path, updated, updated);
      }
      // a folder's time moves when a file is made in it, not while a session keeps writing to one
      utimesSync(dir, folder, folder);
    };
    for (let n = 0; n < 300; n++) session(`idle-${n}`, 1_790_000_000 + n, 1_790_500_000 + n);
    session("active", 1_790_900_000, 1_789_000_000);
    expect(listSessions("grok", CWD, { home, env: {} })[0]?.id).toBe("active");
  });

  it("lists a hashed Grok group's session folders once", () => {
    const home = newHome();
    for (let n = 0; n < 100; n++) {
      const dir = join(home, ".grok", "sessions", "long-slug-abc123", `s-${n}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "summary.json"), JSON.stringify({ info: { id: `s-${n}`, cwd: CWD }, updated_at: "2026-10-01T10:00:00Z" }));
      writeFileSync(join(dir, "updates.jsonl"), "");
    }
    let looked = 0;
    const rows = listSessions("grok", CWD, { home, env: {}, lstat: (path) => { looked++; return lstatSync(path); } });
    expect(rows).toHaveLength(MAX_ROWS);
    // each of the 100 folders timed once: at least one lstat (its files, else itself), at most its two
    // files' times, never those times twice
    expect(looked).toBeGreaterThanOrEqual(100);
    expect(looked).toBeLessThanOrEqual(2 * 100);
  });

  it("finds Grok sessions in a native hashed cwd group", () => {
    const home = newHome();
    const dir = join(home, ".grok", "sessions", "long-slug-abc123", ID(7));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "summary.json"), JSON.stringify({ info: { id: ID(7), cwd: CWD }, created_at: "2026-10-01T09:00:00Z", updated_at: "2026-10-01T10:00:00Z" }));
    const other = join(home, ".grok", "sessions", "other-slug-def456", ID(8));
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "summary.json"), JSON.stringify({ info: { id: ID(8), cwd: "/elsewhere" }, updated_at: "2026-10-01T10:00:00Z" }));
    expect(listSessions("grok", CWD, { home, env: {} }).map((row) => row.id)).toEqual([ID(7)]);
  });

  const grokSession = (group: string, id: string, cwd: string, home: string) => {
    const dir = join(home, ".grok", "sessions", group, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "summary.json"), JSON.stringify({ info: { id, cwd }, updated_at: "2026-10-01T10:00:00Z" }));
  };

  it("spends no stats on the sessions of another folder's Grok group", () => {
    const home = newHome();
    for (let n = 0; n < MAX_STATS + 10; n++) grokSession("foreign-slug-aaa111", `foreign-${n}`, "/elsewhere", home);
    grokSession("target-slug-bbb222", ID(7), CWD, home);
    let stats = 0;
    const rows = listSessions("grok", CWD, { home, env: {}, stat: (path, bigint) => { stats++; return statAs(path, bigint); } });
    expect(rows.map((row) => row.id)).toEqual([ID(7)]);
    expect(stats).toBeLessThan(20);
  });

  it("reads the cwd's own Grok group even when the store holds too many groups to list", () => {
    const home = newHome();
    for (let n = 0; n <= 4096; n++) mkdirSync(join(home, ".grok", "sessions", `empty-${n}`), { recursive: true });
    grokSession(FOLDERS.grok!, ID(6), CWD, home);
    expect(listSessions("grok", CWD, { home, env: {} }).map((row) => row.id)).toEqual([ID(6)]);
  });

  it.skipIf(!SYMLINKS)("checks a folder's identity under Windows rules within the counted stat budget", () => {
    const home = newHome();
    const real = join(root, `real-${homes}`);
    mkdirSync(real);
    const alias = join(root, `alias-${homes}`);
    symlinkSync(real, alias, WINDOWS ? "junction" : "dir");
    for (let n = 0; n < 5; n++) grokSession(encodeURIComponent(real), `alias-${n}`, alias, home);
    let stats = 0;
    const rows = listSessions("grok", real, {
      home, env: {}, platform: "win32",
      stat: (path, bigint) => { stats++; return bigint ? statSync(path, { bigint: true }) : statSync(path); },
    });
    expect(rows).toHaveLength(5);
    // the store, five summaries, and both folders of each of the five sessions
    expect(stats).toBe(1 + 5 + 5 * 2);
  });

  for (const [name, cwd, spelling] of [
    ["a drive letter in another case", "C:\\work\\project", "c:\\work\\project"],
    ["a verbatim drive prefix", "C:\\work\\project", "\\\\?\\C:\\work\\project"],
    ["a verbatim UNC prefix", "\\\\server\\share\\project", "\\\\?\\UNC\\server\\share\\project"],
  ] as const) {
    it(`reads a Grok group named after the same Windows folder with ${name}`, () => {
      const home = newHome();
      grokSession(encodeURIComponent(spelling), ID(5), spelling, home);
      expect(listSessions("grok", cwd, { home, env: {} }).map((row) => row.id)).toEqual([ID(5)]);
    });
  }

  for (const [name, spelling] of [
    ["forward slashes", "C:/work/project"],
    ["a trailing separator", "C:\\work\\project\\"],
    ["mixed separators", "C:\\work/project"],
  ] as const) {
    it(`reads a Grok group of the same Windows folder spelled with ${name}`, () => {
      const home = newHome();
      grokSession(encodeURIComponent(spelling), ID(4), spelling, home);
      expect(listSessions("grok", "C:\\work\\project", { home, env: {}, platform: "win32" }).map((row) => row.id)).toEqual([ID(4)]);
    });
  }

  it("reads the Grok group of a Windows short-name cwd's long name, resolving it once", () => {
    const home = newHome();
    const long = "C:\\Program Files\\Project Folder";
    grokSession(encodeURIComponent(long), ID(3), long, home);
    const resolved: string[] = [];
    let stats = 0;
    const rows = listSessions("grok", "C:\\PROGRA~1\\PROJEC~1", {
      home, env: {}, platform: "win32",
      realpath: (path) => { resolved.push(path); return path === "C:\\PROGRA~1\\PROJEC~1" ? long : path; },
      stat: (path, bigint) => { stats++; return bigint ? statSync(path, { bigint: true }) : statSync(path); },
    });
    expect(rows.map((row) => row.id)).toEqual([ID(3)]);
    expect(resolved).toEqual(["C:\\PROGRA~1\\PROJEC~1"]);
    // stat calls: the store and the session's summary (the one resolution is budgeted, through realpath)
    expect(stats).toBe(2);
  });

  const SHORT = "C:\\PROGRA~1\\PROJEC~1";
  const LONG = "C:\\Program Files\\Project Folder";
  const shortAlias = (resolved: string[]) => (path: string) => { resolved.push(path); return path === SHORT ? LONG : path; };

  it("finds Claude's project of a Windows short-name cwd's long name, resolving it once", () => {
    const home = newHome();
    const project = join(home, ".claude", "projects", claudeProjectDir(LONG));
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, `${ID(2)}.jsonl`), `${JSON.stringify({ type: "user", cwd: LONG, timestamp: "2026-10-01T09:00:00.000Z", message: { role: "user", content: "long-name prompt" } })}\n`);
    const resolved: string[] = [];
    const rows = listSessions("claude", SHORT, { home, env: {}, platform: "win32", realpath: shortAlias(resolved) });
    expect(rows.map((row) => [row.id, row.firstMessage])).toEqual([[ID(2), "long-name prompt"]]);
    expect(resolved).toEqual([SHORT]);
  });

  it("finds a pi session folder of a Windows short-name cwd's long name", () => {
    const home = newHome();
    const folder = join(home, ".pi", "agent", "sessions", "--C--Program Files-Project Folder--");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "long.jsonl"), piHeader(ID(3), LONG) + piPrompt("long-name prompt"));
    const resolved: string[] = [];
    expect(listSessions("pi", SHORT, { home, env: {}, platform: "win32", realpath: shortAlias(resolved) }).map((row) => row.id)).toEqual([ID(3)]);
    expect(resolved).toEqual([SHORT]);
  });

  it("finds omp's temp-scoped folder when TEMP is a Windows short-name alias of the cwd's base", () => {
    const home = newHome();
    const shortTemp = "C:\\Users\\LONGUS~1\\AppData\\Local\\Temp";
    const longTemp = "C:\\Users\\Long User Name\\AppData\\Local\\Temp";
    const cwd = `${longTemp}\\project`;
    const folder = join(home, ".omp", "agent", "sessions", "-tmp-project");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "scoped.jsonl"), piHeader(ID(8), cwd) + piPrompt("temp-scoped prompt"));
    const resolved: string[] = [];
    const rows = listSessions("omp", cwd, {
      home, env: {}, platform: "win32", tmpdir: shortTemp,
      realpath: (path) => { resolved.push(path); return path === shortTemp ? longTemp : path; },
    });
    expect(rows.map((row) => row.id)).toEqual([ID(8)]);
    expect(resolved.sort()).toEqual([cwd, home, shortTemp].sort());
  });

  for (const [agent, store] of [["omp", ".omp"], ["gjc", ".gjc"]] as const) {
    it.skipIf(!SYMLINKS || WINDOWS)(`lists ${agent}'s session recorded under the canonical folder of a cwd reached through a link`, () => {
      const home = newHome();
      // macOS's /var -> /private/var: the pane names the link, the agent records the folder it resolves to
      const privateVar = join(root, `private-${homes}`, "var");
      mkdirSync(join(privateVar, "project"), { recursive: true });
      const link = join(root, `var-${homes}`);
      symlinkSync(privateVar, link, "dir");
      const canonical = join(privateVar, "project");
      const folder = join(home, store, "agent", "sessions", `--${canonical.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "linked.jsonl"), piHeader(ID(9), canonical) + piPrompt("linked prompt"));
      const options = { home, env: {}, tmpdir: join(root, "no-temp-scope") };
      expect(listSessions(agent, canonical, options).map((row) => row.id)).toEqual([ID(9)]);
      expect(listSessions(agent, join(link, "project"), options).map((row) => row.id)).toEqual([ID(9)]);
    });
  }

  it("lists a pi session only in a layout version pi documents", () => {
    const home = newHome();
    mkdirSync(piStore(home), { recursive: true });
    const header = (id: string, version?: number) => `${JSON.stringify({ type: "session", ...(version === undefined ? {} : { version }), id, timestamp: "2026-10-01T09:00:00.000Z", cwd: CWD })}\n`;
    writeFileSync(join(piStore(home), "future.jsonl"), header("future", 999) + piPrompt("future"));
    writeFileSync(join(piStore(home), "v1.jsonl"), header("v1") + piPrompt("v1"));
    writeFileSync(join(piStore(home), "v2.jsonl"), header("v2", 2) + piPrompt("v2"));
    expect(listSessions("pi", CWD, { home, env: {} }).map((row) => row.id).sort()).toEqual(["v1", "v2"]);
  });

  it("puts the most recently written session first, whatever its file name", () => {
    const home = newHome();
    mkdirSync(piStore(home), { recursive: true });
    for (const [name, seconds] of [["2026-10-01T09-00-00_a.jsonl", 1_790_000_300], ["2026-10-02T09-00-00_b.jsonl", 1_790_000_100], ["2026-10-03T09-00-00_c.jsonl", 1_790_000_200]] as const) {
      const path = join(piStore(home), name);
      writeFileSync(path, piHeader(name) + piPrompt(name));
      utimesSync(path, seconds, seconds);
    }
    expect(listSessions("pi", CWD, { home, env: {} }).map((row) => row.id)).toEqual(["2026-10-01T09-00-00_a.jsonl", "2026-10-03T09-00-00_c.jsonl", "2026-10-02T09-00-00_b.jsonl"]);
  });

  it("gives no resume command for an id that could be read as an option", () => {
    const home = newHome();
    mkdirSync(piStore(home), { recursive: true });
    writeFileSync(join(piStore(home), "flag.jsonl"), piHeader("--yolo") + piPrompt("flag"));
    expect(listSessions("pi", CWD, { home, env: {} }).map((row) => [row.id, row.resume])).toEqual([["--yolo", null]]);
  });
});

const snapshot = (worktree: string | null = null): Pick<SessionSnapshot, "workspaces" | "tabs" | "panes"> => ({
  workspaces: [{ workspace_id: "w1", ...(worktree ? { worktree: { checkout_path: worktree, is_linked_worktree: true, repo_key: "", repo_name: "", repo_root: "" } } : {}) }],
  tabs: [{ tab_id: "t2", workspace_id: "w1", number: 2 }, { tab_id: "t1", workspace_id: "w1", number: 1 }],
  panes: [{ pane_id: "p2", tab_id: "t2", workspace_id: "w1", cwd: "/second" }, { pane_id: "p1", tab_id: "t1", workspace_id: "w1", cwd: CWD }],
} as unknown as Pick<SessionSnapshot, "workspaces" | "tabs" | "panes">);

describe("GET /api/sessions/history", () => {
  const request = (query: string) => {
    const url = new URL(`http://localhost/api/sessions/history?${query}`);
    return [new Request(url), url] as const;
  };

  it("names the workspace's worktree checkout, else its first tab's folder", () => {
    expect(workspaceFolder(snapshot(), "w1")).toBe(CWD);
    expect(workspaceFolder(snapshot("/checkout"), "w1")).toBe("/checkout");
    expect(workspaceFolder(snapshot(), "w9")).toBeNull();
  });

  it("lists the workspace folder's sessions", async () => {
    const home = newHome();
    install("codex", home);
    const response = await handleSessionHistoryRequest(...request("workspace_id=w1&agent=codex"), { readOnly: false, stores: { home, env: {} }, snapshot: async () => snapshot() });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as { cwd: string; sessions: { id: string; resume: { argv: string[] } | null }[] };
    expect(body.cwd).toBe(CWD);
    expect(body.sessions.map((row) => row.resume?.argv)).toEqual(EXPECTED.codex.map((id) => ["codex", "resume", id]));
  });

  it("refuses a device that may only watch", async () => {
    let asked = false;
    const response = await handleSessionHistoryRequest(...request("workspace_id=w1&agent=codex"), { readOnly: true, snapshot: async () => { asked = true; return snapshot(); } });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("read_only");
    expect(asked).toBe(false);
  });

  it("refuses an unknown agent, a missing or unknown workspace", async () => {
    const options = { readOnly: false, snapshot: async () => snapshot() };
    const codes = async (query: string) => {
      const response = await handleSessionHistoryRequest(...request(query), options);
      return [response.status, ((await response.json()) as { error: { code: string } }).error.code];
    };
    expect(await codes("workspace_id=w1&agent=bash")).toEqual([400, "invalid_agent"]);
    expect(await codes("agent=codex")).toEqual([400, "missing_workspace_id"]);
    expect(await codes("workspace_id=w9&agent=codex")).toEqual([404, "workspace_not_found"]);
  });
});
