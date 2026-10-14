import { describe, expect, it } from "bun:test";

import { recordShortcut, shortcutMatchesQuery } from "./shortcutRecorder.ts";
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

  it("refuses anything that is not exactly Mod+Shift", () => {
    expect(recordShortcut(press("g", { shiftKey: false }), false)).toEqual({ kind: "invalid", reason: "chord" });
    expect(recordShortcut(press("g", { ctrlKey: false }), false)).toEqual({ kind: "invalid", reason: "chord" });
    expect(recordShortcut(press("g", { altKey: true }), false)).toEqual({ kind: "invalid", reason: "chord" });
    expect(recordShortcut(press("g"), true)).toEqual({ kind: "invalid", reason: "chord" });
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
