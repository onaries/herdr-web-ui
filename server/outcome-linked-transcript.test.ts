import { afterEach, expect, it, mock, spyOn } from "bun:test";
import * as client from "./herdr/client.ts";
import * as conversation from "./conversation.ts";
import { handlePromptRequest, noteSubmitted } from "./prompt.ts";
import { commandInvocations, commandOutcome, commandTranscriptRecords, CommandReservations, type CommandSend } from "./outcome.ts";
import type { PanePromptResponse } from "../shared/protocol.ts";

afterEach(() => mock.restore());
const at = Date.parse("2026-10-20T00:00:00Z");

it("leaves one late echo unclaimed when either of two identical sends could have been swallowed", () => {
  const reservations = new CommandReservations();
  const first: CommandSend = { id: "first", text: "/context", at, agent: "claude", screen: "", form: null,
    identity: "fixture", invocations: commandInvocations("claude", "/context", []) };
  const second: CommandSend = { ...first, id: "second", at: at + 10 };
  reservations.add(first, []);
  reservations.add(second, []);
  const records = commandTranscriptRecords([
    { type: "system", subtype: "local_command", uuid: "one-echo", timestamp: new Date(at + 20).toISOString(),
      content: "<command-name>/context</command-name>\n<command-message>context</command-message>" },
    { type: "system", subtype: "local_command", parentUuid: "one-echo", timestamp: new Date(at + 21).toISOString(),
      content: "<local-command-stdout>fixture-output</local-command-stdout>" },
  ].map(entry => JSON.stringify(entry)).join("\n"));
  reservations.observeTranscript("fixture", "store", records, second.id);
  expect(first.transcriptEvidence).toBeUndefined();
  expect(second.transcriptEvidence).toBeUndefined();
});
for (const order of ["forward", "reverse", "unlinked"] as const) {
  for (const chain of order === "unlinked" ? [false] : [false, true]) {
    it(`attributes overlapping Claude echoes in ${order} completion order with ${chain ? "indirect" : "direct"} ancestry`, async () => {
      const pane = { pane_id: `linked-${order}-${chain}`, terminal_id: "terminal", workspace_id: "w", tab_id: "t",
        cwd: "/fixture", focused: false, revision: 0, agent: "claude", agent_status: "idle" };
      spyOn(Date, "now").mockReturnValue(at + 30);
      spyOn(client, "sessionSnapshot").mockResolvedValue({
        panes: [pane], layouts: [], agents: [], workspaces: [], tabs: [], protocol: 22, version: "fixture",
      });
      spyOn(client, "paneRead").mockResolvedValue({ ...pane, text: "", source: "detection", format: "text", truncated: false });
      let text = "";
      spyOn(conversation, "readCommandTranscript").mockImplementation(async () => ({
        identity: "fixture", records: commandTranscriptRecords(text),
      }));
      for (const [index, id] of ["first", "second"].entries()) {
        const sent = { id, text: "/context", at: at + index * 10, agent: "claude", screen: "", store: null,
          identity: JSON.stringify([pane.terminal_id, undefined]), form: null,
          invocations: commandInvocations("claude", "/context", []) };
        noteSubmitted(pane.pane_id, sent.text, sent);
      }
      const poll = async () => {
        const url = new URL(`http://localhost/api/pane/prompt?pane_id=${pane.pane_id}`);
        const shown = await (await handlePromptRequest(new Request(url), url))?.json() as PanePromptResponse;
        return shown.outcomes?.map(({ state }) => state);
      };
      const echoes = [21, 22].map((time) => JSON.stringify({ type: "system", subtype: "local_command",
        timestamp: new Date(at + time).toISOString(), uuid: `echo-${time}`, parentUuid: null,
        content: "<command-name>/context</command-name>\n<command-message>context</command-message>\n<command-args></command-args>" }) + "\n").join("");
      const firstParent = order === "reverse" ? 22 : 21;
      const secondParent = order === "reverse" ? 21 : 22;
      const result = (time: number, parent: number) => (chain
        ? JSON.stringify({ type: "assistant", uuid: `middle-${parent}`, parentUuid: `echo-${parent}` }) + "\n" : "")
        + JSON.stringify({ type: "system", subtype: "local_command",
          timestamp: new Date(at + time).toISOString(), uuid: `stdout-${time}`,
          ...(order === "unlinked" ? {} : { parentUuid: `${chain ? "middle" : "echo"}-${parent}` }),
          content: "<local-command-stdout>fixture-output</local-command-stdout>" }) + "\n";
      text = echoes + result(23, firstParent);
      expect(await poll()).toEqual(order === "reverse" ? ["unknown", "result-observed"] : ["result-observed", "accepted"]);
      text += result(24, secondParent);
      expect(await poll()).toEqual(["result-observed", "result-observed"]);
      expect(await poll()).toEqual(["result-observed", "result-observed"]);
    });
  }
}

for (const parent of ["missing", "cycle", "version"]) {
  it(`does not fall back to FIFO when stdout has ${parent} ancestry`, () => {
    const sent = { id: "context", text: "/context", at, agent: "claude", identity: "fixture", screen: "", form: null,
      invocations: commandInvocations("claude", "/context", []) };
    const records = [
      { type: "system", subtype: "local_command", uuid: "version", timestamp: new Date(at + 1).toISOString(),
        content: "<command-name>/version</command-name>\n<command-message>version</command-message>" },
      { type: "system", subtype: "local_command", uuid: "context", timestamp: new Date(at + 2).toISOString(),
        content: "<command-name>/context</command-name>\n<command-message>context</command-message>" },
      { type: "assistant", uuid: "cycle", parentUuid: "cycle" },
      { type: "system", subtype: "local_command", parentUuid: parent, timestamp: new Date(at + 3).toISOString(),
        content: "<local-command-stdout>fixture-output</local-command-stdout>" },
    ];
    expect(commandOutcome("pane", sent, { now: at + 10, transcript: records.map((entry) => JSON.stringify(entry)).join("\n") }))
      .toMatchObject({ state: "accepted", evidence: [] });
  });
}

it("does not use unlinked stdout after an unrelated native user message", () => {
  const sent = { id: "context", text: "/context", at, agent: "claude", identity: "fixture", screen: "", form: null,
    invocations: commandInvocations("claude", "/context", []) };
  const records = [
    { type: "system", subtype: "local_command", timestamp: new Date(at + 1).toISOString(),
      content: "<command-name>/context</command-name>\n<command-message>context</command-message>" },
    { type: "user", timestamp: new Date(at + 2).toISOString(), message: { content: "fixture-unrelated-message" } },
    { type: "system", subtype: "local_command", timestamp: new Date(at + 3).toISOString(),
      content: "<local-command-stdout>fixture-output</local-command-stdout>" },
  ];
  expect(commandOutcome("pane", sent, { now: at + 10, transcript: records.map((entry) => JSON.stringify(entry)).join("\n") }))
    .toMatchObject({ state: "accepted", evidence: [] });
});

it.each([false, true])("does not give an ambiguous terminal echo's result to Chat (reserved earlier: %s)", async (reserved) => {
  const pane = { pane_id: `ambiguous-linked-${reserved}`, terminal_id: "terminal", workspace_id: "w", tab_id: "t",
    cwd: "/fixture", focused: false, revision: 0, agent: "claude", agent_status: "idle" };
  spyOn(Date, "now").mockReturnValue(at + 30);
  spyOn(client, "sessionSnapshot").mockResolvedValue({
    panes: [pane], layouts: [], agents: [], workspaces: [], tabs: [], protocol: 22, version: "fixture",
  });
  spyOn(client, "paneRead").mockResolvedValue({ ...pane, text: "", source: "detection", format: "text", truncated: false });
  const text = [
    ...[["terminal", 10], ["chat", 20]].map(([id, time]) => ({ type: "system", subtype: "local_command",
      uuid: id, timestamp: new Date(at + Number(time)).toISOString(),
      content: "<command-name>/context</command-name>\n<command-message>context</command-message>" })),
    { type: "system", subtype: "local_command", uuid: "output", parentUuid: "terminal",
      timestamp: new Date(at + 21).toISOString(), content: "<local-command-stdout>terminal-output</local-command-stdout>" },
  ].map(entry => JSON.stringify(entry)).join("\n");
  let shownText = reserved ? text.split("\n")[0]! : text;
  spyOn(conversation, "readCommandTranscript").mockImplementation(async () => ({ identity: "fixture", records: commandTranscriptRecords(shownText) }));
  const sent = { id: "ambiguous", text: "/context", at, agent: "claude", screen: "", store: null, form: null,
    identity: JSON.stringify([pane.terminal_id, undefined]), invocations: commandInvocations("claude", "/context", []) };
  noteSubmitted(pane.pane_id, sent.text, sent);
  const url = new URL(`http://localhost/api/pane/prompt?pane_id=${pane.pane_id}`);
  if (reserved) {
    const before = await (await handlePromptRequest(new Request(url), url))?.json() as PanePromptResponse;
    expect(before.outcomes).toMatchObject([{ state: "accepted", evidence: [] }]);
    shownText = text;
  }
  const shown = await (await handlePromptRequest(new Request(url), url))?.json() as PanePromptResponse;
  expect(shown.outcomes).toMatchObject([{ state: "accepted", evidence: [] }]);
});
