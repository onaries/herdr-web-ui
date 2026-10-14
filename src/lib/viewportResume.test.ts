import { describe, expect, it } from "bun:test";
import { shouldSyncViewportOnResume } from "./viewportResume.ts";

describe("shouldSyncViewportOnResume", () => {
  it("syncs when a hidden page becomes visible", () => {
    expect(shouldSyncViewportOnResume("visibilitychange", "visible")).toBe(true);
  });

  it("does not sync when a page becomes hidden", () => {
    expect(shouldSyncViewportOnResume("visibilitychange", "hidden")).toBe(false);
  });

  it("syncs on pageshow, including restored pages", () => {
    expect(shouldSyncViewportOnResume("pageshow", "hidden")).toBe(true);
  });
});
