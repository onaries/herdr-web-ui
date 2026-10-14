/**
 * The browser's pinned Agents roster. Keys include the PC and pane so a pane id
 * reused on another PC never receives the old PC's pin.
 */

const STORAGE_KEY = "herdr-web-ui:sidebar-agent-pins";

export function sidebarPinKey(machineId: string, paneId: string): string {
  return `${machineId}:${paneId}`;
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

export function toggleSidebarPin(keys: readonly string[], key: string): string[] {
  return keys.includes(key) ? keys.filter((current) => current !== key) : [...keys, key];
}

function pinMachineId(key: string): string | null {
  const separator = key.indexOf(":");
  return separator > 0 ? key.slice(0, separator) : null;
}

export function pruneSidebarPins(keys: readonly string[], liveKeys: ReadonlySet<string>, machines: readonly { id: string; snapshot: object | null }[]): string[] {
  if (machines.length === 0) return [...keys];
  const loading = new Set(machines.filter((machine) => machine.snapshot === null).map((machine) => machine.id));
  return keys.filter((key) => liveKeys.has(key) || (pinMachineId(key) !== null && loading.has(pinMachineId(key)!)));
}

/**
 * Pinned rows in their saved order, and the other rows in the source roster order. With workspace
 * cards, grouping `pinned` then `rest` keeps each pinned row in its own card, first there, and puts
 * the cards that hold pins first, in the order of their first pin.
 */
export function splitPinnedRows<T>(rows: readonly T[], keys: readonly string[], keyOf: (row: T) => string): { pinned: T[]; rest: T[] } {
  const byKey = new Map(rows.map((row) => [keyOf(row), row]));
  const pinned = keys.flatMap((key) => {
    const row = byKey.get(key);
    return row === undefined ? [] : [row];
  });
  const pinnedKeys = new Set(pinned.map(keyOf));
  return { pinned, rest: rows.filter((row) => !pinnedKeys.has(keyOf(row))) };
}
