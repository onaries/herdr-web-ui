import { describe, expect, test } from "bun:test";
import { fontSmoothingAttribute, panelMotionScale, sanitizeFontSmoothing, sanitizePanelMotion } from "./appearanceRendering.ts";

describe("appearance rendering", () => {
  test("a stale or hand-edited record falls back to the defaults", () => {
    expect(sanitizeFontSmoothing("subpixel")).toBe("grayscale");
    expect(sanitizeFontSmoothing(undefined)).toBe("grayscale");
    expect(sanitizeFontSmoothing("system")).toBe("system");
    expect(sanitizePanelMotion(3)).toBe("default");
    expect(sanitizePanelMotion("off")).toBe("off");
  });

  test("the default smoothing leaves <html> bare, the other is named", () => {
    expect(fontSmoothingAttribute("grayscale")).toBeUndefined();
    expect(fontSmoothingAttribute("system")).toBe("system");
  });

  test("off zeroes the durations, the rest scale them", () => {
    expect(panelMotionScale("off")).toBe("0");
    expect(panelMotionScale("default")).toBe("1");
    expect(Number(panelMotionScale("fast"))).toBeLessThan(1);
    expect(Number(panelMotionScale("slow"))).toBeGreaterThan(1);
  });
});
