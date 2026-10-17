import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devinConversation, forgetDevinState } from "../devin.ts";
import { devinUserText } from "./devin.ts";

const directories: string[] = [];
afterEach(() => {
  forgetDevinState();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("restores the original slash invocation only from a single recorded text block", () => {
  const meta = { extensions: { "chisel/acp-content-blocks": [{ type: "text", text: "/claude:review hello" }] } };
  expect(devinUserText("expanded", meta)).toBe("/claude:review hello");
});

test("leaves unmatched text and multimodal messages unchanged", () => {
  for (const blocks of [
    undefined, [], [{ type: "text", text: "ordinary message" }],
    [{ type: "text", text: "inline /skill" }], [{ type: "image", text: "/skill" }],
    [{ type: "text", text: "/skill" }, { type: "image", data: "image" }],
    [{ type: "text", text: "/skill" }, { type: "text", text: "more" }],
  ]) {
    expect(devinUserText("raw", { extensions: { "chisel/acp-content-blocks": blocks } })).toBe("raw");
  }
  expect(devinUserText("raw", null)).toBe("raw");
});

test("reads the recorded skill invocation through devinConversation on a disposable fixture database", () => {
  const directory = mkdtempSync(join(tmpdir(), "devin-invocation-"));
  directories.push(directory);
  const path = join(directory, "sessions.db");
  const db = new Database(path);
  db.exec("CREATE TABLE sessions(id TEXT, working_directory TEXT, main_chain_id INTEGER, hidden INTEGER, model TEXT); CREATE TABLE message_nodes(session_id TEXT,node_id INTEGER,parent_node_id INTEGER,chat_message TEXT,created_at INTEGER); CREATE TABLE tool_call_state(session_id TEXT,tool_call_id TEXT,tool_call_json TEXT,tool_call_update_json TEXT)");
  const sessionId = "probe-session";
  const cwd = "/synthetic/probe";
  db.query("INSERT INTO sessions VALUES (?, ?, NULL, 0, NULL)").run(sessionId, cwd);
  try {
    const fixture = readFileSync(join(import.meta.dir, "../fixtures/skill-invocations/devin.jsonl"), "utf8");
    for (const line of fixture.trim().split("\n")) {
      const entry: unknown = JSON.parse(line);
      if (typeof entry !== "object" || entry === null || !("table" in entry) || !("row" in entry)) continue;
      const row = entry.row;
      if (typeof row !== "object" || row === null) continue;
      if (entry.table !== "message_nodes" || !("chat_message" in row) || typeof row.chat_message !== "string") continue;
      const message: unknown = JSON.parse(row.chat_message);
      if (typeof message !== "object" || message === null || !("role" in message) || message.role !== "user" || !("content" in message) || typeof message.content !== "string") continue;
      const metadata = "metadata" in message ? message.metadata : null;
      if (typeof metadata !== "object" || metadata === null || !("extensions" in metadata)) continue;
      const extensions = metadata.extensions;
      if (typeof extensions !== "object" || extensions === null || !("chisel/acp-content-blocks" in extensions)) continue;
      const original = extensions["chisel/acp-content-blocks"];
      if (!Array.isArray(original)) continue;
      const blocks = original.flatMap((block: unknown) => typeof block === "object" && block !== null && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string" && block.text === "/probe-skill hello" ? [{ type: block.type, text: block.text }] : []);
      if (blocks.length !== 1) continue;
      const invocation = { role: message.role, content: message.content, metadata: { extensions: { "chisel/acp-content-blocks": blocks } } };
      db.query("INSERT INTO message_nodes VALUES (?, 1, NULL, ?, 1700000000)").run(sessionId, JSON.stringify(invocation));
      db.query("UPDATE sessions SET main_chain_id = 1 WHERE id = ?").run(sessionId);
      break;
    }
  } finally { db.close(); }
  const users = devinConversation(sessionId, cwd, {}, path).turns.filter((turn) => turn.role === "user");
  expect(users.map((turn) => turn.parts)).toEqual([[{ kind: "text", text: "/probe-skill hello" }]]);
});

test("bounds a restored invocation like any other user text", () => {
  const directory = mkdtempSync(join(tmpdir(), "devin-invocation-"));
  directories.push(directory);
  const path = join(directory, "sessions.db");
  const db = new Database(path);
  db.exec("CREATE TABLE sessions(id TEXT, working_directory TEXT, main_chain_id INTEGER, hidden INTEGER, model TEXT); CREATE TABLE message_nodes(session_id TEXT,node_id INTEGER,parent_node_id INTEGER,chat_message TEXT,created_at INTEGER); CREATE TABLE tool_call_state(session_id TEXT,tool_call_id TEXT,tool_call_json TEXT,tool_call_update_json TEXT)");
  const invocation = { role: "user", content: "expanded", metadata: { extensions: { "chisel/acp-content-blocks": [{ type: "text", text: `/probe-skill ${"x".repeat(70_000)}` }] } } };
  db.query("INSERT INTO sessions VALUES ('long', '/synthetic/probe', 1, 0, NULL)").run();
  db.query("INSERT INTO message_nodes VALUES ('long', 1, NULL, ?, 1700000000)").run(JSON.stringify(invocation));
  db.close();
  const [part] = devinConversation("long", "/synthetic/probe", {}, path).turns[0]?.parts ?? [];
  expect(part?.kind === "text" ? part.text.length : 0).toBe(64 * 1024);
});
