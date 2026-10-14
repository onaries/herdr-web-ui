import { expect, it } from "bun:test";
import { pageScrollDistance, plainPageDirection } from "./pageScroll.ts";

it("retains overlap in native rows and computed chat pixels while always advancing", () => {
  expect(pageScrollDistance(24, 1, 1)).toBe(23);
  expect(pageScrollDistance(24, 1, 3)).toBe(21);
  expect(pageScrollDistance(24, 1, 0)).toBe(24);
  expect(pageScrollDistance(400, 24, 3)).toBe(328);
  expect(pageScrollDistance(400, 30, 3)).toBe(310);
  expect(pageScrollDistance(24, 1, 100)).toBe(1);
  expect(pageScrollDistance(10, 24, 1)).toBe(1);
});


it("uses only unmodified page keys, preserving modified shortcuts and composition", () => {
  const event = { key: "PageUp", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
  expect(plainPageDirection(event)).toBe(-1);
  expect(plainPageDirection({ ...event, key: "PageDown" })).toBe(1);
  expect(plainPageDirection({ ...event, key: "ArrowUp" })).toBeNull();
  for (const flags of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { isComposing: true }, { keyCode: 229 }]) {
    expect(plainPageDirection({ ...event, ...flags })).toBeNull();
  }
});
