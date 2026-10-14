import { describe, expect, it } from "bun:test";
import { resolveWorkspaceRoot, workspaceRelativePath } from "./workspacePath.ts";

describe("workspace-relative paths", () => {
  it("resolves the root from the typed start", () => {
    expect(resolveWorkspaceRoot("~", "/home/u")).toBe("/home/u");
    expect(resolveWorkspaceRoot("~/code/app/", "/home/u")).toBe("/home/u/code/app");
    expect(resolveWorkspaceRoot("/srv/app", "/home/u")).toBe("/srv/app");
    expect(resolveWorkspaceRoot("", "/home/u")).toBeNull();
    expect(resolveWorkspaceRoot("/", "/home/u")).toBeNull();
  });
  it("reads paths from the root, else falls back", () => {
    const root = "/home/u/code/app";
    expect(workspaceRelativePath(root, root, "~/code/app")).toBe("app");
    expect(workspaceRelativePath(`${root}/src/lib`, root, "x")).toBe("app/src/lib");
    expect(workspaceRelativePath("/home/u/code/app2", root, "~/code/app2")).toBe("~/code/app2");
    expect(workspaceRelativePath("/home/u", root, "~")).toBe("~");
    expect(workspaceRelativePath("/a", null, "/a")).toBe("/a");
  });
});
