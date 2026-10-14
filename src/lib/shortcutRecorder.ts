import { isReservedShortcutKey } from "./shortcutBindings.ts";
import { shortcutEventKey, type ShortcutEventLike } from "./shortcuts.ts";

/** The keys a Mod+Shift binding may use: what sanitizeShortcutOverrides accepts. */
export const SHORTCUT_KEYS: readonly string[] = [..."abcdefghijklmnopqrstuvwxyz0123456789,", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown"];

export type RecordedShortcut =
  | { kind: "key"; key: string }
  | { kind: "cancel" }
  | { kind: "ignore" }
  | { kind: "invalid"; reason: "chord" | "key" | "reserved" };

const MODIFIER_KEYS: ReadonlySet<string> = new Set(["Shift", "Control", "Meta", "Alt", "AltGraph", "OS"]);

/**
 * Reads one key press made while a row records. Only a Mod+Shift chord on a bindable key is taken;
 * a key the browser or OS commonly keeps for itself is refused, not recorded with a warning. A
 * bare Escape cancels, and a lone modifier press is ignored so the chord can still be completed.
 */
export function recordShortcut(event: ShortcutEventLike, platformIsMac: boolean): RecordedShortcut {
  if (event.isComposing || event.keyCode === 229) return { kind: "ignore" };
  if (MODIFIER_KEYS.has(event.key)) return { kind: "ignore" };
  const anyModifier = event.ctrlKey || event.metaKey || event.shiftKey || event.altKey;
  if (event.key === "Escape" && !anyModifier) return { kind: "cancel" };
  const hasMod = platformIsMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!hasMod || !event.shiftKey || event.altKey) return { kind: "invalid", reason: "chord" };
  const key = shortcutEventKey(event);
  if (!SHORTCUT_KEYS.includes(key)) return { kind: "invalid", reason: "key" };
  if (isReservedShortcutKey(key, platformIsMac)) return { kind: "invalid", reason: "reserved" };
  return { kind: "key", key };
}

/** Every word of the query must appear in the shortcut's name or in its keys as shown. */
export function shortcutMatchesQuery(label: string, keysText: string, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = `${label} ${keysText}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}
