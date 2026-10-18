import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeThemeValue, parseThemeBlocks, parseThemeValue } from "../src/lib/themeCss.ts";
import { ROLES, SHADOW_GEOMETRY, siblingFor, SUPPORTED_ENTRIES } from "../src/lib/themes.ts";
import { HERDR_SOURCE, KIND, mapTerminalAnsi, RAW, SOURCE, TOKENS } from "./herdr-themes.ts";
import { deltaE, mapTheme, minimumContrast, proposeTheme, ROLE_DEFAULTS } from "./herdr-theme-proposal.ts";
import { OVERRIDES, provenanceFailures } from "./herdr-theme-overrides.ts";
import type { ThemeOverride } from "./herdr-theme-overrides.ts";

const css = readFileSync(join(import.meta.dir, "../src/styles.css"), "utf8");
const fixture = `:root {}\n[data-theme="light"] {}\n[data-theme="dark"][data-palette="tokyo-night"] {\n${Object.entries(mapTheme("tokyo-night")).map(([role, value]) => `--${role}: ${value};`).join("\n")}\n}`;
const entry = [{ id: "tokyo-night", mode: "dark" }] as const;

describe("pinned herdr palettes", () => {
  it("records the pinned source and all 17 RGB palettes with 19 named tokens", () => {
    expect(HERDR_SOURCE).toEqual({ repo: "herdrdev/herdr", sha: "143bf5fd4781d164260c63fe28e7dc08054ad32f" });
    expect(Object.keys(RAW)).toHaveLength(17);
    expect(TOKENS).toHaveLength(19);
    expect(Object.keys(KIND)).toEqual(Object.keys(RAW));
    expect(Object.values(KIND).filter((mode) => mode === "dark")).toHaveLength(10);
    expect(Object.values(KIND).filter((mode) => mode === "light")).toHaveLength(7);
    for (const [id, raw] of Object.entries(RAW)) {
      expect({ id, tokens: Object.keys(raw).sort() }).toEqual({ id, tokens: [...TOKENS].sort() });
      for (const [token, value] of Object.entries(raw)) {
        if (token === "sidebar_bg") expect(value).toBeNull();
        else expect(value).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
    expect(RAW.nord.teal).toBe("#8fbcbb");
    expect(RAW.catppuccin.surface_dim).toBe("#1e1e2e");
    expect(Object.keys(SOURCE)).toEqual(Object.keys(RAW));
    for (const source of Object.values(SOURCE)) {
      expect(source.url).toMatch(/^https:\/\/github.com\//);
      expect(["MIT", "Apache-2.0"]).toContain(source.license);
    }
    expect(SOURCE["tokyo-night-day"].license).toBe("Apache-2.0");
  });

  it("maps every palette to every role with parseable values and fixed shadow geometry", () => {
    for (const id of Object.keys(RAW) as (keyof typeof RAW)[]) {
      const roles = mapTheme(id);
      expect(Object.keys(roles).sort()).toEqual(Object.keys(ROLES).sort());
      for (const [role, value] of Object.entries(roles)) {
        const parsed = parseThemeValue(`${id}/${KIND[id]}`, role, value);
        if (parsed.kind === "shadow") {
          expect(parsed.layers.map((layer) => layer.geometry)).toEqual([...SHADOW_GEOMETRY[KIND[id]][role as keyof typeof SHADOW_GEOMETRY.dark]]);
        }
      }
      expect(roles.bg).toBe(id === "catppuccin" || id === "vesper" ? RAW[id].surface_dim : RAW[id].panel_bg);
      expect(roles["bg-elevated"]).toBe(RAW[id].surface0);
      expect(roles["syntax-meta"]).toBe(RAW[id].teal);
      expect(roles["bg-input"]).toBe(roles["bg-elevated"]);
      expect(roles["bubble-border"]).toBe("var(--border)");
      expect(roles["danger-text"]).toBe(roles["status-blocked"]);
    }
    expect(Object.keys(ROLE_DEFAULTS)).toHaveLength(17);
    expect(mapTheme("tokyo-night")["accent-tint"]).toBe("rgba(122, 162, 247, 0.13)");
    expect(mapTheme("gruvbox-light")["status-done-tint"]).toBe("rgba(121, 116, 14, 0.12)");
  });

  it("changes the mapped consequence when a raw token changes, without mutating vendored input", () => {
    const before = mapTheme("tokyo-night");
    const after = mapTheme("tokyo-night", { ...RAW["tokyo-night"], blue: "#123456" });
    expect(after["status-working"]).toBe("#123456");
    expect(after["syntax-function"]).toBe("#123456");
    expect(after["status-working-tint"]).toBe("rgba(18, 52, 86, 0.14)");
    expect(mapTheme("tokyo-night")).toEqual(before);
  });

  it("finds only the opposite side of the seven known pairs, including legacy Catppuccin", () => {
    const pairs = [
      ["catppuccin", "catppuccin-latte"], ["tokyo-night", "tokyo-night-day"],
      ["gruvbox", "gruvbox-light"], ["one-dark", "one-light"],
      ["solarized", "solarized-light"], ["kanagawa", "kanagawa-lotus"], ["rose-pine", "rose-pine-dawn"],
    ] as const;
    for (const [dark, light] of pairs) {
      expect(siblingFor(dark, "light")).toBe(light);
      expect(siblingFor(light, "dark")).toBe(dark);
      expect(siblingFor(dark, "dark")).toBeUndefined();
      expect(siblingFor(light, "light")).toBeUndefined();
    }
    for (const id of ["amber", "charcoal", "dracula", "nord", "vesper", "unknown", "__proto__"]) {
      expect(siblingFor(id, "dark")).toBeUndefined();
      expect(siblingFor(id, "light")).toBeUndefined();
    }
  });
});

describe("executable provenance policy", () => {
  it("maps light ANSI hues from herdr and checks every recorded ANSI repair distance", () => {
    const raw = RAW["one-light"];
    expect(mapTerminalAnsi("one-light")["term-red"]).toBe(raw.red);
    expect(mapTerminalAnsi("one-light", { ...raw, red: "#123456" })["term-bright-red"]).toBe("#123456");
    for (const item of OVERRIDES) {
      const mapped = mapTerminalAnsi(item.theme);
      if (!(item.role in mapped)) continue;
      expect(item.dE).toBeCloseTo(deltaE(Reflect.get(mapped, item.role), item.value), 10);
    }
  });

  it("rejects an undocumented ANSI change, including canonical legacy Latte", () => {
    for (const id of ["one-light", "catppuccin-latte"] as const) {
      const own = parseThemeBlocks(css)[`${id}/light`]?.declared;
      const value = own?.["--term-black"];
      expect(value).toBeDefined();
      const changed = css.replace(`--term-black: ${value};`, "--term-black: #123456;");
      expect(provenanceFailures(changed).join("\n")).toContain(`${id}/light term-black`);
    }
  });

  it("checks every new supported entry's own CSS declarations against mapping or explicit overrides", () => {
    expect(provenanceFailures(css, SUPPORTED_ENTRIES, OVERRIDES)).toEqual([]);
  });

  it("rejects a changed role in a temporary CSS row rather than reporting a vacuous pass", () => {
    const changed = fixture.replace("--bg: #1a1b26;", "--bg: #123456;");
    expect(provenanceFailures(fixture, entry, [])).toEqual([]);
    expect(provenanceFailures(changed, entry, [])).toEqual([
      "tokyo-night/dark bg: #123456 differs from mapped #1a1b26 without override",
    ]);
  });

  it("accepts a matching explicit deviation with numeric distance and reason", () => {
    const changed = fixture.replace("--bg: #1a1b26;", "--bg: #123456;");
    const override: ThemeOverride = { theme: "tokyo-night", mode: "dark", role: "bg", value: "#123456", dE: 12, reason: "Reviewed surface change" };
    expect(provenanceFailures(changed, entry, [override])).toEqual([]);
  });

  it("rejects missing own declarations, malformed CSS and wrong-kind entries", () => {
    expect(provenanceFailures(fixture.replace("--bg: #1a1b26;", ""), entry, []).join("\n")).toContain("tokyo-night/dark bg: (missing)");
    expect(() => provenanceFailures(fixture.replace("--bg: #1a1b26;", "--bg: hsl(0 0% 0%);"), entry, [])).toThrow("tokyo-night/dark bg");
    expect(provenanceFailures(fixture, [{ id: "tokyo-night", mode: "light" }], [])).toEqual(["tokyo-night/light: no pinned herdr palette of this kind"]);
  });

  it("rejects stale, duplicate, redundant and undocumented override records by entry and role", () => {
    const override: ThemeOverride = { theme: "tokyo-night", mode: "dark", role: "bg", value: "#123456", dE: 1, reason: "Reviewed" };
    expect(provenanceFailures(css, SUPPORTED_ENTRIES, [override])).toContain("tokyo-night/dark bg: stale override");
    expect(provenanceFailures(fixture, entry, [override, override])).toContain("tokyo-night/dark bg: duplicate override");
    expect(provenanceFailures(fixture, entry, [{ ...override, value: "#1a1b26" }])).toContain("tokyo-night/dark bg: redundant override");
    for (const bad of [{ dE: NaN }, { dE: Infinity }, { dE: -1 }, { reason: " " }]) {
      expect(provenanceFailures(fixture, entry, [{ ...override, ...bad }])).toContain("tokyo-night/dark bg: override needs finite dE and reason");
    }
  });
});

describe("offline AA repair", () => {
  it("repairs only failing foregrounds, rechecks serialized hex and recomputes dependent defaults", () => {
    for (const id of Object.keys(RAW) as (keyof typeof RAW)[]) {
      if (id === "dracula") continue; // Its bounded failure is exercised separately below.
      const mapped = mapTheme(id), proposal = proposeTheme(id);
      for (const role of ["text", "text-dim", "status-working", "status-blocked", "status-done",
        "syntax-function", "syntax-keyword", "syntax-string", "syntax-number", "syntax-type", "syntax-variable", "syntax-meta"] as const) {
        const before = minimumContrast(mapped, role, mapped[role], KIND[id]);
        if (before >= 4.5) expect(proposal.roles[role]).toBe(mapped[role]);
        else expect(minimumContrast(proposal.roles, role, proposal.roles[role], KIND[id])).toBeGreaterThanOrEqual(4.6);
      }
      expect(proposal.roles.bg).toBe(mapped.bg);
      for (const item of proposal.moved) {
        expect(Number.isFinite(item.dE)).toBe(true);
        expect(item.dE).toBeGreaterThan(0);
        expect(item.value).toBe(proposal.roles[item.role]);
      }
      for (const [role, value] of Object.entries(proposal.roles)) {
        expect(normalizeThemeValue(value)).toBe(value);
        parseThemeValue(id, role, value);
      }
      expect(Object.keys(parseThemeBlocks(`${css}\n[data-theme="${KIND[id]}"][data-palette="proposal"] {${Object.entries(proposal.roles).map(([role, value]) => `--${role}: ${value};`).join("")}}`))).toContain(`proposal/${KIND[id]}`);
    }
  }, 30000);

  it("fails closed when Dracula cannot reach the target within the bounded chroma policy", () => {
    expect(() => proposeTheme("dracula")).toThrow("dracula/dark status-blocked: cannot reach 4.6 within 5% chroma reduction");
  }, 30000);
});
