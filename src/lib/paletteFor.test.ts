import { describe, expect, test } from "bun:test";
import { paletteFor } from "./paletteFor.ts";
import { DEFAULT_SETTINGS, sanitizeSettings } from "./settings.ts";

const choices = { theme: "system", palette: "amber", paletteLight: "catppuccin", paletteDark: "charcoal" } as const;

describe("paletteFor", () => {
  test("system mode picks the palette of the resolved theme", () => {
    expect(paletteFor(choices, "dark")).toBe("charcoal");
    expect(paletteFor(choices, "light")).toBe("catppuccin");
  });

  test("a fixed theme uses the single palette", () => {
    expect(paletteFor({ ...choices, theme: "dark" }, "dark")).toBe("amber");
    expect(paletteFor({ ...choices, theme: "light" }, "light")).toBe("amber");
  });

  test("a record without the two palettes starts both from its palette", () => {
    const settings = sanitizeSettings({ theme: "system", palette: "charcoal" });
    expect(settings.paletteLight).toBe("charcoal");
    expect(settings.paletteDark).toBe("charcoal");
    expect(DEFAULT_SETTINGS.paletteLight).toBe("amber");
  });

  test("a stored pair survives and an unknown one falls back", () => {
    const settings = sanitizeSettings({ palette: "charcoal", paletteLight: "catppuccin", paletteDark: "pink" });
    expect(settings.paletteLight).toBe("catppuccin");
    expect(settings.paletteDark).toBe("charcoal");
  });

  test("a removed palette in the pair loads as amber", () => {
    const settings = sanitizeSettings({ theme: "system", palette: "report", paletteLight: "lilac", paletteDark: "forest" });
    expect(settings.palette).toBe("amber");
    expect(settings.paletteLight).toBe("amber");
    expect(settings.paletteDark).toBe("amber");
  });
});
