import { expect, test } from "bun:test";

import { fallbackInitial } from "./agentMark.ts";

test("private-use agent glyphs never become visible fallback text", () => {
  expect(fallbackInitial("")).toBe("?");
  expect(fallbackInitial("opencode")).toBe("O");
});

test("fallback initials preserve ordinary agent labels", () => {
  expect(fallbackInitial("deepseek")).toBe("D");
  expect(fallbackInitial("  claude ")).toBe("C");
});
