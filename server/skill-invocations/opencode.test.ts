import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { opencodeRecord, opencodeTurns } from "../opencode.ts";
import { opencodeSkillInvocation } from "./opencode.ts";

describe("OpenCode's recorded skill invocation", () => {
  it("restores the recorded expanded user part through the real turn builder", () => {
    const rows = readFileSync(new URL("../fixtures/skill-invocations/opencode.jsonl", import.meta.url), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const message = rows.find((entry) => entry.table === "message" && JSON.parse(entry.row.data).role === "user");
    const parts = rows.filter((entry) => entry.table === "part" && entry.row.message_id === message.row.id).map((entry) => JSON.parse(entry.row.data));
    const turns = opencodeTurns([opencodeRecord(message.row.id, "user", { ...JSON.parse(message.row.data), text: parts.map((part) => part.text).join("\n") })]);
    expect(turns[0]?.parts).toEqual([{ kind: "text", text: "/probe-skill hello" }]);
  });

  it("preserves a displayText override instead of interpreting it as an expansion", () => {
    const expanded = "Body\n\nBase directory for this skill: /tmp/probe\nRelative paths in this skill (e.g., scripts/, references/) are relative to this base directory.\n\nargs";
    const turns = opencodeTurns([opencodeRecord("msg_test", "user", { text: expanded, metadata: { displayText: "/chosen args" } })]);
    expect(turns[0]?.parts).toEqual([{ kind: "text", text: "/chosen args" }]);
  });

  it("supports empty and multiline arguments without following the recorded path", () => {
    const prefix = "Body\n\nBase directory for this skill: C:\\missing\\probe-skill\nRelative paths in this skill (e.g., scripts/, references/) are relative to this base directory.\n\n";
    expect(opencodeSkillInvocation(prefix)).toBe("/probe-skill");
    expect(opencodeSkillInvocation(prefix + "one\ntwo")).toBe("/probe-skill one\ntwo");
  });

  it("leaves unmatched and malformed scaffolds raw", () => {
    for (const prompt of ["plain text", "/probe-skill hello", "Body\n\nBase directory for this skill: /tmp/probe-skill\n\nhello",
      "Body\n\nBase directory for this skill: /tmp/Bad\nRelative paths in this skill (e.g., scripts/, references/) are relative to this base directory.\n\nhello"]) {
      expect(opencodeSkillInvocation(prompt)).toBe(prompt);
    }
  });
});
