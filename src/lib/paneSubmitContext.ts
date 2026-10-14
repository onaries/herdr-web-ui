import { createContext } from "react";
import type { PaneSubmitRetention } from "./paneSubmitRetention.ts";

/** A retained terminal keeps its live submit/queue lease, not its off-screen composer or chat poll. */
export const PaneSubmitContext = createContext<PaneSubmitRetention | null>(null);
export const PanePresentedContext = createContext(true);
/** false for a split tab's pane a phone keeps hidden behind the one it shows: it must not size the shared pty */
export const PaneShownContext = createContext(true);
