import { describe, expect, it } from "bun:test";

import { MENU_SHORTCUT_KEYS, SHORTCUT_KEYS, recordShortcut, shortcutMatchesQuery } from "./shortcutRecorder.ts";
import type { ShortcutEventLike } from "./shortcuts.ts";

function press(key: string, patch: Partial<ShortcutEventLike> = {}): ShortcutEventLike {
  return { key, ctrlKey: true, metaKey: false, shiftKey: true, altKey: false, ...patch };
}

describe("recordShortcut", () => {
  it("takes a Mod+Shift chord on a bindable key", () => {
    expect(recordShortcut(press("G"), false)).toEqual({ kind: "key", key: "g" });
    expect(recordShortcut(press("g", { ctrlKey: false, metaKey: true }), true)).toEqual({ kind: "key", key: "g" });
    expect(recordShortcut(press("!", { code: "Digit1" }), false)).toEqual({ kind: "key", key: "1" });
    expect(recordShortcut(press("<", { code: "Comma" }), false)).toEqual({ kind: "key", key: "," });
    expect(recordShortcut(press("ArrowLeft"), false)).toEqual({ kind: "key", key: "ArrowLeft" });
  });

  it("refuses a chord without Ctrl, Alt or ⌘, and a Windows/Super key chord", () => {
    expect(recordShortcut(press("g", { ctrlKey: false }), false)).toEqual({ kind: "invalid", reason: "chord" });
    expect(recordShortcut(press("g", { ctrlKey: false, shiftKey: false }), true)).toEqual({ kind: "invalid", reason: "chord" });
    expect(recordShortcut(press("PageUp", { ctrlKey: false, shiftKey: false, metaKey: true }), false)).toEqual({ kind: "invalid", reason: "chord" });
  });

  it("keeps any other chord exactly, and asks to confirm one the terminal uses", () => {
    expect(recordShortcut(press("PageUp", { ctrlKey: false, shiftKey: false, metaKey: true }), true)).toEqual({ kind: "exact", value: "meta+PageUp", risk: null });
    expect(recordShortcut(press("k", { shiftKey: false }), false)).toEqual({ kind: "exact", value: "ctrl+k", risk: "terminal" });
    expect(recordShortcut(press("g", { altKey: true }), false)).toEqual({ kind: "exact", value: "ctrl+alt+shift+g", risk: "terminal" });
    // on a Mac Ctrl+Shift+G is not Mod+Shift: the pane would get Ctrl+G
    expect(recordShortcut(press("G"), true)).toEqual({ kind: "exact", value: "ctrl+shift+g", risk: "terminal" });
    expect(recordShortcut(press("ArrowLeft", { ctrlKey: false, shiftKey: false, altKey: true }), false)).toEqual({ kind: "exact", value: "alt+ArrowLeft", risk: "terminal" });
  });

  it("takes Home and End, with Mod+Shift or exact modifiers", () => {
    expect(recordShortcut(press("Home", { ctrlKey: false, metaKey: true }), true)).toEqual({ kind: "key", key: "Home" });
    expect(recordShortcut(press("End", { ctrlKey: false, shiftKey: false, metaKey: true }), true)).toEqual({ kind: "exact", value: "meta+End", risk: null });
  });

  it("records an accented letter by its key, and refuses the browser's tab keys", () => {
    expect(recordShortcut(press("É", { ctrlKey: false, metaKey: true, code: "Semicolon" }), true)).toEqual({ kind: "key", key: ";" });
    expect(recordShortcut(press("ő", { ctrlKey: false, shiftKey: false, metaKey: true, code: "BracketLeft" }), true)).toEqual({ kind: "exact", value: "meta+[", risk: "browser" });
    expect(recordShortcut(press("Ő", { ctrlKey: false, metaKey: true, code: "BracketLeft" }), true)).toEqual({ kind: "invalid", reason: "reserved" });
  });

  it("names a macOS Option chord by its key, not the character Option types", () => {
    expect(recordShortcut(press("˚", { ctrlKey: false, shiftKey: false, metaKey: true, altKey: true, code: "KeyK" }), true)).toEqual({ kind: "exact", value: "alt+meta+k", risk: null });
    expect(recordShortcut(press("Dead", { ctrlKey: false, shiftKey: false, altKey: true, code: "KeyE" }), true)).toEqual({ kind: "exact", value: "alt+e", risk: "terminal" });
  });

  it("marks ⌘ chords the browser commonly uses", () => {
    expect(recordShortcut(press("l", { ctrlKey: false, shiftKey: false, metaKey: true }), true)).toEqual({ kind: "exact", value: "meta+l", risk: "browser" });
    expect(recordShortcut(press("1", { ctrlKey: false, shiftKey: false, metaKey: true, code: "Digit1" }), true)).toEqual({ kind: "exact", value: "meta+1", risk: "browser" });
    expect(recordShortcut(press("k", { ctrlKey: false, shiftKey: false, metaKey: true }), true)).toEqual({ kind: "exact", value: "meta+k", risk: null });
    expect(recordShortcut(press("s", { ctrlKey: false, shiftKey: false, metaKey: true }), true)).toEqual({ kind: "exact", value: "meta+s", risk: "browser" });
    // ⌘⌥I/C/U (Option types ˆ ç ¨) open the developer tools and the page source
    for (const [key, code] of [["ˆ", "KeyI"], ["ç", "KeyC"], ["¨", "KeyU"]] as const) {
      expect(recordShortcut(press(key, { ctrlKey: false, shiftKey: false, metaKey: true, altKey: true, code }), true)).toEqual({ kind: "exact", value: `alt+meta+${code.slice(3).toLowerCase()}`, risk: "browser" });
    }
  });

  it("refuses chords the browser, the OS or text editing keep", () => {
    for (const key of ["w", "t", "n", "c", "v", "x", "a", "z"]) {
      expect(recordShortcut(press(key, { shiftKey: false }), false)).toEqual({ kind: "invalid", reason: "reserved" });
      expect(recordShortcut(press(key, { ctrlKey: false, shiftKey: false, metaKey: true }), true)).toEqual({ kind: "invalid", reason: "reserved" });
    }
    for (const key of ["q", "h", "m"]) expect(recordShortcut(press(key, { ctrlKey: false, shiftKey: false, metaKey: true }), true)).toEqual({ kind: "invalid", reason: "reserved" });
    expect(recordShortcut(press("ArrowRight", { shiftKey: false }), true)).toEqual({ kind: "invalid", reason: "reserved" });
    expect(recordShortcut(press("PageDown", { shiftKey: false }), false)).toEqual({ kind: "invalid", reason: "reserved" });
    expect(recordShortcut(press("Enter", { shiftKey: false }), false)).toEqual({ kind: "invalid", reason: "key" });
  });

  it("refuses keys outside the bindable set and reserved ones", () => {
    expect(recordShortcut(press("Enter"), false)).toEqual({ kind: "invalid", reason: "key" });
    expect(recordShortcut(press("F5"), false)).toEqual({ kind: "invalid", reason: "key" });
    expect(recordShortcut(press("t"), false)).toEqual({ kind: "invalid", reason: "reserved" });
    expect(recordShortcut(press("PageUp"), false)).toEqual({ kind: "invalid", reason: "reserved" });
    expect(recordShortcut(press("PageUp", { ctrlKey: false, metaKey: true }), true)).toEqual({ kind: "key", key: "PageUp" });
  });

  it("cancels on a bare Escape and waits through a lone modifier", () => {
    expect(recordShortcut(press("Escape", { ctrlKey: false, shiftKey: false }), false)).toEqual({ kind: "cancel" });
    expect(recordShortcut(press("Shift"), false)).toEqual({ kind: "ignore" });
    expect(recordShortcut(press("Control"), false)).toEqual({ kind: "ignore" });
    expect(recordShortcut(press("g", { isComposing: true }), false)).toEqual({ kind: "ignore" });
  });
});

describe("shortcutMatchesQuery", () => {
  it("needs every word in the name or the keys", () => {
    expect(shortcutMatchesQuery("Toggle sidebar", "Ctrl Shift B", "")).toBe(true);
    expect(shortcutMatchesQuery("Toggle sidebar", "Ctrl Shift B", "side")).toBe(true);
    expect(shortcutMatchesQuery("Toggle sidebar", "Ctrl Shift B", "shift b")).toBe(true);
    expect(shortcutMatchesQuery("Toggle sidebar", "Ctrl Shift B", "palette")).toBe(false);
  });
});

describe("the Settings list", () => {
  it("offers only keys whose label names the same key on every layout; Record takes the rest", () => {
    for (const key of ["Home", "End", ";", "'", "[", "]", "\\", "-", "=", ".", "/", "`", "§"]) {
      expect(MENU_SHORTCUT_KEYS).not.toContain(key);
      expect(SHORTCUT_KEYS).toContain(key);
    }
    for (const key of MENU_SHORTCUT_KEYS) expect(SHORTCUT_KEYS).toContain(key);
  });
});
