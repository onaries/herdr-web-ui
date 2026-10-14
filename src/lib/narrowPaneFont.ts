import { TERMINAL_FONT_MIN } from "./settings.ts";

/** The width full-screen programs expect at least (btop refuses to draw under it). */
export const NARROW_PANE_COLS = 80;

/**
 * The font a split pane draws at: the user's size, or the largest smaller one that gives the
 * pane 80 columns. `colsAt` measures the columns the pane would have at a size (null when it is
 * not laid out). A pane that cannot reach 80 columns even at the smallest font keeps the user's
 * size: a phone must not shrink every pane for nothing.
 */
export function narrowPaneFontSize(base: number, colsAt: (size: number) => number | null): number {
  const cols = colsAt(base);
  if (cols === null || cols >= NARROW_PANE_COLS) return base;
  // the estimate rounds down twice (the columns, then the size): the size above it may still fit
  for (let size = Math.min(base - 1, Math.floor(base * cols / NARROW_PANE_COLS) + 1); size >= TERMINAL_FONT_MIN; size--) {
    const fitted = colsAt(size);
    if (fitted !== null && fitted >= NARROW_PANE_COLS) return size;
  }
  return base;
}
