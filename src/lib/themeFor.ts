import { rowFor, type ThemeId, type Mode, type ThemeEntry } from "./themes.ts";

/** A side selects a row; a single-kind theme keeps its own mode on either side. */
export function themeFor(settings: { darkTheme: ThemeId; lightTheme: ThemeId }, resolved: Mode): ThemeEntry {
  return rowFor(resolved === "dark" ? settings.darkTheme : settings.lightTheme, resolved);
}
