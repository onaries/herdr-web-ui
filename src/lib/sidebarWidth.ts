/** The sidebar's width when the user has dragged its edge: per device, like the PC folds. */
const KEY = "ovis:sidebar-width";

export const SIDEBAR_MIN_WIDTH = 240;
export const SIDEBAR_MAX_WIDTH = 520;
/** one arrow key press on the focused edge */
export const SIDEBAR_WIDTH_STEP = 16;

/** The widest the sidebar may be in this window: it never takes more than half of it. */
export function sidebarMaxWidth(viewportWidth: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Math.floor(viewportWidth / 2)));
}

export function clampSidebarWidth(width: number, viewportWidth = Number.POSITIVE_INFINITY): number {
  return Math.round(Math.max(SIDEBAR_MIN_WIDTH, Math.min(sidebarMaxWidth(viewportWidth), width)));
}

/** Where a key moves the edge from `current`, or null for a key that is not the edge's. */
export function keyedSidebarWidth(current: number, key: string, viewportWidth = Number.POSITIVE_INFINITY): number | null {
  if (key === "ArrowLeft") return clampSidebarWidth(current - SIDEBAR_WIDTH_STEP, viewportWidth);
  if (key === "ArrowRight") return clampSidebarWidth(current + SIDEBAR_WIDTH_STEP, viewportWidth);
  if (key === "Home") return SIDEBAR_MIN_WIDTH;
  if (key === "End") return sidebarMaxWidth(viewportWidth);
  return null;
}

/** The stored value as a width, or null when nothing usable is stored (the default width applies). */
export function parseSidebarWidth(stored: string | null): number | null {
  if (stored === null || !/^\d+$/.test(stored)) return null;
  return clampSidebarWidth(Number(stored));
}

export function storedSidebarWidth(): number | null {
  try {
    return parseSidebarWidth(window.localStorage.getItem(KEY));
  } catch {
    return null;
  }
}

/** null forgets the choice: the sidebar goes back to the density's own width. */
export function storeSidebarWidth(width: number | null): void {
  try {
    if (width === null) window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, String(clampSidebarWidth(width)));
  } catch {
    /* private mode: the width simply is not remembered */
  }
}
