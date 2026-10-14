import { describe, expect, it } from "bun:test";
import { resolveLink } from "./deepLink.ts";
import { machineGone, machineMissing, notificationLanding, notificationTargetFromSearch, notificationTargets, notificationViewForPane, sameLink } from "./notificationTarget.ts";

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

  it("carries the workspace the worker names, and nothing for an empty or malformed one", () => {
    const source = messages();
    const selected: unknown[] = [];
    source.subscribe((target) => selected.push(target));
    source.send({ type: "select-pane", pane_id: "w1:p9", machine_id: "local", view: "chat", workspace_id: "w1" });
    source.send({ type: "select-pane", pane_id: "w1:p9", machine_id: "local", workspace_id: "" });
    source.send({ type: "select-pane", pane_id: "w1:p9", machine_id: "local", workspace_id: 7 });
    expect(selected).toEqual([
      { machine_id: "local", pane_id: "w1:p9", view: "chat", workspace_id: "w1" },
      { machine_id: "local", pane_id: "w1:p9" },
      { machine_id: "local", pane_id: "w1:p9" },
    ]);
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

describe("notification landing", () => {
  const roster = [
    { id: "local", snapshot: { panes: [{ pane_id: "w1:p1" }] } },
    { id: "pc2", snapshot: null },
  ];

  it("knows a PC is missing only once the roster is in", () => {
    expect(machineMissing([], "pc-gone")).toBe(false);
    expect(machineMissing(roster, "pc-gone")).toBe(true);
    expect(machineMissing(roster, "pc2")).toBe(false);
  });

  it("calls a PC gone only from a roster the server sent after it was named", () => {
    // a tab resumed with an old roster: the PC added meanwhile is not in it, and that says nothing yet
    expect(machineGone(roster, 4, 4, "pc-new")).toBe(false);
    // the roster asked for after the tap still lacks it: removed
    expect(machineGone(roster, 5, 4, "pc-new")).toBe(true);
    expect(machineGone([...roster, { id: "pc-new", snapshot: null }], 5, 4, "pc-new")).toBe(false);
    // a remembered selection is checked against the first roster in (named at 0)
    expect(machineGone(roster, 1, 0, "pc-gone")).toBe(true);
    // nothing waits
    expect(machineGone(roster, 9, null, "pc-gone")).toBe(false);
  });

  it("waits on a PC the roster in hand lacks instead of discarding the tap, and asks again", () => {
    // the cached roster may predate a PC set up elsewhere: the tap waits as a link, marked stale
    expect(notificationLanding(roster, { machine_id: "pc-gone", pane_id: "w1:p1", view: "chat" })).toEqual({
      kind: "link", link: { machine: "pc-gone", workspace: null, pane: "w1:p1", view: "chat", settings: null }, stale: true,
    });
  });

  it("selects a pane the roster lists at once", () => {
    expect(notificationLanding(roster, { machine_id: "local", pane_id: "w1:p1", view: "chat" })).toEqual({ kind: "select" });
  });

  it("waits as a link while the roster, the PC's panes or the pane are not known", () => {
    const link = (machine: string, pane: string) => ({ kind: "link" as const, link: { machine, workspace: null, pane, view: "chat" as const, settings: null }, stale: false });
    expect(notificationLanding([], { machine_id: "pc-gone", pane_id: "w1:p1", view: "chat" })).toEqual(link("pc-gone", "w1:p1"));
    expect(notificationLanding(roster, { machine_id: "pc2", pane_id: "w1:p1", view: "chat" })).toEqual(link("pc2", "w1:p1"));
    expect(notificationLanding(roster, { machine_id: "local", pane_id: "w1:p9", view: "chat" })).toEqual(link("local", "w1:p9"));
    expect(notificationLanding(roster, { machine_id: "local", pane_id: "w1:p9" })).toEqual({ kind: "link", link: { machine: "local", workspace: null, pane: "w1:p9", view: null, settings: null }, stale: false });
  });

  it("names the workspace an ended pane was last seen in, so its workspace opens with the pane-closed note", () => {
    const landing = notificationLanding(roster, { machine_id: "local", pane_id: "w1:p9", view: "chat", workspace_id: "w1" });
    expect(landing.kind).toBe("link");
    const link = landing.kind === "link" ? landing.link : null;
    expect(link?.workspace).toBe("w1");
    const snapshot = {
      workspaces: [{ workspace_id: "w1", label: "app" }, { workspace_id: "w2", label: "other" }],
      panes: [{ pane_id: "w1:p1", workspace_id: "w1" }, { pane_id: "w2:p1", workspace_id: "w2" }],
      layouts: [],
    } as unknown as Parameters<typeof resolveLink>[0];
    expect(resolveLink(snapshot, link!)).toEqual({ pane: "w1:p1", workspace: "w1", note: "pane-closed" });
  });

  it("tells a second delivery of one tap from another place", () => {
    const link = { machine: "local", workspace: "w1", pane: "w1:p9", view: "chat" as const, settings: null };
    expect(sameLink(null, link)).toBe(false);
    expect(sameLink({ ...link }, link)).toBe(true);
    expect(sameLink({ ...link, pane: "w1:p8" }, link)).toBe(false);
    expect(sameLink({ ...link, machine: "pc2" }, link)).toBe(false);
    expect(sameLink({ ...link, view: null }, link)).toBe(false);
  });
});
