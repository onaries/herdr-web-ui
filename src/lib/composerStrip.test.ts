import { describe, expect, it } from "bun:test";
import { composerStrip } from "./composerStrip.ts";

describe("composerStrip", () => {
  it("draws nothing without a folder or a branch, blank strings included", () => {
    expect(composerStrip({})).toBeNull();
    expect(composerStrip({ cwd: null, branch: null })).toBeNull();
    expect(composerStrip({ cwd: "", branch: "   " })).toBeNull();
  });

  it("names the folder by its last name and keeps the whole path", () => {
    expect(composerStrip({ cwd: "/home/sam/dev/api" })).toEqual({ folder: "api", path: "/home/sam/dev/api", branch: null });
    expect(composerStrip({ cwd: "C:\\work\\api\\" })).toEqual({ folder: "api", path: "C:\\work\\api\\", branch: null });
    expect(composerStrip({ cwd: "/" })).toEqual({ folder: "/", path: "/", branch: null });
  });

  it("draws a branch alone, trimmed", () => {
    expect(composerStrip({ branch: " main " })).toEqual({ folder: null, path: null, branch: "main" });
  });

  it("draws both when both are known", () => {
    expect(composerStrip({ cwd: "~/dev/api", branch: "feature/strip" })).toEqual({ folder: "api", path: "~/dev/api", branch: "feature/strip" });
  });
});
