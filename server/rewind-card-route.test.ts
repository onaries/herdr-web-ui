import { afterEach, expect, it, mock, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PanePromptResponse } from "../shared/protocol.ts";
import * as conversation from "./conversation.ts";
import * as client from "./herdr/client.ts";
import { HerdrError, socketAddress } from "./herdr/client.ts";
import { handlePromptRequest } from "./prompt.ts";

afterEach(() => mock.restore());

/** A herdr stand-in serving one Claude pane whose screen the test sets; keys sent to it are kept. */
async function withFakeHerdr(pane: { screen: string }, run: (paneId: string, keys: unknown[]) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-rewind-card-"));
  const socketPath = join(root, "herdr.sock");
  const previous = process.env.HERDR_SOCKET;
  const paneId = "rewind-card-pane";
  const keys: unknown[] = [];
  const server = createServer((socket) => {
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk;
      if (!input.includes("\n")) return;
      const request = JSON.parse(input) as { id: string; method: string; params?: { keys?: unknown; text?: unknown } };
      if (request.method === "pane.send_keys") keys.push(request.params?.keys);
      if (request.method === "pane.send_text") keys.push(request.params?.text);
      const result = request.method === "session.snapshot"
        ? { snapshot: { panes: [{ pane_id: paneId, agent: "claude", agent_status: "idle" }], layouts: [] } }
        : { read: { text: pane.screen } };
      socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketAddress(socketPath), resolve); });
  process.env.HERDR_SOCKET = socketPath;
  try {
    await run(paneId, keys);
  } finally {
    if (previous === undefined) delete process.env.HERDR_SOCKET;
    else process.env.HERDR_SOCKET = previous;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}

const recorded = (name: string): string => readFileSync(new URL(`./fixtures/claude-rewind-2.1.304-${name}-40.txt`, import.meta.url), "utf8");

// Codex #1 on db8d72b5, through the real answer route (independent review D-1): with apple sent twice, the
// newer copy's confirm step can be opened in the terminal after the card for the older one was served
it("answers a rewind Restore card only on the copy it was served for, through the real answer route", async () => {
  const older = recorded("confirm-apple-restore");
  const pane = { screen: older };
  const record = spyOn(conversation, "rewindClaudeTranscript").mockResolvedValue(null);
  await withFakeHerdr(pane, async (paneId, keys) => {
    const url = new URL(`http://localhost/api/pane/prompt?pane_id=${paneId}`);
    const card = (await (await handlePromptRequest(new Request(url), url))?.json() as PanePromptResponse).prompt!;
    expect(card.options.map((option) => option.label)).toEqual(["Restore conversation", "Never mind"]);
    // the newer copy: the same quote, a younger age
    pane.screen = older.replace("(3h ago)", "(2h ago)");
    const answerUrl = new URL("http://localhost/api/pane/prompt/answer");
    const answered = await handlePromptRequest(new Request(answerUrl, { method: "POST", body: JSON.stringify({ pane_id: paneId, prompt_id: card.id, option_index: 0 }) }), answerUrl);
    expect(answered?.status).toBe(409);
    expect(((await answered!.json()) as { error: { code: string } }).error.code).toBe("prompt_changed");
    expect(keys).toEqual([]);
    expect(record).not.toHaveBeenCalled();
  });
});

it("writes the rewind card's Esc only while its requester is still there, herdr's write-time guard included", async () => {
  const pane = { screen: recorded("confirm-apple-restore") };
  await withFakeHerdr(pane, async (paneId) => {
    const url = new URL(`http://localhost/api/pane/prompt?pane_id=${paneId}`);
    const card = (await (await handlePromptRequest(new Request(url), url))?.json() as PanePromptResponse).prompt!;
    const requester = new AbortController();
    const written: string[][] = [];
    // the requester leaves while the key's connection to herdr opens
    spyOn(client, "paneSendKeys").mockImplementation(async (_pane, keys, _socket, guard) => {
      requester.abort();
      if (guard !== undefined && !guard()) throw new HerdrError("cancelled", "herdr pane.send_keys was not sent");
      written.push(keys);
    });
    const answerUrl = new URL("http://localhost/api/pane/prompt/answer");
    await handlePromptRequest(new Request(answerUrl, { method: "POST", signal: requester.signal, body: JSON.stringify({ pane_id: paneId, prompt_id: card.id, option_index: 1 }) }), answerUrl).catch(() => undefined);
    expect(written).toEqual([]);
  });
});
