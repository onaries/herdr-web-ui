import { describe, expect, test } from "bun:test";

import { followGlides } from "./followScroll.ts";

describe("followGlides", () => {
  test("glides only while a turn works", () => {
    expect(followGlides({ working: true, reducedMotion: false })).toBe(true);
    expect(followGlides({ working: false, reducedMotion: false })).toBe(false);
  });
  test("reduced motion stays instant", () => {
    expect(followGlides({ working: true, reducedMotion: true })).toBe(false);
  });
  test("a layout the reader changed stays instant", () => {
    expect(followGlides({ working: true, reducedMotion: false, manualLayout: true })).toBe(false);
  });
});
