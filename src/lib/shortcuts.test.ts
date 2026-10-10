import { describe, expect, it } from "bun:test";

import { isAppShortcut, isMacPlatform, matchShortcut, type ShortcutEventLike, keepsArrowsForText, shortcutConflict, shortcutDisplayKeys, shortcutKeys } from "./shortcuts.ts";
import { isReservedShortcutKey, sanitizeShortcutOverrides } from "./shortcutBindings.ts";

function keyEvent(key: string, patch: Partial<ShortcutEventLike> = {}): ShortcutEventLike {
  return { key, ctrlKey: false, metaKey: false, shiftKey: true, altKey: false, ...patch };
}

describe("matchShortcut", () => {
  it("uses Command on Apple platforms and Control elsewhere", () => {
    expect(matchShortcut(keyEvent("K", { metaKey: true }), true)).toBe("palette");
    expect(matchShortcut(keyEvent("k", { ctrlKey: true }), false)).toBe("palette");
    expect(matchShortcut(keyEvent("k", { ctrlKey: true }), true)).toBeNull();
    expect(matchShortcut(keyEvent("k", { metaKey: true }), false)).toBeNull();
  });

  it("matches every terminal-safe key", () => {
    expect(matchShortcut(keyEvent("j", { ctrlKey: true }), false)).toBe("toggle-view");
    expect(matchShortcut(keyEvent("F", { ctrlKey: true }), false)).toBe("find");
    expect(matchShortcut(keyEvent("F", { metaKey: true }), true)).toBe("find");
    expect(matchShortcut(keyEvent("f", { ctrlKey: true, shiftKey: false }), false)).toBeNull();
    expect(matchShortcut(keyEvent("f", { ctrlKey: true }), false, { find: null })).toBeNull();
    expect(matchShortcut(keyEvent("g", { ctrlKey: true }), false, sanitizeShortcutOverrides({ find: "g" }))).toBe("find");
    expect(matchShortcut(keyEvent("B", { ctrlKey: true }), false)).toBe("toggle-sidebar");
    expect(matchShortcut(keyEvent("n", { ctrlKey: true }), false)).toBe("new-session");
    expect(matchShortcut(keyEvent("ArrowUp", { ctrlKey: true }), false)).toBe("previous-pane");
    expect(matchShortcut(keyEvent("ArrowDown", { ctrlKey: true }), false)).toBe("next-pane");
    expect(matchShortcut(keyEvent(",", { ctrlKey: true }), false)).toBe("settings");
    expect(matchShortcut(keyEvent("<", { ctrlKey: true, code: "Comma" }), false)).toBe("settings");
  });

  it("requires Shift and rejects extra or competing modifiers", () => {
    expect(matchShortcut(keyEvent("k", { ctrlKey: true, shiftKey: false }), false)).toBeNull();
    expect(matchShortcut(keyEvent("k", { ctrlKey: true, altKey: true }), false)).toBeNull();
    expect(matchShortcut(keyEvent("k", { ctrlKey: true, metaKey: true }), false)).toBeNull();
    expect(matchShortcut(keyEvent("x", { ctrlKey: true }), false)).toBeNull();
  });
});

describe("keepsArrowsForText", () => {
  const classes = (...names: string[]) => ({ contains: (name: string) => names.includes(name) });
  it("leaves Mod+Shift+arrows to the message box and other text fields, where they select text", () => {
    expect(keepsArrowsForText({ tagName: "TEXTAREA", classList: classes("composer-text") })).toBe(true);
    expect(keepsArrowsForText({ tagName: "INPUT", type: "text", classList: classes() })).toBe(true);
    expect(keepsArrowsForText({ tagName: "INPUT", type: "search", classList: classes() })).toBe(true);
    expect(keepsArrowsForText({ tagName: "DIV", isContentEditable: true, classList: classes() })).toBe(true);
  });

  it("switches panes from the terminal and anywhere that is no text field", () => {
    expect(keepsArrowsForText({ tagName: "TEXTAREA", classList: classes("xterm-helper-textarea") })).toBe(false);
    expect(keepsArrowsForText({ tagName: "INPUT", type: "checkbox", classList: classes() })).toBe(false);
    expect(keepsArrowsForText({ tagName: "BUTTON", classList: classes() })).toBe(false);
    expect(keepsArrowsForText(null)).toBe(false);
  });
});

describe("new workspace", () => {
  it("opens with Mod+Shift+O, which a browser tab lets through, and still with Mod+Shift+N", () => {
    const press = (key: string) => matchShortcut({ key, ctrlKey: true, metaKey: false, shiftKey: true, altKey: false }, false);
    expect(press("O")).toBe("new-session");
    expect(press("N")).toBe("new-session");
  });
});

it("overrides remove default bindings, unbinding gives keys back, and IME events never switch panes", () => {
  const key = (value: string): ShortcutEventLike => ({ key: value, ctrlKey: true, metaKey: false, shiftKey: true, altKey: false });
  expect(matchShortcut(key("k"), false, { palette: "p" })).toBeNull();
  expect(matchShortcut(key("p"), false, { palette: "p" })).toBe("palette");
  expect(matchShortcut(key("n"), false, { "new-session": null })).toBeNull();
  expect(matchShortcut({ ...key("k"), isComposing: true }, false)).toBeNull();
  expect(matchShortcut({ ...key("k"), keyCode: 229 }, false)).toBeNull();
});

it("matches shifted digits and detects alias and default-restoration conflicts", () => {
  expect(matchShortcut({ key: "!", code: "Digit1", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false }, false, { palette: "1" })).toBe("palette");
  expect(shortcutConflict("palette", ["n"], {})).toBe(true);
  expect(shortcutConflict("palette", shortcutKeys("palette", {}), { palette: "p", settings: "k" })).toBe(true);
});

describe("shortcutDisplayKeys", () => {
  it("shows the default chord, custom chord, disabled state, and uncustomizable voice chord", () => {
    expect(shortcutDisplayKeys("palette", {})).toEqual(["Mod", "Shift", "K"]);
    expect(shortcutDisplayKeys("toggle-view", { "toggle-view": "p" })).toEqual(["Mod", "Shift", "P"]);
    expect(shortcutDisplayKeys("settings", { settings: null })).toEqual([]);
    expect(shortcutDisplayKeys("voice", { voice: "p" })).toEqual(["Mod", "Shift", "Space"]);
  });
});

describe("non-Latin keyboard layouts", () => {
  it("uses KeyA-Z for a non-ASCII single character but preserves an ASCII event.key layout", () => {
    expect(matchShortcut(keyEvent("한", { ctrlKey: true, code: "KeyK" }), false, { palette: "k" })).toBe("palette");
    expect(matchShortcut(keyEvent("ㅏ", { ctrlKey: true, code: "KeyK" }), false)).toBe("palette");
    expect(matchShortcut(keyEvent("л", { metaKey: true, code: "KeyK" }), true)).toBe("palette");
    expect(matchShortcut(keyEvent("ㅏ", { ctrlKey: true, code: "KeyK" }), false, { palette: null })).toBeNull();
    expect(matchShortcut(keyEvent("q", { ctrlKey: true, code: "KeyK" }), false, { palette: "q" })).toBe("palette");
    expect(matchShortcut(keyEvent("q", { ctrlKey: true, code: "KeyK" }), false)).toBeNull();
    expect(matchShortcut(keyEvent("🙂", { ctrlKey: true, code: "KeyK" }), false, { palette: "k" })).toBeNull();
  });

  it("leaves an accented Latin letter to the terminal, whatever key position it sits on", () => {
    // BÉPO: É is on KeyW; Turkish F: Ç is on KeyB, the default sidebar key's position
    expect(matchShortcut(keyEvent("É", { ctrlKey: true, code: "KeyW" }), false, { "toggle-sidebar": "w" })).toBeNull();
    expect(matchShortcut(keyEvent("Ç", { ctrlKey: true, code: "KeyB" }), false)).toBeNull();
    expect(matchShortcut(keyEvent("ı", { ctrlKey: true, code: "KeyI" }), false, { palette: "i" })).toBeNull();
  });

  it("keeps IME guards and Comma/Digit code normalization ahead of layout fallback", () => {
    expect(matchShortcut(keyEvent("한", { ctrlKey: true, code: "KeyK", isComposing: true }), false, { palette: "k" })).toBeNull();
    expect(matchShortcut(keyEvent("한", { ctrlKey: true, code: "KeyK", keyCode: 229 }), false, { palette: "k" })).toBeNull();
    expect(matchShortcut(keyEvent("한", { ctrlKey: true, code: "Comma" }), false, { settings: "," })).toBe("settings");
    expect(matchShortcut(keyEvent("한", { ctrlKey: true, code: "Digit1" }), false, { palette: "1" })).toBe("palette");
  });

  it("keeps app-level and terminal shortcut detection on the same matcher", () => {
    const overrides = { palette: "k", "toggle-sidebar": "x" };
    const events = [
      keyEvent("한", { ctrlKey: true, code: "KeyK" }),
      keyEvent("x", { ctrlKey: true }),
      keyEvent("k", { ctrlKey: true, isComposing: true }),
      keyEvent("z", { ctrlKey: true }),
    ];
    for (const event of events) {
      expect(isAppShortcut(event, overrides)).toBe(matchShortcut(event, isMacPlatform(), overrides) !== null);
    }
  });
});

describe("isReservedShortcutKey", () => {
  it("reports documented browser reservations and macOS screenshot chords", () => {
    expect(isReservedShortcutKey("n", false)).toBe(true);
    expect(isReservedShortcutKey("T", false)).toBe(true);
    expect(isReservedShortcutKey("p", true)).toBe(true);
    expect(isReservedShortcutKey("b", true)).toBe(true);
    expect(isReservedShortcutKey("w", false)).toBe(true);
    expect(isReservedShortcutKey("w", true)).toBe(true);
    expect(isReservedShortcutKey("q", true)).toBe(true);
    expect(isReservedShortcutKey("j", false)).toBe(true);
    expect(isReservedShortcutKey("o", false)).toBe(true);
    expect(isReservedShortcutKey("3", true)).toBe(true);
    expect(isReservedShortcutKey("4", true)).toBe(true);
    expect(isReservedShortcutKey("5", true)).toBe(true);
  });

  it("does not classify unrelated or platform-inapplicable keys as reserved", () => {
    expect(isReservedShortcutKey("k", false)).toBe(false);
    expect(isReservedShortcutKey("ArrowUp", true)).toBe(false);
    expect(isReservedShortcutKey("j", true)).toBe(false);
    expect(isReservedShortcutKey("3", false)).toBe(false);
  });

  it("warns without rejecting a configured key or changing an existing default", () => {
    const overrides = sanitizeShortcutOverrides({ "new-session": "t" });
    expect(overrides).toEqual({ "new-session": "t" });
    expect(matchShortcut(keyEvent("t", { ctrlKey: true }), false, overrides)).toBe("new-session");
    expect(matchShortcut(keyEvent("n", { ctrlKey: true }), false)).toBe("new-session");
  });
});
