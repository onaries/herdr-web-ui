import { heightFor, settled, type HeightState } from "./animatedHeight.ts";

/** Inner resizes are one layout change; only an explicit fold may move a virtualized row. */
export function contentHeightFor(state: HeightState, measured: number, animateContent: boolean): HeightState {
  const next = heightFor(state, measured);
  return animateContent || next === state ? next : settled(next);
}
