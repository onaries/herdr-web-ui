import { describe, expect, it } from "bun:test";

import { resolveComposerMenuActiveItemId } from "./composerMenuHighlight.ts";

describe("resolveComposerMenuActiveItemId", () => {
  it("keeps a highlighted result on refresh for the same search", () => {
    expect(resolveComposerMenuActiveItemId({
      items: [{ id: "first" }, { id: "picked" }],
      highlightedItemId: "picked",
      currentSearchKey: "@src",
      highlightedSearchKey: "@src",
    })).toBe("picked");
  });

  it("starts at the first result for a new search", () => {
    expect(resolveComposerMenuActiveItemId({
      items: [{ id: "first" }, { id: "picked" }],
      highlightedItemId: "picked",
      currentSearchKey: "@src/a",
      highlightedSearchKey: "@src",
    })).toBe("first");
  });

  it("falls back when the picked result disappears and clears empty results", () => {
    const search = { currentSearchKey: "/git", highlightedSearchKey: "/git", highlightedItemId: "missing" };
    expect(resolveComposerMenuActiveItemId({ ...search, items: [{ id: "first" }] })).toBe("first");
    expect(resolveComposerMenuActiveItemId({ ...search, items: [] })).toBeNull();
  });
});
