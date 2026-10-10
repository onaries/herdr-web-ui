import type { PaneLayoutSnapshot } from "../../shared/protocol.ts";
type PaneLayoutSplit = PaneLayoutSnapshot["splits"][number];

/** macOS Control-click opens a context menu even though its pointer button is the left one. */
export function paneContextPress(event: { button: number; ctrlKey: boolean }, apple: boolean): boolean {
  return event.button === 2 || (apple && event.button === 0 && event.ctrlKey);
}

/** herdr's stable split path, not its preorder number (which changes after another split). */
export function splitPath(id: string): boolean[] | null {
  const match = /^split_\d+_(root|[01]+)$/.exec(id);
  if (!match) return null;
  return match[1] === "root" ? [] : [...match[1]!].map((side) => side === "1");
}

/** Changes in ratios/terminal size are harmless; changes in topology cancel a drag. */
export function layoutTopology(layout: PaneLayoutSnapshot): string {
  return JSON.stringify([layout.tab_id, layout.zoomed, layout.panes.map((pane) => pane.pane_id),
    layout.splits.map((split) => [split.id, split.direction])]);
}

export function splitRatioAt(split: PaneLayoutSplit, layout: PaneLayoutSnapshot,
  canvas: { left: number; top: number; width: number; height: number }, x: number, y: number): number {
  const horizontal = split.direction === "right";
  const point = horizontal ? layout.area.x + (x - canvas.left) / canvas.width * layout.area.width
    : layout.area.y + (y - canvas.top) / canvas.height * layout.area.height;
  const start = horizontal ? split.rect.x : split.rect.y;
  const extent = horizontal ? split.rect.width : split.rect.height;
  return Math.max(0.1, Math.min(0.9, (point - start) / Math.max(1, extent)));
}
