import { createContext, type MutableRefObject } from "react";

/** One PC canvas remembers that this browser already released its panes while away.
 * Keyed terminals inherit only that view-only state, never another pane's pending input. */
export const PaneAwayContext = createContext<MutableRefObject<boolean> | null>(null);
