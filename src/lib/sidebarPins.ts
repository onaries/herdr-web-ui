/**
 * The browser's pinned sidebar rows: agents and workspaces, in one list shared with the other
 * browsers of the server. Keys include the PC so an id reused on another PC never receives the
 * old PC's pin; a workspace's key marks itself as one, after the PC.
 */

const STORAGE_KEY = "herdr-web-ui:sidebar-agent-pins";

export function sidebarPinKey(machineId: string, paneId: string): string {
  return `${machineId}:${paneId}`;
}

/** what follows the PC in a workspace's key: herdr's pane ids never start with it */
const WORKSPACE_MARK = "workspace:";

export function workspacePinKey(machineId: string, workspaceId: string): string {
  return `${machineId}:${WORKSPACE_MARK}${workspaceId}`;
}

export function isWorkspacePinKey(key: string): boolean {
  const machineId = pinMachineId(key);
  return machineId !== null && key.startsWith(WORKSPACE_MARK, machineId.length + 1);
}

/** This PC's pinned workspaces, in pin order. */
export function pinnedWorkspaceIds(keys: readonly string[], machineId: string): string[] {
  const prefix = workspacePinKey(machineId, "");
  return keys.flatMap((key) => key.startsWith(prefix) && key.length > prefix.length ? [key.slice(prefix.length)] : []);
}

/** This PC's workspace pins whose workspace is gone leave with a change of the user's; every other pin stays. */
export function pruneWorkspacePins(keys: readonly string[], machineId: string, liveWorkspaceIds: ReadonlySet<string>): string[] {
  const prefix = workspacePinKey(machineId, "");
  return keys.filter((key) => !key.startsWith(prefix) || liveWorkspaceIds.has(key.slice(prefix.length)));
}

function storage(): Storage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; }
  catch { return null; }
}

export function loadSidebarPins(): string[] {
  try {
    // a denied read throws here as well: the sidebar then starts with no pins
    const value = storage()?.getItem(STORAGE_KEY);
    if (value === undefined || value === null) return [];
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? [...new Set(parsed.filter((key): key is string => typeof key === "string" && key.length > 0))] : [];
  } catch { return []; }
}

export function saveSidebarPins(keys: readonly string[]): void {
  try { storage()?.setItem(STORAGE_KEY, JSON.stringify([...new Set(keys)])); }
  catch { /* storage denied: pins last for the session */ }
}

/**
 * The pins this page holds, for the sidebar and for the sync with the other browsers
 * (lib/preferencesSync.ts): set here, they are saved and every reader hears it.
 */
let pins: string[] | null = null;
const pinListeners = new Set<() => void>();

export function currentSidebarPins(): string[] {
  pins ??= loadSidebarPins();
  return pins;
}

export function setSidebarPins(keys: readonly string[]): void {
  const next = [...new Set(keys)];
  const current = currentSidebarPins();
  if (next.length === current.length && next.every((key, index) => key === current[index])) return;
  pins = next;
  saveSidebarPins(next);
  for (const listener of [...pinListeners]) listener();
}

export function subscribeSidebarPins(listener: () => void): () => void {
  pinListeners.add(listener);
  return () => { pinListeners.delete(listener); };
}

export function toggleSidebarPin(keys: readonly string[], key: string): string[] {
  return keys.includes(key) ? keys.filter((current) => current !== key) : [...keys, key];
}

function pinMachineId(key: string): string | null {
  const separator = key.indexOf(":");
  return separator > 0 ? key.slice(0, separator) : null;
}

/** The agent pins whose pane is gone from a loaded PC leave; workspace pins are the workspace list's to prune. */
export function pruneSidebarPins(keys: readonly string[], liveKeys: ReadonlySet<string>, machines: readonly { id: string; snapshot: object | null }[]): string[] {
  if (machines.length === 0) return [...keys];
  const loading = new Set(machines.filter((machine) => machine.snapshot === null).map((machine) => machine.id));
  return keys.filter((key) => isWorkspacePinKey(key) || liveKeys.has(key) || (pinMachineId(key) !== null && loading.has(pinMachineId(key)!)));
}

export interface WorkspaceGroup<W> { workspace: W; children: W[] }

/**
 * The workspace list's groups split by pins, as Paseo hoists a pinned chat out of its project: the
 * pinned ones first, in pin order, a pinned repository's workspace with its worktrees and a pinned
 * worktree alone; the rest in the source order. A pinned worktree leaves its group, which stays.
 */
export function splitPinnedGroups<W>(groups: readonly WorkspaceGroup<W>[], pinnedIds: readonly string[], idOf: (workspace: W) => string): { pinned: WorkspaceGroup<W>[]; rest: WorkspaceGroup<W>[] } {
  const pinnedSet = new Set(pinnedIds);
  const strip = (group: WorkspaceGroup<W>): WorkspaceGroup<W> => ({ workspace: group.workspace, children: group.children.filter((child) => !pinnedSet.has(idOf(child))) });
  const byId = new Map<string, WorkspaceGroup<W>>();
  for (const group of groups) {
    byId.set(idOf(group.workspace), strip(group));
    for (const child of group.children) byId.set(idOf(child), { workspace: child, children: [] });
  }
  const pinned = [...pinnedSet].flatMap((id) => {
    const group = byId.get(id);
    return group === undefined ? [] : [group];
  });
  return { pinned, rest: groups.filter((group) => !pinnedSet.has(idOf(group.workspace))).map(strip) };
}

/** The rows of the pinned groups, a pinned repository's worktrees too: none of them is reordered. */
export function pinnedGroupIds<W>(pinned: readonly WorkspaceGroup<W>[], idOf: (workspace: W) => string): Set<string> {
  return new Set(pinned.flatMap((group) => [group.workspace, ...group.children].map(idOf)));
}

/** Pinned rows in their saved order, and the other rows in the source roster order. */
export function splitPinnedRows<T>(rows: readonly T[], keys: readonly string[], keyOf: (row: T) => string): { pinned: T[]; rest: T[] } {
  const byKey = new Map(rows.map((row) => [keyOf(row), row]));
  const pinned = keys.flatMap((key) => {
    const row = byKey.get(key);
    return row === undefined ? [] : [row];
  });
  const pinnedKeys = new Set(pinned.map(keyOf));
  return { pinned, rest: rows.filter((row) => !pinnedKeys.has(keyOf(row))) };
}
