/**
 * Settings → Appearance → Text smoothing and Panel motion. lib/settings.ts writes them on <html>
 * (`data-font-smoothing`, `--motion-scale`) and src/styles.css reads them; the durations the
 * scale multiplies are the stylesheet's (DESIGN.md, Motion). Only the choices are decided here.
 */

/** grayscale: the thinner smoothing the app always drew; system: whatever the OS does by default (subpixel on older macOS) */
export const FONT_SMOOTHINGS = ["grayscale", "system"] as const;
export type FontSmoothing = (typeof FONT_SMOOTHINGS)[number];
export const FONT_SMOOTHING_DEFAULT: FontSmoothing = "grayscale";

/** The drawer and the phone sheets: off snaps them open and closed, the others scale their durations. */
export const PANEL_MOTIONS = ["off", "fast", "default", "slow"] as const;
export type PanelMotion = (typeof PANEL_MOTIONS)[number];
export const PANEL_MOTION_DEFAULT: PanelMotion = "default";

const PANEL_MOTION_SCALE: Record<PanelMotion, number> = { off: 0, fast: 0.5, default: 1, slow: 1.75 };

/** A value from a saved record: a known choice, else the default, so a stale or hand-edited record never breaks the look. */
export function sanitizeFontSmoothing(value: unknown): FontSmoothing {
  return FONT_SMOOTHINGS.find((choice) => choice === value) ?? FONT_SMOOTHING_DEFAULT;
}

export function sanitizePanelMotion(value: unknown): PanelMotion {
  return PANEL_MOTIONS.find((choice) => choice === value) ?? PANEL_MOTION_DEFAULT;
}

/** What <html> carries as data-font-smoothing: nothing at the default, so the stylesheet draws as it always did. */
export function fontSmoothingAttribute(choice: FontSmoothing): string | undefined {
  return choice === FONT_SMOOTHING_DEFAULT ? undefined : choice;
}

/** What <html> carries as --motion-scale: the factor on the drawer and sheet durations. */
export function panelMotionScale(choice: PanelMotion): string {
  return String(PANEL_MOTION_SCALE[choice]);
}
