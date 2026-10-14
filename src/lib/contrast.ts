/**
 * Settings → Appearance → Contrast: how far text and hairlines stand out from the surfaces, in
 * steps around the palette's own drawing. lib/settings.ts writes the step on <html> as
 * `data-contrast` and src/styles.css mixes the text and border tokens by it; what each step
 * mixes is the stylesheet's (DESIGN.md, Contrast). Only the steps themselves are decided here.
 */

/** The softest step: --text and --text-strong halfway to --text-dim, the hairlines at half strength. */
export const CONTRAST_MIN = -2;
/** The strongest step: the text tokens most of the way to white (dark) or black (light). */
export const CONTRAST_MAX = 3;
/** The palette as its block draws it. */
export const CONTRAST_DEFAULT = 0;

/** A step from a saved record: whole and within the range; anything else is the default, so a stale or hand-edited record never breaks the look. */
export function sanitizeContrast(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return CONTRAST_DEFAULT;
  return Math.min(CONTRAST_MAX, Math.max(CONTRAST_MIN, Math.round(value)));
}

/** The step as the stepper shows it: signed, so the default reads as 0 and a step down as a step down, not as a size. */
export function contrastText(step: number): string {
  if (step > 0) return `+${step}`;
  if (step < 0) return `−${-step}`;
  return "0";
}

/** What <html> carries for the stylesheet: the step, or nothing at the default, so the palette is drawn exactly as its block says. */
export function contrastAttribute(step: number): string | undefined {
  return step === CONTRAST_DEFAULT ? undefined : String(step);
}
