import { describe, expect, it } from "bun:test";
import { ViewportIntentGate } from "./viewportIntent.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("explicit viewport intent ordering", () => {
  it("drops unsent offsets and waits for an old native scroll before granting Find", async () => {
    const gate = new ViewportIntentGate();
    const native = deferred<void>();
    const events: string[] = [];
    gate.registerScrollCancellation(() => events.push("cancel pending drag"));
    gate.scroll(() => { events.push("old scroll sent"); return native.promise; });
    let granted = false;
    const find = gate.beginSearch().then((release) => { granted = true; events.push("find may send"); return release; });
    expect(gate.isSearching()).toBe(true);
    expect(events).toEqual(["old scroll sent", "cancel pending drag"]);
    expect(gate.scroll(() => { events.push("forbidden new scroll"); return Promise.resolve(); })).toBeNull();
    await Promise.resolve();
    expect(granted).toBe(false);
    native.resolve();
    const release = await find;
    expect(events).toEqual(["old scroll sent", "cancel pending drag", "find may send"]);
    expect(gate.isSearching()).toBe(true);
    release!();
    expect(gate.isSearching()).toBe(false);
    await gate.scroll(() => { events.push("new explicit scroll"); return Promise.resolve(); });
    expect(events.at(-1)).toBe("new explicit scroll");
    expect(events).not.toContain("forbidden new scroll");
  });

  it("retains in-flight writes when the tools effect is replaced", async () => {
    const gate = new ViewportIntentGate();
    const native = deferred<void>();
    const calls: string[] = [];
    const removeOld = gate.registerScrollCancellation(() => calls.push("old"));
    gate.scroll(() => native.promise);
    gate.registerScrollCancellation(() => calls.push("new"));
    removeOld();
    expect(gate.scroll(() => { calls.push("overlapping scroll"); return Promise.resolve(); })).toBeNull();
    let granted = false;
    const find = gate.beginSearch().then((release) => { granted = true; return release; });
    expect(calls).toEqual(["new"]);
    await Promise.resolve(); expect(granted).toBe(false);
    native.resolve(); (await find)!();
    expect(granted).toBe(true);
  });

  it("a failed prior scroll releases the barrier, and duplicate searches cannot release its owner", async () => {
    const gate = new ViewportIntentGate();
    const native = deferred<void>();
    const states: boolean[] = [];
    const unsubscribe = gate.subscribe(() => states.push(gate.isSearching()));
    gate.scroll(() => native.promise);
    const first = gate.beginSearch();
    expect(await gate.beginSearch()).toBeNull();
    native.reject(new Error("disconnected"));
    const finishFirst = (await first)!;
    finishFirst();
    const finishSecond = (await gate.beginSearch())!;
    finishFirst();
    expect(gate.isSearching()).toBe(true);
    finishSecond();
    expect(states).toEqual([true, false, true, false]);
    unsubscribe();
  });

  it("separate pane owners never wait for each other's native writes", async () => {
    const first = new ViewportIntentGate(), second = new ViewportIntentGate();
    const native = deferred<void>();
    first.scroll(() => native.promise);
    const release = await second.beginSearch();
    expect(release).not.toBeNull();
    expect(first.isSearching()).toBe(false);
    release!(); native.resolve();
  });
});
