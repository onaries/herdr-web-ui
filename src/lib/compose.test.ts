import { describe, expect, it } from "bun:test";

import { agentDisplayLabel, composerDelivery, composerMessage, terminalOnlyCommand, composerSendShown, composerPayload, composerModelDraw, composerStatusCompact, composerStatusHint, composerStatusWord, COMPOSER_STATUS_COMPACT_BELOW, contextLeftPercent, formatTokens, imageMention, insertMention, MAX_COMPOSER_CHARS, QUEUE_READY_STATUS, rankSlashCommands, submitNote, submitNotTyped } from "./compose.ts";

describe("composerMessage and submitNote", () => {
  it("keeps the message as written for agent.prompt: inner newlines stay, the composer's own trailing ones go", () => {
    expect(composerMessage("line one\r\nline two\n\n")).toBe("line one\nline two");
  });

  it("says why a message did not go, and never claims a lost one was sent", () => {
    expect(submitNote("agent_blocked", "x")).toBe("Not sent: the agent is waiting for an answer in the terminal. Answer it first.");
    expect(submitNote("read_only", "x")).toBe("Not sent: this view only watches the pane.");
    expect(submitNote("submit_timeout", "x")).toMatch(/^Not sent: .*nothing was typed/);
    expect(submitNote("disconnected", "x")).toMatch(/^Not confirmed: .*Check the terminal/);
    expect(submitNote("pane_not_found", "pane w1:p9 not found")).toBe("Not sent: pane w1:p9 not found");
  });

  it("knows a refusal that typed nothing from a message that may have reached the pane", () => {
    expect(["submit_timeout", "agent_blocked", "read_only"].map(submitNotTyped)).toEqual([true, true, true]);
    expect(["disconnected", "timeout", "submit_failed"].map(submitNotTyped)).toEqual([false, false, false]);
    expect(["pending_input_unsupported", "invalid_delivery", "invalid_submit_text", "agent_not_ready", "pending_limit"].map(submitNotTyped)).toEqual([true, true, true, true, true]);
    expect(["pane_not_found", "retired_submit_id"].map(submitNotTyped)).toEqual([true, true]);
    // refused before the paste because Claude's input box held a draft (#609)
    expect(submitNotTyped("input_draft")).toBe(true);
    expect(submitNote("pending_input_unsupported", "x")).toBe("Update this PC to send messages in the next turn. Your draft stayed here.");
    expect(submitNotTyped("submit_changed")).toBe(false);
    expect(submitNotTyped("pending_uncertain")).toBe(false);
  });
});

describe("composerPayload", () => {
  it("bracketed mode wraps the text as one paste, without the submit", () => {
    expect(composerPayload("hello", true)).toBe("\u001b[200~hello\u001b[201~");
  });

  it("bracketed mode keeps inner newlines literal to the TUI input box", () => {
    expect(composerPayload("line one\nline two", true)).toBe("\u001b[200~line one\rline two\u001b[201~");
  });

  it("normalizes CRLF and lone CR to the pty newline CR", () => {
    expect(composerPayload("a\r\nb\rc", true)).toBe("\u001b[200~a\rb\rc\u001b[201~");
  });

  it("drops trailing newlines: the submit CR belongs to the composer, not the text", () => {
    expect(composerPayload("cmd\n\n", true)).toBe("\u001b[200~cmd\u001b[201~");
    expect(composerPayload("cmd\n\n", false)).toBe("cmd");
  });

  it("plain mode uses classic paste semantics: every newline submits its own line", () => {
    expect(composerPayload("git status\ngit diff", false)).toBe("git status\rgit diff");
  });

  it("plain mode sends a single line; the submit CR goes on its own", () => {
    expect(composerPayload("git status", false)).toBe("git status");
  });

  it("empty text types nothing; its submit still goes on its own", () => {
    expect(composerPayload("", true)).toBe("\u001b[200~\u001b[201~");
    expect(composerPayload("", false)).toBe("");
  });

  it("caps what one send can carry", () => {
    expect(MAX_COMPOSER_CHARS).toBeLessThanOrEqual(20_000);
    expect(composerPayload("x".repeat(MAX_COMPOSER_CHARS), false)).toHaveLength(MAX_COMPOSER_CHARS);
  });
});

describe("imageMention", () => {
  it("references the stored file as an editable @path with a trailing space", () => {
    expect(imageMention("/tmp/proj/.herdr-web-ui/paste-1.png")).toBe(
      "@/tmp/proj/.herdr-web-ui/paste-1.png ",
    );
  });
});

describe("insertMention", () => {
  const mention = imageMention("/tmp/p.png");

  it("separates a mention from the word before the caret (#120)", () => {
    expect(insertMention("test.", 5, 5, mention)).toEqual({ text: "test. @/tmp/p.png ", caret: 18 });
  });

  it("adds no space in an empty composer or after whitespace", () => {
    expect(insertMention("", 0, 0, mention)).toEqual({ text: "@/tmp/p.png ", caret: 12 });
    expect(insertMention("test. ", 6, 6, mention).text).toBe("test. @/tmp/p.png ");
    expect(insertMention("test.\n", 6, 6, mention).text).toBe("test.\n@/tmp/p.png ");
  });

  it("looks at the text before the selection, and replaces the selection", () => {
    expect(insertMention("see this here", 4, 8, mention)).toEqual({ text: "see @/tmp/p.png  here", caret: 16 });
    expect(insertMention("ab", 1, 1, mention)).toEqual({ text: "a @/tmp/p.png b", caret: 14 });
  });

  it("cuts the insertion to what still fits", () => {
    const full = "x".repeat(MAX_COMPOSER_CHARS - 3);
    expect(insertMention(full, full.length, full.length, mention)).toEqual({
      text: `${full} @/`,
      caret: MAX_COMPOSER_CHARS,
    });
  });
});

describe("composer presentation helpers", () => {
  it("holds queued messages while the agent needs an approval or answer", () => {
    expect(QUEUE_READY_STATUS.blocked).not.toBe(true);
    expect(QUEUE_READY_STATUS.working).not.toBe(true);
    expect(QUEUE_READY_STATUS.unknown).not.toBe(true);
    expect(QUEUE_READY_STATUS.done).toBe(true);
    expect(QUEUE_READY_STATUS.idle).toBe(true);
  });
  it("maps agent states to compact status words", () => {
    expect(composerStatusWord("idle")).toBe("READY");
    expect(composerStatusWord("working")).toBe("RUN");
    expect(composerStatusWord("blocked")).toBe("INPUT");
    expect(composerStatusWord("done")).toBe("DONE");
    expect(composerStatusWord("waiting")).toBe("BG");
    expect(composerStatusWord("paused")).toBe("READY");
  });

  it("makes the status row compact by the card's width, not the window's", () => {
    // a phone's card, and a laptop's with the sidebar open in a 940px window
    expect(composerStatusCompact(374)).toBe(true);
    expect(composerStatusCompact(588)).toBe(true);
    expect(composerStatusCompact(COMPOSER_STATUS_COMPACT_BELOW - 1)).toBe(true);
    // the threshold itself, a 1024px window with the sidebar open, and the full 820px card
    expect(composerStatusCompact(COMPOSER_STATUS_COMPACT_BELOW)).toBe(false);
    expect(composerStatusCompact(672)).toBe(false);
    expect(composerStatusCompact(820)).toBe(false);
    // a card that is not laid out yet has no width: it is not called narrow
    expect(composerStatusCompact(0)).toBe(false);
  });

  it("uses one Stop or Send control and queues all agents' working-turn messages", () => {
    expect(composerSendShown({ working: true, text: "" })).toBe(false);
    expect(composerSendShown({ working: true, text: " \n" })).toBe(false);
    expect(composerSendShown({ working: true, text: "check the tests" })).toBe(true);
    expect(composerSendShown({ working: false, text: "" })).toBe(true);
    for (const agent of ["codex", "claude", "pi", "omo"]) {
      expect(composerDelivery(agent, "working")).toBe("queue");
      for (const state of ["idle", "blocked", "done", "unknown"] as const) expect(composerDelivery(agent, state)).toBe("immediate");
    }
    expect(composerDelivery(null, "working")).toBe("immediate");
  });

  it("says the reconnecting sentence in the status content only once there is a draft", () => {
    // the empty box's placeholder says it
    expect(composerStatusHint({ uploading: false, connected: false, text: "" })).toBe(null);
    expect(composerStatusHint({ uploading: false, connected: false, text: " " })).toBe("offline");
    expect(composerStatusHint({ uploading: false, connected: false, text: "draft" })).toBe("offline");
    expect(composerStatusHint({ uploading: false, connected: true, text: "draft" })).toBe(null);
    expect(composerStatusHint({ uploading: true, connected: true, text: "" })).toBe("uploading");
    // an upload caught by a dropped connection: the box is empty, so the placeholder says why
    expect(composerStatusHint({ uploading: true, connected: false, text: "" })).toBe("uploading");
    // with a draft the placeholder is gone: the reconnecting sentence is the one said (the tile says Uploading)
    expect(composerStatusHint({ uploading: true, connected: false, text: "draft" })).toBe("offline");
  });

  it("removes the effort word before shortening the model", () => {
    expect(composerModelDraw({ modelClipped: false, effortClipped: false })).toBe("full");
    expect(composerModelDraw({ modelClipped: false, effortClipped: true })).toBe("no-effort");
    expect(composerModelDraw({ modelClipped: true, effortClipped: true })).toBe("no-effort");
    expect(composerModelDraw({ modelClipped: true, effortClipped: false })).toBe("no-effort");
  });

  it("turns machine agent ids into labels", () => {
    expect(agentDisplayLabel("claude")).toBe("Claude");
    expect(agentDisplayLabel("open_code")).toBe("Open Code");
    expect(agentDisplayLabel(null)).toBe("Shell");
  });

  it("filters slash commands by prefix and ranks frequent selections first", () => {
    const commands = [
      { name: "status", description: "Show status", source: "builtin" as const },
      { name: "start", description: "Start work", source: "project" as const },
      { name: "stop", description: "Stop work", source: "user" as const },
    ];
    expect(rankSlashCommands(commands, "st", { stop: 4, status: 2 })).toEqual([
      commands[2]!,
      commands[0]!,
      commands[1]!,
    ]);
  });

  it("also finds a command by a word of its name, a substring, its letters in order or its description", () => {
    const named = (name: string, description = "") => ({ name, description, source: "plugin" as const });
    const commands = [
      named("superpowers:brainstorming"),
      named("review", "Look over a diff"),
      named("code-review"),
      named("reviewer-notes"),
      named("my-brainstorm-helper"),
      named("unrelated", "Something else"),
    ];
    const find = (query: string) => rankSlashCommands(commands, query, {}).map((command) => command.name);
    // the namespace is not a prefix to type: the command's own word finds it
    expect(find("brain")).toEqual(["my-brainstorm-helper", "superpowers:brainstorming"]);
    // both name prefixes precede the word match
    expect(find("review")).toEqual(["review", "reviewer-notes", "code-review"]);
    expect(find("ainst")).toEqual(["my-brainstorm-helper", "superpowers:brainstorming"]);
    expect(find("spbr")).toEqual(["superpowers:brainstorming"]);
    expect(find("diff")).toEqual(["review"]);
    expect(find("zzz")).toEqual([]);
    expect(find("")).toHaveLength(commands.length);
    // a stronger kind of match beats a frequently used weaker one
    expect(rankSlashCommands(commands, "review", { "code-review": 9 }).map((command) => command.name)[0]).toBe("review");
  });

  it("keeps every match tier ahead of weaker alphabetical or frequently used results", () => {
    const commands = [
      { name: "a-preview", description: "", source: "plugin" as const },
      { name: "b-v-i-e-w", description: "", source: "plugin" as const },
      { name: "a-description", description: "view changes", source: "plugin" as const },
      { name: "z-view-notes", description: "", source: "plugin" as const },
      { name: "view", description: "", source: "plugin" as const },
    ];
    expect(rankSlashCommands(commands, "VIEW", { "a-description": 99 }).map(({ name }) => name))
      .toEqual(["view", "z-view-notes", "a-preview", "b-v-i-e-w", "a-description"]);
    expect(rankSlashCommands([{ name: "review", description: "diff", source: "builtin" }], "d", {})).toEqual([]);
  });

  it("keeps compound queries at word boundaries and applies usage within that tier", () => {
    const commands = ["a-mypdf-tools", "z:pdf-tools", "b:pdf-tools"]
      .map((name) => ({ name, description: "", source: "plugin" as const }));
    expect(rankSlashCommands(commands, "pdf-t", { "z:pdf-tools": 2 }).map(({ name }) => name))
      .toEqual(["z:pdf-tools", "b:pdf-tools", "a-mypdf-tools"]);
  });

  it("matches subsequences containing letters outside the basic multilingual plane", () => {
    const command = { name: "prefix:𐐨ab", description: "", source: "plugin" as const };
    expect(rankSlashCommands([command], "𐐀b", {})).toEqual([command]);
  });
});

describe("context left", () => {
  it("reads tokens and what is left the short way", () => {
    expect([950, 67_723, 435_404, 1_000_000, 1_250_000].map(formatTokens)).toEqual(["950", "68k", "435k", "1M", "1.3M"]);
    expect(contextLeftPercent({ used: 67_723, window: 258_400 })).toBe(74);
    expect(contextLeftPercent({ used: 300_000, window: 258_400 })).toBe(0);
    expect(contextLeftPercent({ used: 67_723, window: null })).toBeNull();
  });
});

// /tree moves the session's branch and opens the agent's tree browser, which the chat reads as
// nothing at all: no card, and the pane still looks done while the terminal waits for arrow keys.
// The composer says so before the send, because after it the browser is already open and the reader
// is already in the state the note describes
describe("commands the chat cannot finish", () => {
  it("names /tree where the agent has it", () => {
    expect(terminalOnlyCommand("pi", "/tree")).toBe("tree");
    expect(terminalOnlyCommand("pi", "  /TREE  ")).toBe("tree");
    expect(terminalOnlyCommand("pi", "/tree w13:p2")).toBe("tree"); // takes no argument, but a stray
    // one is still the same command typed and the reader still needs telling
    // omp's own docs describe the same command, the same navigator and the same three branch-summary
    // choices, so the chat cannot show its browser either
    expect(terminalOnlyCommand("omp", "/tree")).toBe("tree");
  });

  it("stays quiet about everything else", () => {
    expect(terminalOnlyCommand("pi", "/fork")).toBeNull();
    expect(terminalOnlyCommand("pi", "/compact")).toBeNull();
    // a message that merely mentions or begins like it: /treemap is not /tree, and prose that only
    // names the command is not a command
    expect(terminalOnlyCommand("pi", "/treemap")).toBeNull();
    expect(terminalOnlyCommand("pi", "use /tree to switch branches")).toBeNull();
    expect(terminalOnlyCommand("pi", "tree")).toBeNull();
    expect(terminalOnlyCommand("pi", "//tree")).toBeNull();
    // an agent with no evidence of the command gets no note: telling a Claude reader about a tree
    // browser Claude does not have is its own kind of wrong
    expect(terminalOnlyCommand("claude", "/tree")).toBeNull();
    expect(terminalOnlyCommand("codex", "/tree")).toBeNull();
    expect(terminalOnlyCommand(null, "/tree")).toBeNull();
  });
});
