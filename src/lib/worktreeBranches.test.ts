import { describe, expect, it } from "bun:test";
import type { WorkspaceInfo, WorktreeEntry, WorktreeListing, WorktreeOpened } from "../../shared/protocol.ts";
import { normalizeCheckoutPath, WorkspaceBranchCache, worktreeRepositories, worktreeWorkspaceSignature } from "./worktreeBranches.ts";
import { branchWords, DETACHED } from "./paneBranch.ts";

function workspace(id: string, path = `/repo/${id}`, repoKey = "repo", linked = true): WorkspaceInfo {
  return {
    workspace_id: id, active_tab_id: `${id}:t1`, label: `Renamed ${id}`, number: 1,
    tab_count: 1, pane_count: 1, focused: false, agent_status: "idle",
    worktree: { checkout_path: path, is_linked_worktree: linked, repo_key: repoKey, repo_name: repoKey, repo_root: "/repo" },
  };
}

function entry(id: string | null, path: string, branch: string | null = "feature/actual", overrides: Partial<WorktreeEntry> = {}): WorktreeEntry {
  return { open_workspace_id: id, path, branch, label: "arbitrary label", is_linked_worktree: true,
    is_bare: false, is_detached: false, is_prunable: false, ...overrides };
}

function listing(entries: WorktreeEntry[], repoKey = "repo"): WorktreeListing {
  return { source: { repo_key: repoKey, repo_name: repoKey, repo_root: "/repo", source_checkout_path: "/repo", source_workspace_id: "main" }, worktrees: entries };
}

function opened(id: string, path: string, branch: string | null): WorktreeOpened {
  return { workspace_id: id, pane_id: `${id}:p1`, path, branch, already_open: false };
}

describe("worktree branch metadata", () => {
  it("normalizes trailing checkout separators and Windows paths without trimming names", () => {
    expect(normalizeCheckoutPath("/repo/feature///")).toBe("/repo/feature");
    expect(normalizeCheckoutPath("/")).toBe("/");
    expect(normalizeCheckoutPath("/repo/feature ")).toBe("/repo/feature ");
    expect(normalizeCheckoutPath("/repo/back\\slash/")).toBe("/repo/back\\slash");
    expect(normalizeCheckoutPath("c:\\repo\\feature\\")).toBe("C:/repo/feature");
    expect(normalizeCheckoutPath("C:\\")).toBe("C:/");
    expect(normalizeCheckoutPath("\\\\host\\share\\feature\\")).toBe("//host/share/feature");
  });

  it("requests each repository once through its main checkout when present", () => {
    const shell = { ...workspace("shell"), worktree: null };
    expect(worktreeRepositories([workspace("child"), workspace("other", "/other", "other"), workspace("main", "/repo", "repo", false), workspace("second"), shell]))
      .toEqual([{ repoKey: "other", workspaceId: "other" }, { repoKey: "repo", workspaceId: "main" }]);
    expect(worktreeRepositories([workspace("main", "/repo", "repo", false), shell])).toEqual([]);
  });

  it("ignores status, names and order but changes its signature for checkout identity", () => {
    const first = workspace("first");
    const second = workspace("second");
    const signature = worktreeWorkspaceSignature([first, second]);
    expect(worktreeWorkspaceSignature([{ ...second, label: "custom name", agent_status: "working" }, first])).toBe(signature);
    expect(worktreeWorkspaceSignature([workspace("first", "/repo/changed"), second])).not.toBe(signature);
    expect(worktreeWorkspaceSignature([workspace("first", "/repo/first", "other-repo"), second])).not.toBe(signature);
    expect(worktreeWorkspaceSignature([first])).not.toBe(signature);
  });

  it("takes the exact API branch independently of workspace, label and folder names", () => {
    const workspaces = [workspace("child", "/repo/not-the-branch/")];
    const cache = new WorkspaceBranchCache();
    cache.reconcile(workspaces);
    cache.applyListing("repo", listing([entry("child", "/repo/not-the-branch", "codex/fix-sidebar")]), cache.generation);
    expect(cache.branchesFor(workspaces).get("child")).toEqual({ checkoutPath: "/repo/not-the-branch", branch: "codex/fix-sidebar", isDetached: false });
    expect(cache.branchesFor([{ ...workspaces[0]!, label: "Renamed again" }]).get("child")?.branch).toBe("codex/fix-sidebar");
  });

  it("rejects another repository, another workspace and a different checkout path", () => {
    const workspaces = [workspace("child")];
    const cache = new WorkspaceBranchCache();
    cache.reconcile(workspaces);
    expect(cache.applyListing("repo", listing([entry("child", "/repo/child")], "wrong-repo"), cache.generation)).toBe(false);
    cache.applyListing("repo", listing([entry("wrong-id", "/repo/child"), entry("child", "/repo/wrong-path"), entry(null, "/repo/child")]), cache.generation);
    expect(cache.branchesFor(workspaces).size).toBe(0);
  });

  it("only confirms detached HEAD from the inventory's detached flag", () => {
    const workspaces = [workspace("detached"), workspace("unknown")];
    const cache = new WorkspaceBranchCache();
    cache.reconcile(workspaces);
    cache.rememberOpened(opened("detached", "/repo/detached", null));
    expect(cache.branchesFor(workspaces).has("detached")).toBe(false);
    cache.applyListing("repo", listing([entry("detached", "/repo/detached", null, { is_detached: true }), entry("unknown", "/repo/unknown", null)]), cache.generation);
    expect(cache.branchesFor(workspaces).get("detached")).toMatchObject({ branch: null, isDetached: true });
    expect(cache.branchesFor(workspaces).get("unknown")).toMatchObject({ branch: null, isDetached: false });
  });

  it("publishes an omitted detached branch from Herdr without crashing the sidebar", () => {
    const workspaces = [workspace("detached"), workspace("unknown")];
    const cache = new WorkspaceBranchCache();
    cache.reconcile(workspaces);
    // Herdr 0.9.5 omits absent Option fields from JSON rather than sending null.
    cache.rememberOpened(JSON.parse(JSON.stringify(opened("detached", "/repo/detached", null)),
      (key, value: unknown) => key === "branch" ? undefined : value));
    expect([...branchWords(cache.branchesFor(workspaces))]).toEqual([]);
    const inventory: WorktreeListing = JSON.parse(JSON.stringify(listing([
      entry("detached", "/repo/detached", null, { is_detached: true }),
      entry("unknown", "/repo/unknown", null),
    ])), (key, value: unknown) => key === "branch" ? undefined : value);
    cache.applyListing("repo", inventory, cache.generation);
    const branches = cache.branchesFor(workspaces);
    expect([...branchWords(branches)]).toEqual([["detached", DETACHED]]);
    expect(branches.get("detached")).toMatchObject({ branch: null, isDetached: true });
    expect(branches.get("unknown")).toMatchObject({ branch: null, isDetached: false });
  });

  it("retains a known checkout across failed reads and removes closed or changed identities", () => {
    const workspaces = [workspace("child"), workspace("closed")];
    const cache = new WorkspaceBranchCache();
    cache.reconcile(workspaces);
    cache.applyListing("repo", listing([entry("child", "/repo/child"), entry("closed", "/repo/closed")]), cache.generation);
    cache.invalidate(); // an offline or failed refresh leaves exact matches intact
    expect(cache.branchesFor(workspaces).size).toBe(2);
    expect(cache.branchesFor([workspace("child", "/repo/different")]).size).toBe(0);
    expect(cache.branchesFor([workspace("child", "/repo/child", "new-repo")]).size).toBe(0);
    cache.reconcile([workspace("child", "/repo/different")]);
    expect(cache.branchesFor(workspaces).size).toBe(0);
    cache.reconcile([]);
    expect(cache.branchesFor(workspaces).size).toBe(0);
  });

  it("rejects a stale inventory after create/open and preserves a seed until its snapshot arrives", () => {
    const cache = new WorkspaceBranchCache();
    const main = workspace("main", "/repo", "repo", false);
    cache.reconcile([main]);
    const earlier = cache.generation;
    cache.rememberOpened(opened("new", "/repo/new/", "feature/new"));
    expect(cache.applyListing("repo", listing([entry("main", "/repo", "main")]), earlier)).toBe(false);
    const workspaces = [main, workspace("new")];
    expect(cache.branchesFor(workspaces).get("new")?.branch).toBe("feature/new");
    cache.reconcile(workspaces);
    expect(cache.branchesFor(workspaces).get("new")?.branch).toBe("feature/new");
    const current = cache.generation;
    cache.applyListing("repo", listing([entry("new", "/repo/new", "feature/updated")]), current);
    expect(cache.branchesFor(workspaces).get("new")?.branch).toBe("feature/updated");
  });

  it("removes metadata when a successful inventory no longer names the opened checkout", () => {
    const workspaces = [workspace("child")];
    const cache = new WorkspaceBranchCache();
    cache.reconcile(workspaces);
    cache.rememberOpened(opened("child", "/repo/child", "feature/new"));
    cache.applyListing("repo", listing([entry(null, "/repo/child", "feature/new")]), cache.generation);
    expect(cache.branchesFor(workspaces).size).toBe(0);
  });
});
