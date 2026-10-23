import type { PaneScrollInfo } from "./herdr-api.generated.ts";

export interface PaneFindMatch {
  start: { row: number; col: number };
  end: { row: number; col: number };
}

export interface PaneFindRequest {
  pane_id: string;
  query: string;
  direction: "forward" | "backward";
  /** Defaults to true. False reads matches without moving the shared viewport. */
  jump?: boolean;
  previous?: PaneFindMatch;
  content_revision?: number;
}

export interface PaneFindResponse {
  total: number;
  /** One-based ordinal, or null when no match was found. */
  current: number | null;
  match: PaneFindMatch | null;
  content_revision: number;
  /** Native window around current, at most 1024; absent on older bridges. End cells are inclusive. */
  matches?: PaneFindMatch[];
  /** Viewport mapping at the searched revision; absent on older bridges. */
  scroll?: PaneScrollInfo | null;
}
