/**
 * The page's first script: a classic, blocking one in <head> (scripts/theme-bootstrap-build.ts puts
 * it there), so it runs before the stylesheet or the app can paint. It draws the saved theme's row
 * on the document the way the app will (lib/themeBoot.ts), so a cold launch shows that row from its
 * first frame instead of the stylesheet's default until React applies the settings.
 * Same-origin and external, never inline: the app's policy allows `script-src 'self'` only.
 */
// first: this script runs before main.tsx, so it moves the settings saved under the old key itself
import "./lib/legacyStorage.ts";
import { applyThemeEntry, savedThemeEntry } from "./lib/themeBoot.ts";

const root = document.documentElement;
const entry = savedThemeEntry(() => window.localStorage);
applyThemeEntry(root, entry);
// the frames before the stylesheet arrives: the row's own surface, until the app hands it back to
// the theme blocks (applyToDocument in lib/settings.ts), or keeps it on the current row when the
// stylesheet never loaded, so later theme changes are not held by it
root.style.backgroundColor = entry.bg;
