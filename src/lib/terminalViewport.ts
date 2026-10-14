import type { PaneFindMatch, PaneScrollInfo } from "../../shared/protocol.ts";

export interface ViewportCell { chars: string; width: number }
export interface FindCellRect { row: number; col: number; width: number; current: boolean }
export type CellReader = (row: number, col: number) => ViewportCell | undefined;

export function validScroll(value: PaneScrollInfo | null | undefined): value is PaneScrollInfo {
  return value != null && [value.offset_from_bottom, value.max_offset_from_bottom, value.viewport_rows].every(Number.isSafeInteger)
    && value.viewport_rows > 0 && value.max_offset_from_bottom >= 0 && value.offset_from_bottom >= 0 && value.offset_from_bottom <= value.max_offset_from_bottom;
}
export function scrollThumb(scroll: PaneScrollInfo, height: number, minimum = 24): { top: number; height: number } {
  const size = Math.min(height, Math.max(minimum, height * scroll.viewport_rows / (scroll.max_offset_from_bottom + scroll.viewport_rows)));
  return { height: size, top: (height - size) * (1 - scroll.offset_from_bottom / Math.max(1, scroll.max_offset_from_bottom)) };
}
export function offsetAtThumb(scroll: PaneScrollInfo, top: number, height: number, thumbHeight: number): number {
  const ratio = Math.max(0, Math.min(1, top / Math.max(1, height - thumbHeight)));
  return Math.round(scroll.max_offset_from_bottom * (1 - ratio));
}
/** a metrics read re-arms this soon while output is arriving */
export const SCROLL_POLL_BUSY_MS = 250;
/** the longest an idle, visible pane waits between metrics reads */
export const SCROLL_POLL_IDLE_MAX_MS = 15_000;
/** Delay before the next metrics read after `idleReads` reads in a row with no output, scroll,
 * resize or visibility change in between: 1 s, 2 s, 4 s, 8 s, then 15 s. Any of those events
 * resets the count, so a quiet pane stops asking herdr every second yet still catches a scroll
 * made without output (another client, herdr itself) within the cap. */
export function idleScrollPollDelay(idleReads: number): number {
  const reads = Number.isFinite(idleReads) && idleReads > 0 ? Math.floor(idleReads) : 0;
  return Math.min(SCROLL_POLL_IDLE_MAX_MS, 1000 * 2 ** Math.min(reads, 4));
}
/** The poll's next delay: busy while something is moving, 1 s while scrolled up into history (herdr can
 * hold that view still while output grows the history below it, which sends this client no bytes to wake
 * the poll), else the idle backoff. */
export function scrollPollDelay(busy: boolean, idleReads: number, metrics: PaneScrollInfo | null | undefined): number {
  if (busy) return SCROLL_POLL_BUSY_MS;
  if (validScroll(metrics) && metrics.offset_from_bottom > 0) return 1000;
  return idleScrollPollDelay(idleReads);
}
export function sameFindMatch(a: PaneFindMatch | null | undefined, b: PaneFindMatch): boolean {
  return !!a && a.start.row === b.start.row && a.start.col === b.start.col && a.end.row === b.end.row && a.end.col === b.end.col;
}
const quote = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Native history cells are inclusive. Validate against the attach buffer before painting:
 * the HTTP reply and terminal bytes have no shared delivery sequence. Never use DOM text,
 * xterm's lost wrap flags or its selection to fabricate/paint a native match. */
export function visibleFindRects(matches: readonly PaneFindMatch[], scroll: PaneScrollInfo, query: string, cols: number, rows: number, read: CellReader, current?: PaneFindMatch | null): FindCellRect[] {
  if (!query || !validScroll(scroll) || scroll.viewport_rows !== rows || cols <= 0) return [];
  const top = scroll.max_offset_from_bottom - scroll.offset_from_bottom;
  const bottom = top + rows - 1;
  const result: FindCellRect[] = [];
  const flags = /\p{Lu}/u.test(query) ? "u" : "iu";
  for (const match of matches) {
    if (match.end.row < top || match.start.row > bottom || match.start.row > match.end.row) continue;
    if (match.start.col < 0 || match.end.col < 0 || match.start.col >= cols || match.end.col >= cols) continue;
    const first = Math.max(top, match.start.row), last = Math.min(bottom, match.end.row);
    const parts: FindCellRect[] = [];
    let text = "";
    let valid = true;
    for (let row = first; row <= last && valid; row++) {
      const start = row === match.start.row ? match.start.col : 0;
      const end = row === match.end.row ? match.end.col : cols - 1;
      if (end < start || read(row - top, start)?.width === 0) { valid = false; break; }
      for (let col = start; col <= end; col++) {
        const cell = read(row - top, col);
        if (!cell || (cell.width > 0 && col + cell.width - 1 > end)) { valid = false; break; }
        if (cell.width > 0) text += cell.chars || " ";
      }
      parts.push({ row: row - top, col: start, width: end - start + 1, current: sameFindMatch(current, match) });
    }
    if (!valid || !text) continue;
    // A clipped match must still agree with the corresponding visible end of the query.
    const pattern = `${match.start.row >= top ? "^" : ""}${quote(text)}${match.end.row <= bottom ? "$" : ""}`;
    if (new RegExp(pattern, flags).test(query)) result.push(...parts);
  }
  return result;
}
