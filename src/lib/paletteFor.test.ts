import { describe, expect, test } from "bun:test";
import { paletteFor } from "./paletteFor.ts";
import { DEFAULT_SETTINGS, sanitizeSettings } from "./settings.ts";

const choices = { theme: "system", palette: "amber", paletteLight: "catppuccin", paletteDark: "forest" } as const;

describe("paletteFor", () => {
  test("system mode picks the palette of the resolved theme", () => {
    expect(paletteFor(choices, "dark")).toBe("forest");
    expect(paletteFor(choices, "light")).toBe("catppuccin");
  });

  test("a fixed theme uses the single palette", () => {
    expect(paletteFor({ ...choices, theme: "dark" }, "dark")).toBe("amber");
    expect(paletteFor({ ...choices, theme: "light" }, "light")).toBe("amber");
  });

  test("a record without the two palettes starts both from its palette", () => {
    const settings = sanitizeSettings({ theme: "system", palette: "lilac" });
    expect(settings.paletteLight).toBe("lilac");
    expect(settings.paletteDark).toBe("lilac");
    expect(DEFAULT_SETTINGS.paletteLight).toBe("amber");
  });

  test("a stored pair survives and an unknown one falls back", () => {
    const settings = sanitizeSettings({ palette: "report", paletteLight: "forest", paletteDark: "pink" });
    expect(settings.paletteLight).toBe("forest");
    expect(settings.paletteDark).toBe("report");
  });
});
