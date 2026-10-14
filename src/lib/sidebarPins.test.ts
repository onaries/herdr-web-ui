import { describe, expect, it } from "bun:test";
import { groupRows } from "./sidebarAgents.ts";
import { loadSidebarPins, pruneSidebarPins, sidebarPinKey, splitPinnedRows, toggleSidebarPin } from "./sidebarPins.ts";

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

  it("keeps a pinned agent in its card, first there, with the cards that hold pins first", () => {
    // A1 and A2 share workspace A; C1 then A2 are pinned
    const rows = [{ id: "A1", ws: "A" }, { id: "A2", ws: "A" }, { id: "B1", ws: "B" }, { id: "C1", ws: "C" }];
    const { pinned, rest } = splitPinnedRows(rows, ["C1", "A2"], (row) => row.id);
    expect(pinned.map((row) => row.id)).toEqual(["C1", "A2"]);
    expect(groupRows([...pinned, ...rest], (row) => row.ws).map((group) => [group.key, group.rows.map((row) => row.id)]))
      .toEqual([["C", ["C1"]], ["A", ["A2", "A1"]], ["B", ["B1"]]]);
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
