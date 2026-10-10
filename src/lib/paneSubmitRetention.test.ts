import { describe, expect, it } from "bun:test";
import { PaneSubmitRetention } from "./paneSubmitRetention.ts";

describe("pane submit retention", () => {
  it("retains only outstanding claims, including concurrent explicit sends", () => {
    const held = new PaneSubmitRetention();
    expect(held.snapshot()).toEqual([]);
    const first = held.retain("pane-a"), second = held.retain("pane-a"), other = held.retain("pane-b");
    expect(held.snapshot()).toEqual(["pane-a", "pane-b"]);
    first(); first();
    expect(held.has("pane-a")).toBe(true);
    second();
    expect(held.snapshot()).toEqual(["pane-b"]);
    other();
    expect(held.snapshot()).toEqual([]);
  });
  it("native close drops a pending mount and an old receipt cannot release a reused ID", () => {
    const held = new PaneSubmitRetention();
    const old = held.retain("pane-a");
    held.reconcile(new Set());
    expect(held.snapshot()).toEqual([]);
    const current = held.retain("pane-a");
    old();
    expect(held.snapshot()).toEqual(["pane-a"]);
    current();
    expect(held.snapshot()).toEqual([]);
  });
  it("PC owners and their listeners are independent", () => {
    const first = new PaneSubmitRetention(), second = new PaneSubmitRetention();
    let notifications = 0;
    const unsubscribe = first.subscribe(() => { notifications++; });
    const release = first.retain("pane-a");
    expect(second.has("pane-a")).toBe(false);
    first.reconcile(new Set(["pane-a"]));
    expect(notifications).toBe(1);
    release();
    expect(notifications).toBe(2);
    unsubscribe();
    first.retain("pane-b");
    expect(notifications).toBe(2);
  });
});
