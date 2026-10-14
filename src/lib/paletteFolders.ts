/**
 * Folder browsing inside the command palette (adapted from T3 Code's palette browse mode): a query
 * that starts as a path does (`~`, `/`, `C:\`) lists the folders of the PC instead of panes. The
 * last segment filters the folder named before it; Enter on a folder walks into it, and the
 * folder reached opens in Files. Pinned folders (the folders of the panes pinned in the Agents
 * roster) and the PC's recent folders are offered as jumps while the typed path leads to them.
 */

import { sidebarPinKey } from "./sidebarPins.ts";

export interface FolderQuery {
  /** the folder to list, as the server takes it (absolute, `~` or `~/…`) */
  directory: string;
  /** the text after its last `/`, filtering its folders by their start */
  filter: string;
}

const PATH_START = /^(?:~(?:[\\/]|$)|\/|[A-Za-z]:[\\/])/u;

/** The folder a path-like query names and the filter after it, or null for a pane/action search. */
export function folderQuery(query: string): FolderQuery | null {
  if (!PATH_START.test(query)) return null;
  const path = query.replace(/\\/g, "/");
  const cut = path.lastIndexOf("/");
  if (cut < 0) return { directory: path, filter: "" };
  let directory = path.slice(0, cut + 1);
  // `~/` is home and `C:/` a drive's root: only a deeper folder loses its trailing slash
  if (directory === "~/") directory = "~";
  else if (directory !== "/" && !/^[A-Za-z]:\/$/u.test(directory)) directory = directory.replace(/\/+$/u, "") || "/";
  return { directory, filter: path.slice(cut + 1) };
}

/** `~/…` for a path inside home, as the directory field is usually typed. */
export function homeRelative(path: string, home: string): string {
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

/** The query that lists `path`: its home-relative form with a trailing slash. */
export function folderQueryFor(path: string, home: string | null): string {
  const shown = home === null ? path : homeRelative(path, home);
  return shown.endsWith("/") ? shown : `${shown}/`;
}

/**
 * The folders whose name starts with the filter (any case), the one it names exactly first. A
 * dot-folder shows only once the filter starts with a dot.
 */
export function browseEntries(directories: readonly string[], filter: string): string[] {
  const lower = filter.toLowerCase();
  const showHidden = filter.startsWith(".");
  const visible = directories.filter((name) => name.toLowerCase().startsWith(lower) && (showHidden || !name.startsWith(".")));
  const exact = filter === "" ? -1 : visible.findIndex((name) => name.toLowerCase() === lower);
  return exact <= 0 ? visible : [visible[exact]!, ...visible.slice(0, exact), ...visible.slice(exact + 1)];
}

interface PinnedPane { pane_id: string; cwd?: string | null; foreground_cwd?: string | null }

/** The folders of this PC's pinned panes, in pin order, each once. */
export function pinnedFolders(pins: readonly string[], machineId: string, panes: readonly PinnedPane[]): string[] {
  const byKey = new Map(panes.map((pane) => [sidebarPinKey(machineId, pane.pane_id), pane]));
  const folders = pins.flatMap((key) => {
    const pane = byKey.get(key);
    const path = pane?.foreground_cwd ?? pane?.cwd;
    return path ? [path] : [];
  });
  return [...new Set(folders)];
}

/**
 * The folders the typed path leads to (any case), by their absolute or home-relative form; the
 * folder already listed is left out, and `limit` caps the list.
 */
export function matchFolders(paths: readonly string[], query: string, home: string | null, limit: number): string[] {
  const typed = query.replace(/\\/g, "/").toLowerCase();
  const forms = (path: string): string[] => [folderQueryFor(path, null), ...(home === null ? [] : [folderQueryFor(path, home)])].map((form) => form.toLowerCase());
  return paths.filter((path) => forms(path).some((form) => form !== typed && form.startsWith(typed))).slice(0, limit);
}

/**
 * The folder the palette asked Files to show: Files' browser takes it as it opens, or at once
 * while it is already open, instead of the pane's own folder.
 */
let requestedFolder: string | null = null;
const folderListeners = new Set<() => void>();

export function requestFilesFolder(path: string): void {
  requestedFolder = path;
  for (const listener of [...folderListeners]) listener();
}

export function takeFilesFolder(): string | null {
  const path = requestedFolder;
  requestedFolder = null;
  return path;
}

export function subscribeFilesFolder(listener: () => void): () => void {
  folderListeners.add(listener);
  return () => { folderListeners.delete(listener); };
}
