import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import { shouldFoldUserMessage, USER_MESSAGE_FOLD_CHARS, USER_MESSAGE_FOLD_LINES, visibleUserMessageText } from "./userMessageFold.ts";

const lines = (count: number): string => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");

describe("shouldFoldUserMessage", () => {
  it("folds a message with more lines than the fold shows, and leaves one with that many open", () => {
    expect(shouldFoldUserMessage(lines(USER_MESSAGE_FOLD_LINES))).toBe(false);
    expect(shouldFoldUserMessage(lines(USER_MESSAGE_FOLD_LINES + 1))).toBe(true);
  });

  it("folds a long paste with few line breaks by its length", () => {
    expect(shouldFoldUserMessage("x".repeat(USER_MESSAGE_FOLD_CHARS))).toBe(false);
    expect(shouldFoldUserMessage("x".repeat(USER_MESSAGE_FOLD_CHARS + 1))).toBe(true);
    expect(shouldFoldUserMessage(`${"word ".repeat(100)}\n${"word ".repeat(100)}`)).toBe(true);
  });

  it("never folds a short or blank message", () => {
    expect(shouldFoldUserMessage("")).toBe(false);
    expect(shouldFoldUserMessage("   \n\n  ")).toBe(false);
    expect(shouldFoldUserMessage("Nice. Now add a metric for replayed requests.")).toBe(false);
  });

  it("does not count blank lines around the message", () => {
    expect(shouldFoldUserMessage(`\n\n${lines(USER_MESSAGE_FOLD_LINES)}\n\n\n`)).toBe(false);
  });

  it("measures a link or an image by its label, not its address", () => {
    const address = `https://example.test/${"a".repeat(2000)}`;
    expect(shouldFoldUserMessage(`See [the file](${address}) and ![shot](<${address}>).`)).toBe(false);
    expect(visibleUserMessageText(`[the file](${address})`)).toBe("the file");
    expect(visibleUserMessageText(`![shot](<${address}>)`)).toBe("shot");
    expect(shouldFoldUserMessage(`[${"label ".repeat(200)}](${address})`)).toBe(true);
  });

  it("counts a fenced paste's lines like any others", () => {
    expect(shouldFoldUserMessage(`Here is the log:\n\`\`\`\n${lines(USER_MESSAGE_FOLD_LINES)}\n\`\`\``)).toBe(true);
  });
});

describe("the fold's height", () => {
  it("is the same line count in the stylesheet, where the body is capped, as in the rule that folds", () => {
    const tokens = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    expect(tokens).toContain(`--chat-fold-lines: ${USER_MESSAGE_FOLD_LINES};`);
    const chat = readFileSync(new URL("../components/ChatView.css", import.meta.url), "utf8");
    expect(chat).toContain("calc(var(--chat-fold-lines) * var(--chat-fs-body) * var(--lh-prose))");
  });
});
