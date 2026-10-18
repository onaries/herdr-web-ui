/**
 * What every browser of this server shares: the settings that do not depend on the device
 * (src/lib/settings.ts SETTING_SCOPE says which) and the pinned agents. GET/PUT
 * /api/preferences; a change reaches the other browsers as a `preferences` event on
 * /api/machines/events. The values are checked where they are used (sanitizeSettings): the
 * server keeps only the names below and the shape. A browser sends only the settings it changed,
 * which the server lays over what it holds, so a setting nobody changed stays each device's own.
 */
export const SHARED_SETTING_KEYS = [
  "theme", "palette", "darkTheme", "lightTheme", "language", "sidebarRows", "agentOrder", "agentMarks", "autoSendQueued",
  "showThinking", "quickReplies", "showQuickReplies", "showUsage", "usageCount",
  "usageGlance", "usageOrder", "usageHidden", "claudeLaunchMode", "codexLaunchMode",
] as const;
export type SharedSettingKey = (typeof SHARED_SETTING_KEYS)[number];

export interface SharedPreferences {
  /** 0 until a browser first writes; each write adds one */
  revision: number;
  /** only the settings some browser has shared: one nobody changed is absent, and stays each device's own */
  settings: Partial<Record<SharedSettingKey, unknown>>;
  /** sidebar pin keys (`machine:pane` for an agent, `machine:workspace:id` for a workspace), in their order; absent until a browser first shares its pins */
  pins?: string[];
}

export const MAX_PINS = 500;
const MAX_PIN_LENGTH = 300;
/** a shared value is a few words or a short list; a change and the whole document it makes stay small */
export const MAX_PREFERENCES_BYTES = 64 * 1024;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** What a browser sends: the settings it changed, and the pins when they changed */
export interface PreferencesChange { settings: SharedPreferences["settings"]; pins?: string[] }

/** System's legacy single palette is the dark side, independent of this browser's OS. */
export function mirrorPalette<T>(theme: unknown, darkTheme: T, lightTheme: T): T {
  return theme === "light" ? lightTheme : darkTheme;
}

/** Only the server writer interprets legacy changes; provenance is the incoming key set. */
export function normalizeThemeChange(stored: SharedPreferences["settings"], change: PreferencesChange): PreferencesChange {
  const settings = { ...change.settings };
  if (!("darkTheme" in settings) && !("lightTheme" in settings) && "palette" in settings) {
    const mode = settings.theme ?? stored.theme;
    if (mode === "dark") settings.darkTheme = settings.palette;
    if (mode === "light") settings.lightTheme = settings.palette;
  }
  // A legacy document has only `palette`. Once this change brings in a side, the stored palette
  // first takes the side it was drawn on (light only in light mode, as mirrorPalette reads it), so
  // the side nobody picked is not filled with amber and the user's synced look is not lost.
  const legacyStored = !("darkTheme" in stored) && !("lightTheme" in stored) && "palette" in stored;
  if (legacyStored && ("darkTheme" in settings || "lightTheme" in settings)) {
    const side = stored.theme === "light" ? "lightTheme" : "darkTheme";
    if (!(side in settings)) settings[side] = stored.palette;
  }
  const merged = { ...stored, ...settings };
  if ("darkTheme" in merged || "lightTheme" in merged) {
    settings.palette = mirrorPalette(merged.theme, merged.darkTheme ?? "amber", merged.lightTheme ?? "amber");
  }
  return { ...change, settings };
}

/** The settings and pins of a body or a stored file, cut to the shared names and the limits; null when the shape is wrong. */
export function sharedPreferencesBody(raw: unknown): PreferencesChange | null {
  if (!isObject(raw) || !isObject(raw["settings"]) || (raw["pins"] !== undefined && !Array.isArray(raw["pins"]))) return null;
  const pins = raw["pins"] as unknown[] | undefined;
  if (pins !== undefined && (pins.length > MAX_PINS || !pins.every((pin) => typeof pin === "string" && pin.length > 0 && pin.length <= MAX_PIN_LENGTH))) return null;
  const given = raw["settings"];
  const settings: SharedPreferences["settings"] = {};
  for (const key of SHARED_SETTING_KEYS) if (key in given) settings[key] = given[key];
  return pins === undefined ? { settings } : { settings, pins: [...new Set(pins as string[])] };
}
