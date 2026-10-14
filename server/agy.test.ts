import { Database } from "bun:sqlite";
import { afterAll, expect, it, spyOn } from "bun:test";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrPane, SessionSnapshot } from "../shared/protocol.ts";
import { ConversationUnavailable, forgetTranscriptState, paneConversation } from "./conversation.ts";
import * as herdr from "./herdr/client.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-agy-recognition-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const id = "12345678-1234-1234-1234-123456789abc";
mkdirSync(join(root, "presence"));
mkdirSync(join(root, "conversations"));
const lock = join(root, "presence", `${id}.lock`);
writeFileSync(lock, "");
const logs = join(root, "brain", id, ".system_generated", "logs");
mkdirSync(logs, { recursive: true });
writeFileSync(join(logs, "transcript_full.jsonl"), JSON.stringify({ step_index: 0, type: "USER_INPUT", status: "DONE", content: "account two question" }) + "\n");
const db = new Database(join(root, "conversations", `${id}.db`), { create: true });
db.exec("CREATE TABLE steps (idx INTEGER PRIMARY KEY); INSERT INTO steps VALUES (0)");
db.close();

it.each(["agy", "agy-native"])("reads %s's held conversation despite an inherited Pi label", async (name) => {
  const fd = openSync(lock, "r");
  const pane = { pane_id: "account-two", cwd: root, agent: "pi" } as HerdrPane;
  const snapshot = spyOn(herdr, "sessionSnapshot").mockResolvedValue({ panes: [pane] } as SessionSnapshot);
  const info = { pane_id: pane.pane_id, foreground_processes: [
    { pid: process.pid, name, argv: [`/bin/${name}`] },
    { pid: 42, name: "node", argv: ["node", "mcp-server"] },
  ] };
  const rpc = spyOn(herdr, "herdrRpc").mockResolvedValue({ process_info: info } as never);
  const processInfo = spyOn(herdr, "paneProcessInfo").mockResolvedValue(info);
  try {
    const result = await paneConversation(pane.pane_id);
    expect(result.source).toBe("agy-transcript");
    expect(result.turns[0]?.parts).toEqual([{ kind: "text", text: "account two question" }]);
  } finally {
    processInfo.mockRestore(); rpc.mockRestore(); snapshot.mockRestore(); closeSync(fd); forgetTranscriptState();
  }
});

it.each(["agy", "agy-native"])("rejects active %s without a held conversation instead of reading stale Pi history", async (name) => {
  const pane = { pane_id: "account-two", cwd: root, agent: "pi" } as HerdrPane;
  const snapshot = spyOn(herdr, "sessionSnapshot").mockResolvedValue({ panes: [pane] } as SessionSnapshot);
  const info = { pane_id: pane.pane_id, foreground_processes: [{ pid: process.pid, name, argv: [`/bin/${name}`] }] };
  const rpc = spyOn(herdr, "herdrRpc").mockResolvedValue({ process_info: info } as never);
  const processInfo = spyOn(herdr, "paneProcessInfo").mockResolvedValue(info);
  try {
    await expect(paneConversation(pane.pane_id)).rejects.toThrow(ConversationUnavailable);
  } finally {
    processInfo.mockRestore(); rpc.mockRestore(); snapshot.mockRestore(); forgetTranscriptState();
  }
});
