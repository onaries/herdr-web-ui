import { describe, expect, it } from "bun:test";

import { NARROW_PANE_COLS, narrowPaneFontSize } from "./narrowPaneFont.ts";
import { TERMINAL_FONT_MIN } from "./settings.ts";

/** A pane `width` px wide whose cells are 0.6 of the font size, as a monospace face's are. */
const pane = (width: number) => (size: number): number => Math.floor(width / (size * 0.6));

describe("narrowPaneFontSize", () => {
  it("keeps the user's size in a pane that already has 80 columns", () => {
    expect(narrowPaneFontSize(13, pane(700))).toBe(13);
  });

  it("takes the largest smaller size that reaches 80 columns", () => {
    const colsAt = pane(565); // 72 columns at 13px
    expect(colsAt(13)).toBe(72);
    const size = narrowPaneFontSize(13, colsAt);
    expect(size).toBe(11);
    expect(colsAt(size)).toBeGreaterThanOrEqual(NARROW_PANE_COLS);
    expect(colsAt(size + 1)).toBeLessThan(NARROW_PANE_COLS);
  });

  it("finds the size just above the rounded-down estimate", () => {
    const colsAt = pane(580); // 74 columns at 13px: the estimate says 12, and 12 fits
    expect(narrowPaneFontSize(13, colsAt)).toBe(12);
  });

  it("goes down to the smallest font, and no further", () => {
    const colsAt = pane(480);
    expect(colsAt(TERMINAL_FONT_MIN)).toBe(NARROW_PANE_COLS);
    expect(narrowPaneFontSize(13, colsAt)).toBe(TERMINAL_FONT_MIN);
  });

  it("keeps the user's size where even the smallest font cannot reach 80 columns", () => {
    expect(narrowPaneFontSize(13, pane(470))).toBe(13);
    expect(narrowPaneFontSize(13, pane(200))).toBe(13);
  });

  it("keeps the user's size while the pane is not laid out", () => {
    expect(narrowPaneFontSize(13, () => null)).toBe(13);
  });
});
