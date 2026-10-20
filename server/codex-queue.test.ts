import { expect, it } from "bun:test";
import { codexQueueInputEmpty } from "./prompt.ts";

const screen = (input: string) => `• Working (2s • esc to interrupt)\n${input}\n  GPT-6.1-Sol high · /workspace\n  ? for shortcuts\n`;

it("requires the live bottom composer and distinguishes a placeholder from the same typed words", () => {
  expect(codexQueueInputEmpty(screen("›"))).toBe(true);
  const plain = screen("› Ask Codex to do anything");
  expect(codexQueueInputEmpty(plain)).toBe(false);
  expect(codexQueueInputEmpty(plain, screen("› \x1b[2mAsk Codex to do anything\x1b[0m"))).toBe(true);
  expect(codexQueueInputEmpty(plain, plain)).toBe(false);
  expect(codexQueueInputEmpty(plain, screen("› \x1b[38;2;90;90;90mAsk Codex to do anything\x1b[0m"))).toBe(false);
  for (const input of ["› existing draft", "› existing draft\n  ›", "›\n  continued draft", "›\nSelect model", "›\n1. Allow once"]) {
    expect(codexQueueInputEmpty(screen(input))).toBe(false);
  }
  expect(codexQueueInputEmpty(screen("›").replace("Working (2s • esc to interrupt)", "Done"))).toBe(false);
  expect(codexQueueInputEmpty("• Working (2s • esc to interrupt)\n›\n")).toBe(false);
  expect(codexQueueInputEmpty(screen("›") + "Update available\n")).toBe(false);
});
