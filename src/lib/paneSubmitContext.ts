import { createContext } from "react";
import type { PaneSubmitRetention } from "./paneSubmitRetention.ts";

/** A retained terminal keeps its live submit receipt, not its off-screen composer or chat poll. */
export const PaneSubmitContext = createContext<PaneSubmitRetention | null>(null);
export const PanePresentedContext = createContext(true);
