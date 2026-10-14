import { describe, expect, test } from "bun:test";
import { DISMISS_SHARE, FLICK_SPEED, sheetDismisses, sheetDragVerdict } from "./sheets.ts";

describe("sheetDragVerdict", () => {
  test("a tiny movement is not a direction yet", () => {
    expect(sheetDragVerdict(3, 4, 0)).toBe("pending");
  });

  test("a stroke down from the sheet's top drags it", () => {
    expect(sheetDragVerdict(2, 20, 0)).toBe("drag");
  });

  test("a stroke down a list scrolled away from its top scrolls the list back", () => {
    expect(sheetDragVerdict(2, 20, 120)).toBe("ignore");
  });

  test("a stroke up or sideways is the content's", () => {
    expect(sheetDragVerdict(0, -20, 0)).toBe("ignore");
    expect(sheetDragVerdict(30, 12, 0)).toBe("ignore");
  });
});

describe("sheetDismisses", () => {
  test("a sheet let go far enough down closes, one let go short of it springs back", () => {
    expect(sheetDismisses(500 * DISMISS_SHARE + 1, 500, 0)).toBe(true);
    expect(sheetDismisses(500 * DISMISS_SHARE - 1, 500, 0)).toBe(false);
  });

  test("a flick down closes it from near the top, a slow drag there does not", () => {
    expect(sheetDismisses(40, 500, FLICK_SPEED + 0.1)).toBe(true);
    expect(sheetDismisses(40, 500, FLICK_SPEED - 0.1)).toBe(false);
  });

  test("a flick that has not moved the sheet is a tap, not a close", () => {
    expect(sheetDismisses(2, 500, 3)).toBe(false);
  });
});
