/** Settings → Appearance → Interface font size: the size lib/settings.ts writes as --ui-scale, and the chat's --chat-scale. */

/** The interface's body size (`--fs-md`) in px: the chat's range, less the sizes a 32px control cannot hold. */
export const UI_FONT_MIN = 11;
export const UI_FONT_MAX = 20;

/** A stored interface size: a whole px within the limits, or null (follow the density) for anything else. */
export function sanitizeUiFontSize(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(UI_FONT_MAX, Math.max(UI_FONT_MIN, Math.round(value)));
}

/**
 * The multiplier that draws `basePx` text at `sizePx`: `--ui-scale` is the interface's body size
 * over the density's own, and `--chat-scale` the chat's over the interface's, so a chosen chat
 * size is drawn as itself whatever the interface size and an unchosen one follows it. 1 when
 * either side is not a positive size.
 */
export function fontScale(sizePx: number, basePx: number): number {
  if (!(sizePx > 0) || !(basePx > 0)) return 1;
  return sizePx / basePx;
}
