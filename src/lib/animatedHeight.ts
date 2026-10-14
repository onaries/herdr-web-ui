/**
 * The sizing behind components/AnimatedHeight.tsx: a box that follows its content's measured
 * height through a CSS transition. Its first measurement lays the box out where the content
 * already is, so nothing moves on mount; a later one sets the box moving, and it clips its
 * content until the transition reports its end. A fold aims the box at nothing.
 */
export interface HeightState {
  /** the box's height in px; null before its content was ever measured (the box is auto) */
  readonly height: number | null;
  /** the height is on its way: the box clips its content until the move has ended */
  readonly moving: boolean;
}

/** Before anything was measured: the box takes its content's height on its own. */
export const RESTING: HeightState = { height: null, moving: false };

/** Time allowed past a transition's computed span for its end event before the box rests on its own. */
export const SETTLE_GRACE_MS = 100;

/**
 * Where the box goes for content measured `measured` px tall, or for a fold (`null`). The same
 * height hands back the same state, so a measurement that found nothing new commits nothing.
 */
export function heightFor(state: HeightState, measured: number | null): HeightState {
  const height = measured === null ? 0 : Math.ceil(measured);
  if (state.height === height) return state;
  // the first measurement lays the box out where its content already is: nothing moves
  return { height, moving: state.height !== null };
}

/** The transition reported its end, or never ran: the box rests at its height, its content unclipped. */
export function settled(state: HeightState): HeightState {
  return state.moving ? { height: state.height, moving: false } : state;
}

/** Each entry of a computed `transition-duration` or `transition-delay` ("0.18s, 50ms"), in ms. */
export function transitionTimes(value: string): number[] {
  return value.split(",").map((entry) => {
    const match = /^\s*(-?\d*\.?\d+)(ms|s)\s*$/.exec(entry);
    if (match === null) return 0;
    return Number(match[1]) * (match[2] === "s" ? 1000 : 1);
  });
}

/**
 * How long the longest of an element's transitions runs from now, its delay included, in ms:
 * 0 when none moves (`transition: none`, reduced motion, Panel motion off), so the box can rest
 * at once instead of waiting for an end event that never comes. A delay list shorter than the
 * duration list repeats, as the browser pairs them.
 */
export function transitionSpan(duration: string, delay: string): number {
  const durations = transitionTimes(duration);
  const delays = transitionTimes(delay);
  let span = 0;
  durations.forEach((length, index) => {
    if (length <= 0) return;
    span = Math.max(span, length + (delays[index % delays.length] ?? 0));
  });
  return span;
}
