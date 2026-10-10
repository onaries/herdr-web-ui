/** Overrides keep the app's Mod+Shift convention; null returns a key to the terminal. */
export type ShortcutOverrides = Record<string, string | null>;
export const CUSTOM_SHORTCUT_IDS = ["palette", "find", "toggle-view", "toggle-sidebar", "new-session", "previous-pane", "next-pane", "settings"];

/**
 * Narrow warning list for Mod+Shift browser/OS reservations; this is not exhaustive:
 * Mod+Shift+N opens Chromium private browsing, Mod+Shift+T reopens a closed browser tab,
 * Mod+Shift+B opens or toggles browser bookmarks, and Firefox uses Mod+Shift+P for a private
 * window. Mod+Shift+W closes a browser window. On non-Mac platforms Chromium/Firefox also
 * reserve Mod+Shift+C/I/J for DevTools and Chromium reserves Mod+Shift+O for bookmarks.
 * macOS uses Cmd+Shift+3/4/5 for screenshots and Cmd+Shift+Q for logout.
 * This only reports likely conflicts; configured and default bindings remain valid.
 */
export function isReservedShortcutKey(key: string, platformIsMac: boolean): boolean {
  const normalized = /^[a-z]$/i.test(key) ? key.toLowerCase() : key;
  if (normalized === "n" || normalized === "t" || normalized === "b" || normalized === "p" || normalized === "w") return true;
  return platformIsMac
    ? normalized === "3" || normalized === "4" || normalized === "5" || normalized === "q"
    : normalized === "c" || normalized === "i" || normalized === "j" || normalized === "o";
}

export function sanitizeShortcutOverrides(raw: unknown): ShortcutOverrides {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: ShortcutOverrides = {};
  for (const id of CUSTOM_SHORTCUT_IDS) {
    const value = (raw as Record<string, unknown>)[id];
    if (value === null || (typeof value === "string" && /^(?:[a-z0-9,]|ArrowUp|ArrowDown|ArrowLeft|ArrowRight)$/.test(value))) result[id] = value;
  }
  return result;
}
