import { expect, test } from "bun:test";
import { parseQuery } from "./paletteSearch.ts";
import { paletteOpenQuery } from "./paletteSeed.ts";

test("a string query seeds the palette as it is", () => {
  expect(paletteOpenQuery("> split ")).toBe("> split ");
  expect(parseQuery(paletteOpenQuery(">split")).actionsOnly).toBe(true);
});

test("no argument or a click event opens the palette blank", () => {
  expect(paletteOpenQuery(undefined)).toBe("");
  expect(paletteOpenQuery({ type: "click" })).toBe("");
});
