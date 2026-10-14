import { describe, expect, test } from "bun:test";

import type { SlashCommand } from "../../shared/protocol.ts";
import { createSkillMatcher } from "./skillMentions.ts";

const command = (name: string, source: SlashCommand["source"], trigger?: "$"): SlashCommand => ({ name, description: "", source, ...(trigger ? { trigger } : {}) });
const commands = [command("review", "skill"), command("review-pr", "skill"), command("plan", "skill", "$"), command("help", "builtin"), command("ship:it", "skill")];

function chips(text: string): string[] {
  const matcher = createSkillMatcher(commands);
  return (matcher?.(text) ?? [text]).flatMap((part) => typeof part === "string" ? [] : [part.raw]);
}

describe("createSkillMatcher", () => {
  test("is null when the pane lists no skill", () => {
    expect(createSkillMatcher([command("help", "builtin")])).toBeNull();
  });

  test("chips a skill in its trigger form and keeps the raw text", () => {
    const matcher = createSkillMatcher(commands)!;
    const parts = matcher("Run /review now, or $plan.");
    expect(parts).toEqual(["Run ", { raw: "/review", name: "review" }, " now, or ", { raw: "$plan", name: "plan" }, "."]);
    expect(parts.map((part) => typeof part === "string" ? part : part.raw).join("")).toBe("Run /review now, or $plan.");
  });

  test("never chips a bare word or the wrong trigger", () => {
    expect(chips("please review the plan")).toEqual([]);
    expect(chips("$review and /plan")).toEqual([]);
  });

  test("only skills chip, not built-ins", () => {
    expect(chips("try /help")).toEqual([]);
  });

  test("whole names only", () => {
    expect(chips("/review-all /review/x a/review /review.md /reviews")).toEqual([]);
    expect(chips("/review-pr and /review")).toEqual(["/review-pr", "/review"]);
    expect(chips("(/ship:it)")).toEqual(["/ship:it"]);
  });
});
