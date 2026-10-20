import { describe, expect, test } from "bun:test";

import type { SlashCommand } from "../../shared/protocol.ts";
import { skillSyntax } from "../../shared/skill-syntax.ts";
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

  test("omo chips /skill:x, $skill:x and [skill: x] for a listed skill only", () => {
    const omo = createSkillMatcher([command("skill:mass-ulw", "skill"), command("compact", "builtin")], skillSyntax("omo"))!;
    const raws = (text: string) => omo(text).flatMap((part) => typeof part === "string" ? [] : [part.raw]);
    expect(omo("run $skill:mass-ulw now")).toEqual(["run ", { raw: "$skill:mass-ulw", name: "skill:mass-ulw" }, " now"]);
    expect(raws("/skill:mass-ulw go")).toEqual(["/skill:mass-ulw"]);
    expect(omo("did [skill: mass-ulw]")).toEqual(["did ", { raw: "[skill: mass-ulw]", name: "skill:mass-ulw" }]);
    expect(raws("x[skill: mass-ulw]y")).toEqual(["[skill: mass-ulw]"]);
    expect(raws("[skill: unknown] $skill:unknown $skill:mass-ulwx a$skill:mass-ulw")).toEqual([]);
  });

  test("chips another agent's skills in the form it types them: /skill:x for pi, $x for Codex", () => {
    const pi = createSkillMatcher([command("skill:pdf-tools", "skill"), command("review", "user")], skillSyntax("pi"))!;
    expect(pi("run /skill:pdf-tools on it, then /review")).toEqual(["run ", { raw: "/skill:pdf-tools", name: "skill:pdf-tools" }, " on it, then /review"]);
    const codex = createSkillMatcher([command("deepinit", "skill", "$")], skillSyntax("codex"))!;
    expect(codex("start with $deepinit")).toEqual(["start with ", { raw: "$deepinit", name: "deepinit" }]);
    expect(codex("start with /deepinit")).toEqual(["start with /deepinit"]);
  });

  test("chips an OpenCode v2 @ skill as the name it is sent with, never its file's path", () => {
    const opencode = createSkillMatcher([{ name: "pdf-tools", description: "", source: "skill", trigger: "@", id: "/skills/pdf-tools/SKILL.md" }], skillSyntax("opencode"))!;
    expect(opencode("read it with @pdf-tools, not @pdf or @/skills/pdf-tools/SKILL.md")).toEqual(["read it with ", { raw: "@pdf-tools", name: "pdf-tools" }, ", not @pdf or @/skills/pdf-tools/SKILL.md"]);
  });

  test("without omo, $skill:x and [skill: x] stay plain text", () => {
    const list = [command("skill:mass-ulw", "skill")];
    const plain = createSkillMatcher(list)!;
    expect(plain("$skill:mass-ulw [skill: mass-ulw]")).toEqual(["$skill:mass-ulw [skill: mass-ulw]"]);
    expect(createSkillMatcher(list, skillSyntax(null))!("$skill:mass-ulw")).toEqual(["$skill:mass-ulw"]);
  });

  test("whole names only", () => {
    expect(chips("/review-all /review/x a/review /review.md /reviews")).toEqual([]);
    expect(chips("/review-pr and /review")).toEqual(["/review-pr", "/review"]);
    expect(chips("(/ship:it)")).toEqual(["/ship:it"]);
  });
});
