import { describe, expect, test } from "bun:test";
import { EDGE_SPEED_PX, EDGE_ZONE_PX, edgeScrollStep, HOLD_SLOP_PX, heldStill, rowAt } from "./touchReorder.ts";

describe("heldStill", () => {
  test("a finger that barely moves is still pressing", () => {
    expect(heldStill(0, 0)).toBe(true);
    expect(heldStill(HOLD_SLOP_PX, -HOLD_SLOP_PX)).toBe(true);
  });

  test("a finger that moved is a scroll or a swipe", () => {
    expect(heldStill(HOLD_SLOP_PX + 1, 0)).toBe(false);
    expect(heldStill(0, -(HOLD_SLOP_PX + 1))).toBe(false);
  });
});

describe("rowAt", () => {
  const rows = [
    { id: "a", top: 0, bottom: 40 },
    { id: "b", top: 40, bottom: 80 },
    { id: "c", top: 100, bottom: 140 },
  ];

  test("the row under the finger", () => {
    expect(rowAt(10, rows)).toBe("a");
    expect(rowAt(40, rows)).toBe("b");
    expect(rowAt(139, rows)).toBe("c");
  });

  test("between rows or past the ends, the nearest one", () => {
    expect(rowAt(85, rows)).toBe("b");
    expect(rowAt(97, rows)).toBe("c");
    expect(rowAt(-30, rows)).toBe("a");
    expect(rowAt(400, rows)).toBe("c");
  });

  test("no rows, no row", () => {
    expect(rowAt(10, [])).toBeNull();
  });
});

describe("edgeScrollStep", () => {
  test("the middle of the list scrolls nothing", () => {
    expect(edgeScrollStep(300, 0, 600)).toBe(0);
  });

  test("near an edge the list scrolls that way, fastest at the edge", () => {
    expect(edgeScrollStep(EDGE_ZONE_PX / 2, 0, 600)).toBeLessThan(0);
    expect(edgeScrollStep(0, 0, 600)).toBe(-EDGE_SPEED_PX);
    expect(edgeScrollStep(600 - EDGE_ZONE_PX / 2, 0, 600)).toBeGreaterThan(0);
    expect(edgeScrollStep(700, 0, 600)).toBe(EDGE_SPEED_PX);
  });

  test("a short list keeps a middle that does not scroll", () => {
    expect(edgeScrollStep(50, 0, 100)).toBe(0);
    expect(edgeScrollStep(10, 0, 100)).toBeLessThan(0);
  });
});
