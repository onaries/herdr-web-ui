import { exactChordRefusal, exactChordRisk, formatExactChord, isReservedShortcutKey } from "./shortcutBindings.ts";
import { exactChordFromEvent, shortcutEventKey, type ShortcutEventLike } from "./shortcuts.ts";

/** The keys a recorded binding may use, with Mod+Shift or exact modifiers: what sanitizeShortcutOverrides accepts. */
export const SHORTCUT_KEYS: readonly string[] = [..."abcdefghijklmnopqrstuvwxyz0123456789,-=[];'\\./`§", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"];

/**
 * The Mod+Shift keys the Settings list offers. Home, End and the punctuation keys are left to Record:
 * punctuation is bound by position, so a US character in a list would name another key on most layouts.
 */
export const MENU_SHORTCUT_KEYS: readonly string[] = [..."abcdefghijklmnopqrstuvwxyz0123456789,", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown"];

export type RecordedShortcut =
  | { kind: "key"; key: string }
  // an exact chord as stored; a risk asks the user to confirm before it is saved
  | { kind: "exact"; value: string; risk: "terminal" | "browser" | null }
  | { kind: "cancel" }
  | { kind: "ignore" }
  | { kind: "invalid"; reason: "chord" | "key" | "reserved" };

const MODIFIER_KEYS: ReadonlySet<string> = new Set(["Shift", "Control", "Meta", "Alt", "AltGraph", "OS"]);

/**
 * Reads one key press made while a row records. A Mod+Shift chord on a bindable key is stored as
 * that key, and a Mod+Shift key the browser or OS commonly keeps for itself is refused. Any other
 * chord keeps its exact modifiers: it needs Ctrl, Alt or ⌘, is refused where the browser, OS or
 * text editing keeps it, and carries a risk where the terminal or the browser also uses it. A bare
 * Escape cancels, and a lone modifier press is ignored so the chord can still be completed.
 */
export function recordShortcut(event: ShortcutEventLike, platformIsMac: boolean): RecordedShortcut {
  if (event.isComposing || event.keyCode === 229) return { kind: "ignore" };
  if (MODIFIER_KEYS.has(event.key)) return { kind: "ignore" };
  const anyModifier = event.ctrlKey || event.metaKey || event.shiftKey || event.altKey;
  if (event.key === "Escape" && !anyModifier) return { kind: "cancel" };
  const hasMod = platformIsMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (hasMod && event.shiftKey && !event.altKey) {
    const key = shortcutEventKey(event);
    if (!SHORTCUT_KEYS.includes(key)) return { kind: "invalid", reason: "key" };
    if (isReservedShortcutKey(key, platformIsMac)) return { kind: "invalid", reason: "reserved" };
    return { kind: "key", key };
  }
  const chord = exactChordFromEvent(event);
  if (!event.ctrlKey && !event.altKey && !event.metaKey) return { kind: "invalid", reason: "chord" };
  if (!SHORTCUT_KEYS.includes(chord.key)) return { kind: "invalid", reason: "key" };
  const refusal = exactChordRefusal(chord, platformIsMac);
  if (refusal !== null) return { kind: "invalid", reason: refusal };
  return { kind: "exact", value: formatExactChord(chord), risk: exactChordRisk(chord, platformIsMac) };
}

/** Every word of the query must appear in the shortcut's name or in its keys as shown. */
export function shortcutMatchesQuery(label: string, keysText: string, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = `${label} ${keysText}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}
