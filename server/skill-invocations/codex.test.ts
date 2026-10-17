import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { parseCodexTranscript } from "../codex.ts";

it("keeps the recorded dollar invocation and hides only the selected skill envelope", () => {
  const recorded = readFileSync(new URL("../fixtures/skill-invocations/codex.jsonl", import.meta.url), "utf8");
  const turns = parseCodexTranscript(recorded);
  const userText = turns.filter((turn) => turn.role === "user").flatMap((turn) => turn.parts.flatMap((part) => part.kind === "text" ? [part.text] : []));
  expect(userText).toContain("$probe-skill hello");
  expect(userText.some((text) => text.includes("<skill>"))).toBe(false);
  expect(turns.flatMap((turn) => turn.parts).some((part) => part.kind === "skill" && part.skill.name === "probe-skill")).toBe(true);
});
