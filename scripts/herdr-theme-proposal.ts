#!/usr/bin/env bun
/** Offline proposals only. Review and author CSS by hand; this tool never writes files. */
import { ROLES, SHADOW_GEOMETRY } from "../src/lib/themes.ts";
import type { Mode } from "../src/lib/themes.ts";
import { isHerdrThemeId, KIND, RAW } from "./herdr-themes.ts";
import type { HerdrThemeId, RawPalette } from "./herdr-themes.ts";

export type Role = keyof typeof ROLES;
export type ThemeRoles = Record<Role, string>;
type Vector = readonly [number, number, number];

function rgb(hex: string): Vector {
  if (!/^#[0-9a-f]{6}$/.test(hex)) throw new Error(`Expected #rrggbb, got ${hex}`);
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

function hex([r, g, b]: Vector): string {
  return `#${[r, g, b].map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, "0")).join("")}`;
}

const linear = (c: number): number => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const gamma = (c: number): number => c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;

/** OKLab a,b preserve OKLCH hue/chroma while L changes; dE is 100 * Euclidean OKLab. */
function lab([red, green, blue]: Vector): Vector {
  const r = linear(red / 255), g = linear(green / 255), b = linear(blue / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

function fromLab([L, a, b]: Vector): Vector {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [gamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s) * 255,
    gamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s) * 255,
    gamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s) * 255];
}

export function deltaE(from: string, to: string): number {
  const a = lab(rgb(from)), b = lab(rgb(to));
  return 100 * Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function mix(from: string, to: string): string {
  const [l, a, b] = lab(rgb(from)), [L, A, B] = lab(rgb(to));
  const c = Math.hypot(a, b), C = Math.hypot(A, B);
  const h = Math.atan2(b, a), H = Math.atan2(B, A);
  const hue = h + 0.1 * (Math.atan2(Math.sin(H - h), Math.cos(H - h)));
  const chroma = c * 0.9 + C * 0.1;
  return hex(fromLab([l * 0.9 + L * 0.1, chroma * Math.cos(hue), chroma * Math.sin(hue)]));
}

const rgba = (value: string, alpha: number): string => `rgba(${rgb(value).join(", ")}, ${alpha})`;
const statusAlpha = (mode: Mode): number => mode === "dark" ? 0.14 : 0.12;

/** One executable policy for every role absent from herdr, applied in insertion order. */
export const ROLE_DEFAULTS = {
  "bg-input": (r: ThemeRoles) => r["bg-elevated"],
  "text-strong": (r: ThemeRoles) => r.text,
  "primary-hover": (r: ThemeRoles) => mix(r.primary, r.text),
  "primary-text": (r: ThemeRoles) => r["bg-panel"],
  "danger-text": (r: ThemeRoles) => r["status-blocked"],
  scrim: (r: ThemeRoles, mode: Mode) => rgba(mode === "dark" ? r.bg : r.text, mode === "dark" ? 0.5 : 0.35),
  "line-number": (r: ThemeRoles) => r["text-dim"],
  "bubble-border": () => "var(--border)",
  "accent-tint": (r: ThemeRoles, mode: Mode) => rgba(r.accent, mode === "dark" ? 0.13 : 0.1),
  "primary-tint": (r: ThemeRoles, mode: Mode) => rgba(r.primary, mode === "dark" ? 0.16 : 0.14),
  "status-working-tint": (r: ThemeRoles, mode: Mode) => rgba(r["status-working"], statusAlpha(mode)),
  "status-blocked-tint": (r: ThemeRoles, mode: Mode) => rgba(r["status-blocked"], statusAlpha(mode)),
  "status-done-tint": (r: ThemeRoles, mode: Mode) => rgba(r["status-done"], statusAlpha(mode)),
  "danger-tint": (r: ThemeRoles, mode: Mode) => rgba(r["status-blocked"], mode === "dark" ? 0.12 : 0.1),
  "shadow-drawer": (r: ThemeRoles, mode: Mode) => `${SHADOW_GEOMETRY[mode]["shadow-drawer"][0]} ${rgba(mode === "dark" ? "#000000" : r.text, mode === "dark" ? 0.6 : 0.22)}`,
  "shadow-pop": (r: ThemeRoles, mode: Mode) => `${SHADOW_GEOMETRY[mode]["shadow-pop"][0]} ${rgba(mode === "dark" ? "#000000" : r.text, mode === "dark" ? 0.55 : 0.16)}, ${SHADOW_GEOMETRY[mode]["shadow-pop"][1]} var(--border)`,
  "shadow-card": (r: ThemeRoles, mode: Mode) => `${SHADOW_GEOMETRY[mode]["shadow-card"][0]} ${rgba(mode === "dark" ? "#000000" : r.text, mode === "dark" ? 0.35 : 0.07)}`,
} satisfies Partial<Record<Role, (roles: ThemeRoles, mode: Mode) => string>>;

/** Pure boundary mapping. No repair here: every later repair is an explicit CSS override. */
export function mapTheme(id: HerdrThemeId, raw: RawPalette = RAW[id]): ThemeRoles {
  const bg = id === "catppuccin" || id === "vesper" ? raw.surface_dim : raw.panel_bg;
  const roles: ThemeRoles = {
    bg, "bg-panel": raw.panel_bg, "bg-elevated": raw.surface0, "bg-hover": raw.active_row_bg,
    border: raw.surface0, "border-strong": raw.surface1, text: raw.text, "text-dim": raw.subtext0,
    accent: raw.accent, primary: raw.accent,
    "status-working": raw.blue, "status-blocked": raw.red, "status-done": raw.green,
    "status-idle": raw.overlay1, notice: raw.yellow,
    "term-bg": bg, "term-fg": raw.text, "term-selection": raw.selection_bg, "term-cursor": raw.text,
    "syntax-keyword": raw.mauve, "syntax-string": raw.green, "syntax-number": raw.peach,
    "syntax-type": raw.yellow, "syntax-variable": raw.text, "syntax-meta": raw.teal, "syntax-function": raw.blue,
    // Filled by ROLE_DEFAULTS below, kept explicit so the role contract is type-checked.
    "bg-input": "", "text-strong": "", "primary-hover": "", "primary-text": "", "danger-text": "",
    scrim: "", "line-number": "", "bubble-border": "", "accent-tint": "", "primary-tint": "",
    "status-working-tint": "", "status-blocked-tint": "", "status-done-tint": "", "danger-tint": "",
    "shadow-drawer": "", "shadow-pop": "", "shadow-card": "",
  };
  for (const [role, derive] of Object.entries(ROLE_DEFAULTS)) roles[role as keyof typeof ROLE_DEFAULTS] = derive(roles, KIND[id]);
  return roles;
}

function luminance([r, g, b]: Vector): number {
  return 0.2126 * linear(r / 255) + 0.7152 * linear(g / 255) + 0.0722 * linear(b / 255);
}

export function contrast(a: string, b: string): number {
  const x = luminance(rgb(a)), y = luminance(rgb(b));
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function over(color: Vector, ground: Vector, alpha: number): Vector {
  return [color[0] * alpha + ground[0] * (1 - alpha), color[1] * alpha + ground[1] * (1 - alpha), color[2] * alpha + ground[2] * (1 - alpha)];
}

export function minimumContrast(roles: ThemeRoles, role: Role, value = roles[role], mode: Mode): number {
  const surfaces = role.startsWith("syntax-") ? ["bg-panel", "bg-elevated"] as const : ["bg", "bg-panel", "bg-elevated", "bg-hover"] as const;
  return Math.min(...surfaces.map((surface) => {
    const ground = rgb(roles[surface]);
    const background = /^status-(working|blocked|done)$/.test(role) ? over(rgb(value), ground, statusAlpha(mode)) : ground;
    const a = luminance(rgb(value)), b = luminance(background);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }));
}

const AA_ROLES: readonly Role[] = ["text", "text-dim", "status-working", "status-blocked", "status-done",
  "syntax-function", "syntax-keyword", "syntax-string", "syntax-number", "syntax-type", "syntax-variable", "syntax-meta"];

/**
 * Search nearest passing quantized L, then bisect its boundary. Only initially AA-failing
 * foregrounds move. Chroma relaxation is bounded at 5%; gamut clipping matches repair.mjs.
 * Failure is explicit: no success-looking partial proposal is printed.
 */
export function proposeTheme(id: HerdrThemeId): { roles: ThemeRoles; moved: { role: Role; value: string; dE: number; reason: string }[] } {
  const mapped = mapTheme(id), roles = { ...mapped }, mode = KIND[id];
  for (const role of AA_ROLES) {
    const original = mapped[role];
    if (minimumContrast(roles, role, original, mode) >= 4.5) continue;
    const [L, a, b] = lab(rgb(original));
    let repaired: string | undefined;
    for (let reduction = 0; reduction <= 50 && repaired === undefined; reduction++) {
      const scale = 1 - reduction / 1000;
      let best: number | undefined;
      const value = (l: number): string => hex(fromLab([l, a * scale, b * scale]));
      for (let step = 0; step <= 10000; step++) {
        const l = step / 10000;
        if (best !== undefined && Math.abs(l - L) >= Math.abs(best - L)) continue;
        if (minimumContrast(roles, role, value(l), mode) >= 4.6) best = l;
      }
      if (best === undefined) continue;
      let passing = best, failing = L;
      for (let step = 0; step < 45; step++) {
        const mid = (passing + failing) / 2;
        if (minimumContrast(roles, role, value(mid), mode) >= 4.6) passing = mid;
        else failing = mid;
      }
      repaired = value(passing);
    }
    if (repaired === undefined) throw new Error(`${id}/${mode} ${role}: cannot reach 4.6 within 5% chroma reduction`);
    roles[role] = repaired;
  }
  // Defaults dependent on repaired foregrounds must travel with those foregrounds.
  for (const [role, derive] of Object.entries(ROLE_DEFAULTS)) roles[role as keyof typeof ROLE_DEFAULTS] = derive(roles, mode);
  const moved = Object.keys(ROLES).flatMap((role) => {
    const key = role as Role, value = roles[key], from = mapped[key];
    if (value === from) return [];
    const colors = (text: string): string[] => [...text.matchAll(/#[0-9a-f]{6}|rgba\((\d+), (\d+), (\d+), [\d.]+\)/g)]
      .map((m) => m[0].startsWith("#") ? m[0] : hex([Number(m[1]), Number(m[2]), Number(m[3])]));
    const before = colors(from), after = colors(value);
    const dE = Math.max(0, ...before.map((color, i) => deltaE(color, after[i] ?? color)));
    return [{ role: key, value, dE, reason: AA_ROLES.includes(key) ? "AA lightness repair on serialized hex (target 4.6; chroma reduction at most 5%)" : "Recomputed default from AA-repaired foreground" }];
  });
  return { roles, moved };
}

if (import.meta.main) {
  const id = process.argv[2] ?? "";
  if (process.argv.length !== 3 || !isHerdrThemeId(id)) {
    console.error(`Usage: bun scripts/herdr-theme-proposal.ts <theme>\nKnown themes: ${Object.keys(RAW).join(", ")}`);
    process.exit(2);
  }
  const { roles, moved } = proposeTheme(id);
  console.log(`/* ${id}/${KIND[id]} - proposal only; dE_OK = 100 * OKLab distance */`);
  console.log(`[data-theme="${KIND[id]}"][data-palette="${id}"] {`);
  for (const role of Object.keys(ROLES)) {
    const key = role as Role;
    console.log(`  --${role}: ${roles[key]}; /* dE ${(moved.find((item) => item.role === key)?.dE ?? 0).toFixed(4)} */`);
  }
  console.log("}");
  console.log(JSON.stringify(moved, null, 2));
}
