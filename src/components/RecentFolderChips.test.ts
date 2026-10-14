import { expect, it } from "bun:test";
import { chipsThatFit } from "./RecentFolderChips.tsx";

it("fits every chip it can, keeping room for the +N chip when some are left over", () => {
  expect(chipsThatFit([100, 100, 100], 40, 8, 316)).toBe(3);
  expect(chipsThatFit([100, 100, 100], 40, 8, 315)).toBe(2);
  expect(chipsThatFit([100, 100, 100], 40, 8, 255)).toBe(1);
  expect(chipsThatFit([300, 100], 40, 8, 200)).toBe(1);
  expect(chipsThatFit([], 40, 8, 200)).toBe(0);
});
