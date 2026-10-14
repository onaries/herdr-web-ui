import { afterEach, describe, expect, it } from "bun:test";

import { advancesAreMonospace, canListInstalledFonts, filterFamilies, queryInstalledFonts, uniqueFamilies } from "./installedFonts.ts";

const win = globalThis as { window?: unknown };

afterEach(() => {
  delete win.window;
});

describe("installed font list", () => {
  it("keeps one sorted, composed name per family", () => {
    const fonts = [{ family: "Menlo " }, { family: "Fira Code" }, { family: "" }, { family: "Menlo" }, { family: "Cafe\u0301" }];
    expect(uniqueFamilies(fonts)).toEqual(["Caf\u00e9", "Fira Code", "Menlo"]);
  });

  it("filters by a case-insensitive substring and keeps all for a blank query", () => {
    const families = ["Fira Code", "JetBrains Mono", "Menlo"];
    expect(filterFamilies(families, " MONO ")).toEqual(["JetBrains Mono"]);
    expect(filterFamilies(families, "  ")).toEqual(families);
    expect(filterFamilies(families, "zzz")).toEqual([]);
  });

  it("refuses a proportional face and accepts a fixed one", () => {
    expect(advancesAreMonospace([10, 10, 10.001, 10])).toBe(true);
    expect(advancesAreMonospace([4, 12, 14, 10])).toBe(false);
    expect(advancesAreMonospace([])).toBe(true);
  });
});

describe("Local Font Access", () => {
  it("is unavailable without the API and never throws", async () => {
    expect(canListInstalledFonts()).toBe(false);
    expect(await queryInstalledFonts()).toEqual({ status: "unavailable" });
  });

  it("answers the families the API lists, and unavailable when it is refused", async () => {
    win.window = { queryLocalFonts: async () => [{ family: "Menlo" }, { family: "Menlo" }, { family: "Fira Code" }] };
    expect(canListInstalledFonts()).toBe(true);
    expect(await queryInstalledFonts()).toEqual({ status: "granted", families: ["Fira Code", "Menlo"] });
    win.window = { queryLocalFonts: async () => { throw new DOMException("denied", "NotAllowedError"); } };
    expect(await queryInstalledFonts()).toEqual({ status: "unavailable" });
  });
});
