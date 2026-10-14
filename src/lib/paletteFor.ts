/**
 * Which palette a resolved theme is drawn in. In System mode the Light and Dark palettes are
 * chosen apart, so the OS switching themes switches palettes; a fixed Light or Dark uses the one
 * `palette` setting, as before.
 */

import type { Palette, ResolvedTheme, ThemeSetting } from "./settings.ts";

export interface PaletteChoices {
  theme: ThemeSetting;
  palette: Palette;
  paletteLight: Palette;
  paletteDark: Palette;
}

export function paletteFor(choices: PaletteChoices, resolved: ResolvedTheme): Palette {
  if (choices.theme !== "system") return choices.palette;
  return resolved === "dark" ? choices.paletteDark : choices.paletteLight;
}
