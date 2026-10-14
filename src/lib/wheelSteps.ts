/**
 * Lines herdr scrolls a pane per wheel report: its `ui.mouse_scroll_lines` default. The browser
 * cannot read the PC's herdr config, so a changed value only changes how far one report goes.
 */
export const HERDR_MOUSE_SCROLL_LINES = 3;

/**
 * Whole steps of `stepPixels` in the pixels gathered so far, and the pixels left for the next
 * move. Steps keep the sign of the travel; the rest keeps it too, so a reversal first pays back
 * what was gathered the other way. No step size (an unlaid-out terminal) makes no steps.
 */
export function wheelSteps(pixels: number, stepPixels: number): { steps: number; rest: number } {
  if (!(stepPixels > 0) || !Number.isFinite(pixels)) return { steps: 0, rest: 0 };
  const steps = Math.trunc(pixels / stepPixels);
  return { steps, rest: pixels - steps * stepPixels };
}

/**
 * The last step a gesture sends when the finger lifts: one more in the travel's direction when
 * what is left reaches half a step, so a short flick still scrolls and a long drag loses no more
 * than half a step at its end. No step size makes no step.
 */
export function finalStep(rest: number, stepPixels: number): -1 | 0 | 1 {
  if (!(stepPixels > 0) || !Number.isFinite(rest)) return 0;
  return Math.abs(rest) >= stepPixels / 2 ? (Math.sign(rest) as -1 | 1) : 0;
}
