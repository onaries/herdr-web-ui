import type { ConversationTurn } from "../../shared/protocol.ts";

/** Fewer turns than this read at a glance: the minimap stays out. */
export const MINIMAP_MIN_TURNS = 4;
/** The empty margin beside the chat column the rail needs, so it never lies over the text. */
export const MINIMAP_GUTTER_PX = 32;

export interface MinimapTurn {
  readonly row: number;
  readonly preview: string;
}

/** One tick per message the user sent; a compaction, a runtime notice or a task report is no turn of theirs. */
export function minimapTurns(turns: readonly ConversationTurn[]): MinimapTurn[] {
  const result: MinimapTurn[] = [];
  turns.forEach((turn, row) => {
    if (turn.role !== "user" || turn.parts.some((part) => part.kind === "compact" || part.kind === "notice" || part.kind === "task_result")) return;
    const text = turn.parts.map((part) => part.kind === "text" ? part.text : "").join(" ").replace(/\s+/g, " ").trim();
    result.push({ row, preview: text.length > 120 ? `${text.slice(0, 119)}…` : text });
  });
  return result;
}

export function minimapTop(index: number, count: number): number {
  return count <= 1 ? 0 : (Math.max(0, Math.min(index, count - 1)) / (count - 1)) * 100;
}

/**
 * The tick of the turn in view: the first turn whose row is on screen, else the last one that
 * began above it (a long answer fills the view). Null before the first turn.
 */
export function minimapCurrent(turnRows: readonly number[], firstVisible: number, lastVisible: number): number | null {
  let before: number | null = null;
  for (const [index, row] of turnRows.entries()) {
    if (row >= firstVisible && row <= lastVisible) return index;
    if (row < firstVisible) before = index;
  }
  return before;
}

export function minimapFits(viewWidth: number, columnWidth: number): boolean {
  return (viewWidth - Math.min(viewWidth, columnWidth)) / 2 >= MINIMAP_GUTTER_PX;
}

export function minimapStep(from: number, count: number, key: string): number | null {
  if (count === 0) return null;
  if (key === "ArrowUp") return Math.max(0, from - 1);
  if (key === "ArrowDown") return Math.min(count - 1, from + 1);
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}
