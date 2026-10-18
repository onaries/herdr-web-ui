import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeThemeValue, parseThemeBlocks, parseThemeValue, resolveEntry, ThemeValueError } from "./themeCss.ts";
import { SHADOW_GEOMETRY, SUPPORTED_ENTRIES } from "./themes.ts";
import baseline from "./themes.legacy-baseline.json";

const css = readFileSync(join(import.meta.dir, "..", "styles.css"), "utf8");
const blocks = parseThemeBlocks(css);

it("spells a theme value one way: collapsed spaces, lowercase hex, rgba() with spaced arguments and no trailing zeros", () => {
  expect(normalizeThemeValue("  #DCD4C6 ")).toBe("#dcd4c6");
  expect(normalizeThemeValue("rgba(240,168,48,0.130)")).toBe("rgba(240, 168, 48, 0.13)");
  expect(normalizeThemeValue("0 16px\n    48px RGBA(40, 32, 22, .16),  0 0 0 1px var(--border)")).toBe("0 16px 48px rgba(40, 32, 22, 0.16), 0 0 0 1px var(--border)");
  expect(normalizeThemeValue("var(--Border)")).toBe("var(--Border)");
});

describe("CSS theme table", () => {
  it("enumerates exactly the supported entries, including every frozen legacy row", () => {
    expect(Object.keys(blocks).sort()).toEqual(SUPPORTED_ENTRIES.map(({ id, mode }) => `${id}/${mode}`).sort());
    for (const entry of Object.keys(baseline.combos)) expect(blocks[entry]).toBeDefined();
  });

  it("preserves every frozen declared and resolved value through the shared normalizer", () => {
    for (const [entry, frozen] of Object.entries(baseline.combos)) {
      const block = blocks[entry];
      expect(block).toBeDefined();
      if (!block) throw new Error(`Missing frozen entry ${entry}`);
      const actual = resolveEntry(css, block.id, block.mode);
      for (const kind of ["declared", "resolved"] as const) {
        for (const [role, value] of Object.entries(frozen[kind])) {
          expect({ entry, kind, role, value: actual[kind][role] }).toEqual({ entry, kind, role, value: normalizeThemeValue(value) });
        }
      }
    }
  });

  it("preserves transparent and inherited or aliased bubble borders", () => {
    expect(blocks["amber/dark"]?.declared["--bubble-border"]).toBe("transparent");
    expect(blocks["charcoal/dark"]?.declared["--bubble-border"]).toBeUndefined();
    expect(resolveEntry(css, "charcoal", "dark").resolved["--bubble-border"]).toBe("transparent");
    for (const [id, mode] of [["amber", "light"], ["catppuccin", "dark"]] as const) {
      const { declared, resolved } = resolveEntry(css, id, mode);
      expect(declared["--bubble-border"]).toBe("var(--border)");
      expect(resolved["--bubble-border"]).toBe(resolved["--border"]);
    }
  });

  it("resolves parsed blocks identically to CSS text", () => {
    for (const { id, mode } of Object.values(blocks)) {
      expect(resolveEntry(blocks, id, mode)).toEqual(resolveEntry(css, id, mode));
    }
  });

  it("parses every supported shadow into fixed geometry and colors", () => {
    for (const [entry, block] of Object.entries(blocks)) {
      const { declared } = resolveEntry(css, block.id, block.mode);
      for (const [role, geometry] of Object.entries(SHADOW_GEOMETRY[block.mode])) {
        const value = parseThemeValue(entry, role, declared[`--${role}`] ?? "");
        expect(value.kind).toBe("shadow");
        if (value.kind === "shadow") {
          expect(value.layers.map((layer) => layer.geometry)).toEqual([...geometry]);
          expect(value.layers.every((layer) => layer.color.startsWith("rgba(") || layer.color === "var(--border)")).toBe(true);
        }
      }
    }
  });

  it("gives each selector-list entry the same declarations", () => {
    const parsed = parseThemeBlocks(`${css}\n[data-theme="dark"][data-palette="one"], [data-theme="dark"][data-palette="two"] { --bg: #123456; }`);
    expect(parsed["one/dark"]?.declared).toEqual({ "--bg": "#123456" });
    expect(parsed["two/dark"]?.declared).toEqual(parsed["one/dark"]?.declared);
  });

  it.each(["hsl(1 2 3)", "rgb(1, 2, 3)", "#fff", "rgba(256, 0, 0, 0.5)", "rgba(0, 0, 0, 2)", "rgba(0, 0, 0,)", "rgba(0, 0, 0, 0x1)", "var(--border, red)", "0 0 1px red"])("rejects unknown value %s with entry, role and value", (value) => {
    const malformed = css.replace('[data-theme="dark"][data-palette="charcoal"] {', `[data-theme="dark"][data-palette="charcoal"] { --probe: ${value};`);
    expect(() => parseThemeBlocks(malformed)).toThrow(ThemeValueError);
    expect(() => parseThemeBlocks(malformed)).toThrow(`charcoal/dark probe: unreadable value ${value}`);
  });

  it("rejects a malformed color in a known role", () => {
    expect(() => parseThemeBlocks(css.replace("--bg: #12100e", "--bg: hsl(1 2 3)"))).toThrow("amber/dark bg: unreadable value hsl(1 2 3)");
  });

  it("rejects missing base blocks and duplicate entries", () => {
    expect(() => parseThemeBlocks(css.replace('[data-theme="light"] {', ".not-a-theme {"))).toThrow("amber/light block: missing block");
    expect(() => parseThemeBlocks(`${css}\n:root { --bg: #123456; }`)).toThrow("amber/dark block: duplicate block");
    expect(() => resolveEntry(css, "missing", "dark")).toThrow("missing/dark block: missing block");
  });

  it("rejects unclosed blocks and duplicate declarations", () => {
    expect(() => parseThemeBlocks(":root { --bg: #123456;")).toThrow(ThemeValueError);
    expect(() => parseThemeBlocks(css.replace("--bg: #12100e;", "--bg: #12100e; --bg: #123456;"))).toThrow("amber/dark bg: duplicate declaration");
  });

  it.each(["var(--absent)", "var(--bg)"])("rejects missing and cyclic alias targets %s", (value) => {
    expect(() => resolveEntry(css.replace("--bg: #12100e", `--bg: ${value}`), "amber", "dark")).toThrow(ThemeValueError);
  });

  it("rejects a color alias whose target is not a color", () => {
    expect(() => resolveEntry(css.replace("--bg: #12100e", "--bg: var(--space-1)"), "amber", "dark")).toThrow("amber/dark bg: unreadable value var(--space-1)");
  });

  it("ignores theme-shaped selectors nested in media rules", () => {
    expect(parseThemeBlocks(`${css}\n@media (width < 1px) { :root { --bg: hsl(1 2 3); } }`)).toEqual(blocks);
  });
});
