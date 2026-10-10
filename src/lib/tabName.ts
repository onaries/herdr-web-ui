import type { HerdrTab } from "../../shared/protocol.ts";

/**
 * The name a tab was given, or null while herdr names it itself: by its place in the row ("2"),
 * which herdr moves up when a tab before it closes while the tab keeps its number.
 */
export function customTabLabel(tab: Pick<HerdrTab, "label" | "number">, place: number = tab.number): string | null {
  const label = tab.label.trim();
  return label === "" || label === String(place) ? null : label;
}

/** herdr names a tab by its place until it is renamed: the strip says so in words. */
export function tabLabel(tab: Pick<HerdrTab, "label" | "number">, t: (key: string, vars?: Record<string, string | number>) => string, place: number = tab.number): string {
  return customTabLabel(tab, place) ?? t("Tab {n}", { n: place });
}
