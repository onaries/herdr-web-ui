import { describe, expect, test } from "bun:test";
import { composerFull, pasteOverflow } from "./composerLength.ts";

describe("composerFull", () => {
  test("is true only at or past the cap", () => {
    expect(composerFull(9, 10)).toBe(false);
    expect(composerFull(10, 10)).toBe(true);
    expect(composerFull(11, 10)).toBe(true);
  });
});

describe("pasteOverflow", () => {
  test("counts the characters left out of a paste", () => {
    expect(pasteOverflow("abcd", 4, 4, "efghij", 8)).toBe(2);
  });
  test("is zero when the paste fits", () => {
    expect(pasteOverflow("abcd", 4, 4, "efgh", 8)).toBe(0);
  });
  test("a selection the paste replaces frees its room", () => {
    expect(pasteOverflow("abcdefgh", 2, 6, "123456", 8)).toBe(2);
    expect(pasteOverflow("abcdefgh", 6, 2, "1234", 8)).toBe(0);
  });
  test("a full box takes none of it", () => {
    expect(pasteOverflow("abcdefgh", 8, 8, "xyz", 8)).toBe(3);
  });
});
