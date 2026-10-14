import { describe, expect, it } from "bun:test";

import { FIRST_SKELETON_ROWS, MAX_SKELETON_ROWS, skeletonRows } from "./skeleton.ts";

describe("skeletonRows", () => {
  it("draws a few rows before the first listing", () => {
    expect(skeletonRows(null)).toHaveLength(FIRST_SKELETON_ROWS);
  });

  it("draws one row per row the last listing had, one at least and the list's cap at most", () => {
    expect(skeletonRows(5)).toHaveLength(5);
    expect(skeletonRows(0)).toHaveLength(1);
    expect(skeletonRows(200)).toHaveLength(MAX_SKELETON_ROWS);
  });

  it("varies the widths in a fixed order, no two neighbours alike, so two reads draw the same rows", () => {
    const rows = skeletonRows(MAX_SKELETON_ROWS);
    expect(new Set(rows)).toEqual(new Set(["short", "medium", "long"]));
    expect(skeletonRows(MAX_SKELETON_ROWS)).toEqual(rows);
    expect(skeletonRows(4)).toEqual(rows.slice(0, 4));
    for (let index = 1; index < rows.length; index++) expect(rows[index]).not.toBe(rows[index - 1]);
  });
});
