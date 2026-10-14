import { beforeEach, describe, expect, it } from "bun:test";

import { actionAliases, rankByTitle, requestedSettingsPage, requestSettingsPage, settingsPageEntries } from "./paletteSettings.ts";

const identity = (key: string): string => key;

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
  it("lets a user reach a page by theme or font", () => {
    const pages = settingsPageEntries(identity).map((entry) => ({ item: entry.id, title: entry.label, aliases: entry.aliases }));
    expect(rankByTitle("theme", pages)).toEqual(["appearance"]);
    expect(rankByTitle("font", pages)).toEqual(["chat", "terminal"]);
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
