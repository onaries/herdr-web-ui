import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import { TERMINAL_FONT_STACK } from "./fontFamily.ts";
import { UI_FONT_MAX, UI_FONT_MIN, fontScale, sanitizeUiFontSize } from "./typography.ts";
import { DEFAULT_SETTINGS, SETTING_SCOPE, chatFontSize, sanitizeSettings, uiFontSize } from "./settings.ts";

const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const token = (name: string): string => new RegExp(`${name}:\\s*([^;]+);`).exec(styles)![1]!.trim();

describe("the built-in stacks", () => {
  it("keep the terminal's stack apart: xterm never takes the bundled code face", () => {
    expect(TERMINAL_FONT_STACK).not.toContain("JetBrains Mono Web");
    expect(token("--font-mono")).toContain('"JetBrains Mono Web"');
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
    expect(SETTING_SCOPE.uiFontSize).toBe("device");
  });

  it("keeps only a valid size from a stored record", () => {
    expect(sanitizeSettings({ uiFontSize: 17 }).uiFontSize).toBe(17);
    expect(sanitizeSettings({ uiFontSize: "17" }).uiFontSize).toBeNull();
  });

  it("gives the interface the density's body size until one is chosen, and the chat the interface's until it has its own", () => {
    expect(uiFontSize(DEFAULT_SETTINGS)).toBe(14);
    expect(uiFontSize(sanitizeSettings({ density: "compact" }))).toBe(13);
    expect(uiFontSize(sanitizeSettings({ density: "compact", uiFontSize: 16 }))).toBe(16);
    expect(chatFontSize(sanitizeSettings({ uiFontSize: 16 }))).toBe(16);
    expect(chatFontSize(sanitizeSettings({ uiFontSize: 16, chatFontSize: 12 }))).toBe(12);
  });
});
