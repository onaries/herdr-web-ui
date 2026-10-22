import { describe, expect, test } from "bun:test";
import { readers } from "./index.ts";
import { readersFor, type DialogReader } from "./registry.ts";

// Copied from the moved/list/sideways responder sets in prompt.ts at f736a9c4.
const snapshot: Record<string, readonly [DialogReader["reread"], DialogReader["list"]]> = {
  "claude-question": ["none", "none"],
  "claude-submit": ["none", "none"],
  "claude-approval": ["none", "none"],
  "claude-plan": ["none", "none"],
  "claude-confirm": ["before-commit", "none"],
  "claude-model": ["before-commit", "letter-window"],
  "claude-effort": ["before-commit", "slider"],
  "claude-held": ["none", "none"],
  "claude-goal": ["before-commit", "none"],
  "codex-menu": ["none", "none"],
  "codex-question": ["none", "none"],
  "codex-async-question": ["none", "none"],
  "codex-approval": ["none", "none"],
  "codex-model": ["before-commit", "letter-window"],
  "omp-question": ["none", "none"],
  "omp-submit": ["none", "none"],
  "omp-approval": ["none", "none"],
  "omp-model": ["each-move", "none"],
  "omp-handoff": ["before-commit", "none"],
  "omo-model": ["before-commit", "none"],
  "omo-question": ["before-commit", "none"],
  "omo-typing": ["none", "none"],
  "omo-review": ["none", "none"],
  "omo-pending": ["none", "none"],
  "pi-model": ["before-commit", "none"],
  "pi-question": ["none", "none"],
  "pi-confirm": ["none", "none"],
  "pi-input": ["none", "none"],
  "hermes-question": ["none", "none"],
  "hermes-input": ["none", "none"],
  "cmd-question": ["before-commit", "none"],
  "opencode-question": ["before-commit", "none"],
  "opencode-v1-question": ["none", "none"],
  "hermes-help": ["none", "none"],
  "hermes-status": ["none", "none"],
  "hermes-version": ["none", "none"],
  "hermes-profile": ["none", "none"],
  "hermes-reload-skills": ["none", "none"],
  "fallback-menu": ["none", "none"],
  "fallback-gjc-menu": ["before-commit", "none"],
  "fallback-keys": ["none", "none"],
};

describe("dialog reader behavior snapshot", () => {
  test("registers every snapshot reader once", () => {
    const ids = readers.map((reader) => reader.id).sort();
    expect(ids).toEqual(Object.keys(snapshot).sort());
  });

  for (const reader of readers) {
    test(`preserves ${reader.id} reread and list behavior`, () => {
      expect(snapshot[reader.id]?.[0]).toBe(reader.reread);
      expect(snapshot[reader.id]?.[1]).toBe(reader.list);
    });
  }
});

test("keeps OmO cross-listing after each agent's own readers", () => {
  const omo = ["omo-model", "omo-question", "omo-typing", "omo-review", "omo-pending"];
  for (const agent of ["omo", "pi", "claude", ""]) {
    const ids = readersFor(agent).map((reader) => reader.id);
    expect(ids.filter((id) => id.startsWith("omo-"))).toEqual(omo);
    if (agent === "pi") expect(ids.indexOf("omo-model")).toBeLessThan(ids.indexOf("pi-question"));
    if (agent === "claude") expect(ids.indexOf("claude-held")).toBeLessThan(ids.indexOf("omo-model"));
  }
});

test("keeps fallback readers last for known and unknown agents", () => {
  for (const agent of ["claude", "codex", "omp", "omo", "pi", "hermes", "gjc", "opencode", "grok", "agy", "devin", "cmd", "", "unknown"]) {
    expect(readersFor(agent).slice(-3).map((reader) => reader.id)).toEqual(["fallback-menu", "fallback-gjc-menu", "fallback-keys"]);
  }
});
