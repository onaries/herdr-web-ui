/** The file panel's width when the user has dragged its edge: per device, like the sidebar's. */
const KEY = "ovis:file-panel-width";

/** From this window width the file panel docks beside the pane; below it the viewer is a sheet. */
export const FILE_PANEL_DOCK_QUERY = "(min-width: 980px)";
export const FILE_PANEL_MIN_WIDTH = 320;
export const FILE_PANEL_MAX_WIDTH = 900;
/** one arrow key press on the focused edge */
export const FILE_PANEL_WIDTH_STEP = 16;

/** The panel yields to the sidebar and a 320px pane, even below its preferred minimum. */
export function filePanelMaxWidth(viewportWidth: number, sidebarWidth = 0): number {
  return Math.min(
    Math.max(FILE_PANEL_MIN_WIDTH, Math.min(FILE_PANEL_MAX_WIDTH, Math.floor(viewportWidth * 0.6))),
    Math.floor(viewportWidth - sidebarWidth - 320),
  );
}

export function clampFilePanelWidth(width: number, viewportWidth = Number.POSITIVE_INFINITY, sidebarWidth = 0): number {
  const max = filePanelMaxWidth(viewportWidth, sidebarWidth);
  return Math.round(Math.min(max, Math.max(FILE_PANEL_MIN_WIDTH, width)));
}

/** Where a key moves the edge from `current`; the edge is the panel's left one, so ArrowLeft widens. Null for a key that is not the edge's. */
export function keyedFilePanelWidth(current: number, key: string, viewportWidth = Number.POSITIVE_INFINITY, sidebarWidth = 0): number | null {
  if (key === "ArrowLeft") return clampFilePanelWidth(current + FILE_PANEL_WIDTH_STEP, viewportWidth, sidebarWidth);
  if (key === "ArrowRight") return clampFilePanelWidth(current - FILE_PANEL_WIDTH_STEP, viewportWidth, sidebarWidth);
  if (key === "Home") return clampFilePanelWidth(FILE_PANEL_MIN_WIDTH, viewportWidth, sidebarWidth);
  if (key === "End") return filePanelMaxWidth(viewportWidth, sidebarWidth);
  return null;
}

/** The stored value as a width, or null when nothing usable is stored (the default width applies). */
export function parseFilePanelWidth(stored: string | null): number | null {
  if (stored === null || !/^\d+$/.test(stored)) return null;
  return clampFilePanelWidth(Number(stored));
}

export function storedFilePanelWidth(): number | null {
  try {
    return parseFilePanelWidth(window.localStorage.getItem(KEY));
  } catch {
    return null;
  }
}

/** null forgets the choice: the panel goes back to its default width. */
export function storeFilePanelWidth(width: number | null): void {
  try {
    if (width === null) window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, String(clampFilePanelWidth(width)));
  } catch {
    /* private mode: the width simply is not remembered */
  }
}
