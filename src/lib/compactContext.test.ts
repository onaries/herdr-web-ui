import { describe, expect, test } from "bun:test";

import type { SlashCommand } from "../../shared/protocol.ts";
import { compactCommandText } from "./compactContext.ts";

const command = (name: string, trigger?: "$"): SlashCommand => ({ name, description: "", source: "builtin", ...(trigger ? { trigger } : {}) });

describe("compactCommandText", () => {
  test("names the slash command when the agent lists compact", () => {
    expect(compactCommandText([command("model"), command("compact")])).toBe("/compact");
  });
  test("is null when the agent lists no compact", () => {
    expect(compactCommandText([command("model"), command("compaction")])).toBeNull();
    expect(compactCommandText([])).toBeNull();
  });
  test("ignores a $-skill named compact", () => {
    expect(compactCommandText([command("compact", "$")])).toBeNull();
  });
});
