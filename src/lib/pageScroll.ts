import type { ShortcutEventLike } from "./shortcuts.ts";

/** Plain page keys can belong to chat without replacing modified app shortcuts. */
export function plainPageDirection(event: ShortcutEventLike): -1 | 1 | null {
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.isComposing || event.keyCode === 229) return null;
  return event.key === "PageUp" ? -1 : event.key === "PageDown" ? 1 : null;
}

/** Lines kept visible between pages, in chat and in terminal history. */
export const PAGE_OVERLAP_ROWS = 1;

/** Native rows and chat pixels retain the requested overlap between pages. */
export function pageScrollDistance(viewport: number, lineHeight: number, overlapRows: number): number {
  return Math.max(1, viewport - lineHeight * overlapRows);
}
