import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import { SYMBOLS_FONT, TERMINAL_FONT_STACK } from "./fontFamily.ts";
import { CODE_FONT_STACK, UI_FONT_MAX, UI_FONT_MIN, UI_FONT_STACK, codeFontStack, fontScale, sanitizeUiFontSize, uiFontStack } from "./typography.ts";
import { DEFAULT_SETTINGS, SETTING_SCOPE, chatFontSize, sanitizeSettings, telemetrySettingsSnapshot, uiFontSize } from "./settings.ts";

const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const token = (name: string): string => new RegExp(`${name}:\\s*([^;]+);`).exec(styles)![1]!.trim();

describe("the built-in stacks", () => {
  it("are the stylesheet's, verbatim, so a chosen font falls back exactly as none would", () => {
    expect(UI_FONT_STACK).toBe(token("--font-ui"));
    expect(CODE_FONT_STACK).toBe(token("--font-mono"));
  });

  it("keep the terminal's stack apart: xterm never takes the bundled code face", () => {
    expect(TERMINAL_FONT_STACK).not.toContain("JetBrains Mono Web");
    expect(CODE_FONT_STACK).toContain('"JetBrains Mono Web"');
  });
});

describe("interface font stack", () => {
  it("keeps the stylesheet's when nothing is typed", () => {
    expect(uiFontStack("")).toBeNull();
    expect(uiFontStack(" , ")).toBeNull();
  });

  it("puts the typed list in front of the built-in stack, never in place of it", () => {
    expect(uiFontStack("Noto Sans, Segoe UI")).toBe(`"Noto Sans", "Segoe UI", ${UI_FONT_STACK}`);
  });

  it("never lets an unsanitized list through", () => {
    expect(uiFontStack("x; } body { color: red")).toBe(`"x body color: red", ${UI_FONT_STACK}`);
  });
});

describe("code font stack", () => {
  it("keeps the stylesheet's when nothing is typed", () => {
    expect(codeFontStack("")).toBeNull();
  });

  it("puts the typed list after the icon font and in front of the code faces", () => {
    const stack = codeFontStack('Fira Code, "Cascadia Mono"')!;
    expect(stack.startsWith(`${SYMBOLS_FONT}, "Fira Code", "Cascadia Mono", "JetBrains Mono Web"`)).toBe(true);
    expect(stack.replace('"Fira Code", "Cascadia Mono", ', "")).toBe(CODE_FONT_STACK);
  });
});

describe("interface font size", () => {
  it("is a whole px within the limits, or follows the density", () => {
    expect(sanitizeUiFontSize(15.6)).toBe(16);
    expect(sanitizeUiFontSize(99)).toBe(UI_FONT_MAX);
    expect(sanitizeUiFontSize(2)).toBe(UI_FONT_MIN);
    expect(sanitizeUiFontSize("18")).toBeNull();
    expect(sanitizeUiFontSize(Number.NaN)).toBeNull();
    expect(sanitizeUiFontSize(undefined)).toBeNull();
  });

  it("scales the type tokens by the chosen size over the density's", () => {
    expect(fontScale(14, 14)).toBe(1);
    expect(fontScale(21, 14)).toBe(1.5);
    expect(fontScale(13, 13)).toBe(1);
    expect(fontScale(0, 14)).toBe(1);
    expect(fontScale(14, Number.NaN)).toBe(1);
  });
});

describe("in Settings", () => {
  it("stays on this device, with nothing chosen by default", () => {
    expect(DEFAULT_SETTINGS.uiFontSize).toBeNull();
    expect(DEFAULT_SETTINGS.uiFontFamily).toBe("");
    expect(DEFAULT_SETTINGS.codeFontFamily).toBe("");
    expect(SETTING_SCOPE.uiFontSize).toBe("device");
    expect(SETTING_SCOPE.uiFontFamily).toBe("device");
    expect(SETTING_SCOPE.codeFontFamily).toBe("device");
  });

  it("keeps only a valid size and sanitized families from a stored record", () => {
    expect(sanitizeSettings({ uiFontSize: 17, uiFontFamily: " Noto Sans ; , x", codeFontFamily: "Fira Code" })).toMatchObject({ uiFontSize: 17, uiFontFamily: '"Noto Sans", x', codeFontFamily: '"Fira Code"' });
    expect(sanitizeSettings({ uiFontSize: "17", uiFontFamily: 3, codeFontFamily: null })).toMatchObject({ uiFontSize: null, uiFontFamily: "", codeFontFamily: "" });
  });

  it("gives the interface the density's body size until one is chosen, and the chat the interface's until it has its own", () => {
    expect(uiFontSize(DEFAULT_SETTINGS)).toBe(14);
    expect(uiFontSize(sanitizeSettings({ density: "compact" }))).toBe(13);
    expect(uiFontSize(sanitizeSettings({ density: "compact", uiFontSize: 16 }))).toBe(16);
    expect(chatFontSize(sanitizeSettings({ uiFontSize: 16 }))).toBe(16);
    expect(chatFontSize(sanitizeSettings({ uiFontSize: 16, chatFontSize: 12 }))).toBe(12);
  });

  it("never puts a typed family in the telemetry snapshot", () => {
    const snapshot = telemetrySettingsSnapshot(sanitizeSettings({ uiFontSize: 16, uiFontFamily: "private-ui-font", codeFontFamily: "private-code-font" }));
    expect(JSON.stringify(snapshot)).not.toContain("private-");
    expect(Object.keys(snapshot)).not.toContain("uiFontFamily");
    expect(Object.keys(snapshot)).not.toContain("codeFontFamily");
  });
});
