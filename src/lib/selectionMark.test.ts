import { describe, expect, it } from "bun:test";
import { markSelection, selectionStill, type SelectionMark } from "./selectionMark.ts";

const start: SelectionMark = { machineId: "local", paneId: "w1:p1", generation: 0 };

describe("markSelection", () => {
  it("keeps the mark while the selection stands, and moves a generation on with every change", () => {
    expect(markSelection(start, "local", "w1:p1")).toBe(start);
    const other = markSelection(start, "local", "w1:p2");
    expect(other).toEqual({ machineId: "local", paneId: "w1:p2", generation: 1 });
    expect(markSelection(other, "office", "w1:p2").generation).toBe(2);
    expect(markSelection(other, "local", null).generation).toBe(2);
  });
});

describe("selectionStill", () => {
  it("lets a call act only while nothing was opened since it was made, the same pane opened again included", () => {
    expect(selectionStill(start, start)).toBe(true);
    expect(selectionStill(start, markSelection(start, "local", "w1:p2"))).toBe(false);
    expect(selectionStill(start, markSelection(start, "office", "w1:p1"))).toBe(false);
    // a split asked on p1, p2 opened while herdr answered, then p1 again: the user moved on,
    // so the new pane is not opened over what they came back to
    const back = markSelection(markSelection(start, "local", "w1:p2"), "local", "w1:p1");
    expect(back).toEqual({ machineId: "local", paneId: "w1:p1", generation: 2 });
    expect(selectionStill(start, back)).toBe(false);
  });
});
