import { describe, expect, it } from "bun:test";

import type { PaneInfo } from "../../shared/protocol.ts";
import { activityOrder, liveSeqs, newSeqMemory, shownStatus, stateSeqs } from "./sidebarOrder.ts";
import { DEFAULT_SETTINGS, sanitizeSettings } from "./settings.ts";

const pane = (id: string, agent_status: string, workspace_id = `w-${id}`) => ({ pane_id: id, workspace_id, agent_status }) as PaneInfo;
const ids = (list: PaneInfo[]) => list.map((entry) => entry.pane_id);

describe("state_change_seq", () => {
  it("is read from the snapshot's agents, the only place session.snapshot carries it", () => {
    const seqs = stateSeqs({ agents: [{ pane_id: "a", state_change_seq: 7 }, { pane_id: "b" }, { pane_id: "c", state_change_seq: "9" }] } as never);
    expect([...seqs]).toEqual([["a", 7]]);
    expect(stateSeqs(null).size).toBe(0);
  });
});

describe("live counters", () => {
  const snap = (statuses: Record<string, string>, seqs: Record<string, number>) => ({
    panes: Object.entries(statuses).map(([id, status]) => pane(id, status)),
    agents: Object.entries(seqs).map(([pane_id, state_change_seq]) => ({ pane_id, state_change_seq })),
  }) as never;

  it("dates a pushed status change above every known counter until herdr's own counter comes", () => {
    const memory = newSeqMemory();
    expect([...liveSeqs(snap({ a: "idle", b: "done" }, { a: 5, b: 9 }), memory)]).toEqual([["a", 5], ["b", 9]]);
    // a is sent a message: the push changes its status, the counter is still 5
    const pushed = liveSeqs(snap({ a: "working", b: "done" }, { a: 5, b: 9 }), memory);
    expect(pushed.get("a")!).toBeGreaterThan(9);
    // it finishes before the roster is read again: dated later still, so it is a new change
    const finished = liveSeqs(snap({ a: "done", b: "done" }, { a: 5, b: 9 }), memory);
    expect(finished.get("a")!).toBeGreaterThan(pushed.get("a")!);
    // herdr's counter arrives and replaces the stand-in
    expect(liveSeqs(snap({ a: "done", b: "done" }, { a: 11, b: 9 }), memory).get("a")).toBe(11);
    expect(memory.bumped.size).toBe(0);
  });

  it("keeps herdr's counters for changes a roster read brings with their counters", () => {
    const memory = newSeqMemory();
    liveSeqs(snap({ a: "working", b: "working" }, { a: 5, b: 6 }), memory);
    // both finish between two roster reads, a after b: herdr's counters say so, and stand
    const read = liveSeqs(snap({ a: "done", b: "done" }, { a: 21, b: 20 }), memory);
    expect([...read]).toEqual([["a", 21], ["b", 20]]);
    expect(ids(activityOrder([pane("b", "done"), pane("a", "done")], (row) => row, read))).toEqual(["a", "b"]);
    expect(memory.bumped.size).toBe(0);
  });

  it("drops its stand-ins when herdr's counters go back (herdr restarted)", () => {
    const memory = newSeqMemory();
    liveSeqs(snap({ a: "idle", b: "done" }, { a: 50, b: 49 }), memory);
    liveSeqs(snap({ a: "working", b: "done" }, { a: 50, b: 49 }), memory);
    expect(memory.bumped.size).toBe(1);
    const restarted = liveSeqs(snap({ a: "working", b: "done" }, { a: 2, b: 1 }), memory);
    expect([...restarted]).toEqual([["a", 2], ["b", 1]]);
    expect(memory.bumped.size).toBe(0);
  });

  it("does not date a pane's first sighting, or a pane with no counter", () => {
    const memory = newSeqMemory();
    liveSeqs(snap({ a: "idle", shell: "unknown" }, { a: 5 }), memory);
    const next = liveSeqs(snap({ a: "idle", shell: "working", c: "done" }, { a: 5, c: 7 }), memory);
    expect([...next]).toEqual([["a", 5], ["c", 7]]);
  });
});

describe("activity order", () => {
  const agents = [pane("idle", "idle"), pane("working", "working"), pane("blocked", "blocked"), pane("done-old", "done"), pane("done-new", "done"), pane("nocount", "idle")];
  const seqs = new Map([["idle", 50], ["working", 10], ["blocked", 1], ["done-old", 20], ["done-new", 30]]);
  const order = (rows: PaneInfo[], counters = seqs) => ids(activityOrder(rows, (row) => row, counters));

  it("puts blocked first, then the latest change first whatever the state", () => {
    expect(order(agents)).toEqual(["blocked", "idle", "done-new", "done-old", "working", "nocount"]);
  });

  it("keeps the agent just worked in on top while it runs and after it finishes", () => {
    // a message sent from "done-old": it starts working, so its counter is the newest
    const sent = agents.map((entry) => entry.pane_id === "done-old" ? pane("done-old", "working") : entry);
    const running = new Map([...seqs, ["done-old", 60]]);
    expect(order(sent, running).slice(0, 2)).toEqual(["blocked", "done-old"]);
    expect(order(agents, new Map([...running, ["done-old", 61]])).slice(0, 2)).toEqual(["blocked", "done-old"]);
  });

  it("puts a new agent on top, and keeps the given order between equals", () => {
    const fresh = [...agents, pane("new", "idle"), pane("tie", "idle")];
    expect(order(fresh, new Map([...seqs, ["new", 99]])).slice(0, 2)).toEqual(["blocked", "new"]);
    // without a counter, rows keep the order given, at the end
    expect(order(fresh).slice(-3)).toEqual(["nocount", "new", "tie"]);
  });
});

describe("shown status", () => {
  it("shows BG while a pane holds its turn for background work, herdr's own status otherwise", () => {
    const held = { ...pane("a", "done"), background_wait: true as const };
    expect(shownStatus(held)).toBe("waiting");
    expect(shownStatus({ ...held, agent_status: "blocked" })).toBe("blocked");
    expect(shownStatus(pane("a", "done"))).toBe("done");
  });
});

it("defaults to herdr's order, and accepts only known values", () => {
  expect(DEFAULT_SETTINGS.agentOrder).toBe("workspace");
  expect(sanitizeSettings({ agentOrder: "activity" })).toMatchObject({ agentOrder: "activity" });
  expect(sanitizeSettings({ agentOrder: "recent" })).toMatchObject({ agentOrder: "workspace" });
});
