import { TERMINAL_FONT_MAX, TERMINAL_FONT_MIN } from "./settings.ts";

/** A pinch scales the terminal font from the size it started at, not from the previous move: whole px, 10–22. */
export function pinchFontSize(startSize: number, startDistance: number, distance: number): number {
  if (!(startDistance > 0) || !Number.isFinite(distance)) return startSize;
  return Math.min(TERMINAL_FONT_MAX, Math.max(TERMINAL_FONT_MIN, Math.round(startSize * distance / startDistance)));
}
