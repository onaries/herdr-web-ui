import { describe, expect, it, spyOn } from "bun:test";
import * as client from "./herdr/client.ts";
import { HerdrError } from "./herdr/client.ts";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaneRewindResponse } from "../shared/protocol.ts";
import { socketAddress } from "./herdr/client.ts";
import { handlePaneRequest } from "./pane-routes.ts";
import { handleRewindRequest, restoredOnScreen, walkClaudeRewind, type RewindIo } from "./rewind.ts";
import { parseClaudeRewindConfirm } from "./dialogs/claude.ts";
import { configureClaudeRewinds, observeClaudeIdentity, rewindClaudeTranscriptAt } from "./conversation.ts";
import { chatOwnedInput, lastChatSubmitted } from "./prompt.ts";
import { writeFileSync } from "node:fs";

/** Claude Code 2.1.304's /rewind at 40 columns, recorded (server/fixtures) */
const screen = (name: string): string => readFileSync(new URL(`./fixtures/claude-rewind-2.1.304-${name}-40.txt`, import.meta.url), "utf8");

/**
 * Claude Code 2.1.304's confirm step with the cursor on each of its four rows, recorded at 40 columns:
 * on the two Summarize rows the row turns into an add-context field ("Summarize from here: add
 * context (optional)") under its own note, which typed text and Enter go to.
 */
const CONFIRM_ROWS = ["confirm-apple-restore", "confirm-apple-summarize-from", "confirm-apple-summarize-up-to", "confirm-apple-never-mind"];

/** The recorded confirm step with the cursor on `choice`, quoting what `base` quotes. */
function confirmAt(base: string, choice: number): string {
  const quote = base.split("\n").filter((line) => line.startsWith("   │ "));
  const lines = screen(CONFIRM_ROWS[choice]!).split("\n");
  const from = lines.findIndex((line) => line.startsWith("   │ "));
  const to = lines.length - 1 - [...lines].reverse().findIndex((line) => line.startsWith("   │ "));
  return [...lines.slice(0, from), ...quote, ...lines.slice(to + 1)].join("\n");
}

/** The recorded list at 40 columns (select-long), its rows replaced: `labels` as a pane that narrow shows them, the cursor on `cursor`. */
function listScreen(labels: string[], cursor: number): string {
  const recorded = screen("select-long");
  const head = recorded.slice(0, recorded.indexOf("   Restore the code"));
  const rows = labels.map((label, index) => `   ${index === cursor ? "❯" : " "} ${label}${label === "(current)" ? "" : "\n     ⚠ No code restore"}`).join("\n\n");
  return `${head}   Restore the code and/or\n   conversation to the point before…\n\n${rows}\n\n   Enter to continue · Esc to cancel\n`;
}

/** The recorded confirm step at 40 columns (confirm-long), quoting `message` instead. */
function confirmScreen(message: string): string {
  const recorded = screen("confirm-long");
  const from = recorded.indexOf("   │ ");
  return `${recorded.slice(0, from)}   │ ${message}\n${recorded.slice(recorded.indexOf("   │ (3h ago)"))}`;
}

type DialogState = { at: "closed" } | { at: "list"; row: number } | { at: "confirm"; row: number; choice: number } | { at: "restored" | "summarized"; row: number };

/**
 * The dialog as the recordings show it: the list's screen for each row the cursor is on, the
 * confirm step for some of them, ↑/↓ moving the cursor (on the list, and over the confirm step's
 * recorded rows), Enter on a row opening its confirm step, Enter on the confirm step taking the
 * choice under the cursor ("Never mind" goes back to the same row, Restore conversation restores, a
 * Summarize row summarizes), Esc on the confirm step going back to the list's same row, Esc on the
 * list closing it. herdr's prompt types its text and Enter: over an open dialog, only the Enter
 * lands. `interfere` runs after each key, for a key the walker did not send.
 */
function dialogModel(rowCount: number, list: (row: number) => string, confirm: (row: number) => string | undefined, interfere?: (key: string, press: (key: string) => void) => void) {
  let state: DialogState = { at: "closed" };
  const sent: string[] = [];
  const read = (): string => state.at === "confirm" ? confirmAt(confirm(state.row)!, state.choice)
    : state.at === "list" ? list(state.row) : state.at === "restored" ? screen("restored") : screen("closed");
  const apply = (key: string): void => {
    if (state.at === "list") {
      if (key === "up") state = { at: "list", row: Math.max(0, state.row - 1) };
      else if (key === "down") state = { at: "list", row: Math.min(rowCount - 1, state.row + 1) };
      else if (key === "esc") state = { at: "closed" };
      else if (key === "enter" && confirm(state.row) !== undefined) state = { at: "confirm", row: state.row, choice: 0 };
    } else if (state.at === "confirm") {
      if (key === "down") state = { ...state, choice: Math.min(3, state.choice + 1) };
      else if (key === "up") state = { ...state, choice: Math.max(0, state.choice - 1) };
      // Esc goes back to the list on the same row, from any of the four rows (recorded)
      else if (key === "esc") state = { at: "list", row: state.row };
      else if (key === "enter") state = state.choice === 3 ? { at: "list", row: state.row } : { at: state.choice === 0 ? "restored" : "summarized", row: state.row };
    }
  };
  const press = (key: string): void => { sent.push(key); apply(key); interfere?.(key, apply); };
  const io: RewindIo = {
    read: async () => read(),
    keys: async (keys) => { for (const key of keys) press(key); },
    command: async (text) => {
      sent.push(text);
      if (state.at === "closed" && text === "/rewind") state = { at: "list", row: rowCount - 1 };
      else if (state.at !== "closed") apply("enter");
    },
  };
  return { io, sent, state: () => state };
}

/** The recorded fruit and long-message dialogs, a recorded screen per row. */
function recordedDialog(rows: string[], confirms: Record<number, string>, interfere?: (key: string, press: (key: string) => void) => void) {
  return dialogModel(rows.length, (row) => screen(rows[row]!), (row) => confirms[row] === undefined ? undefined : screen(confirms[row]!), interfere);
}

/** A dialog over `messages` (oldest first), each row cut to `width` characters as a narrow pane cuts it, from the recorded layouts. */
function narrowDialog(messages: string[], width: number, interfere?: (key: string, press: (key: string) => void) => void, confirms: Record<number, string> = {}) {
  const labels = [...messages.map((message) => message.length > width ? `${message.slice(0, width - 1)}…` : message), "(current)"];
  return dialogModel(labels.length, (row) => listScreen(labels, row), (row) => confirms[row] ?? (row < messages.length ? confirmScreen(messages[row]!) : undefined), interfere);
}

const fruit = () => recordedDialog(["after-never-mind", "select-banana", "select-current"], { 0: "confirm-apple" });
const LONG = "please describe the history of the cherry orchard near the river in some detail";
const long = () => recordedDialog(["select-long-apple", "select-long", "select-long-banana", "select-long-current"], { 1: "confirm-long" });

describe("walking Claude Code's rewind list", () => {
  it("moves up to the message and opens its confirm step", async () => {
    const dialog = fruit();
    expect(await walkClaudeRewind(dialog.io, "apple", 0)).toBe("shown");
    expect(dialog.sent).toEqual(["/rewind", "up", "up", "enter"]);
    expect(dialog.state()).toEqual({ at: "confirm", row: 0, choice: 0 });
  });

  it("finds a message the narrow list cuts short, by the confirm step's quote", async () => {
    const dialog = long();
    expect(await walkClaudeRewind(dialog.io, LONG, 0)).toBe("shown");
    expect(dialog.sent).toEqual(["/rewind", "up", "up", "enter"]);
  });

  it("goes back to the list when a cut row was another message, and closes the list when none is left", async () => {
    const dialog = long();
    expect(await walkClaudeRewind(dialog.io, "please describe the history of something else", 0)).toBe("not_found");
    // back to the list with Esc (recorded), never over the confirm step's rows
    expect(dialog.sent).toEqual(["/rewind", "up", "up", "enter", "esc", "up", "esc"]);
    expect(dialog.state()).toEqual({ at: "closed" });
  });

  it("walks past newer messages with the same words", async () => {
    const dialog = fruit();
    expect(await walkClaudeRewind(dialog.io, "apple", 1)).toBe("not_found");
    expect(dialog.sent).toEqual(["/rewind", "up", "up", "esc"]);
  });

  // HIGH 3 (merge pass r1) and CodeRabbit 4332440008: a narrow pane cuts A, A and B to the same row
  const OTHER = "please describe the history of the old mill by the river";
  it("opens the older of two same messages past a third the narrow list cuts the same, by each cut row's quote ([A, A, B])", async () => {
    const dialog = narrowDialog([LONG, LONG, OTHER], 31);
    expect(await walkClaudeRewind(dialog.io, LONG, 1)).toBe("shown");
    expect(dialog.state()).toEqual({ at: "confirm", row: 0, choice: 0 });
    // B's and the newer A's confirm steps were left with Esc: no Down, so no add-context field
    expect(dialog.sent.filter((key) => key === "down")).toEqual([]);
    expect(dialog.sent.filter((key) => key === "esc")).toHaveLength(2);
  });

  it("counts only the same message's cut rows as the newer copies ([A, B, A])", async () => {
    const older = narrowDialog([LONG, OTHER, LONG], 31);
    expect(await walkClaudeRewind(older.io, LONG, 1)).toBe("shown");
    expect(older.state()).toEqual({ at: "confirm", row: 0, choice: 0 });
    const newer = narrowDialog([LONG, OTHER, LONG], 31);
    expect(await walkClaudeRewind(newer.io, LONG, 0)).toBe("shown");
    expect(newer.state()).toEqual({ at: "confirm", row: 2, choice: 0 });
    const missing = narrowDialog([OTHER, LONG], 31);
    expect(await walkClaudeRewind(missing.io, LONG, 1)).toBe("not_found");
    expect(missing.state()).toEqual({ at: "closed" });
  });

  // Codex on db8d72b5 (2): a message that itself ends in "…" reads as exactly what a longer one is cut to
  it("opens and compares a row ending in \"…\" even when it reads as the message itself", async () => {
    const ending = "please describe the history of…";
    const longer = "please describe the history of the mill, the river and the town around them";
    const dialog = narrowDialog([ending, ending, longer], 31);
    expect(await walkClaudeRewind(dialog.io, ending, 1)).toBe("shown");
    expect(dialog.state()).toEqual({ at: "confirm", row: 0, choice: 0 });
  });

  // HIGH 4 (merge pass r1): backing out of another message's confirm step
  it("backs out of a confirm step with Esc alone, one key at a time, never over its rows", async () => {
    const dialog = long();
    const batches: string[][] = [];
    const io: RewindIo = { ...dialog.io, keys: async (keys) => { batches.push(keys); await dialog.io.keys(keys); } };
    expect(await walkClaudeRewind(io, "please describe the history of something else", 0)).toBe("not_found");
    expect(batches.every((keys) => keys.length === 1)).toBe(true);
    expect(batches.flat()).not.toContain("down");
    expect(dialog.state()).toEqual({ at: "closed" });
  });

  it("chooses nothing once a key it did not send moved the list under it, and leaves no dialog open", async () => {
    let moved = false;
    const dialog = narrowDialog([LONG, OTHER], 31, (key, apply) => { if (key === "esc" && !moved) { moved = true; apply("down"); } });
    expect(await walkClaudeRewind(dialog.io, "please describe the history of something else", 0, 60)).toBe("changed");
    // the only Enter is the one that opened B's confirm step; Esc closes what is left
    expect(dialog.sent.filter((key) => key === "enter")).toEqual(["enter"]);
    expect(dialog.state()).toEqual({ at: "closed" });
  });

  // R1-NEW-3: Claude Code cuts a long quote at 500 characters, with no mark (recorded, 610 characters)
  const LONG_610 = "zeta " + "a long message that keeps going with plenty of words to wrap across several lines in the confirm step ".repeat(6) + "THE END";
  const cut = (unambiguous?: () => Promise<boolean>) => {
    const dialog = narrowDialog(["first", LONG_610], 31, undefined, { 1: screen("confirm-long-610") });
    return { dialog, io: unambiguous ? { ...dialog.io, unambiguous } : dialog.io };
  };
  it("opens a long message whose quote Claude Code cuts when no other message starts the same", async () => {
    const { dialog, io } = cut(async () => true);
    expect(await walkClaudeRewind(io, LONG_610, 0)).toBe("shown");
    expect(dialog.state()).toEqual({ at: "confirm", row: 1, choice: 0 });
  });

  it("refuses a long message whose cut quote another message may share, and closes the dialog", async () => {
    for (const unambiguous of [async () => false, undefined]) {
      const { dialog, io } = cut(unambiguous);
      expect(await walkClaudeRewind(io, LONG_610, 0)).toBe("ambiguous");
      expect(dialog.state()).toEqual({ at: "closed" });
      expect(dialog.sent).not.toContain("down");
    }
  });

  it("refuses a message as long as Claude Code's cut that a longer one starts with, rather than opening the longer", async () => {
    // the 610-character message's recorded quote, cut at 500: a message of exactly those words reads the same
    const quote = parseClaudeRewindConfirm(screen("confirm-long-610"))!.message;
    const dialog = narrowDialog([quote, LONG_610], 31, undefined, { 1: screen("confirm-long-610") });
    expect(await walkClaudeRewind({ ...dialog.io, unambiguous: async () => false }, quote, 0)).toBe("ambiguous");
    expect(dialog.state()).toEqual({ at: "closed" });
  });

  it("sends nothing more once the dialog does not show what a key did", async () => {
    const dialog = fruit();
    const io: RewindIo = { ...dialog.io, command: async (text) => { dialog.sent.push(text); } };
    expect(await walkClaudeRewind(io, "apple", 0, 60)).toBe("changed");
    expect(dialog.sent).toEqual(["/rewind"]);
  });
});

/** A herdr stand-in for one pane: the recorded dialog answers its reads, keys and prompts. */
async function withHerdr(pane: { agent: string; status: string }, dialog: ReturnType<typeof recordedDialog>, run: (paneId: string, prompts: string[]) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-rewind-"));
  const socketPath = join(root, "herdr.sock");
  const previous = process.env.HERDR_SOCKET;
  const paneId = "rewind-pane";
  const prompts: string[] = [];
  const server = createServer((socket) => {
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk;
      if (!input.includes("\n")) return;
      const request = JSON.parse(input) as { id: string; method: string; params?: { keys?: string[]; text?: string } };
      void (async () => {
        let result: unknown = {};
        if (request.method === "pane.get") result = { pane: { pane_id: paneId, agent: pane.agent, agent_status: pane.status, cwd: root } };
        else if (request.method === "pane.read") result = { read: { text: await dialog.io.read() } };
        else if (request.method === "pane.send_keys") await dialog.io.keys(request.params?.keys ?? []);
        else if (request.method === "agent.prompt") { prompts.push(request.params?.text ?? ""); await dialog.io.command(request.params?.text ?? ""); }
        socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
      })();
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketAddress(socketPath), resolve); });
  process.env.HERDR_SOCKET = socketPath;
  try {
    await run(paneId, prompts);
  } finally {
    if (previous === undefined) delete process.env.HERDR_SOCKET;
    else process.env.HERDR_SOCKET = previous;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}

const rewind = async (body: unknown): Promise<[number, unknown]> => {
  const url = new URL("http://localhost/api/pane/rewind");
  const response = (await handlePaneRequest(new Request(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), url, "/api/pane/rewind", {}))!;
  return [response.status, await response.json()];
};

describe("the box a restore filled, before the next send empties it (core/composer.ts freeClaudeBox)", () => {
  it("is the chat's own only for the Claude process that restored it", async () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-rewind-owner-"));
    try {
      const records = readFileSync(new URL("./fixtures/claude-rewind-2.1.304-fork.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean);
      const path = join(root, "session.jsonl");
      writeFileSync(path, `${records.slice(0, records.findIndex((line) => line.includes('"content":"cherry"'))).join("\n")}\n`);
      observeClaudeIdentity(path, 4242);
      expect(rewindClaudeTranscriptAt(path, "apple", 0, { pid: 4242, paneId: "owner-pane" })).toBe("apple");
      // the restored words are not the chat's last send: only the identity-bound owner offers them
      expect(lastChatSubmitted("owner-pane")).toBeNull();
      // another Claude process on the pane: the box holds nothing the chat may clear
      observeClaudeIdentity(path, 4343);
      expect(await chatOwnedInput("owner-pane")).toBeNull();
    } finally {
      configureClaudeRewinds(null);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Claude Code after Restore conversation", () => {
  const recorded = (name: string): string => readFileSync(new URL(`./fixtures/claude-rewind-2.1.304-${name}.txt`, import.meta.url), "utf8");
  for (const width of [40, 120]) {
    it(`sees the message back in Claude's input box at ${width} columns`, () => {
      expect(restoredOnScreen(recorded(`restored-${width}`), "apple")).toBe(true);
      expect(restoredOnScreen(recorded(`restored-${width}`), "banana")).toBe(false);
      // the first Esc only arms the clear ("Esc again to clear"); the second empties the box
      expect(restoredOnScreen(recorded(`restored-esc-${width}`), "apple")).toBe(true);
      expect(restoredOnScreen(recorded(`restored-cleared-${width}`), "apple")).toBe(false);
      expect(restoredOnScreen(recorded(`confirm-apple-${width}`), "apple")).toBe(false);
    });
  }
});

describe("POST /api/pane/rewind", () => {
  it("opens Claude Code's confirm step for the message", async () => {
    const dialog = fruit();
    await withHerdr({ agent: "claude", status: "idle" }, dialog, async (paneId, prompts) => {
      expect(await rewind({ pane_id: paneId, text: "apple" })).toEqual([200, { ok: true, outcome: "interaction-required" } satisfies PaneRewindResponse]);
      expect(prompts).toEqual(["/rewind"]);
      expect(dialog.state()).toEqual({ at: "confirm", row: 0, choice: 0 });
    });
  });

  it("refuses grok and agy, whose input box nothing here reads, over a draft or not", async () => {
    for (const agent of ["grok", "agy"]) {
      for (const box of ["", "half a thought"]) {
        const dialog = fruit();
        const io = { ...dialog.io, read: async () => `\n\n\n> ${box}\n` };
        await withHerdr({ agent, status: "done" }, { ...dialog, io }, async (paneId, prompts) => {
          expect(await rewind({ pane_id: paneId, text: "apple" })).toEqual([409, { error: expect.objectContaining({ code: "input_draft" }) }]);
          expect(prompts).toEqual([]);
          expect(dialog.sent).toEqual([]);
        });
      }
    }
  });

  it("refuses while the agent works, for another agent, and over a draft in Claude Code's box", async () => {
    await withHerdr({ agent: "claude", status: "working" }, fruit(), async (paneId, prompts) => {
      expect((await rewind({ pane_id: paneId, text: "apple" }))[0]).toBe(409);
      expect(prompts).toEqual([]);
    });
    await withHerdr({ agent: "codex", status: "idle" }, fruit(), async (paneId, prompts) => {
      expect((await rewind({ pane_id: paneId, text: "apple" }))[0]).toBe(400);
      expect(prompts).toEqual([]);
    });
    const drafted = fruit();
    const io = { ...drafted.io, read: async () => screen("closed").replace(/❯\s*$/m, "❯ half a thought") };
    await withHerdr({ agent: "claude", status: "idle" }, { ...drafted, io }, async (paneId, prompts) => {
      expect(await rewind({ pane_id: paneId, text: "apple" })).toEqual([409, { error: expect.objectContaining({ code: "input_draft" }) }]);
      expect(prompts).toEqual([]);
    });
  });

  // HIGH 1 (merge pass r1): /rewind, up, up, enter, /rewind, Enter on choice 0
  it("refuses a second rewind while Claude's confirm step or list is open, typing nothing", async () => {
    const dialog = fruit();
    await withHerdr({ agent: "claude", status: "idle" }, dialog, async (paneId, prompts) => {
      expect((await rewind({ pane_id: paneId, text: "apple" }))[0]).toBe(200);
      const keys = dialog.sent.length;
      // herdr still reports the agent idle with the dialog up, and the dialog shows no input box
      expect(await rewind({ pane_id: paneId, text: "banana" })).toEqual([409, { error: expect.objectContaining({ code: "dialog_open" }) }]);
      expect(prompts).toEqual(["/rewind"]);
      expect(dialog.sent.length).toBe(keys);
      expect(dialog.state()).toEqual({ at: "confirm", row: 0, choice: 0 });
    });
    const opened = fruit();
    await opened.io.command("/rewind");
    await withHerdr({ agent: "claude", status: "idle" }, opened, async (paneId, prompts) => {
      expect(await rewind({ pane_id: paneId, text: "apple" })).toEqual([409, { error: expect.objectContaining({ code: "dialog_open" }) }]);
      expect(prompts).toEqual([]);
      expect(opened.state()).toEqual({ at: "list", row: 2 });
    });
  });

  // HIGH 5 (merge pass r1): nothing is sent automatically after a disconnect
  const asked = (paneId: string, signal: AbortSignal) => new Request("http://localhost/api/pane/rewind", { method: "POST", body: JSON.stringify({ pane_id: paneId, text: "apple" }), headers: { "content-type": "application/json" }, signal });
  it("types nothing for a requester gone while the rewind waited its turn", async () => {
    const dialog = fruit();
    await withHerdr({ agent: "claude", status: "idle" }, dialog, async (paneId, prompts) => {
      const requester = new AbortController();
      // the pane's input order runs the task once the requester has disconnected
      await handleRewindRequest(asked(paneId, requester.signal), async (_paneId, task) => { requester.abort(); return await task(); });
      expect(prompts).toEqual([]);
      expect(dialog.sent).toEqual([]);
    });
  });

  it("sends no further key once the requester disconnects mid-walk", async () => {
    const dialog = fruit();
    const requester = new AbortController();
    const io: RewindIo = { ...dialog.io, command: async (text) => { await dialog.io.command(text); requester.abort(); } };
    await withHerdr({ agent: "claude", status: "idle" }, { ...dialog, io }, async (paneId) => {
      await handleRewindRequest(asked(paneId, requester.signal), async (_paneId, task) => await task());
      expect(dialog.sent).toEqual(["/rewind"]);
    });
  });

  // Codex on db8d72b5 (3): the requester can leave while a key's connection to herdr is still opening
  it("gives herdr the disconnect as the write-time guard of the rewind's command and keys", async () => {
    const dialog = fruit();
    const requester = new AbortController();
    const written: string[] = [];
    // herdr's client asks the guard once connected, right before writing (server/herdr/client.ts herdrRpc)
    const write = async (what: string, guard?: () => boolean) => {
      requester.abort();
      if (guard !== undefined && !guard()) throw new HerdrError("cancelled", `herdr ${what} was not sent`);
      written.push(what);
    };
    const prompt = spyOn(client, "agentPrompt").mockImplementation((_target, text, _socket, guard) => write(text, guard));
    const keys = spyOn(client, "paneSendKeys").mockImplementation((_pane, sent, _socket, guard) => write(sent.join(","), guard));
    try {
      await withHerdr({ agent: "claude", status: "idle" }, dialog, async (paneId) => {
        await handleRewindRequest(asked(paneId, requester.signal), async (_paneId, task) => await task());
        expect(written).toEqual([]);
      });
    } finally { prompt.mockRestore(); keys.mockRestore(); }
  });

  it("refuses a body without the message", async () => {
    expect((await rewind({ pane_id: "p" }))[0]).toBe(400);
    expect((await rewind({ pane_id: "p", text: "apple", later: -1 }))[0]).toBe(400);
  });
});
