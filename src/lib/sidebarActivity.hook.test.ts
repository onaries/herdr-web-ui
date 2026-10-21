import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { Machine } from "../../shared/machines.ts";
import type { AgentStatus, HerdrPane } from "../../shared/protocol.ts";
import machinesFixture from "../../site/demo/fixtures/machines.json";
import { useSidebarActivityState, type SidebarActivity } from "./sidebarActivity.tsx";
import { cleanSeen, loadSeen, receiveSeen, saveSeen, seenKey, SEEN_LIMIT } from "./seenFinishes.ts";
import type { SeenFinish } from "../../shared/seen.ts";
import { conversationFinishEvidence } from "./panePresentation.ts";

const fixture: Machine[] = JSON.parse(JSON.stringify(machinesFixture.machines));
function roster(finishes: Record<string, number>, statuses: Record<string, AgentStatus> = {}, epoch: string | undefined = "server-a"): Machine[] {
  const machine = structuredClone(fixture[0]);
  if (!machine?.snapshot) throw new Error("fixture has no snapshot");
  const pane = machine.snapshot.panes[0], agent = machine.snapshot.agents[0];
  if (!pane || !agent) throw new Error("fixture has no agent pane");
  machine.snapshot.finish_epoch = epoch;
  machine.snapshot.panes = Object.entries(finishes).map(([id, finish_id]) => ({ ...pane, pane_id: id, agent_status: statuses[id] ?? "done", finish_id }));
  // Deliberately unchanged: native overrides finish without any herdr counter change.
  machine.snapshot.agents = Object.keys(finishes).map((id) => ({ ...agent, pane_id: id, agent_status: statuses[id] ?? "done", state_change_seq: 5 }));
  return [machine];
}

describe("sidebar finish acknowledgement through React effects", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderers: ReactTestRenderer[];
  let visibility: DocumentVisibilityState;
  let events: EventTarget;
  let storageEvents: EventTarget;
  let data: Map<string, string>;
  let storageAdds: number;
  let storageRemoves: number;

  beforeEach(() => {
    for (const key of ["document", "window", "localStorage", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    renderers = []; visibility = "visible"; events = new EventTarget(); storageEvents = new EventTarget(); data = new Map();
    storageAdds = 0; storageRemoves = 0;
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      get visibilityState() { return visibility; },
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
        if (type === "storage") storageAdds++;
        storageEvents.addEventListener(type, listener);
      },
      removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
        if (type === "storage") storageRemoves++;
        storageEvents.removeEventListener(type, listener);
      },
    } });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      get length() { return data.size; }, key: (index: number) => [...data.keys()][index] ?? null,
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value); },
      removeItem: (key: string) => { data.delete(key); },
    } });
  });
  afterEach(async () => {
    await act(async () => { for (const renderer of renderers) renderer.unmount(); });
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  async function storage(key: string | null, newValue: string | null, storageArea?: Storage): Promise<void> {
    await act(async () => {
      const event = new Event("storage");
      Object.defineProperties(event, { key: { value: key }, newValue: { value: newValue }, storageArea: { value: storageArea } });
      storageEvents.dispatchEvent(event);
    });
  }

  async function open(machines: Machine[], selected: string | null = null, covered = false, share?: (finish: SeenFinish) => Promise<void>) {
    let activity: SidebarActivity | undefined;
    let current = machines;
    let renders = 0;
    function Probe({ machines, selected, covered }: { machines: Machine[]; selected: string | null; covered: boolean }) {
      // Keep callback identity stable between the hook's own renders.
      renders++;
      activity = useSidebarActivityState(machines, "local", selected, inFronts[Number(covered)]!, share);
      return null;
    }
    let renderer: ReactTestRenderer | undefined;
    await act(async () => { renderer = create(createElement(Probe, { machines, selected, covered })); });
    if (!renderer) throw new Error("probe did not mount");
    const mounted = renderer; renderers.push(mounted);
    return {
      status(id: string, override?: Partial<HerdrPane>): AgentStatus | undefined {
        const pane = current[0]?.snapshot?.panes.find((pane) => pane.pane_id === id);
        if (!activity || !pane) throw new Error("probe has no pane");
        return activity.status("local", { ...pane, ...override });
      },
      statusAt(machineId: string, id: string, override?: Partial<HerdrPane>): AgentStatus | undefined {
        const pane = current.find((machine) => machine.id === machineId)?.snapshot?.panes.find((pane) => pane.pane_id === id);
        if (!activity || !pane) throw new Error("probe has no pane");
        return activity.status(machineId, { ...pane, ...override });
      },
      async update(next: Machine[], selected: string | null = null, covered = false): Promise<void> {
        current = next;
        await act(async () => { mounted.update(createElement(Probe, { machines: next, selected, covered })); });
      },
      async unmount(): Promise<void> {
        const index = renderers.indexOf(mounted);
        if (index < 0) return;
        await act(async () => { mounted.unmount(); });
        renderers.splice(index, 1);
      },
      get renders() { return renders; },
    };
  }
  const inFronts = [() => true, () => false];

  for (const state of ["connecting", "reconnecting", "disconnected"] as const) {
    it(`keeps cached read finishes ready while ${state}, without marking an unseen selected pane`, async () => {
      const client = await open(roster({ a: 1, b: 1 }), "a");
      const offline = roster({ a: 1, b: 1 });
      offline[0]!.state = state;
      await client.update(offline, "b");
      expect(client.status("a")).toBe("idle");
      expect(client.status("b")).toBe("done");
      expect(loadSeen("local", "server-a")).toEqual({ a: 1 });
      const reopened = await open(offline, "b");
      expect(reopened.status("a")).toBe("idle");
      expect(reopened.status("b")).toBe("done");
    });
  }

  it("uses the warm snapshot for multiple PCs and presentation-only updates", async () => {
    const local = roster({ a: 1, b: 1 })[0]!;
    const remoteA: Machine = { ...structuredClone(local), id: "remote-a" };
    const remoteB: Machine = { ...structuredClone(local), id: "remote-b" };
    for (const machine of [local, remoteA, remoteB]) {
      data.set(seenKey(machine.id, "server-a", "a"), JSON.stringify({ id: 1, at: 1 }));
      data.set(seenKey(machine.id, "server-a", "b"), JSON.stringify({ id: 1, at: 2 }));
    }
    const client = await open([local, remoteA, remoteB], "a");
    let keyCalls = 0, readCalls = 0;
    const storage = localStorage;
    const key = storage.key.bind(storage), getItem = storage.getItem.bind(storage);
    storage.key = (index) => { keyCalls++; return key(index); };
    storage.getItem = (name) => { readCalls++; return getItem(name); };

    const changed = roster({ a: 1, b: 1 }, { a: "working" })[0]!;
    await client.update([changed, remoteA, remoteB], "b");
    await client.update([roster({ a: 1, b: 1 })[0]!, remoteA, remoteB], "a");

    expect([keyCalls, readCalls]).toEqual([0, 0]);
    expect(client.status("a")).toBe("idle");
    expect(client.status("b")).toBe("idle");
  });

  it("keeps the seen map identity when a repeated acknowledgement changes no value", async () => {
    data.set(seenKey("local", "server-a", "a"), JSON.stringify({ id: 1, at: 1 }));
    const client = await open(roster({ a: 1 }), "a");
    const before = client.renders;
    await client.update(roster({ a: 1 }), "a");
    expect(client.renders - before).toBe(1);
    expect(client.status("a")).toBe("idle");
  });

  it("publishes same-page saves to mounted consumers and owns one storage listener lifetime", async () => {
    const first = await open(roster({ a: 1 }));
    const second = await open(roster({ a: 1 }));
    expect([storageAdds, storageRemoves]).toEqual([1, 0]);
    expect(second.status("a")).toBe("done");
    await act(async () => { saveSeen("local", "server-a", "a", 1); });
    expect(second.status("a")).toBe("idle");

    await first.unmount();
    expect(storageRemoves).toBe(0);
    await second.unmount();
    expect([storageAdds, storageRemoves]).toEqual([1, 1]);
  });

  it("keeps the global record cap without restoring evicted history on roster updates", async () => {
    for (let index = 0; index < 1900; index++) {
      data.set(seenKey("local", "server-a", `p${index}`), JSON.stringify({ id: 1, at: index }));
    }
    const client = await open(roster({ p0: 1 }));
    await act(async () => {
      for (let index = 1900; index < 2200; index++) saveSeen("remote", "server-b", `p${index}`, 1);
    });

    expect(data.size).toBe(SEEN_LIMIT);
    expect(data.has(seenKey("local", "server-a", "p0"))).toBe(false);
    expect(loadSeen("local", "server-a").p0).toBeUndefined();
    await client.update(roster({ p0: 1 }, { p0: "working" }));
    expect(data.size).toBe(SEEN_LIMIT);
    expect(data.has(seenKey("local", "server-a", "p0"))).toBe(false);
    expect(loadSeen("local", "server-a").p0).toBeUndefined();
  });

  it("publishes records after a later PC acknowledgement evicts an earlier PC", async () => {
    for (let index = 0; index < SEEN_LIMIT; index++) {
      data.set(seenKey("remote", "server-a", `p${index}`), JSON.stringify({ id: 1, at: index }));
    }
    const remote = { ...roster({ p0: 1 })[0]!, id: "remote" };
    const local = roster({ newest: 1 })[0]!;
    const client = await open([remote, local]);
    expect(client.statusAt("remote", "p0")).toBe("idle");

    await client.update([remote, local], "newest");
    expect(client.statusAt("remote", "p0")).toBe("done");
    expect(data.has(seenKey("remote", "server-a", "p0"))).toBe(false);
  });

  it("updates the mounted epoch when one same-page batch contains mixed epochs for a PC", async () => {
    const client = await open(roster({ a: 1 }));
    await act(async () => {
      receiveSeen([
        { pc: "local", epoch: "server-b", pane: "other", id: 1 },
        { pc: "local", epoch: "server-a", pane: "a", id: 1 },
      ]);
    });
    expect(client.status("a")).toBe("idle");
  });

  it("forgets deleted and cleared marks until their content is presented again", async () => {
    const client = await open(roster({ a: 1 }), "a");
    const key = seenKey("local", "server-a", "a");
    data.delete(key);
    await storage(key, null);
    expect(client.status("a")).toBe("done");
    expect(loadSeen("local", "server-a")).toEqual({});

    data.clear();
    await storage(null, null);
    expect(client.status("a")).toBe("done");
    expect(loadSeen("local", "server-a")).toEqual({});
    await client.unmount();
    const reopened = await open(roster({ a: 1 }));
    expect(reopened.status("a")).toBe("done");
    expect(loadSeen("local", "server-a")).toEqual({});
    await reopened.update(roster({ a: 1 }), "a");
    expect(reopened.status("a")).toBe("idle");
    expect(loadSeen("local", "server-a")).toEqual({ a: 1 });
  });

  it("keeps bounded session acknowledgements through storage access loss and rehydrates when restored", async () => {
    const client = await open(roster({ a: 1 }), "a");
    const available = localStorage;
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => { throw new Error("blocked"); } });
    try {
      await client.update(roster({ a: 2 }), "a");
      expect(client.status("a")).toBe("idle");
      expect(loadSeen("local", "server-a")).toEqual({ a: 2 });
    } finally {
      Object.defineProperty(globalThis, "localStorage", { configurable: true, value: available });
    }
    expect(loadSeen("local", "server-a")).toEqual({ a: 2 });
    expect(JSON.parse(data.get(seenKey("local", "server-a", "a"))!)).toMatchObject({ id: 2 });
  });

  it("keeps a newer persisted finish when an older clear event arrives", async () => {
    const client = await open(roster({ a: 1, b: 2 }), "a");
    data.clear();
    await act(async () => { saveSeen("local", "server-a", "b", 2); });
    await storage(null, null, localStorage);
    expect(client.status("a")).toBe("done");
    expect(client.status("b")).toBe("idle");
    expect(loadSeen("local", "server-a")).toEqual({ b: 2 });
  });

  it("ignores events from a different storage area", async () => {
    const client = await open(roster({ a: 1 }), "a");
    await storage(null, null, {} as Storage);
    expect(client.status("a")).toBe("idle");
    expect(loadSeen("local", "server-a")).toEqual({ a: 1 });
  });

  it("persists a session-only finish when the same storage methods recover", async () => {
    const storage = localStorage;
    const getItem = storage.getItem, setItem = storage.setItem;
    storage.getItem = () => { throw new Error("blocked"); };
    storage.setItem = () => { throw new Error("blocked"); };
    const client = await open(roster({ a: 1 }), "a");
    expect(client.status("a")).toBe("idle");
    expect(data.has(seenKey("local", "server-a", "a"))).toBe(false);

    storage.getItem = getItem;
    storage.setItem = setItem;
    await client.update(roster({ a: 1 }), "a");
    expect(data.get(seenKey("local", "server-a", "a"))).toMatch(/"id":1/);
  });

  it("tells the other browsers of a presented finish once, and again after a failed attempt", async () => {
    const told: SeenFinish[] = [];
    let reachable = false;
    const share = async (finish: SeenFinish) => { told.push(finish); if (!reachable) throw new Error("offline"); };
    const warn = console.warn;
    const warned: unknown[] = [];
    console.warn = (...args: unknown[]) => { warned.push(args[0]); };
    try {
      const client = await open(roster({ a: 1 }), "a", false, share);
      await act(async () => { await Promise.resolve(); });
      expect(warned).toEqual(["Could not tell the other browsers about a read finish"]);
      reachable = true;
      await client.update(roster({ a: 1 }), "a");
      await client.update(roster({ a: 1 }), "a");
      await client.update(roster({ a: 1, b: 1 }), "b");
      const a = { pc: "local", epoch: "server-a", pane: "a", id: 1 };
      expect(told).toEqual([a, a, { ...a, pane: "b" }]);
    } finally {
      console.warn = warn;
    }
  });

  it("does not send again a finish the server answered with an error", async () => {
    const told: SeenFinish[] = [];
    const share = async (finish: SeenFinish) => { told.push(finish); throw Object.assign(new Error("seen_unwritable"), { status: 500 }); };
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      const client = await open(roster({ a: 1 }), "a", false, share);
      await act(async () => { await Promise.resolve(); });
      await client.update(roster({ a: 1 }), "a");
      await client.update(roster({ a: 1 }), "a");
      expect(told).toHaveLength(1);
    } finally {
      console.warn = warn;
    }
  });

  it("upgrades a shared finish when its same-ID answer fingerprint becomes available", async () => {
    const told: SeenFinish[] = [];
    const share = async (finish: SeenFinish) => { told.push(finish); };
    const pane = "proof-upgrade";
    const client = await open(roster({ [pane]: 1 }), pane, false, share);
    expect(told).toEqual([{ pc: "local", epoch: "server-a", pane, id: 1 }]);

    const conversation = {
      source: "pi-transcript" as const,
      history_id: "session",
      turns: [{ role: "assistant" as const, ts: "2026-10-19T00:00:00Z", end_ts: "2026-10-19T00:00:01Z",
        parts: [{ kind: "text" as const, text: "Finished", phase: "final_answer" as const }] }],
    };
    expect(conversationFinishEvidence.accept(seenKey("local", "server-a", pane), 1, conversation)).toBe(true);
    await client.update(roster({ [pane]: 1 }), pane);
    expect(told).toHaveLength(2);
    expect(told[1]).toMatchObject({ pane, id: 1, answer: expect.any(String) });
  });

  it("does not let a late network rejection erase a newer share, and bounds share retention", async () => {
    const told: SeenFinish[] = [];
    let rejectFirst!: (error: Error) => void;
    let resolveLatest!: () => void;
    const share = (finish: SeenFinish) => {
      told.push(finish);
      return new Promise<void>((resolve, reject) => {
        if (finish.id === 1) rejectFirst = reject;
        else resolveLatest = resolve;
      });
    };
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      const client = await open(roster({ a: 1 }), "a", false, share);
      await client.update(roster({ a: 2 }), "a");
      rejectFirst(new Error("offline"));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      await client.update(roster({ a: 2 }), "a");
      expect(told.map(({ id }) => id)).toEqual([1, 2]);
      resolveLatest();
      await act(async () => { await Promise.resolve(); });
    } finally {
      console.warn = warn;
    }

    const bounded: SeenFinish[] = [];
    const client = await open(roster({ p0: 1 }), "p0", false, async (finish) => { bounded.push(finish); });
    for (let index = 1; index <= SEEN_LIMIT; index++) {
      const pane = `p${index}`;
      await client.update(roster({ [pane]: 1 }), pane);
    }
    await client.update(roster({ p0: 1 }), "p0");
    expect(bounded).toHaveLength(SEEN_LIMIT + 2);
    expect(bounded.at(-1)?.pane).toBe("p0");
  });

  it("keeps one latest share per pane through more turns than the history limit", async () => {
    const told: SeenFinish[] = [];
    const client = await open(roster({ kept: 1 }), "kept", false, async (finish) => { told.push(finish); });
    for (let id = 1; id <= SEEN_LIMIT + 1; id++) await client.update(roster({ active: id }), "active");
    await client.update(roster({ kept: 1 }), "kept");
    await client.update(roster({ active: 1 }), "active");
    expect(told.filter(({ pane }) => pane === "kept")).toHaveLength(1);
    expect(told.filter(({ pane }) => pane === "active")).toHaveLength(SEEN_LIMIT + 1);
    expect(loadSeen("local", "server-a").active).toBe(SEEN_LIMIT + 1);
  });

  it("draws a finish another browser of the server presented as ready, and never steps it back", async () => {
    const client = await open(roster({ a: 2, b: 1 }));
    expect([client.status("a"), client.status("b")]).toEqual(["done", "done"]);
    await act(async () => { receiveSeen([{ pc: "local", epoch: "server-a", pane: "a", id: 2, answer: "proof" }]); });
    expect([client.status("a"), client.status("b")]).toEqual(["idle", "done"]);
    await act(async () => { receiveSeen([{ pc: "local", epoch: "server-a", pane: "a", id: 1 }, { pc: "local", epoch: "server-b", pane: "b", id: 1 }]); });
    expect([client.status("a"), client.status("b")]).toEqual(["idle", "done"]);
    expect(JSON.parse(data.get(seenKey("local", "server-a", "a"))!)).toMatchObject({ id: 2, answer: "proof" });
  });

  it("does not scan unrelated storage on repeated or new acknowledgement", async () => {
    const client = await open(roster({ a: 1 }), "a");
    let unrelatedReads = 0;
    const read = localStorage.getItem;
    const key = seenKey("remote", "server-b", "other");
    data.set(key, JSON.stringify({ id: 4, at: 1 }));
    localStorage.getItem = (name) => { if (name === key) unrelatedReads++; return read(name); };
    await client.update(roster({ a: 1 }), "a");
    expect(unrelatedReads).toBe(0);
    await client.update(roster({ a: 2 }), "a");
    expect(unrelatedReads).toBe(0);
  });

  it("does not mark WORKING; a later native DONE with unchanged herdr seq keeps its dot", async () => {
    const client = await open(roster({ a: 1 }, { a: "working" }), "a");
    expect(loadSeen("local", "server-a")).toEqual({});
    await client.update(roster({ a: 2 }));
    expect(client.status("a")).toBe("done");
  });

  it("keeps a later unseen finish after opening an earlier finish", async () => {
    const client = await open(roster({ a: 1 }), "a");
    expect(client.status("a")).toBe("idle");
    await client.update(roster({ a: 1 }, { a: "working" }));
    await client.update(roster({ a: 2 }));
    expect(client.status("a")).toBe("done");
  });

  it("does not mark a finish under an overlay, but marks when uncovered", async () => {
    const client = await open(roster({ a: 0 }, { a: "working" }), "a", true);
    await client.update(roster({ a: 1 }), "a", true);
    expect(client.status("a")).toBe("done");
    expect(loadSeen("local", "server-a")).toEqual({});
    await client.update(roster({ a: 1 }), "a");
    expect(client.status("a")).toBe("idle");
  });

  it("does not acknowledge background work while the underlying status is DONE", async () => {
    const machines = roster({ a: 1 });
    machines[0]!.snapshot!.panes[0]!.background_wait = true;
    const client = await open(machines, "a");
    expect(client.status("a")).toBe("waiting");
    expect(loadSeen("local", "server-a")).toEqual({});
    await client.update(roster({ a: 1 }));
    expect(client.status("a")).toBe("done");
  });

  it("drops the prior epoch even if pane IDs and finish counters are identical", async () => {
    const client = await open(roster({ a: 1 }), "a");
    await client.update(roster({ a: 1 }, {}, "server-b"));
    expect(client.status("a")).toBe("done");
    expect(loadSeen("local", "server-a")).toEqual({});
  });

  it("never restores an old tab's mark into a new epoch", async () => {
    const stale = await open(roster({ a: 1, b: 1 }), "a");
    const fresh = await open(roster({ a: 1, b: 1 }));
    await fresh.update(roster({ a: 1, b: 1 }, {}, "server-b"), "b");
    await stale.update(roster({ a: 1, b: 1 }), "b");
    const reload = await open(roster({ a: 1, b: 1 }, {}, "server-b"));
    expect([reload.status("a"), reload.status("b")]).toEqual(["done", "idle"]);
  });

  it("keeps another tab's new-pane marks when this tab has an older roster", async () => {
    const stale = await open(roster({ a: 1 }));
    await open(roster({ a: 1, c: 3 }), "c");
    await stale.update(roster({ a: 1 }), "a");
    expect(loadSeen("local", "server-a")).toEqual({ a: 1, c: 3 });
  });

  it("does not mistake an older initial roster or lower herdr seq for a restart", async () => {
    saveSeen("local", "server-a", "a", 4);
    const stale = await open(roster({ a: 1 }));
    expect(loadSeen("local", "server-a")).toEqual({ a: 4 });
    await stale.update(roster({ a: 4 }));
    expect(stale.status("a")).toBe("idle");
  });

  it("does not let an older initial epoch delete a newer tab's marks", async () => {
    saveSeen("local", "server-b", "b", 2);
    await open(roster({ a: 1 }, {}, "server-a"), "a");
    expect(loadSeen("local", "server-b")).toEqual({ b: 2 });
  });

  it("persists independent pane writes even with both reads before either write", () => {
    // This is the read/read/write/write schedule that lost a mark in the old whole-record store.
    const first = loadSeen("local", "server-a"), second = loadSeen("local", "server-a");
    expect([first, second]).toEqual([{}, {}]);
    saveSeen("local", "server-a", "a", 1);
    saveSeen("local", "server-a", "b", 2);
    expect(loadSeen("local", "server-a")).toEqual({ a: 1, b: 2 });
  });

  it("updates another mounted tab on storage events and repairs a lower same-pane race", async () => {
    const client = await open(roster({ a: 4 }));
    const key = seenKey("local", "server-a", "a");
    // Both contexts already prepared values; the older write lands last.
    data.set(key, JSON.stringify({ id: 4, at: 1 }));
    data.set(key, JSON.stringify({ id: 2, at: 2 }));
    await storage(key, JSON.stringify({ id: 4, at: 1 }));
    expect(loadSeen("local", "server-a")).toEqual({ a: 4 });
    expect(client.status("a")).toBe("idle");
  });

  it("marks only a visible page and a connected, actually rendered pane", async () => {
    visibility = "hidden";
    const client = await open(roster({ a: 1 }), "a");
    expect(client.status("a")).toBe("done");
    await act(async () => { visibility = "visible"; events.dispatchEvent(new Event("visibilitychange")); });
    expect(client.status("a")).toBe("idle");
    const absent = await open(roster({ b: 1 }), "not-rendered");
    expect(absent.status("b")).toBe("done");
    await absent.update(roster({ b: 1 }).map((m) => ({ ...m, state: "disconnected" })), "b");
    expect(absent.status("b")).toBe("done");
  });

  it("does not resurrect a deleted key when a previously queued write event arrives", async () => {
    const client = await open(roster({ a: 1 }), "a");
    await client.update(roster({ a: 1 }));
    const key = seenKey("local", "server-a", "a");
    data.delete(key);
    await storage(key, JSON.stringify({ id: 1, at: 1 }));
    expect(data.has(key)).toBe(false);
    expect(client.status("a")).toBe("done");
    expect(loadSeen("local", "server-a")).toEqual({});
  });

  it("leaves older bridges without an epoch or finish ID always unread", async () => {
    const machines = roster({ a: 1 });
    delete machines[0]!.snapshot!.finish_epoch;
    const noEpoch = await open(machines, "a");
    expect(noEpoch.status("a")).toBe("done");
    const noId = roster({ a: 1 });
    delete noId[0]!.snapshot!.panes[0]!.finish_id;
    const client = await open(noId, "a");
    expect(client.status("a")).toBe("done");
  });

  it("removes old-format records and caps keys oldest first, never by a roster", () => {
    data.set("herdr-web-ui:seen:local", '{"a":5}');
    data.set("herdr-web-ui:settings", "{}");
    for (let i = 0; i <= SEEN_LIMIT; i++) data.set(seenKey("local", "server-a", `p${i}`), JSON.stringify({ id: 1, at: i }));
    cleanSeen();
    expect(data.has("herdr-web-ui:seen:local")).toBe(false);
    expect(data.has(seenKey("local", "server-a", "p0"))).toBe(false);
    expect(data.has(seenKey("local", "server-a", `p${SEEN_LIMIT}`))).toBe(true);
    expect(data.get("herdr-web-ui:settings")).toBe("{}");
  });
});
