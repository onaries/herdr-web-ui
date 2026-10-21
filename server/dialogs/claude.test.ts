import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { answerKeys, claudeRewindOpen, parseInteractivePrompt } from "../prompt.ts";
import { claudeRewindOnScreen, readers } from "./claude.ts";
import { executeInteractionPlan } from "./interaction-plan.ts";
import type { ReaderContext } from "./registry.ts";
import type { AnswerStep } from "./shared.ts";

const fixture = (state: string, width: number): string =>
  readFileSync(new URL(`../fixtures/claude-goal-2.1.304-${state}-${width}.txt`, import.meta.url), "utf8");

/** Claude Code 2.1.304's /rewind, recorded over a resumed apple/banana session (fixtures named by state and width) */
const rewind = (state: string, width: number): string =>
  readFileSync(new URL(`../fixtures/claude-rewind-2.1.304-${state}-${width}.txt`, import.meta.url), "utf8");

describe("Claude Code's /rewind", () => {
  const OFFERED = ["Restore conversation", "Never mind"];

  for (const width of [40, 120]) {
    test(`reads the confirm step's choices at ${width} columns`, () => {
      const prompt = parseInteractivePrompt("claude", rewind("confirm-apple", width));
      // what one key commits from the first row: Restore (Enter) and Never mind (Esc)
      expect(prompt?.options.map((option) => option.label)).toEqual(OFFERED);
      expect(prompt?.body?.split("\n")[0]).toBe("apple");
      expect(answerKeys(prompt!, { option_index: 0 })).toEqual([{ keys: ["enter"] }]);
      expect(answerKeys(prompt!, { option_index: 1 })).toEqual([{ keys: ["esc"] }]);
    });

    test(`reads the message list with the cursor on (current) at ${width} columns`, () => {
      const prompt = parseInteractivePrompt("claude", rewind("select-current", width));
      expect(prompt?.options.map((option) => option.label)).toEqual(["banana"]);
      // the cursor starts under the messages, on the session as it is now
      expect(answerKeys(prompt!, { option_index: 0 })).toEqual([{ keys: ["up"] }, { keys: ["enter"] }]);
    });

    test(`reads the message list scrolled to banana at ${width} columns`, () => {
      const prompt = parseInteractivePrompt("claude", rewind("select-banana", width));
      expect(prompt?.options.map((option) => option.label)).toEqual(["apple", "banana"]);
      expect(answerKeys(prompt!, { option_index: 0 })).toEqual([{ keys: ["up"] }, { keys: ["enter"] }]);
      expect(answerKeys(prompt!, { option_index: 1 })).toEqual([{ keys: ["enter"] }]);
    });
  }

  test("reads the confirm step under a rule a tip takes the start of", () => {
    const prompt = parseInteractivePrompt("claude", rewind("confirm-apple-tip", 40));
    expect(prompt?.options.map((option) => option.label)).toEqual(OFFERED);
    expect(prompt?.body?.split("\n")[0]).toBe("apple");
  });

  test("joins a long message the narrow confirm step wraps", () => {
    const prompt = parseInteractivePrompt("claude", rewind("confirm-long", 40));
    expect(prompt?.body?.split("\n")[0]).toBe("please describe the history of the cherry orchard near the river in some detail");
    expect(prompt?.options.map((option) => option.label)).toEqual(OFFERED);
  });

  test("the age under the message is part of the card's identity: another copy of the same words is another card", () => {
    const shown = rewind("confirm-apple", 120);
    expect(parseInteractivePrompt("claude", shown.replace("(3h ago)", "(4h ago)"))?.id).not.toBe(parseInteractivePrompt("claude", shown)?.id);
    // the card shows the message and its notes, not the age
    expect(parseInteractivePrompt("claude", shown)?.body?.split("\n")[0]).toBe("apple");
  });

  test("a confirm step the recording does not show gets no card", () => {
    const shown = rewind("confirm-apple", 120);
    expect(parseInteractivePrompt("claude", shown.replace("2. Summarize from here", "2. Restore code"))).toBeNull();
    expect(parseInteractivePrompt("claude", shown.replace("   Rewind\n", "   Rollback\n"))).toBeNull();
    expect(parseInteractivePrompt("claude", `${shown}\n❯ hello`)).toBeNull();
  });

  // F3 r2 D3: Claude Code 2.1.305 drops "the conversation" from the confirm question. Fixtures are the
  // F3 r2 recordings (rewind.390.confirm.txt, rewind.1280.fresh-msg.confirm.txt), whose dump dropped
  // blank lines; they are put back between the panel's blocks, as 2.1.305's list (read live) draws them.
  const rewind305 = (state: string, width: number): string =>
    readFileSync(new URL(`../fixtures/claude-rewind-2.1.305-${state}-${width}.txt`, import.meta.url), "utf8");

  test("reads Claude Code 2.1.305's confirm step, and answers it", async () => {
    for (const [state, width, message] of [["confirm-kiwi", 145, "kiwi rewind 390"], ["confirm-cherry", 120, "cherry rewind 1280"]] as const) {
      const shown = rewind305(state, width);
      const prompt = parseInteractivePrompt("claude", shown);
      expect(prompt?.options.map((option) => option.label), state).toEqual(OFFERED);
      expect(prompt?.body?.split("\n")[0]).toBe(message);
      expect(answerKeys(prompt!, { option_index: 0 })).toEqual([{ keys: ["enter"] }]);
      const reader = readers.find((candidate) => candidate.id === "claude-rewind")!;
      const context: ReaderContext = { agent: "claude", omoAsk: null, omoTrusted: true, omoOpen: [], sent: null, working: false };
      const sent: AnswerStep[] = [];
      const plan = reader.interaction!(reader.parse(shown, context)!);
      const result = await executeInteractionPlan(plan, 0, { rereadMoves: true, read: async () => shown, send: async (step) => { sent.push(step); }, active: () => true, cancelled: () => false });
      expect({ result, sent }).toEqual({ result: "answered", sent: [{ keys: ["enter"] }] });
    }
  });

  test("reads either wording, and no other confirm question", () => {
    const older = rewind("confirm-apple", 120);
    expect(parseInteractivePrompt("claude", older)?.options.map((option) => option.label)).toEqual(OFFERED);
    const shown = rewind305("confirm-kiwi", 145);
    const ask = "Confirm you want to restore to the point before you sent this message:";
    for (const nearMiss of [
      "Confirm you want to restore the code to the point before you sent this message:",
      "Confirm you want to restore the code and conversation to the point before you sent this message:",
      "Confirm you want to restore to the point before this message:",
      "Confirm you want to delete the point before you sent this message:",
    ]) {
      expect(parseInteractivePrompt("claude", shown.replace(ask, nearMiss)), nearMiss).toBeNull();
    }
  });

  // HIGH 2 (merge pass r1): every confirm step reads "Restore conversation"; the quote tells them apart
  test("an answer made for one message's confirm step sends no Enter on another message's", async () => {
    const reader = readers.find((candidate) => candidate.id === "claude-rewind")!;
    const answer = async (shown: string) => {
      const sent: AnswerStep[] = [];
      const context: ReaderContext = { agent: "claude", omoAsk: null, omoTrusted: true, omoOpen: [], sent: null, working: false };
      const plan = reader.interaction!(reader.parse(rewind("confirm-apple", 40), context)!);
      const result = await executeInteractionPlan(plan, 0, { rereadMoves: true, read: async () => shown, send: async (step) => { sent.push(step); }, active: () => true, cancelled: () => false });
      return { result, sent };
    };
    expect(await answer(rewind("confirm-long", 40))).toEqual({ result: "prompt_changed", sent: [] });
    expect(await answer(rewind("confirm-apple", 40))).toEqual({ result: "answered", sent: [{ keys: ["enter"] }] });
  });

  test("does not hold sends for a rewind panel drawn above Claude's own input box, as a reply quoting it is", () => {
    const quoted = `${rewind("confirm-apple", 40)}\n${rewind("closed", 40)}`;
    expect(claudeRewindOnScreen(quoted)).toBe(true);
    expect(claudeRewindOpen(quoted)).toBe(false);
  });

  test("holds sends for an open rewind panel under an earlier input box's rules, which are no box of its own", () => {
    const under = `${rewind("closed", 40)}\n${rewind("confirm-apple-summarize-from", 40)}`;
    expect(claudeRewindOpen(under)).toBe(true);
  });

  // R1-NEW-1: the confirm step with the cursor on each row, recorded; the Summarize rows are add-context fields
  for (const width of [40, 120]) {
    test(`knows every recorded state of the rewind panel as one, the add-context fields included, at ${width} columns`, () => {
      for (const state of ["confirm-apple-restore", "confirm-apple-summarize-from", "confirm-apple-summarize-up-to", "confirm-apple-never-mind", "confirm-apple-restore-esc", "confirm-apple-summarize-from-esc", "confirm-long-610"]) {
        expect(claudeRewindOnScreen(rewind(state, width)), state).toBe(true);
      }
      // Esc on the list closes it: Claude's own input box is back
      expect(claudeRewindOnScreen(rewind("confirm-apple-esc-esc", width))).toBe(false);
      // the dialog takes the input box's place in every state, so a send waits on each of them
      for (const state of ["confirm-apple-restore", "confirm-apple-summarize-from", "confirm-apple-summarize-up-to", "confirm-apple-never-mind", "confirm-apple-restore-esc", "confirm-apple-summarize-from-esc", "confirm-long-610"]) {
        expect(claudeRewindOpen(rewind(state, width)), state).toBe(true);
      }
      // a Summarize row is a text field, not the four choices: no card answers it
      expect(parseInteractivePrompt("claude", rewind("confirm-apple-summarize-from", width))).toBeNull();
      expect(parseInteractivePrompt("claude", rewind("confirm-apple-never-mind", width))?.options.map((option) => option.label)).toEqual(["Never mind"]);
    });
  }

  // CodeRabbit 4333021179: a Summarize row is an add-context field, so the card offers only what it can commit
  test("offers on a confirm step only what one key commits: Restore where the cursor is, and Never mind by Esc", () => {
    const labels = (state: string, width: number) => parseInteractivePrompt("claude", rewind(state, width))?.options.map((option) => option.label);
    for (const width of [40, 120]) {
      expect(labels("confirm-apple-restore", width)).toEqual(["Restore conversation", "Never mind"]);
      // the cursor moved to Never mind in the terminal: Restore would have to cross the Summarize rows
      expect(labels("confirm-apple-never-mind", width)).toEqual(["Never mind"]);
    }
  });

  test("answers each confirm card choice with one key through the answer plan, never over a Summarize row", async () => {
    const reader = readers.find((candidate) => candidate.id === "claude-rewind")!;
    const context: ReaderContext = { agent: "claude", omoAsk: null, omoTrusted: true, omoOpen: [], sent: null, working: false };
    // the recorded screens: Down from Restore lands on the add-context field of Summarize from here
    const answer = async (state: string, option: number) => {
      let shown = rewind(state, 40);
      const sent: AnswerStep[] = [];
      const plan = reader.interaction!(reader.parse(shown, context)!);
      const result = await executeInteractionPlan(plan, option, { rereadMoves: true, read: async () => shown, active: () => true, cancelled: () => false,
        send: async (step) => { sent.push(step); if (step.keys?.[0] === "down") shown = rewind("confirm-apple-summarize-from", 40); } });
      return { result, sent };
    };
    expect(await answer("confirm-apple-restore", 0)).toEqual({ result: "answered", sent: [{ keys: ["enter"] }] });
    expect(await answer("confirm-apple-restore", 1)).toEqual({ result: "answered", sent: [{ keys: ["esc"] }] });
    expect(await answer("confirm-apple-never-mind", 0)).toEqual({ result: "answered", sent: [{ keys: ["esc"] }] });
  });

  // Codex on db8d72b5 (1): repeated messages read the same; the age under the quote tells the copies apart
  test("sends no Enter on another copy's confirm step of the same words, opened after the card was made", async () => {
    const reader = readers.find((candidate) => candidate.id === "claude-rewind")!;
    const context: ReaderContext = { agent: "claude", omoAsk: null, omoTrusted: true, omoOpen: [], sent: null, working: false };
    const card = rewind("confirm-apple-restore", 40);
    const answer = async (shown: string) => {
      const sent: AnswerStep[] = [];
      const plan = reader.interaction!(reader.parse(card, context)!);
      const result = await executeInteractionPlan(plan, 0, { rereadMoves: true, read: async () => shown, send: async (step) => { sent.push(step); }, active: () => true, cancelled: () => false });
      return { result, sent };
    };
    // a newer apple's confirm step: the same quote, a younger age
    expect(await answer(card.replace("(3h ago)", "(2h ago)"))).toEqual({ result: "prompt_changed", sent: [] });
    expect(await answer(card)).toEqual({ result: "answered", sent: [{ keys: ["enter"] }] });
  });

  test("a list cut by a later line gets no card", () => {
    expect(parseInteractivePrompt("claude", `${rewind("select-banana", 120)}\n❯ hello`)).toBeNull();
  });
});

describe("Claude Code's bare /goal", () => {
  for (const width of [40, 120]) {
    test(`reads the goal dialog with a goal at ${width} columns`, () => {
      const prompt = parseInteractivePrompt("claude", fixture("active", width));
      expect(prompt?.title).toBe("Goal active");
      expect(prompt?.question).toBe("the file hello.txt exists in the project directory");
      expect(prompt?.body).toMatch(/^running \d+s · 0 tokens$/);
      expect(prompt?.options.map((option) => option.label)).toEqual(["Close"]);
      expect(answerKeys(prompt!, { option_index: 0 })).toEqual([{ keys: ["esc"] }]);
    });

    test(`reads the goal dialog without a goal at ${width} columns`, () => {
      const prompt = parseInteractivePrompt("claude", fixture("none", width));
      expect(prompt?.title).toBe("Goal");
      expect(prompt?.question).toBe("No goal set");
      expect(prompt?.body).toBeNull();
      expect(prompt?.options.map((option) => option.label)).toEqual(["Close"]);
      expect(answerKeys(prompt!, { option_index: 0 })).toEqual([{ keys: ["esc"] }]);
    });
  }

  test("a card for the same goal keeps its identity while the elapsed time ticks", () => {
    const shown = fixture("active", 120);
    const later = shown.replace(/running \d+s/, "running 4m 12s");
    expect(later).not.toBe(shown);
    expect(parseInteractivePrompt("claude", later)?.id).toBe(parseInteractivePrompt("claude", shown)?.id);
  });

  test("a different goal is a different card", () => {
    const shown = fixture("active", 120);
    expect(parseInteractivePrompt("claude", shown.replaceAll("hello.txt", "other.txt"))?.id).not.toBe(parseInteractivePrompt("claude", shown)?.id);
  });

  test("a running row that is not the recorded shape gets no card", () => {
    const shown = fixture("active", 120);
    for (const row of ["running a new unrecorded status", "running 25s", "running 25s · 0 tokens left", "running soon · 0 tokens"]) {
      expect(parseInteractivePrompt("claude", shown.replace(/running \d+s · 0 tokens/, row)), row).toBeNull();
    }
    expect(parseInteractivePrompt("claude", shown.replace(/running \d+s · 0 tokens/, "running 1h 2m 3s · 1,204 tokens"))?.title).toBe("Goal active");
  });

  test("a layout the dialog does not draw gets no card", () => {
    const shown = fixture("active", 120);
    expect(parseInteractivePrompt("claude", shown.replace("◎ Goal active", "◎ Goal achieved"))).toBeNull();
    expect(parseInteractivePrompt("claude", shown.replace("Esc to dismiss", "Esc to dismiss\n\n   Clear goal"))).toBeNull();
    expect(parseInteractivePrompt("claude", `${shown}\n❯ hello`)).toBeNull();
    expect(parseInteractivePrompt("claude", fixture("none", 120).replace("No goal set", "Goal paused"))).toBeNull();
  });
});
