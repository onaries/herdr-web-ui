import { expect, it } from "bun:test";
import { claudeCommandEcho } from "./claude.ts";

it("leaves nonmatching text and builtin echoes to existing handling", () => {
  for (const text of [
    "/probe-skill hello",
    "<command-message>probe-skill</command-message>",
    "<command-message>other</command-message><command-name>/probe-skill</command-name><command-args>hello</command-args>",
    "<command-message>compact</command-message><command-name>/compact</command-name><command-args></command-args>",
  ]) expect(claudeCommandEcho(text)).toBeNull();
});

it("keeps angle brackets in the recorded arguments", () => {
  expect(claudeCommandEcho("<command-message>probe-skill</command-message>\n<command-name>/probe-skill</command-name>\n<command-args>read <path> if x < y</command-args>")?.text).toBe("/probe-skill read <path> if x < y");
});
