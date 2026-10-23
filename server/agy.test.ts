import { expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AgyUnavailable, agyCatalog, agyDatabasePath, parseAgyTranscript } from "./agy.ts";

/** Writes a WAL catalog from a process that then dies without closing it, as agy does when killed:
 * nothing checkpoints, and no handle stays open, so a test may delete side files on any platform. */
async function abandonedWal(dbPath: string, sql: string): Promise<void> {
  const writer = Bun.spawn([process.execPath, "-e", `
    import { Database } from "bun:sqlite";
    new Database(${JSON.stringify(dbPath)}).exec(${JSON.stringify(sql)});
    process.kill(process.pid, "SIGKILL");
  `], { stdout: "ignore", stderr: "pipe" });
  const [stderr] = await Promise.all([new Response(writer.stderr).text(), writer.exited]);
  expect(stderr).toBe("");
  expect([existsSync(`${dbPath}-wal`), existsSync(`${dbPath}-shm`)]).toEqual([true, true]);
}

it("reads a stable rollback-journal catalog without creating side files", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agy-rollback-")));
  try {
    const transcript = join(dir, "brain", "session", ".system_generated", "logs", "transcript_full.jsonl");
    const dbPath = agyDatabasePath(transcript);
    mkdirSync(dirname(dbPath), { recursive: true });
    const writer = new Database(dbPath);
    try {
      writer.exec("CREATE TABLE steps(idx INTEGER PRIMARY KEY); INSERT INTO steps VALUES (0);");
    } finally { writer.close(); }

    const catalog = agyCatalog(transcript);

    expect([...catalog]).toEqual([0]);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
    expect(existsSync(`${dbPath}-journal`)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("reads a checkpointed WAL catalog without recreating missing side files", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agy-wal-")));
  try {
    const transcript = join(dir, "brain", "session", ".system_generated", "logs", "transcript_full.jsonl");
    const dbPath = agyDatabasePath(transcript);
    mkdirSync(dirname(dbPath), { recursive: true });
    const writer = new Database(dbPath);
    try {
      writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE steps(idx INTEGER PRIMARY KEY); INSERT INTO steps VALUES (0); PRAGMA wal_checkpoint(TRUNCATE);");
    } finally { writer.close(); }
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    expect([...readFileSync(dbPath).subarray(18, 20)]).toEqual([2, 2]);

    const catalog = agyCatalog(transcript);

    expect([...catalog]).toEqual([0]);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.each([
  ["database", 32 * 1024 * 1024 + 1, 0],
  ["WAL", 8192, 32 * 1024 * 1024 + 1],
  ["combined", 16 * 1024 * 1024, 16 * 1024 * 1024 + 1],
] as const)("rejects an oversized %s before copying the catalog", (_name, dbBytes, walBytes) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agy-catalog-limit-")));
  try {
    const transcript = join(dir, "brain", "session", ".system_generated", "logs", "transcript_full.jsonl");
    const dbPath = agyDatabasePath(transcript);
    mkdirSync(dirname(dbPath), { recursive: true });
    const writer = new Database(dbPath);
    try {
      writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE steps(idx INTEGER PRIMARY KEY); INSERT INTO steps VALUES (0); PRAGMA wal_checkpoint(TRUNCATE);");
      truncateSync(dbPath, dbBytes);
      truncateSync(`${dbPath}-wal`, walBytes);
      const reads = spyOn(fs, "readSync");
      // A regression fails on its first write instead of materializing the sparse files.
      const writes = spyOn(fs, "writeFileSync").mockImplementation(() => { throw new Error("unexpected snapshot write"); });
      try {
        expect(() => agyCatalog(transcript)).toThrow(AgyUnavailable);
        expect(reads).toHaveBeenCalledTimes(1);
        expect(reads.mock.calls[0]?.[1].byteLength).toBe(20);
        expect(writes).not.toHaveBeenCalled();
      } finally { writes.mockRestore(); reads.mockRestore(); }
    } finally { writer.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.each(["wal", "shm", null] as const)("reads a WAL catalog with %s missing without changing side files", async (missing) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agy-wal-pair-")));
  try {
    const transcript = join(dir, "brain", "session", ".system_generated", "logs", "transcript_full.jsonl");
    const dbPath = agyDatabasePath(transcript);
    mkdirSync(dirname(dbPath), { recursive: true });
    await abandonedWal(dbPath, "PRAGMA journal_mode=WAL; CREATE TABLE steps(idx INTEGER PRIMARY KEY); INSERT INTO steps VALUES (0); PRAGMA wal_checkpoint(TRUNCATE); INSERT INTO steps VALUES (1);");
    if (missing !== null) rmSync(`${dbPath}-${missing}`);
    const before = [existsSync(`${dbPath}-wal`), existsSync(`${dbPath}-shm`)];
    expect(before).toEqual([missing !== "wal", missing !== "shm"]);

    // A separate process avoids sharing the writer's in-process SQLite state.
    const reader = Bun.spawn([process.execPath, "-e", `
      import { agyCatalog } from ${JSON.stringify(new URL("./agy.ts", import.meta.url).href)};
      console.log(JSON.stringify([...agyCatalog(${JSON.stringify(transcript)})]));
    `], { stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
      reader.exited, new Response(reader.stdout).text(), new Response(reader.stderr).text(),
    ]);

    expect([existsSync(`${dbPath}-wal`), existsSync(`${dbPath}-shm`)]).toEqual(before);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    // Incomplete pairs read only the checkpointed main file, as session-history does.
    expect(JSON.parse(stdout)).toEqual(missing === null ? [0, 1] : [0]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("does not recreate a live WAL pair unlinked between its check and open", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agy-wal-unlink-")));
  try {
    const transcript = join(dir, "brain", "session", ".system_generated", "logs", "transcript_full.jsonl");
    const dbPath = agyDatabasePath(transcript);
    mkdirSync(dirname(dbPath), { recursive: true });
    await abandonedWal(dbPath, "PRAGMA journal_mode=WAL; CREATE TABLE steps(idx INTEGER PRIMARY KEY); INSERT INTO steps VALUES (0); PRAGMA wal_checkpoint(TRUNCATE);");
    const reader = Bun.spawn([process.execPath, "-e", `
      import { agyCatalog, AgyUnavailable } from ${JSON.stringify(new URL("./agy.ts", import.meta.url).href)};
      import { existsSync, rmSync } from "node:fs";
      const path = ${JSON.stringify(dbPath)};
      let removed = false;
      let rows = null;
      try {
        rows = [...agyCatalog(${JSON.stringify(transcript)}, () => {
          if (!existsSync(path + "-wal") || !existsSync(path + "-shm")) throw new Error("pair missing before hook");
          rmSync(path + "-wal");
          rmSync(path + "-shm");
          removed = true;
        })];
      } catch (error) {
        if (!(error instanceof AgyUnavailable)) throw error;
      }
      console.log(JSON.stringify({ removed, rows }));
    `], { stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
      reader.exited, new Response(reader.stdout).text(), new Response(reader.stderr).text(),
    ]);

    expect([existsSync(`${dbPath}-wal`), existsSync(`${dbPath}-shm`)]).toEqual([false, false]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.removed).toBe(true);
    expect([null, [0]]).toContainEqual(result.rows);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("keeps the recorded skill invocation without its expanded metadata", () => {
  const fixture = readFileSync(new URL("./fixtures/skill-invocations/agy.jsonl", import.meta.url), "utf8");
  const turns = parseAgyTranscript(fixture);
  expect(turns.filter(({ role }) => role === "user").map(({ parts }) => parts)).toEqual([
    [{ kind: "text", text: "/probe-skill hello" }],
  ]);
});

it("keeps raw input when it is not a complete recognized envelope", () => {
  const content = "<USER_REQUEST>\n/probe-skill hello\n</USER_REQUEST>\n<OTHER>raw</OTHER>";
  const turns = parseAgyTranscript(JSON.stringify({ step_index: 0, type: "USER_INPUT", status: "DONE", content }));
  expect(turns[0]?.parts).toEqual([{ kind: "text", text: content }]);
});
