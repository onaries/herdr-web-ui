import { afterEach, beforeEach, expect, it, mock, setSystemTime, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import * as client from "./herdr/client.ts";
import * as conversation from "./conversation.ts";
import { handlePromptRequest, noteSubmitted, parseInteractivePrompt } from "./prompt.ts";
import { followClaudeRestore, rememberRewind } from "./rewind.ts";
import { commandInvocations } from "./outcome.ts";
import { parsedByPublicPrompt, type ParsedPrompt } from "./dialogs/shared.ts";
import type { PanePromptResponse } from "../shared/protocol.ts";

// the sends' times and the restored message's are set against a clock that stands still
beforeEach(() => setSystemTime(new Date("2026-10-20T10:00:00.000Z")));
afterEach(() => { mock.restore(); setSystemTime(); });

/** The card the reader makes of a recorded confirm step, as the answer route holds it: every field the reader sets. */
function confirmCard(fixture: string): ParsedPrompt {
  const shown = parseInteractivePrompt("claude", readFileSync(new URL(`./fixtures/claude-rewind-2.1.304-${fixture}.txt`, import.meta.url), "utf8"));
  const card = shown === null ? undefined : parsedByPublicPrompt.get(shown);
  if (card === undefined) throw new Error(`${fixture} gives no card`);
  return card;
}

it("forgets the outcomes of the chat's sends after a restore's point, and keeps the ones before it", async () => {
  const start = Date.now() - 60_000;
  const pane = { pane_id: "rewind-outcomes", terminal_id: "terminal", workspace_id: "w", tab_id: "t",
    cwd: "/fixture", focused: false, revision: 0, agent: "claude", agent_status: "idle" };
  spyOn(client, "sessionSnapshot").mockResolvedValue({ panes: [pane], layouts: [], agents: [], workspaces: [], tabs: [], protocol: 22, version: "fixture" });
  // Claude Code right after Restore conversation on apple: the message is back in its input box
  const restored = readFileSync(new URL("./fixtures/claude-rewind-2.1.304-restored-40.txt", import.meta.url), "utf8");
  spyOn(client, "paneRead").mockResolvedValue({ ...pane, text: restored, source: "detection", format: "text", truncated: false });
  spyOn(conversation, "readCommandTranscript").mockResolvedValue({ identity: "fixture", records: [] });
  const send = (id: string, text: string, after: number) => noteSubmitted(pane.pane_id, text, { id, text, at: start + after, agent: "claude", screen: "",
    store: null, identity: JSON.stringify([pane.terminal_id, undefined]), form: null, invocations: commandInvocations("claude", text, []) });
  send("before", "/context", 0);
  send("after", "/context", 30_000);
  const shown = async () => {
    const url = new URL(`http://localhost/api/pane/prompt?pane_id=${pane.pane_id}`);
    return ((await (await handlePromptRequest(new Request(url), url))?.json()) as PanePromptResponse).outcomes?.map(({ id }) => id) ?? [];
  };
  expect(await shown()).toEqual(["before", "after"]);
  // the message restored was written to the transcript between the two sends: the later one was rewound away with it
  spyOn(conversation, "rewindClaudeTranscript").mockResolvedValue({ said: "apple", at: start + 10_000 });
  await followClaudeRestore(pane.pane_id, confirmCard("confirm-apple-restore-40"), 2_000);
  expect(await shown()).toEqual(["before"]);
});

it("records a restore from a dialog the chat did not open only as the message's one copy, never the newest of several", async () => {
  const pane = { pane_id: "rewind-foreign", terminal_id: "terminal", workspace_id: "w", tab_id: "t", cwd: "/fixture", focused: false, revision: 0, agent: "claude", agent_status: "idle" };
  const restored = readFileSync(new URL("./fixtures/claude-rewind-2.1.304-restored-40.txt", import.meta.url), "utf8");
  spyOn(client, "paneRead").mockResolvedValue({ ...pane, text: restored, source: "detection", format: "text", truncated: false });
  const recorded = spyOn(conversation, "rewindClaudeTranscript").mockResolvedValue(null);
  await followClaudeRestore(pane.pane_id, confirmCard("confirm-apple-restore-40"), 2_000);
  expect(recorded.mock.calls).toEqual([[pane.pane_id, "apple", null]]);
});

it("follows a restore of a long message the walk opened by the whole message, not the quote Claude Code cut", async () => {
  const pane = { pane_id: "rewind-long", terminal_id: "terminal", workspace_id: "w", tab_id: "t", cwd: "/fixture", focused: false, revision: 0, agent: "claude", agent_status: "idle" };
  const long = "zeta " + "a long message that keeps going with plenty of words to wrap across several lines in the confirm step ".repeat(6) + "THE END";
  // the confirm step's card quotes the message cut at 500 characters (recorded); the restored box holds all of it
  const lines = readFileSync(new URL("./fixtures/claude-rewind-2.1.304-restored-120.txt", import.meta.url), "utf8").split("\n");
  // the input box's own row (Claude draws it with a no-break space), under the transcript's "❯ apple"
  const box = lines.length - 1 - [...lines].reverse().findIndex((line) => line.replace(/\u00a0/g, " ").trim() === "❯ apple");
  const restored = [...lines.slice(0, box), `❯ ${long}`, ...lines.slice(box + 1)].join("\n");
  spyOn(client, "paneRead").mockResolvedValue({ ...pane, text: restored, source: "detection", format: "text", truncated: false });
  const recorded = spyOn(conversation, "rewindClaudeTranscript").mockResolvedValue(null);
  rememberRewind(pane.pane_id, long, 0);
  await followClaudeRestore(pane.pane_id, confirmCard("confirm-long-610-120"), 2_000);
  expect(recorded.mock.calls).toEqual([[pane.pane_id, long, 0]]);
});

it("follows a card answer as a restore only when the card's first choice is Restore conversation", async () => {
  const pane = { pane_id: "rewind-cancel", terminal_id: "terminal", workspace_id: "w", tab_id: "t", cwd: "/fixture", focused: false, revision: 0, agent: "claude", agent_status: "idle" };
  const restored = readFileSync(new URL("./fixtures/claude-rewind-2.1.304-restored-40.txt", import.meta.url), "utf8");
  spyOn(client, "paneRead").mockResolvedValue({ ...pane, text: restored, source: "detection", format: "text", truncated: false });
  const recorded = spyOn(conversation, "rewindClaudeTranscript").mockResolvedValue(null);
  // the cursor was on Never mind: the card's one choice is Never mind, and option 0 is no restore
  await followClaudeRestore(pane.pane_id, confirmCard("confirm-apple-never-mind-40"), 2_000);
  expect(recorded).not.toHaveBeenCalled();
});
