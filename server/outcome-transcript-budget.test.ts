import { expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as conversation from "./conversation.ts";
import * as client from "./herdr/client.ts";
import { commandInvocations } from "./outcome.ts";
import { handlePromptRequest, noteSubmitted } from "./prompt.ts";
import type { PanePromptResponse } from "../shared/protocol.ts";

const bytesRead = (reads: ReturnType<typeof spyOn<typeof fs, "readSync">>) => reads.mock.results.reduce((sum, result) =>
  sum + (result.type === "return" && typeof result.value === "number" ? result.value : 0), 0);

it.each([20, 128])("resolves a Chat model send from a %i MiB pi session within the read budget", async (megabytes) => {
  const root = fs.mkdtempSync(join(tmpdir(), "outcome-pi-budget-"));
  const path = join(root, "session.jsonl");
  const at = Date.parse("2026-10-20T00:00:00Z");
  fs.writeFileSync(path, JSON.stringify({ type: "session", id: "session", version: 3 }) + "\n");
  for (let index = 0; index < megabytes; index++) {
    fs.appendFileSync(path, JSON.stringify({ type: "message", id: `entry-${index}`, parentId: index ? `entry-${index - 1}` : null,
      message: { role: "assistant", content: "x".repeat(1024 * 1024) } }) + "\n");
  }
  fs.appendFileSync(path, JSON.stringify({ type: "model_change", id: "selected", parentId: `entry-${megabytes - 1}`,
    timestamp: new Date(at + 10).toISOString(), provider: "fixture", modelId: "chosen-model" }) + "\n");
  const pane = { pane_id: root, terminal_id: "term", workspace_id: "w", tab_id: "t", focused: false, revision: 0,
    agent: "pi", agent_status: "idle", cwd: root };
  const clock = spyOn(Date, "now").mockReturnValue(at + 30);
  const binding = spyOn(conversation, "paneTranscript").mockResolvedValue({ source: "pi-transcript", path });
  const snapshot = spyOn(client, "sessionSnapshot").mockResolvedValue({
    panes: [pane], layouts: [], agents: [], workspaces: [], tabs: [], protocol: 22, version: "fixture",
  });
  const screen = spyOn(client, "paneRead").mockResolvedValue({ ...pane, text: "", source: "detection", format: "text", truncated: false });
  const reads = spyOn(fs, "readSync");
  try {
    const sent = { id: "model", text: "/model chosen-model", at, agent: "pi",
      identity: JSON.stringify([pane.terminal_id, undefined]), screen: "", store: null, form: null,
      invocations: commandInvocations("pi", "/model chosen-model", []) };
    noteSubmitted(pane.pane_id, sent.text, sent);
    const url = new URL(`http://localhost/api/pane/prompt?pane_id=${encodeURIComponent(pane.pane_id)}`);
    const response = await handlePromptRequest(new Request(url), url);
    const shown: PanePromptResponse = await response?.json();
    expect(response?.status).toBe(200);
    expect(bytesRead(reads)).toBeLessThanOrEqual(conversation.TRANSCRIPT_WINDOW_BYTES);
    expect(shown.outcomes?.at(-1)).toMatchObject({ state: "result-observed", evidence: [{ kind: "transcript" }] });
  } finally {
    reads.mockRestore();
    screen.mockRestore();
    snapshot.mockRestore();
    binding.mockRestore();
    clock.mockRestore();
    conversation.forgetTranscriptState();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("withholds pi evidence when a missing parent is not explained by a window cutoff", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "outcome-pi-missing-parent-"));
  const path = join(root, "session.jsonl");
  fs.writeFileSync(path, JSON.stringify({ type: "model_change", id: "leaf", parentId: "missing", modelId: "chosen-model" }) + "\n");
  const binding = spyOn(conversation, "paneTranscript").mockResolvedValue({ source: "pi-transcript", path });
  try {
    expect(fs.statSync(path).size).toBeLessThan(conversation.TRANSCRIPT_WINDOW_BYTES);
    expect(await conversation.readCommandTranscript("missing-parent")).toBeNull();
  } finally {
    binding.mockRestore();
    conversation.forgetTranscriptState();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("parses only appended records after validating the entire retained tail", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "outcome-append-budget-"));
  const path = join(root, "session.jsonl");
  const record = (modelId: string) => JSON.stringify({ type: "model_change", modelId }) + "\n";
  fs.writeFileSync(path, record("old").repeat(1000));
  const binding = spyOn(conversation, "paneTranscript").mockResolvedValue({ source: "claude-transcript", path });
  const reads = spyOn(fs, "readSync");
  const parses = spyOn(JSON, "parse");
  try {
    await conversation.readCommandTranscript("append-budget");
    reads.mockClear();
    parses.mockClear();
    fs.appendFileSync(path, record("new"));
    const result = await conversation.readCommandTranscript("append-budget");
    expect(result?.records).toHaveLength(1001);
    expect(parses.mock.calls.length).toBeLessThanOrEqual(5);
    expect(bytesRead(reads)).toBeLessThanOrEqual(conversation.TRANSCRIPT_WINDOW_BYTES);
  } finally {
    parses.mockRestore();
    reads.mockRestore();
    binding.mockRestore();
    conversation.forgetTranscriptState();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("resolves pi evidence only on the fully contained active branch", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "outcome-pi-branch-"));
  const path = join(root, "session.jsonl");
  const entries = [
    { id: "root", parentId: null, type: "model_change", modelId: "root-model" },
    { id: "abandoned", parentId: "root", type: "model_change", modelId: "old-model" },
    { id: "leaf", parentId: "abandoned", type: "message", message: { role: "assistant", content: [] } },
  ];
  fs.writeFileSync(path, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const binding = spyOn(conversation, "paneTranscript").mockResolvedValue({ source: "pi-transcript", path });
  try {
    const first = await conversation.readCommandTranscript("pi-branch");
    expect(first?.records.some(({ entry }) => entry.modelId === "old-model")).toBe(true);
    fs.appendFileSync(path, JSON.stringify({ id: "new", parentId: "root", type: "model_change", modelId: "new-model" }) + "\n");
    const switched = await conversation.readCommandTranscript("pi-branch");
    expect(switched?.identity).not.toBe(first?.identity);
    expect(switched?.records.some(({ entry }) => entry.modelId === "old-model")).toBe(false);
    expect(switched?.records.some(({ entry }) => entry.modelId === "new-model")).toBe(true);
    fs.appendFileSync(path, JSON.stringify({ id: "more", parentId: "new", type: "message", message: { role: "assistant", content: [] } }) + "\n");
    expect((await conversation.readCommandTranscript("pi-branch"))?.identity).toBe(switched?.identity);
  } finally {
    binding.mockRestore();
    conversation.forgetTranscriptState();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("validates the full overlapping tail within budget when the window slides", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "outcome-sliding-window-"));
  const path = join(root, "session.jsonl");
  const record = (modelId: string) => JSON.stringify({ type: "model_change", modelId, padding: "x".repeat(64 * 1024) }) + "\n";
  fs.writeFileSync(path, record("old").repeat(260));
  const binding = spyOn(conversation, "paneTranscript").mockResolvedValue({ source: "claude-transcript", path });
  const reads = spyOn(fs, "readSync");
  const parses = spyOn(JSON, "parse");
  try {
    const first = await conversation.readCommandTranscript("sliding");
    const changedOffset = first!.records[1]!.offset;
    reads.mockClear();
    parses.mockClear();
    fs.appendFileSync(path, '{"type":"model_change","modelId":"new"}\n');
    const appended = await conversation.readCommandTranscript("sliding");
    expect(appended?.records.at(-1)?.entry.modelId).toBe("new");
    expect(parses.mock.calls.length).toBeLessThanOrEqual(5);
    expect(bytesRead(reads)).toBeLessThanOrEqual(conversation.TRANSCRIPT_WINDOW_BYTES);
    const fd = fs.openSync(path, "r+");
    try { fs.writeSync(fd, Buffer.from(record("bad")), 0, Buffer.byteLength(record("bad")), changedOffset); }
    finally { fs.closeSync(fd); }
    fs.appendFileSync(path, '{"type":"model_change","modelId":"end"}\n');
    reads.mockClear();
    parses.mockClear();
    const rewritten = await conversation.readCommandTranscript("sliding");
    expect(rewritten?.records.find(row => row.offset === changedOffset)?.entry.modelId).toBe("bad");
    expect(rewritten?.identity).not.toBe(appended?.identity);
    expect(parses.mock.calls.length).toBeGreaterThan(5);
    expect(bytesRead(reads)).toBeLessThanOrEqual(conversation.TRANSCRIPT_WINDOW_BYTES);
  } finally {
    parses.mockRestore();
    reads.mockRestore();
    binding.mockRestore();
    conversation.forgetTranscriptState();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
