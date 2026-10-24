import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PanePromptResponse } from "../../shared/protocol.ts";
import * as client from "../herdr/client.ts";
import * as conversation from "../conversation.ts";
import { createSubmitText } from "./composer.ts";
import { handlePromptRequest } from "../prompt.ts";
import { commandInvocations, commandOutcome, CommandReservations, type CommandSend } from "../outcome.ts";
import { paneCommands } from "../commands.ts";
import { registry } from "../dialogs/registry.ts";
import { findLastIndex } from "../dialogs/shared.ts";

// Hermes 0.21.5 in a 120x40 herdr 0.9.5 pane (isolated HERMES_HOME, fake key), /status sent six times in a row with
// agent.prompt. Each send keeps the detection read taken right before it (with the visible ANSI read the composer takes to
// tell Hermes's dimmed placeholder from a draft) and the one taken after its block printed, each with the viewport's top
// row in the pane's history (max_offset_from_bottom - offset_from_bottom), the same before and after the read. From the
// third send on the earlier blocks fill the screen; from the fourth, a send's two reads, and the next send's, differ only
// in the status bar's clock: only the history moved.
type Read = { top: number; screen: string; colors?: string };
type Recorded = { sends: { sent: Read; after: Read }[] };
const load = (name: string): Recorded =>
  JSON.parse(readFileSync(join(import.meta.dir, "..", "fixtures", "hermes-results", `${name}.json`), "utf8")) as Recorded;
const recorded = load("status-repeat-120");
// A fresh Hermes 0.21.5 pane (120x40, same setup) on a loaded host, /status sent three times from a Chat page that had
// just attached its terminal. Hermes redrew its input area for that attach: the first send's detection read shows the
// input line alone, without the status bar and rules around it. The reads after each send are the screens once the block printed.
const redrawn = load("status-first-redraw-120");

afterEach(() => mock.restore());

/** The block under the last /status echo of a read, as Chat shows it. */
const ownBlock = (read: Read): string => {
  const lines = read.screen.split("\n");
  const echo = findLastIndex(lines, (line) => line === "⚙️  /status");
  return lines.slice(echo + 1, lines.findIndex((line, at) => at > echo && line.startsWith("Agent Running: ")) + 1).join("\n");
};

/** The composer's send and the prompt route, over a herdr that shows `shown` and reports its history row. */
function hermesPane(paneId: string, first: Read = recorded.sends[0]!.sent) {
  let shown: Read = first;
  // rows another device has the terminal scrolled up by: herdr's detection read stays on the live screen
  let scrolledUp = 0;
  const pane = () => ({
    pane_id: paneId, workspace_id: "w", tab_id: "t", terminal_id: `${paneId}-terminal`, cwd: "/fixture", focused: false, revision: 0,
    agent: "hermes", agent_status: "idle" as const, scroll: { max_offset_from_bottom: shown.top, offset_from_bottom: scrolledUp, viewport_rows: 40 },
  });
  spyOn(client, "paneGet").mockImplementation(async () => pane());
  spyOn(client, "paneScrollInfo").mockImplementation(async () => pane().scroll);
  // each send's process binding: no foreground process, without asking a herdr
  spyOn(client, "paneProcessInfo").mockResolvedValue(undefined);
  spyOn(client, "sessionSnapshot").mockImplementation(async () => ({
    panes: [pane()], layouts: [], agents: [], workspaces: [], tabs: [], protocol: 22, version: "fixture",
  }));
  spyOn(client, "paneRead").mockImplementation(async ({ source = "visible", format = "text" }) => ({
    ...pane(), text: format === "ansi" ? shown.colors ?? shown.screen : shown.screen, source, format, truncated: false,
  }));
  const delivered = spyOn(client, "agentPrompt").mockResolvedValue();
  spyOn(conversation, "paneProcessRoots").mockResolvedValue({ omo: null, environ: null, pid: null, cwd: null });
  spyOn(conversation, "paneTranscript").mockRejectedValue(new Error("fixture: no native binding"));
  spyOn(conversation, "readCommandTranscript").mockResolvedValue(null);
  const submit = createSubmitText({
    options: { submitDelayMs: 0 }, lastTyped: new Map(), attachments: new Map(), terminalAttach: async () => true,
    SUBMIT_DEADLINE_MS: 5000, TYPED_SETTLE_MS: 0, DRAFT_CLEAR_WAIT_MS: 0, DRAFT_CLEAR_POLL_MS: 0, SUBMIT_DELAY_MS: 0,
  });
  const url = new URL(`http://localhost/api/pane/prompt?pane_id=${paneId}`);
  return {
    delivered,
    show(read: Read, scrolled = 0) { shown = read; scrolledUp = scrolled; },
    send: async () => await submit(paneId, "/status", "/status", Date.now()),
    outcomes: async () => (await (await handlePromptRequest(new Request(url), url))?.json() as PanePromptResponse).outcomes ?? [],
  };
}

it("gives each /status sent to one Hermes pane its own result, from the block under its own echo (F3 D1)", async () => {
  const pane = hermesPane("hermes-repeat-status");
  for (const [index, { sent, after }] of recorded.sends.entries()) {
    pane.show(sent);
    await pane.send();
    expect(pane.delivered).toHaveBeenCalledTimes(index + 1);
    // echoed nothing yet: whatever the earlier sends left on screen is theirs, even when it reads the same
    const waiting = await pane.outcomes();
    // a pane shows its five newest outcomes
    expect(waiting).toHaveLength(Math.min(index + 1, 5));
    expect(waiting.at(-1)?.state).toBe("accepted");
    pane.show(after);
    const shown = await pane.outcomes();
    expect(shown.at(-1)).toMatchObject({ state: "result-observed", evidence: [{ kind: "recognized-result" }] });
    const lines = after.screen.split("\n");
    const echo = findLastIndex(lines, (line) => line === "⚙️  /status");
    expect(shown.at(-1)?.result_text).toBe(lines.slice(echo + 1, lines.findIndex((line, at) => at > echo && line.startsWith("Agent Running: ")) + 1).join("\n"));
    // the earlier sends keep the results they had
    expect(shown.map((outcome) => outcome.state)).toEqual(shown.map(() => "result-observed"));
  }
});

it("does not resolve a later /status from the earlier block when nothing new printed", async () => {
  const pane = hermesPane("hermes-repeat-silent");
  const [third, fourth] = recorded.sends.slice(2) as [{ sent: Read; after: Read }, { sent: Read; after: Read }];
  pane.show(third.sent);
  await pane.send();
  pane.show(third.after);
  expect((await pane.outcomes()).at(-1)?.state).toBe("result-observed");
  // another /status, and the pane printed nothing: still the three blocks at the same history row
  expect(fourth.sent.top).toBe(third.after.top);
  pane.show(fourth.sent);
  await pane.send();
  const silent = await pane.outcomes();
  expect(silent).toHaveLength(2);
  expect(silent.at(-1)?.state).toBe("accepted");
  expect(silent.at(-1)).not.toHaveProperty("result_text");
});

it("owns a fresh pane's first /status, read while Hermes redrew its input area for a terminal that attached (F3 r2 D1)", async () => {
  const pane = hermesPane("hermes-first-redraw", redrawn.sends[0]!.sent);
  // the input line alone at the bottom: neither the status bar nor the rules were drawn yet
  expect(redrawn.sends[0]!.sent.screen.trimEnd().split("\n").at(-1)).toStartWith("❯ ");
  for (const [index, { sent, after }] of redrawn.sends.entries()) {
    pane.show(sent);
    await pane.send();
    pane.show(after);
    const shown = await pane.outcomes();
    expect(shown).toHaveLength(index + 1);
    expect(shown.at(-1)).toMatchObject({ state: "result-observed", result_text: ownBlock(after) });
  }
});

it("owns its /status block while another device has the terminal scrolled up: herdr's detection read is the live screen", async () => {
  const pane = hermesPane("hermes-scrolled-device", recorded.sends[3]!.sent);
  for (const { sent, after } of recorded.sends.slice(3)) {
    pane.show(sent);
    await pane.send();
    // the history moved by one block, and a phone scrolled its terminal up by as much
    pane.show(after, 12);
    expect((await pane.outcomes()).at(-1)).toMatchObject({ state: "result-observed", result_text: ownBlock(after) });
  }
});

describe("a /status whose earlier /status lost its anchor", () => {
  const rows = paneCommands("hermes", null, "/nonexistent-home");
  const readers = registry.readersFor("hermes");
  const at = Date.parse("2026-10-21T00:00:00Z");
  const send = (ledger: CommandReservations, read: Read, offset: number, screen = read.screen): CommandSend => {
    const invocations = commandInvocations("hermes", "/status", rows);
    const sent: CommandSend = { id: `send-${offset}`, text: "/status", at: at + offset * 1000, agent: "hermes", identity: "hermes-pane",
      screen, top: read.top, invocations, form: invocations[0]?.form ?? null };
    ledger.add(sent, readers);
    return sent;
  };
  const observe = (sent: CommandSend, read: Read, nextAt?: number) =>
    (sent.outcome = commandOutcome("pane-1", sent, { now: sent.at + 500, screen: read.screen, top: read.top, readers, ...(nextAt === undefined ? {} : { nextAt }) }));
  // the earlier send's read torn at its last line, so its tail is never found again
  const torn = (read: Read): string => read.screen.replace(/Agent Running: No(\n ☤ )/u, "Agent Run$1");
  const [, , third, fourth, fifth] = recorded.sends as [unknown, unknown, { sent: Read; after: Read }, { sent: Read; after: Read }, { sent: Read; after: Read }];

  it("lets each later send on a stable screen own its own block once the earlier block is complete on its screen", () => {
    const ledger = new CommandReservations();
    const lost = send(ledger, third.sent, 0, torn(third.sent));
    expect(observe(lost, third.after).state).toBe("accepted");
    // the next send's screen shows the lost send's block complete: what echoes after it is this send's
    const next = send(ledger, fourth.sent, 1);
    expect(observe(lost, fourth.sent, next.at).state).toBe("unknown");
    expect(observe(next, fourth.after)).toMatchObject({ state: "result-observed", result_text: ownBlock(fourth.after) });
    const last = send(ledger, fifth.sent, 2);
    expect(observe(last, fifth.after)).toMatchObject({ state: "result-observed", result_text: ownBlock(fifth.after) });
  });

  it("keeps a later send unclaimed while the earlier send's block could still be the one it echoes", () => {
    const ledger = new CommandReservations();
    const lost = send(ledger, third.sent, 0, torn(third.sent));
    // sent before the lost send's echo printed: one new block later cannot tell the two apart
    const next = send(ledger, third.sent, 1);
    expect(observe(next, third.after).state).toBe("accepted");
    expect(observe(next, fourth.after).state).toBe("accepted");
    expect(observe(lost, fourth.after, next.at).state).toBe("unknown");
    // and a send whose screen kept no history row proves nothing either (no row: no place for the earlier screen)
    const rowless = new CommandReservations();
    send(rowless, third.sent, 3, torn(third.sent));
    const blind = send(rowless, { ...fourth.sent, top: undefined as unknown as number }, 4);
    expect(observe(blind, fourth.after).state).toBe("accepted");
  });

  it("lets the repeats after a lost send whose scroll reads disagreed own their blocks on a screen of identical blocks (#1550)", () => {
    // a full screen of identical /status blocks; each send's block moves the history 12 rows
    const at = (top: number): Read => ({ ...fifth.sent, top });
    const ledger = new CommandReservations();
    const known = send(ledger, at(55), 0);
    expect(observe(known, at(67)).state).toBe("result-observed");
    // Hermes redrew its input area right before agent.prompt: the send's two scroll reads disagreed, so it kept no row
    const lost = send(ledger, { ...fifth.sent, top: undefined as unknown as number }, 1);
    expect(observe(lost, at(79)).state).toBe("accepted");
    const next = send(ledger, at(79), 2);
    observe(lost, at(79), next.at);
    expect(observe(next, at(91)).state).toBe("result-observed");
  });

  it("counts every earlier send a later one may owe, not only the one whose count is known", () => {
    const ledger = new CommandReservations();
    const known = send(ledger, third.sent, 0);
    // a send made before the known send's block printed, whose screen and row were lost: its block prints later
    const pending = send(ledger, { ...third.sent, top: undefined as unknown as number }, 1, "");
    expect(pending.resultEchoes?.["hermes-status"]).toBeNull();
    expect(observe(known, third.after)).toMatchObject({ state: "result-observed", result_text: ownBlock(third.after) });
    // the next send's screen shows only the known send's block complete: two blocks are owed before its own
    const next = send(ledger, third.after, 2);
    expect(observe(next, third.after).state).toBe("accepted");
    // the pending send's block prints: it is not the next send's
    expect(observe(next, fourth.after).state).toBe("accepted");
  });
});
