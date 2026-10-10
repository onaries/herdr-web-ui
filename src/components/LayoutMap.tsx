/**
 * A tab's panes as herdr lays them out, small: one cell per pane at its place and size in the
 * tab's area, from the snapshot's layout rects (lib/layoutMap.ts). A cell opens its pane; the
 * open pane is drawn in the accent, and the pane herdr zooms carries the zoom glyph. It heads
 * the tab strip's pane menu, so a tab with several panes shows where each stands before the
 * list names them.
 */
import { Maximize2 } from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";

import "./LayoutMap.css";

import type { PaneInfo, PaneLayoutSnapshot } from "../../shared/protocol.ts";
import { useT } from "../lib/i18n.ts";
import { layoutCells, zoomedPaneId } from "../lib/layoutMap.ts";
import { displayPaneTitle } from "./Sidebar.tsx";

interface Props {
  layout: PaneLayoutSnapshot;
  /** the layout's panes as the snapshot lists them, for their titles */
  panes: readonly PaneInfo[];
  selectedPaneId: string | null;
  onSelect: (paneId: string) => void;
}

/** a terminal cell is about twice as tall as it is wide: columns over rows, held to a readable band */
function aspectRatio(layout: PaneLayoutSnapshot): number {
  const ratio = Math.max(1, layout.area.width) / (Math.max(1, layout.area.height) * 2);
  return Math.min(3, Math.max(1.2, ratio));
}

/**
 * The map heads a row menu, which closes when focus leaves it. Safari on a Mac does not focus a
 * clicked button, so the press would blur the focused item with no relatedTarget and close the
 * menu before the click selects the pane (as RowMenu's own items guard): the press keeps the
 * focus where it is, and the click still comes.
 */
const keepFocus = (event: ReactMouseEvent<HTMLButtonElement>): void => event.preventDefault();

export function LayoutMap({ layout, panes, selectedPaneId, onSelect }: Props) {
  const t = useT();
  const zoomed = zoomedPaneId(layout);
  const titleOf = (paneId: string): string => {
    const pane = panes.find((candidate) => candidate.pane_id === paneId);
    return pane ? displayPaneTitle(pane) : paneId;
  };
  return (
    <div className="layout-map" role="group" aria-label={t("Pane layout")} style={{ aspectRatio: aspectRatio(layout) }}>
      {layoutCells(layout).map((cell) => {
        const current = cell.paneId === selectedPaneId;
        const title = titleOf(cell.paneId);
        return (
          <button
            key={cell.paneId}
            type="button"
            className={`layout-map-cell${current ? " is-current" : ""}${cell.paneId === zoomed ? " is-zoomed" : ""}`}
            style={{ left: `${cell.left}%`, top: `${cell.top}%`, width: `${cell.width}%`, height: `${cell.height}%` }}
            aria-current={current ? "true" : undefined}
            aria-label={cell.paneId === zoomed ? t("{pane} (zoomed)", { pane: title }) : title}
            title={title}
            onMouseDown={keepFocus}
            onClick={() => onSelect(cell.paneId)}
          >
            {cell.paneId === zoomed && <Maximize2 aria-hidden="true" />}
          </button>
        );
      })}
    </div>
  );
}
