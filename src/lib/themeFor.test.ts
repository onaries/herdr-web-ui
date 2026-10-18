import { describe, expect, test } from "bun:test";
import { themeFor } from "./themeFor.ts";
import { DEFAULT_SETTINGS, sanitizeSettings, terminalTheme } from "./settings.ts";
import { rowFor, SUPPORTED_ENTRIES } from "./themes.ts";

describe("themeFor", () => {
  test("System and fixed modes both select the requested side", () => {
    for (const theme of ["system", "dark", "light"] as const) {
      const choices = sanitizeSettings({ theme, darkTheme: "charcoal", lightTheme: "catppuccin" });
      expect(themeFor(choices, "dark")).toBe(rowFor("charcoal", "dark"));
      expect(themeFor(choices, "light")).toBe(rowFor("catppuccin", "light"));
    }
  });

  test("a record without the two palettes starts both from its palette (a)", () => {
    const settings = sanitizeSettings({ theme: "system", palette: "charcoal" });
    expect(settings.lightTheme).toBe("charcoal");
    expect(settings.darkTheme).toBe("charcoal");
    expect(DEFAULT_SETTINGS.lightTheme).toBe("codex");
  });

  test("fixed mode ignores its stale active pair, preserving the other valid entry (c)", () => {
    const settings = sanitizeSettings({ theme: "dark", palette: "amber", paletteDark: "charcoal", paletteLight: "catppuccin" });
    expect(settings.darkTheme).toBe("amber");
    expect(settings.lightTheme).toBe("catppuccin");
    expect(sanitizeSettings({ palette: "charcoal", paletteLight: "pink" }).lightTheme).toBe("charcoal");
  });

  test("a removed palette in the System pair loads as amber (d)", () => {
    const settings = sanitizeSettings({ theme: "system", palette: "report", paletteLight: "lilac", paletteDark: "forest" });
    expect(settings.palette).toBe("amber");
    expect(settings.lightTheme).toBe("amber");
    expect(settings.darkTheme).toBe("amber");
  });

  test("any side keeps a single-kind row's mode and terminal colors (k)", () => {
    for (const entry of SUPPORTED_ENTRIES) {
      for (const side of ["dark", "light"] as const) {
        const settings = sanitizeSettings({ theme: side, darkTheme: entry.id, lightTheme: entry.id });
        expect(themeFor(settings, side)).toBe(rowFor(entry.id, side));
        const drawn = themeFor(settings, side);
        expect(terminalTheme(drawn.mode, drawn.id)).toEqual(drawn.terminal);
      }
    }
    const dracula = themeFor(sanitizeSettings({ theme: "light", lightTheme: "dracula" }), "light");
    expect(dracula).toBe(rowFor("dracula", "dark"));
    expect(terminalTheme(dracula.mode, dracula.id)).toEqual(rowFor("dracula", "dark").terminal);
    expect(themeFor(sanitizeSettings({ theme: "light", lightTheme: "nope" }), "light")).toBe(rowFor("codex", "light"));
  });
});
