import { describe, expect, test } from "bun:test";
import { DELETE_REPEAT_TEXT, keepDeleteRepeatText, keyboardNeedsText } from "./deleteRepeat.ts";

const field = (value: string) => {
  const box = { value, selection: [value.length, value.length], setSelectionRange(start: number, end: number) { box.selection = [start, end]; } };
  return box;
};

describe("keyboardNeedsText", () => {
  test("iPhone and iPad, in any browser", () => {
    expect(keyboardNeedsText({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 Version/27.0 Mobile/15E148 Safari/604.1", maxTouchPoints: 5 })).toBe(true);
    expect(keyboardNeedsText({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/141.0 Mobile/15E148 Safari/604.1", maxTouchPoints: 5 })).toBe(true);
    // iPadOS reports a Mac
    expect(keyboardNeedsText({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/27.0 Safari/605.1.15", maxTouchPoints: 5 })).toBe(true);
  });

  test("not a Mac, Android or a desktop", () => {
    expect(keyboardNeedsText({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/27.0 Safari/605.1.15", maxTouchPoints: 0 })).toBe(false);
    expect(keyboardNeedsText({ userAgent: "Mozilla/5.0 (Linux; Android 16; Pixel 7) AppleWebKit/537.36 Chrome/141.0 Mobile Safari/537.36", maxTouchPoints: 5 })).toBe(false);
    expect(keyboardNeedsText({ userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/141.0 Safari/537.36", maxTouchPoints: 0 })).toBe(false);
  });
});

describe("keepDeleteRepeatText", () => {
  test("an empty field gets the text, caret after it", () => {
    const box = field("");
    expect(keepDeleteRepeatText(box)).toBe(true);
    expect(box.value).toBe(DELETE_REPEAT_TEXT);
    expect(box.selection).toEqual([DELETE_REPEAT_TEXT.length, DELETE_REPEAT_TEXT.length]);
  });

  test("text already there, an IME's included, is left alone", () => {
    for (const value of [DELETE_REPEAT_TEXT, " 한", "abc"]) {
      const box = field(value);
      expect(keepDeleteRepeatText(box)).toBe(false);
      expect(box.value).toBe(value);
    }
  });
});
