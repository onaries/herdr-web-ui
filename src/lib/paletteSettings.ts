import type { Translate } from "./i18n.ts";

export type SettingsPageId = "appearance" | "chat" | "terminal" | "alerts" | "voice" | "usage" | "shortcuts" | "devices" | "remote" | "integrations" | "about";

/** What the palette shows for one Settings page: its name and the words a user may look for it by. */
export interface SettingsPageEntry {
  id: SettingsPageId;
  label: string;
  aliases: string;
}

/**
 * The Settings pages as the palette lists them. The aliases are one translated phrase per page, so
 * a user finds a page by the words of their own language ("theme", "font", "sound"); every phrase is
 * a literal key, which keeps it in the translation files.
 */
export function settingsPageEntries(t: Translate): SettingsPageEntry[] {
  return [
    { id: "appearance", label: t("Appearance"), aliases: t("theme dark light mode colors palette density language sidebar logos") },
    { id: "chat", label: t("Chat"), aliases: t("chat font size message width composer enter send thinking code") },
    { id: "terminal", label: t("Terminal"), aliases: t("terminal font size cursor key bar keyboard clipboard") },
    { id: "alerts", label: t("Alerts"), aliases: t("notifications sound push bell needs input finished") },
    { id: "voice", label: t("Voice input"), aliases: t("dictation microphone speech openai") },
    { id: "usage", label: t("Subscription usage"), aliases: t("plan limits quota meters pace") },
    { id: "shortcuts", label: t("Shortcuts"), aliases: t("keyboard keys bindings hotkeys") },
    { id: "devices", label: t("Phone & devices"), aliases: t("phone install keep screen on app") },
    { id: "remote", label: t("Remote PCs"), aliases: t("machines computers ssh bridge plugins") },
    { id: "integrations", label: t("Agent integrations"), aliases: t("agents hooks claude codex") },
    { id: "about", label: t("About"), aliases: t("version update release herdr") },
  ];
}

/** Other words for the palette's actions, by action id: a name the user may remember instead of the label. */
export function actionAliases(t: Translate): Readonly<Record<string, string>> {
  return {
    new: t("create workspace session start"),
    "new-tab": t("create tab add"),
    "split-right": t("divide pane layout side"),
    "split-down": t("divide pane layout below"),
    "split-right-open": t("divide pane layout side"),
    "split-down-open": t("divide pane layout below"),
    zoom: t("maximize fullscreen full screen focus"),
    view: t("lens chat terminal conversation"),
    sidebar: t("panel drawer hide show"),
    theme: t("dark light mode appearance colors"),
    settings: t("preferences options config"),
    "add-pc": t("remote machine computer connect ssh"),
    notifications: t("alerts push bell"),
    lock: t("logout log out lock"),
    files: t("folder explorer open file"),
    refresh: t("reload update sync"),
  };
}

export interface SearchableRow<T> {
  item: T;
  title: string;
  aliases?: string;
}

function normalize(text: string): string {
  return text.toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Rows a query finds, best first. A title that holds every word of the query is a strong match
 * (the whole title, then its start, then anywhere in it); a row found only through its aliases is a
 * weak match and comes after every strong one, as T3 Code sorts a secondary hit last. Within a rank
 * the rows keep the order they came in. An empty query keeps every row as it is.
 */
export function rankByTitle<T>(query: string, rows: readonly SearchableRow<T>[]): T[] {
  const needle = normalize(query);
  if (needle === "") return rows.map((row) => row.item);
  const words = needle.split(" ");
  const found: { item: T; index: number; rank: number }[] = [];
  rows.forEach((row, index) => {
    const title = normalize(row.title);
    const all = `${title} ${normalize(row.aliases ?? "")}`;
    if (words.every((word) => title.includes(word))) {
      found.push({ item: row.item, index, rank: title === needle ? 3 : title.startsWith(needle) ? 2 : 1 });
    } else if (words.every((word) => all.includes(word))) {
      found.push({ item: row.item, index, rank: 0 });
    }
  });
  return found.sort((a, b) => b.rank - a.rank || a.index - b.index).map((entry) => entry.item);
}

/**
 * The page the palette asked Settings to open. The dialog mounts per opening and reads it when it
 * mounts; it clears it once it has, and the palette clears it on its own opening, so a request the
 * dialog never saw cannot steer a later opening.
 */
let requested: SettingsPageId | null = null;

export function requestSettingsPage(page: SettingsPageId | null): void {
  requested = page;
}

export function requestedSettingsPage(): SettingsPageId | null {
  return requested;
}
