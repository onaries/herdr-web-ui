import { describe, expect, it } from "bun:test";

import { pinchFontSize } from "./pinchFontSize.ts";
import { TERMINAL_FONT_MAX, TERMINAL_FONT_MIN } from "./settings.ts";

describe("pinchFontSize", () => {
  it("keeps the starting size at the same distance", () => {
    expect(pinchFontSize(13, 100, 100)).toBe(13);
  });

  it("scales out and back from the gesture's starting size", () => {
    expect(pinchFontSize(13, 100, 154)).toBe(20);
    expect(pinchFontSize(20, 154, 100)).toBe(13);
  });

  it("clamps to the terminal font limits", () => {
    expect(pinchFontSize(13, 100, 240)).toBe(TERMINAL_FONT_MAX);
    expect(pinchFontSize(22, 240, 60)).toBe(TERMINAL_FONT_MIN);
  });

  it("rounds to whole pixels", () => {
    expect(pinchFontSize(13, 100, 104)).toBe(14);
    expect(pinchFontSize(13, 100, 103)).toBe(13);
  });

  it("keeps the size when the start points coincide or the distance is not finite", () => {
    expect(pinchFontSize(13, 0, 50)).toBe(13);
    expect(pinchFontSize(13, 100, Number.NaN)).toBe(13);
    expect(pinchFontSize(13, 100, Number.POSITIVE_INFINITY)).toBe(13);
  });
});
