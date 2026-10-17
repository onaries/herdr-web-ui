import { describe, expect, it } from "bun:test";
import { SkillIgnore } from "./skill-ignore.ts";

describe("skill ignore rules", () => {
  it.each([
    ["*.md\n!keep.md", "keep.md", false],
    ["*.md\n!keep.md", "group/other.md", true],
    ["drafts/\n!drafts/a/SKILL.md", "drafts/a/SKILL.md", true],
    ["/root.md", "nested/root.md", false],
    ["/root.md", "root.md", true],
    ["loose.md", "nested/loose.md", true],
    ["group/secret/", "other/group/secret/SKILL.md", false],
    ["**/secret/**", "a/b/secret/x/SKILL.md", true],
    ["a/**/hidden?.[mt]d", "a/b/c/hidden1.md", true],
    ["a/**/hidden?.[mt]d", "a/hidden1.td", true],
    ["cache/", "cache", false],
    ["cache/", "cache/", true],
    ["\\#private\n\\!private", "#private", true],
    ["\\#private\n\\!private", "!private", true],
    ["# comment\n\n   \n", "anything", false],
    ["secret   ", "secret", true],
    ["secret\\ ", "secret ", true],
    ["*.md\n!keep.md\nkeep.md", "keep.md", true],
    ["*\n!keep/\n!keep/**", "keep/SKILL.md", false],
    ["a?b", "a/b", false],
    ["[!a]*", "banana", true],
  ])("applies %j to %j", (rules, path, ignored) => {
    const matcher = new SkillIgnore();
    matcher.add(rules);
    expect(matcher.ignores(path)).toBe(ignored);
  });

  it("prefixes nested ignore files without hiding sibling directories", () => {
    const matcher = new SkillIgnore();
    matcher.add("# comment\n\nsecret/\n!visible.md", "group/");
    expect(matcher.ignores("group/secret/SKILL.md")).toBe(true);
    expect(matcher.ignores("other/secret/SKILL.md")).toBe(false);
  });
});
