import { beforeEach, describe, expect, it } from "bun:test";

import { translate } from "./i18n.ts";
import { actionAliases, rankByTitle, requestedSettingsPage, requestSettingsPage, settingsPageEntries } from "./paletteSettings.ts";
import type { Translate } from "./i18n.ts";

const identity = (key: string): string => key;
/** The Settings pages as the palette searches them, in the language `t` speaks. */
const pagesIn = (t: Translate) => settingsPageEntries(t).map((entry) => ({ item: entry.id, title: entry.label, aliases: entry.aliases }));

describe("rankByTitle", () => {
  const rows = [
    { item: "toggle-theme", title: "Toggle theme", aliases: "dark light" },
    { item: "settings", title: "Settings", aliases: "preferences theme" },
    { item: "theme", title: "Theme", aliases: "" },
    { item: "refresh", title: "Refresh", aliases: "reload" },
  ];

  it("keeps every row for an empty query", () => {
    expect(rankByTitle("  ", rows)).toEqual(["toggle-theme", "settings", "theme", "refresh"]);
  });

  it("puts the whole title, then its start, then the rest of a title first, and alias-only matches last", () => {
    expect(rankByTitle("theme", rows)).toEqual(["theme", "toggle-theme", "settings"]);
    expect(rankByTitle("the", rows)).toEqual(["theme", "toggle-theme", "settings"]);
  });

  it("finds a row by an alias its title lacks", () => {
    expect(rankByTitle("reload", rows)).toEqual(["refresh"]);
  });

  it("needs every word, across the title and the aliases", () => {
    expect(rankByTitle("settings theme", rows)).toEqual(["settings"]);
    expect(rankByTitle("settings nothing", rows)).toEqual([]);
  });
});

describe("settings entries", () => {
  it("lets a user reach a page by theme, palette or font", () => {
    const pages = pagesIn(identity);
    expect(rankByTitle("theme", pages)).toEqual(["appearance"]);
    expect(rankByTitle("palette", pages)).toEqual(["appearance"]);
    expect(rankByTitle("font", pages)).toEqual(["chat", "terminal"]);
  });

  it("finds Appearance by the literal word palette in every language, and by the language's own word", () => {
    // the translated alias is a bag of search words, so it keeps the English word next to its own, as it keeps openai and ssh
    const words = { en: "palette", ko: "팔레트", ja: "パレット", zh: "调色板" } as const;
    for (const [language, word] of Object.entries(words) as [keyof typeof words, string][]) {
      const pages = pagesIn((key, vars) => translate(language, key, vars));
      expect({ language, literal: rankByTitle("palette", pages), own: rankByTitle(word, pages) }).toEqual({ language, literal: ["appearance"], own: ["appearance"] });
    }
  });

  it("has an alias for every action the palette can offer", () => {
    expect(Object.keys(actionAliases(identity))).toContain("theme");
  });
});

describe("requested page", () => {
  beforeEach(() => requestSettingsPage(null));
  it("is held until cleared", () => {
    requestSettingsPage("terminal");
    expect(requestedSettingsPage()).toBe("terminal");
    requestSettingsPage(null);
    expect(requestedSettingsPage()).toBeNull();
  });
});
