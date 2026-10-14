import { describe, expect, it } from "bun:test";
import { composerStrip, worktreeRepoName } from "./composerStrip.ts";

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

  it("names a linked worktree's repository in the folder's place, the path kept for its title", () => {
    expect(composerStrip({ cwd: "/home/sam/.herdr/worktrees/api/worktree-lucky-forest-f1c8", branch: "worktree/lucky-forest-f1c8", repo: "api" }))
      .toEqual({ folder: "api", path: "/home/sam/.herdr/worktrees/api/worktree-lucky-forest-f1c8", branch: "worktree/lucky-forest-f1c8" });
    expect(composerStrip({ repo: "api" })).toEqual({ folder: "api", path: null, branch: null });
    expect(composerStrip({ cwd: "/home/sam/dev/api-login", repo: " " })).toEqual({ folder: "api-login", path: "/home/sam/dev/api-login", branch: null });
  });
});

describe("worktreeRepoName", () => {
  it("names the repository only for a linked worktree", () => {
    const worktree = { checkout_path: "/w", repo_key: "k", repo_root: "/r", repo_name: "api" };
    expect(worktreeRepoName({ worktree: { ...worktree, is_linked_worktree: true } })).toBe("api");
    expect(worktreeRepoName({ worktree: { ...worktree, is_linked_worktree: false } })).toBeNull();
    expect(worktreeRepoName({ worktree: null })).toBeNull();
    expect(worktreeRepoName(undefined)).toBeNull();
  });
});
