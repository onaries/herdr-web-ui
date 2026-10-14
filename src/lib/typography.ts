/**
 * Settings → Appearance → Typography: the interface font and size and the code font, as the
 * values lib/settings.ts writes on `<html>` for the tokens of src/styles.css. A chosen family
 * goes in front of the built-in stack, never in place of it, as the terminal's and the chat's
 * do (lib/fontFamily.ts); the terminal keeps its own stack and size, and the chat its own once
 * chosen.
 */

import { SYMBOLS_FONT, sanitizeFontFamily } from "./fontFamily.ts";

/**
 * The built-in interface stack: `--font-ui` in src/styles.css, verbatim (typography.test.ts holds
 * the two equal). A copy, because the override is written as `--font-ui` itself and a token cannot
 * fall back to its own stylesheet value.
 */
export const UI_FONT_STACK = '"Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans KR", "Malgun Gothic", sans-serif';
/** The built-in code faces after the icon font: `--font-mono` in src/styles.css less its first name. */
export const CODE_TEXT_FONTS = '"JetBrains Mono Web", ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, "D2Coding", monospace';
/** `--font-mono` in src/styles.css, verbatim: the icon font, which draws the private use area alone, then the code faces. */
export const CODE_FONT_STACK = `${SYMBOLS_FONT}, ${CODE_TEXT_FONTS}`;

/** The interface's body size (`--fs-md`) in px: the chat's range, less the sizes a 32px control cannot hold. */
export const UI_FONT_MIN = 11;
export const UI_FONT_MAX = 20;

/** The `--font-ui` to write: the typed list in front of the built-in stack, or null to keep the stylesheet's. */
export function uiFontStack(family: string): string | null {
  const chosen = sanitizeFontFamily(family);
  return chosen === "" ? null : `${chosen}, ${UI_FONT_STACK}`;
}

/**
 * The `--font-mono` to write: the icon font, the typed list, then the built-in code faces, or null
 * to keep the stylesheet's. The icon font stays first as in the terminal's stack, so a prompt's
 * Nerd Font icons draw whatever font is chosen.
 */
export function codeFontStack(family: string): string | null {
  const chosen = sanitizeFontFamily(family);
  return chosen === "" ? null : `${SYMBOLS_FONT}, ${chosen}, ${CODE_TEXT_FONTS}`;
}

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
