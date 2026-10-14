import { describe, expect, it } from "bun:test";

import { CONTRAST_DEFAULT, CONTRAST_MAX, CONTRAST_MIN, contrastAttribute, contrastText, sanitizeContrast } from "./contrast.ts";
import { DEFAULT_SETTINGS, SETTING_SCOPE, sanitizeSettings } from "./settings.ts";

describe("contrast steps", () => {
  it("run from a softer look to a stronger one around the palette's own drawing", () => {
    expect(CONTRAST_MIN).toBeLessThan(CONTRAST_DEFAULT);
    expect(CONTRAST_MAX).toBeGreaterThan(CONTRAST_DEFAULT);
    expect(CONTRAST_DEFAULT).toBe(0);
  });

  it("takes a whole step within the range from a saved record and the default from anything else", () => {
    expect(sanitizeContrast(undefined)).toBe(0);
    expect(sanitizeContrast("2")).toBe(0);
    expect(sanitizeContrast(Number.NaN)).toBe(0);
    expect(sanitizeContrast(null)).toBe(0);
    expect(sanitizeContrast(2)).toBe(2);
    expect(sanitizeContrast(-1)).toBe(-1);
    expect(sanitizeContrast(1.4)).toBe(1);
    expect(sanitizeContrast(99)).toBe(CONTRAST_MAX);
    expect(sanitizeContrast(-99)).toBe(CONTRAST_MIN);
  });

  it("is one setting of this device, drawn as its block says until a step is chosen", () => {
    expect(DEFAULT_SETTINGS.contrast).toBe(0);
    expect(SETTING_SCOPE.contrast).toBe("device");
    expect(sanitizeSettings({}).contrast).toBe(0);
    expect(sanitizeSettings({ contrast: 3 }).contrast).toBe(3);
    expect(sanitizeSettings({ contrast: -7 }).contrast).toBe(CONTRAST_MIN);
    expect(sanitizeSettings({ contrast: "3" }).contrast).toBe(0);
  });

  it("shows the step signed, the default as 0", () => {
    expect(contrastText(0)).toBe("0");
    expect(contrastText(2)).toBe("+2");
    expect(contrastText(-2)).toBe("−2");
  });

  it("marks <html> with the step only away from the default", () => {
    expect(contrastAttribute(0)).toBeUndefined();
    expect(contrastAttribute(-0)).toBeUndefined();
    expect(contrastAttribute(3)).toBe("3");
    expect(contrastAttribute(-2)).toBe("-2");
  });
});
