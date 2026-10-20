import { sameTarget, type SplitTarget } from "./split.ts";

/**
 * Following herdr's focus (Settings → Terminal, `followHerdrFocus`, #311): herdr's own window
 * moves to the pane a click there, `herdr tab focus` or a script brings to the front, and a
 * `pane-focused` frame says so. This device opens that pane too, only when it asked to and only on
 * the PC it has open: another PC's focus is that PC's business, and a pane already in front (the
 * selected one, or the other half of a split) stays where it is. A link still landing goes first.
 */
export function followsHerdrFocus(input: {
  enabled: boolean;
  /** the PC and pane the frame names */
  machineId: string;
  paneId: string;
  selection: { machineId: string; paneId: string | null };
  /** the split's other half, while it is drawn */
  splitOther: SplitTarget | null;
  linkPending: boolean;
}): boolean {
  if (!input.enabled || input.linkPending) return false;
  if (input.machineId !== input.selection.machineId || input.paneId === input.selection.paneId) return false;
  return !sameTarget(input.splitOther, { machineId: input.machineId, paneId: input.paneId });
}
