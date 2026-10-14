import { describe, expect, test } from "bun:test";

import type { ConversationTurn } from "../../shared/protocol.ts";
import { minimapCurrent, minimapFits, minimapStep, minimapTop, minimapTurns } from "./chatMinimap.ts";

const user = (text: string): ConversationTurn => ({ role: "user", ts: null, parts: [{ kind: "text", text }] });
const agent: ConversationTurn = { role: "assistant", ts: null, parts: [{ kind: "text", text: "ok" }] };

describe("chatMinimap", () => {
  test("one tick per message the user sent", () => {
    const notice: ConversationTurn = { role: "user", ts: null, parts: [{ kind: "notice", text: "result" }] };
    const compact: ConversationTurn = { role: "user", ts: null, parts: [{ kind: "compact", text: "summary" }] };
    expect(minimapTurns([user("a\n\n b"), agent, notice, compact, user("c"), agent])).toEqual([
      { row: 0, preview: "a b" },
      { row: 4, preview: "c" },
    ]);
    expect(minimapTurns([user("x".repeat(200))])[0]!.preview).toHaveLength(120);
  });

  test("ticks spread from top to bottom", () => {
    expect(minimapTop(0, 5)).toBe(0);
    expect(minimapTop(2, 5)).toBe(50);
    expect(minimapTop(4, 5)).toBe(100);
    expect(minimapTop(0, 1)).toBe(0);
  });

  test("the turn in view, else the one that began above", () => {
    const rows = [0, 4, 8, 12];
    expect(minimapCurrent(rows, 3, 6)).toBe(1);
    expect(minimapCurrent(rows, 5, 7)).toBe(1);
    expect(minimapCurrent(rows, 13, 15)).toBe(3);
    expect(minimapCurrent([5, 9], 0, 3)).toBeNull();
  });

  test("the rail needs a margin beside the column", () => {
    expect(minimapFits(1200, 760)).toBe(true);
    expect(minimapFits(800, 760)).toBe(false);
    expect(minimapFits(700, 760)).toBe(false);
  });

  test("list keys move the focus within the rail", () => {
    expect(minimapStep(0, 5, "ArrowUp")).toBe(0);
    expect(minimapStep(0, 5, "ArrowDown")).toBe(1);
    expect(minimapStep(4, 5, "ArrowDown")).toBe(4);
    expect(minimapStep(2, 5, "Home")).toBe(0);
    expect(minimapStep(2, 5, "End")).toBe(4);
    expect(minimapStep(2, 5, "a")).toBeNull();
  });
});
