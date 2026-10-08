import { afterAll, describe, expect, it } from "bun:test";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  dshConversation, DshHistoryChanged, dshOutputRef, dshSessionFromPids, dshToolOutput, dshTranscriptPath, parseDshRecords, readDshSession,
} from "./dsh.ts";
import { HistoryChanged, transcriptPage, transcriptToolOutput } from "./conversation.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-dsh-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const id = "f2c92739-0fc4-44fb-a6b7-27b0815e789b";
const time = Date.parse("2026-10-08T00:00:00.000Z");
const record = (type: string, data: unknown, seq: number, at = time) => JSON.stringify({ type, seq, time: at, data });
const header = (sessionId = id) => JSON.stringify({ type: "session", version: 4, id: sessionId, createdAt: time, cwd: "/home/seonwookim" });
const user = (text: string, seq: number, kind = "user") => record("user/message", { role: "user", content: [{ type: "text", text }], source: { kind } }, seq);
const assistant = (seq: number, content: unknown[], usage?: unknown) => record("assistant/message", { turn: 1, step: 1, message: { role: "assistant", content }, ...(usage ? { usage } : {}) }, seq);
const result = (seq: number, toolCallId: string, text: string, isError = false) =>
  record("tool/result", { turn: 1, step: 1, message: { role: "tool", toolCallId, content: [{ type: "text", text }], isError } }, seq);

function writeSession(lines: string[], directory = join(root, "sessions", "--home-seonwookim--", id), name = "session.v4.jsonl.zstd"): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, name);
  writeFileSync(path, Bun.zstdCompressSync(Buffer.from(`${lines.join("\n")}\n`)));
  return path;
}

const callId = "call_5df25fae9066492d84296134cec11c12|fc_02a31c4b7cf803ae";
const undeclaredId = "call_9b0d0d1e2f3a4b5c6d7e8f90a1b2c3d4|fc_missing";
function standardSession(): string {
  return writeSession([
    header(),
    record("request/context", { provider: "opencodex", model: "gpt-6.1-sol", contextWindow: 272000 }, 1),
    user("첫 질문", 2),
    record("turn/start", { turn: 1 }, 3),
    record("step/start", { turn: 1, step: 1 }, 4),
    assistant(5, [
      { type: "reasoning", text: "생각" },
      { type: "text", text: "확인해 보겠습니다" },
      { type: "tool-call", id: callId, name: "bash", arguments: '{"command":"ls -a"}' },
    ], { inputTokens: 15794, outputTokens: 26, totalTokens: 15820 }),
    record("tool/call", { turn: 1, step: 1, callId, name: "bash", arguments: '{"command":"ls -a"}' }, 6),
    result(7, callId, "a\nb\n"),
    assistant(8, [{ type: "text", text: "끝났습니다" }]),
    result(9, undeclaredId, "Error: boom", true),
    user("런타임 컨텍스트", 10, "runtime-context"),
    user("둘째 질문", 11),
    assistant(12, [{ type: "text", text: "둘째 답" }]),
    record("turn/end", { turn: 1, reason: { kind: "completed" } }, 13),
  ]);
}

function longSession(): string {
  const lines = [header()];
  let seq = 1;
  for (let prompt = 1; prompt <= 25; prompt += 1) {
    lines.push(user(`질문 ${prompt}`, seq += 1));
    lines.push(assistant(seq += 1, [{ type: "text", text: `답 ${prompt}` }]));
  }
  return writeSession(lines);
}

const bigOutput = "x".repeat(30_000);
function truncatedSession(): string {
  return writeSession([
    header(),
    user("질문", 1),
    assistant(2, [{ type: "tool-call", id: callId, name: "bash", arguments: '{"command":"cat big"}' }]),
    result(3, callId, bigOutput),
  ]);
}

describe("dsh records", () => {
  it("reads the session header id and skips malformed lines", () => {
    const path = writeSession([header(), "not json", record("session/title", { title: "제목" }, 2)]);
    const records = readDshSession(path);
    expect(records.map((entry) => entry.type)).toEqual(["session", "session/title"]);
    expect(records[0]?.id).toBe(id);
  });

  it("refuses a file that is not zstd", () => {
    const path = join(root, "broken.zstd");
    writeFileSync(path, Buffer.from("plain text"));
    expect(() => readDshSession(path)).toThrow();
  });
});

describe("dsh turns", () => {
  it("keeps every step of one prompt in a single assistant turn", () => {
    const { turns } = parseDshRecords(readDshSession(standardSession()));
    expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(turns[0]?.parts).toEqual([{ kind: "text", text: "첫 질문" }]);
    const first = turns[1]!;
    expect(first.parts[0]).toEqual({ kind: "thinking", text: "생각" });
    expect(first.parts[1]).toEqual({ kind: "text", text: "확인해 보겠습니다" });
    expect(first.parts[2]).toMatchObject({ kind: "tool", name: "bash", input: '{"command":"ls -a"}', output: "a\nb\n" });
    expect(first.parts).toHaveLength(5);
    expect(first.end_ts).toBe(new Date(time).toISOString());
    // the second tool/result names a call no step declared: it still gets a card of its own
    expect(first.parts[3]).toEqual({ kind: "text", text: "끝났습니다" });
    expect(first.parts[4]).toMatchObject({ kind: "tool", error: true, output: "Error: boom" });
    // a runtime-context injection sits in the user's seat without being a turn
    expect(turns[2]?.parts).toEqual([{ kind: "text", text: "둘째 질문" }]);
  });

  it("reports the model and the last request's context", () => {
    const conversation = dshConversation(standardSession());
    expect(conversation.source).toBe("dsh-transcript");
    expect(conversation.metadata).toEqual({
      model: "gpt-6.1-sol",
      reasoning_effort: null,
      context: { used: 15820, window: 272000 },
    });
    expect(conversation.history_id).toStartWith(`dsh:${id}:`);
    expect(conversation.cursor).toBeNull();
  });
});

describe("dsh pages", () => {
  it("pages back from the newest prompts and refuses a foreign cursor", () => {
    const path = longSession();
    const newest = dshConversation(path);
    expect(newest.turns.filter((turn) => turn.role === "user")).toHaveLength(20);
    expect(newest.turns[0]?.parts).toEqual([{ kind: "text", text: "질문 6" }]);
    expect(newest.cursor).not.toBeNull();

    const older = dshConversation(path, { before: newest.cursor! });
    expect(older.turns.filter((turn) => turn.role === "user").map((turn) => turn.parts[0])).toEqual([
      { kind: "text", text: "질문 1" },
      { kind: "text", text: "질문 2" },
      { kind: "text", text: "질문 3" },
      { kind: "text", text: "질문 4" },
      { kind: "text", text: "질문 5" },
    ]);
    expect(older.cursor).toBeNull();

    expect(() => dshConversation(path, { before: `dsh:${id}:1:1` })).toThrow(DshHistoryChanged);
    expect(() => dshConversation(path, { since: "other-history:4" })).toThrow(DshHistoryChanged);
  });

  it("stops when the page boundary moved under the caller", () => {
    const path = longSession();
    const before = dshConversation(path).cursor!;
    expect(() => transcriptPage("dsh-transcript", path, { before })).not.toThrow();
    expect(() => transcriptPage("dsh-transcript", path, { before: `dsh:${id}:999999:1` })).toThrow(HistoryChanged);
  });
});

describe("dsh tool output", () => {
  it("hands out a digest ref and serves the whole output behind it", () => {
    const path = truncatedSession();
    const card = parseDshRecords(readDshSession(path)).turns[1]!.parts[0]!;
    expect(card).toMatchObject({ output_ref: dshOutputRef(callId), output_size: bigOutput.length });
    expect((card as { output: string }).output).toHaveLength(24_000);
    expect(transcriptToolOutput("dsh-transcript", path, dshOutputRef(callId))).toBe(bigOutput);
    expect(dshToolOutput(path, dshOutputRef("call_missing"))).toBeNull();
  });

  it("leaves a short output inline with no ref", () => {
    const card = parseDshRecords(readDshSession(standardSession())).turns[1]!.parts[2]!;
    expect(card).not.toHaveProperty("output_ref");
    expect(dshToolOutput(standardSession(), dshOutputRef(callId))).toBe("a\nb\n");
  });
});

describe("dsh session lookup", () => {
  it("finds the session a live process holds open", () => {
    const home = join(root, "home");
    const path = writeSession([header()], join(home, "sessions", "--home-seonwookim--", id));
    const lock = join(home, "sessions", "--home-seonwookim--", id, "session.lock");
    writeFileSync(lock, "");
    expect(dshSessionFromPids([process.pid], home)).toBeNull();

    const descriptor = openSync(lock, "r");
    try {
      expect(dshSessionFromPids([process.pid], home)).toBe(path);
      expect(dshSessionFromPids([process.pid], join(root, "elsewhere"))).toBeNull();
    } finally {
      closeSync(descriptor);
    }
    expect(dshTranscriptPath(id, home)).toBe(path);
    expect(dshTranscriptPath("not-a-session-id", home)).toBeNull();
  });
});
