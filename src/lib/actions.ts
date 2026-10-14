/**
 * What the shell lets its surfaces do. App builds one AppActions object and hands it
 * to the header, the sidebar, the command palette and the settings dialog, so a
 * keyboard shortcut, a palette row and a sidebar button all run the same code.
 */

import type { SplitPaneDirection } from "../../shared/protocol.ts";
import type { ZoomMode } from "./layoutMap.ts";

export type PaneView = "chat" | "terminal";

/** The selected pane’s mounted history, bound to its PC. */
export interface PaneControls {
  scrollPage: (direction: -1 | 1) => void;
}

export interface AppActions {
  selectPane: (paneId: string) => void;
  /** the previous/next pane in sidebar order; wraps around */
  selectAdjacentPane: (direction: -1 | 1) => void;
  setView: (view: PaneView) => void;
  toggleView: () => void;
  scrollPage: (direction: -1 | 1) => void;
  openNewSession: () => void;
  /**
   * The New tab dialog for a workspace: the named one (a sidebar row's menu, on its own PC),
   * else the selected pane's. Nothing happens without a workspace to add the tab to.
   */
  openNewTab: (target?: { machineId: string; workspaceId: string }) => void;
  /** the palette, blank or opened on `query` (a `>` prefix keeps the actions alone) */
  openPalette: (query?: string) => void;
  /** A pane this page started an agent in opens in an agent's lens, whatever its first snapshot says. */
  agentStarted: (machineId: string, paneId: string) => void;
  openFind: () => void;
  openSettings: () => void;
  /** the Add PC dialog, from Settings → Remote PCs and the palette; Settings closes first */
  openAddPc: () => void;
  toggleSidebar: () => void;
  /** flips dark/light (a `system` setting becomes the opposite of the resolved theme) */
  toggleTheme: () => void;
  /** Sign out of token/device authentication; null for automatic local/Tailscale access. */
  lock: (() => void) | null;
  /** null once alerts are on (or unsupported); otherwise asks for permission */
  enableNotifications: (() => void) | null;
  refresh: () => void;
  /** null without a pane: the files of its folder, each opened in the file viewer */
  openFiles: (() => void) | null;
  /**
   * herdr's split beside the selected pane (its prefix+v and prefix+-), null without a pane. The
   * selection stays on this pane, as herdr's --no-focus keeps its focus, unless `focus` asks for
   * the new pane: then herdr focuses it and the app opens it.
   */
  splitPane: ((direction: SplitPaneDirection, focus?: boolean) => void) | null;
  /**
   * herdr's prefix+z on the selected pane, with the mode the caller's item names (`zoomMode`,
   * lib/layoutMap.ts): its tab shows it alone, or every pane again; null without a pane
   */
  zoomPane: ((mode: ZoomMode) => void) | null;
}
