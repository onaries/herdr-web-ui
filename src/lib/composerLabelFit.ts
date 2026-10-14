import type { ComposerModelDraw } from "./compose.ts";

/**
 * The last step of the model label's fit in the composer's controls row. `composerModelDraw`
 * (lib/compose.ts) measures the row with everything drawn and steps the level out first. This
 * is measured again after that: a name still clipped at its floor (the `3ch` the box keeps so
 * an ellipsized name stays a word) would be a stub, and the group's edge would cut the context
 * ring after it. So the label steps out whole instead, mark and all, read and not drawn, and the
 * ring stands alone and whole, as the row promises. A name clipped above its floor stays: a long
 * identifier shortened to what fits still says what it is.
 */
export function composerLabelDraw(draw: ComposerModelDraw, measured: { modelClipped: boolean; modelWidth: number; modelFloor: number }): ComposerModelDraw {
  if (draw !== "no-effort") return draw;
  return measured.modelClipped && measured.modelWidth <= measured.modelFloor ? "out" : draw;
}
