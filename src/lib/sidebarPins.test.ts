import { describe, expect, it } from "bun:test";
import { isWorkspacePinKey, loadSidebarPins, pinnedGroupIds, pinnedWorkspaceIds, pruneSidebarPins, pruneWorkspacePins, sidebarPinKey, splitPinnedGroups, splitPinnedRows, toggleSidebarPin, workspacePinKey } from "./sidebarPins.ts";

describe("sidebar agent pins", () => {
  it("keys a pin by PC and pane", () => {
    expect(sidebarPinKey("pc-a", "pane-1")).toBe("pc-a:pane-1");
    expect(sidebarPinKey("pc-b", "pane-1")).not.toBe(sidebarPinKey("pc-a", "pane-1"));
  });

  it("toggles pins without changing the saved order of other pins", () => {
    expect(toggleSidebarPin(["a", "b"], "a")).toEqual(["b"]);
    expect(toggleSidebarPin(["a", "b"], "c")).toEqual(["a", "b", "c"]);
  });

  it("prunes only panes absent from the live roster", () => {
    expect(pruneSidebarPins(["pc-a:p1", "pc-b:p1"], new Set(["pc-b:p1"]), [{ id: "pc-a", snapshot: {} }, { id: "pc-b", snapshot: {} }])).toEqual(["pc-b:p1"]);
  });

  it("keeps saved pins until each machine's agent roster has loaded", () => {
    const pins = ["local:p1", "remote:p2"];
    const live = new Set(["local:p1"]);
    expect(pruneSidebarPins(pins, new Set(), [])).toEqual(pins);
    expect(pruneSidebarPins(pins, new Set(), [{ id: "local", snapshot: null }, { id: "remote", snapshot: null }])).toEqual(pins);
    expect(pruneSidebarPins(pins, live, [{ id: "local", snapshot: {} }, { id: "remote", snapshot: null }])).toEqual(pins);
    expect(pruneSidebarPins(pins, live, [{ id: "local", snapshot: {} }, { id: "remote", snapshot: {} }])).toEqual(["local:p1"]);
  });

  it("matches the complete machine key instead of a shared prefix", () => {
    expect(pruneSidebarPins(["pc:p1", "pc-extra:p2"], new Set(), [{ id: "pc", snapshot: null }])).toEqual(["pc:p1"]);
  });

  it("places pinned rows first and keeps source order for the rest", () => {
    const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const order = (keys: string[]) => {
      const { pinned, rest } = splitPinnedRows(rows, keys, (row) => row.id);
      return [...pinned, ...rest].map((row) => row.id);
    };
    expect(order(["c", "a"])).toEqual(["c", "a", "b"]);
    expect(order(["missing", "b"])).toEqual(["b", "a", "c"]);
  });

  it("keys a workspace by PC and marks it as one", () => {
    expect(workspacePinKey("pc-a", "w1")).toBe("pc-a:workspace:w1");
    expect(isWorkspacePinKey(workspacePinKey("pc-a", "w1"))).toBe(true);
    expect(isWorkspacePinKey(sidebarPinKey("pc-a", "w1:p1"))).toBe(false);
    expect(pinnedWorkspaceIds(["pc-a:workspace:w2", "pc-a:w1:p1", "pc-b:workspace:w3", "pc-a:workspace:w1"], "pc-a")).toEqual(["w2", "w1"]);
  });

  it("prunes each kind of pin only where it is known", () => {
    const keys = ["pc-a:workspace:w1", "pc-a:workspace:gone", "pc-b:workspace:gone", "pc-a:p1"];
    // the Agents list leaves workspace pins alone, even of a loaded PC
    expect(pruneSidebarPins(keys, new Set(["pc-a:p1"]), [{ id: "pc-a", snapshot: {} }, { id: "pc-b", snapshot: {} }])).toEqual(keys);
    // a PC's workspace list prunes its own gone workspaces only
    expect(pruneWorkspacePins(keys, "pc-a", new Set(["w1"]))).toEqual(["pc-a:workspace:w1", "pc-b:workspace:gone", "pc-a:p1"]);
  });

  it("hoists a pinned repository with its worktrees and a pinned worktree alone", () => {
    const groups = [
      { workspace: "repo", children: ["wt1", "wt2"] },
      { workspace: "solo", children: [] },
      { workspace: "other", children: [] },
    ];
    const split = (ids: string[]) => splitPinnedGroups(groups, ids, (id) => id);
    expect(split([])).toEqual({ pinned: [], rest: groups });
    expect(split(["wt2", "other"])).toEqual({
      pinned: [{ workspace: "wt2", children: [] }, { workspace: "other", children: [] }],
      rest: [{ workspace: "repo", children: ["wt1"] }, { workspace: "solo", children: [] }],
    });
    expect(split(["repo", "wt1", "missing"])).toEqual({
      pinned: [{ workspace: "repo", children: ["wt2"] }, { workspace: "wt1", children: [] }],
      rest: [{ workspace: "solo", children: [] }, { workspace: "other", children: [] }],
    });
  });

  it("holds a pinned repository's worktrees in place with it", () => {
    const groups = [
      { workspace: "repo", children: ["wt1", "wt2"] },
      { workspace: "solo", children: [] },
    ];
    const { pinned } = splitPinnedGroups(groups, ["repo"], (id) => id);
    expect([...pinnedGroupIds(pinned, (id) => id)]).toEqual(["repo", "wt1", "wt2"]);
    expect(pinnedGroupIds([], (id: string) => id).size).toBe(0);
  });

  it("starts with no pins when storage denies the read", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem() { throw new Error("denied"); } } });
    try { expect(loadSidebarPins()).toEqual([]); }
    finally {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});
