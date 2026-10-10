import { Database } from "bun:sqlite";
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agyConversation, AgyHistoryChanged, agySessionFromPids, agyToolOutput, agyTranscriptPath, parseAgySteps, type AgyStep } from "./agy.ts";
import { HistoryChanged, transcriptPage, transcriptToolOutput } from "./conversation.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-agy-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const id = "12345678-1234-1234-1234-123456789abc";
const stamp = "2026-10-07T00:00:00.000Z";

it("finds only the latest resumed conversation from the pane process's open agy log", () => {
  const app = join(root, "resumed", "antigravity-cli");
  const proc = join(root, "proc");
  const resumed = "6d1609c2-58c0-410d-bf76-032e8217e0f4";
  mkdirSync(join(app, "log"), { recursive: true });
  mkdirSync(join(app, "conversations"));
  mkdirSync(join(proc, "123", "fd"), { recursive: true });
  const log = join(app, "log", "cli-test.log");
  writeFileSync(log, `Streaming conversation ${id}\nStarting conversation update stream for ${resumed}\n`);
  writeFileSync(join(app, "conversations", `${resumed}.db`), "");
  symlinkSync(log, join(proc, "123", "fd", "1"));
  expect(agySessionFromPids([123], proc)).toBe(join(app, "conversations", `${resumed}.db`));
  expect(agySessionFromPids([456], proc)).toBeNull();
  writeFileSync(log, `GetConversationDetail: found conversation ${resumed} (active=false)\n`);
  expect(agySessionFromPids([123], proc)).toBeNull();
});

function integer(value: number): Buffer {
  const bytes: number[] = [];
  do { const byte = value % 128; value = Math.floor(value / 128); bytes.push(byte | (value ? 128 : 0)); } while (value);
  return Buffer.from(bytes);
}
const field = (number: number, value: string | Uint8Array | number): Buffer => {
  if (typeof value === "number") return Buffer.concat([integer(number * 8), integer(value)]);
  const bytes = typeof value === "string" ? Buffer.from(value) : value;
  return Buffer.concat([integer(number * 8 + 2), integer(bytes.length), bytes]);
};
const message = (...parts: Uint8Array[]) => Buffer.concat(parts);
const call = (name = "run_command", key = "call-1") => message(field(1, key), field(2, name), field(3, '{"command":"pwd"}'));
const metadata = (extra: Buffer = Buffer.alloc(0)) => message(field(1, field(1, Date.parse(stamp) / 1000)), extra);
const step = (idx: number, type: number, payload: Buffer, meta = metadata()): AgyStep => ({
  idx, step_type: type, status: 3, step_format: 0,
  step_payload: message(field(1, type), field(4, 3), field(5, meta), payload),
});
const user = (idx: number, text: string) => step(idx, 14, field(19, message(field(2, text), field(3, field(1, text)), field(12, "system context"))));
const assistant = (idx: number, text: string) => step(idx, 15, field(20, field(1, text)));
const result = (idx: number, output: string, exit = 0, key = "call-1") => step(idx, 132,
  field(140, field(2, message(field(1, "Executed command"), field(6, message(
    field(1, "type.googleapis.com/gemini_coder.Step"), field(2, field(28, message(field(6, exit), field(21, field(1, output))))),
  ))))), metadata(field(4, call("run_command", key))));

function database(name: string, steps: AgyStep[]): string {
  const path = join(root, name);
  const db = new Database(path, { create: true });
  db.exec("CREATE TABLE trajectory_meta (trajectory_id TEXT, cascade_id TEXT); CREATE TABLE steps (idx INTEGER PRIMARY KEY,step_type INTEGER,status INTEGER,step_format INTEGER,step_payload BLOB); CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY,data BLOB)");
  db.query("INSERT INTO trajectory_meta VALUES (?,?)").run(id, id);
  const insert = db.query("INSERT INTO steps VALUES (?,?,?,?,?)");
  for (const row of steps) insert.run(row.idx, row.step_type, row.status, row.step_format, row.step_payload);
  db.query("INSERT INTO gen_metadata VALUES (?,?)").run(0, field(1, field(19, "gemini-test")));
  db.close();
  return path;
}

describe("agy native Step decoding", () => {
  it("reads user_response once, folds thinking and tool results into the assistant turn", () => {
    const answer = step(1, 15, field(20, message(field(1, "Original"), field(8, "Answer"), field(3, "Thought"), field(7, call()))));
    const turns = parseAgySteps([user(0, "Question"), answer, result(2, "directory", 1), assistant(3, "Finished")]);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toEqual({ role: "user", ts: stamp, parts: [{ kind: "text", text: "Question" }] });
    expect(turns[1]?.parts).toEqual([
      { kind: "thinking", text: "Thought" }, { kind: "text", text: "Answer" },
      { kind: "tool", name: "run_command", summary: '{"command":"pwd"}', input: '{"command":"pwd"}', output: "directory", error: true },
      { kind: "text", text: "Finished" },
    ]);
  });

  it("keeps tool-only assistant messages and matches results by ID", () => {
    const answer = step(1, 15, field(20, message(field(7, call("first", "one")), field(7, call("second", "two")))));
    const turns = parseAgySteps([user(0, "Question"), answer, result(2, "Second output", 0, "two"), result(3, "First output", 0, "one")]);
    expect(turns[1]?.parts.map((part) => part.kind === "tool" ? [part.name, part.output] : null)).toEqual([
      ["first", "First output"], ["second", "Second output"],
    ]);
  });

  it("reads view_file output from the typed Any payload", () => {
    const view = step(1, 132, field(140, field(2, message(field(1, "Viewed file"), field(6, message(
      field(1, "type.googleapis.com/gemini_coder.Step"), field(2, field(14, field(9, "file contents"))),
    ))))), metadata(field(4, call("view_file"))));
    expect(parseAgySteps([user(0, "Read"), view])[1]?.parts[0]).toMatchObject({ name: "view_file", output: "file contents" });
  });

  it("uses item text when user_response is absent and excludes system steps", () => {
    const input = step(0, 14, field(19, field(3, field(1, "Item"))));
    const system = step(1, 101, field(114, field(1, "Instructions")));
    expect(parseAgySteps([input, system])).toEqual([{ role: "user", ts: stamp, parts: [{ kind: "text", text: "Item" }] }]);
  });

  it("skips unknown fields but rejects corrupt and unsupported formats", () => {
    const input = user(0, "Question");
    input.step_payload = message(input.step_payload, field(500, "future field"));
    expect(parseAgySteps([input])[0]?.parts).toEqual([{ kind: "text", text: "Question" }]);
    expect(() => parseAgySteps([{ ...input, step_format: 1 }])).toThrow("unsupported agy step format");
    expect(() => parseAgySteps([{ ...input, step_payload: Buffer.from([0x9a, 0x01, 0xff]) }])).toThrow();
  });
});

describe("agy SQLite conversation store", () => {
  it("only accepts a UUID database inside the canonical store", () => {
    const store = join(root, "store");
    mkdirSync(store);
    const db = database(`${id}.db`, []);
    symlinkSync(db, join(store, `${id}.db`));
    expect(agyTranscriptPath(id, root)).toBe(db);
    expect(agyTranscriptPath(id, store)).toBeNull();
    expect(agyTranscriptPath("../outside", root)).toBeNull();
    expect(agyTranscriptPath("00000000-0000-0000-0000-000000000000", root)).toBeNull();
  });

  it("paginates at user steps without splitting tools and detects invalid cursors", () => {
    const rows = Array.from({ length: 25 }, (_, index) => [user(index * 2, `Question ${index}`), assistant(index * 2 + 1, `Answer ${index}`)]).flat();
    const path = database("pages.db", rows);
    const newest = transcriptPage("agy-transcript", path);
    expect(newest.source).toBe("agy-transcript");
    expect(newest.turns).toHaveLength(40);
    expect(newest.metadata.model).toBe("gemini-test");
    expect(newest.turns[0]?.parts[0]).toEqual({ kind: "text", text: "Question 5" });
    const older = agyConversation(path, { before: newest.cursor! });
    expect(older.cursor).toBeNull();
    expect(older.turns).toHaveLength(10);
    expect(agyConversation(path, { from: newest.cursor! }).turns).toEqual(newest.turns);
    expect(agyConversation(path, { from: `${newest.history_id}:0` }).turns).toHaveLength(50);
    expect(agyConversation(path, { since: `${newest.history_id}:40` }).turns).toHaveLength(10);
    expect(() => agyConversation(path, { before: "another-session:0" })).toThrow(AgyHistoryChanged);
    expect(() => transcriptPage("agy-transcript", path, { from: "another-session:0" })).toThrow(HistoryChanged);
  });

  it("reads live WAL appends and updated responses instead of trusting main-file stat", () => {
    const path = database("live.db", [user(0, "Question")]);
    const writer = new Database(path);
    try {
      writer.exec("PRAGMA journal_mode=WAL");
      const before = agyConversation(path);
      const row = assistant(1, "Answer");
      writer.query("INSERT INTO steps VALUES (?,?,?,?,?)").run(row.idx, row.step_type, row.status, row.step_format, row.step_payload);
      const after = agyConversation(path);
      expect(after.history_id).toBe(before.history_id);
      expect(after.version).not.toBe(before.version);
      expect(after.turns).toHaveLength(2);
      const changed = assistant(1, "Updated answer");
      writer.query("UPDATE steps SET step_payload=? WHERE idx=1").run(changed.step_payload);
      expect(agyConversation(path).turns[1]?.parts[0]).toEqual({ kind: "text", text: "Updated answer" });
    } finally { writer.close(); }
  });

  it("serves whole tool output behind the truncated tool card", () => {
    const output = "x".repeat(25_000);
    const path = database("tool.db", [user(0, "Run"), result(1, output)]);
    const tool = agyConversation(path).turns[1]?.parts[0];
    expect(tool).toMatchObject({ kind: "tool", output_ref: "call-1", output_size: output.length });
    expect(tool?.kind === "tool" && tool.output.length).toBe(24_000);
    expect(agyToolOutput(path, "call-1")).toBe(output);
    expect(transcriptToolOutput("agy-transcript", path, "call-1")).toBe(output);
    expect(agyToolOutput(path, "missing")).toBeNull();
  });
});
