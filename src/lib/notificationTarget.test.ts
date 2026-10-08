import { describe, expect, it } from "bun:test";
import { notificationTargetFromSearch, notificationTargets, notificationViewForPane } from "./notificationTarget.ts";

function messages() {
  let receive!: (event: MessageEvent) => void;
  const subscribe = notificationTargets({ addEventListener: (_type, listener) => { receive = listener; } });
  return { subscribe, send: (data: unknown) => receive({ data } as MessageEvent) };
}

describe("notification pane delivery", () => {
  it("retains only the newest exact PC and pane while the app is starting", () => {
    const source = messages();
    source.send({ type: "select-pane", pane_id: "older", machine_id: "local" });
    source.send({ type: "select-pane", pane_id: "latest pane/?", machine_id: "remote&pc" });
    const selected: unknown[] = [];
    source.subscribe((target) => selected.push(target));
    expect(selected).toEqual([{ machine_id: "remote&pc", pane_id: "latest pane/?" }]);
  });

  it("preserves the requested chat view with a pane target", () => {
    const source = messages();
    const selected: unknown[] = [];
    source.subscribe((target) => selected.push(target));
    source.send({ type: "select-pane", pane_id: "pi-pane", machine_id: "local", view: "chat" });
    expect(selected).toEqual([{ machine_id: "local", pane_id: "pi-pane", view: "chat" }]);
  });

  it("reads a chat target from a cold-start notification URL only when a pane is present", () => {
    expect(notificationTargetFromSearch("?machine=remote%26pc&pane=pi%2F1&view=chat")).toEqual({
      machine_id: "remote&pc",
      pane_id: "pi/1",
      view: "chat",
    });
    expect(notificationTargetFromSearch("?pane=pi-pane&view=chat")).toEqual({
      machine_id: "local",
      pane_id: "pi-pane",
      view: "chat",
    });
    expect(notificationTargetFromSearch("?pane=pi-pane")).toBeNull();
    expect(notificationTargetFromSearch("?view=chat")).toBeNull();
  });

  it("forces the requested view only for that exact PC and pane", () => {
    const target = { machine_id: "remote", pane_id: "pi-pane", view: "chat" as const };
    expect(notificationViewForPane(target, "remote", "pi-pane")).toBe("chat");
    expect(notificationViewForPane(target, "local", "pi-pane")).toBeNull();
    expect(notificationViewForPane(target, "remote", "another-pane")).toBeNull();
    expect(notificationViewForPane({ machine_id: "remote", pane_id: "pi-pane" }, "remote", "pi-pane")).toBeNull();
  });

  it("delivers directly once the app subscribes", () => {
    const source = messages();
    const selected: unknown[] = [];
    source.subscribe((target) => selected.push(target));
    source.send({ type: "select-pane", pane_id: "pane-a" });
    source.send({ type: "select-pane", pane_id: "pane-b", machine_id: "second/pc" });
    expect(selected).toEqual([{ machine_id: "local", pane_id: "pane-a" }, { machine_id: "second/pc", pane_id: "pane-b" }]);
  });

  it("ignores malformed messages without losing a valid pending selection", () => {
    const source = messages();
    source.send({ type: "select-pane", pane_id: "pane-a", machine_id: 42 });
    for (const data of [null, "select-pane", { type: "other", pane_id: "pane-b" }, { type: "select-pane", pane_id: null }]) source.send(data);
    const selected: unknown[] = [];
    source.subscribe((target) => selected.push(target));
    expect(selected).toEqual([{ machine_id: "local", pane_id: "pane-a" }]);
  });

  it("holds messages after cleanup and does not replay a consumed target on remount", () => {
    const source = messages();
    const selected: unknown[] = [];
    const unsubscribe = source.subscribe((target) => selected.push(target));
    source.send({ type: "select-pane", pane_id: "pane-a" });
    unsubscribe();
    source.send({ type: "select-pane", pane_id: "pane-b" });
    const resumed: unknown[] = [];
    source.subscribe((target) => resumed.push(target))();
    const remounted: unknown[] = [];
    source.subscribe((target) => remounted.push(target));
    expect(selected).toEqual([{ machine_id: "local", pane_id: "pane-a" }]);
    expect(resumed).toEqual([{ machine_id: "local", pane_id: "pane-b" }]);
    expect(remounted).toEqual([]);
  });

  it("an old cleanup cannot detach a later app subscriber", () => {
    const source = messages();
    const unsubscribe = source.subscribe(() => {});
    const selected: unknown[] = [];
    source.subscribe((target) => selected.push(target));
    unsubscribe();
    source.send({ type: "select-pane", pane_id: "pane-b", machine_id: "remote" });
    expect(selected).toEqual([{ machine_id: "remote", pane_id: "pane-b" }]);
  });
});
