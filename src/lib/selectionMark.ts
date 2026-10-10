/**
 * The app's selection, a PC and a pane, with a generation: a call made under one selection
 * ("Split pane right and open it", waiting on herdr over SSH) may still act on the app when it
 * answers only while nothing has been opened since. A pane opened and left again in the
 * meantime counts too: the user moved on, and what they came back to is theirs to keep.
 */
export interface SelectionMark {
  machineId: string;
  paneId: string | null;
  /** one more with every change of PC or pane */
  generation: number;
}

/** The mark once the app shows `machineId` and `paneId`: the same mark while nothing moved, else the next generation. */
export function markSelection(mark: SelectionMark, machineId: string, paneId: string | null): SelectionMark {
  if (mark.machineId === machineId && mark.paneId === paneId) return mark;
  return { machineId, paneId, generation: mark.generation + 1 };
}

/** Whether a call made under `then` may act on the selection `now`: nothing was opened in between. */
export function selectionStill(then: SelectionMark, now: SelectionMark): boolean {
  return then.generation === now.generation;
}
