import { describe, expect, it } from "bun:test";
import type { PendingMessage, ServerMessage } from "../../shared/protocol.ts";
import { paneStorageId } from "../../shared/machines.ts";
import { greetingMemory } from "./greeting.ts";
import { MachineSession, MachineSessionRegistry } from "./machineSession.ts";
import { PendingMessageStore } from "./pendingMessages.ts";
import type { HerdrSocket } from "./ws.ts";

class FakeSocket {
  connected = false;
  connects = 0;
  closes = 0;
  private readonly handlers = new Set<(message: ServerMessage) => void>();
  private readonly disconnects = new Set<() => void>();
  on(handler: (message: ServerMessage) => void): () => void {
    this.handlers.add(handler); return () => { this.handlers.delete(handler); };
  }
  onDisconnect(handler: () => void): () => void {
    this.disconnects.add(handler); return () => { this.disconnects.delete(handler); };
  }
  connect(): void { this.connects++; this.connected = true; }
  close(): void { this.closes++; this.connected = false; this.handlers.clear(); this.disconnects.clear(); }
  receive(message: ServerMessage): void { for (const handler of this.handlers) handler(message); }
  disconnect(): void { this.connected = false; for (const handler of this.disconnects) handler(); }
}

const snapshot: ServerMessage = { type: "snapshot", features: ["submit", "pending-input"], snapshot: { version: "test", protocol: 22, workspaces: [], tabs: [], panes: [], agents: [], layouts: [] } };
const message = (id: string, state: PendingMessage["state"] = "queued"): PendingMessage => ({ id, request_id: 1, text: "review this next", state, created_at: "2026-10-11T00:00:00Z" });
function setup(machineId = "local", sharedStore?: PendingMessageStore) {
  const data = new Map<string, string>();
  const store = sharedStore ?? new PendingMessageStore(() => ({ getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: (key) => { data.delete(key); } }));
  const socket = new FakeSocket();
  const session = new MachineSession(machineId, { socket: socket as unknown as HerdrSocket, pendingStore: store });
  return { session, socket, store };
}
function start(session: MachineSession, socket: FakeSocket): void { session.connect(); socket.receive(snapshot); }

describe("PC connection ownership", () => {
  it("creates no network connection until explicitly connected and replays only the current role", () => {
    const { session, socket } = setup();
    expect(socket.connects).toBe(0);
    start(session, socket);
    socket.receive({ type: "role-ack", mode: "observe" });
    socket.receive({ type: "pty-data", pane_id: "w1:p1", data: "private output" });
    const events: ServerMessage[] = [];
    const off = session.on((frame) => events.push(frame));
    expect(events).toEqual([{ type: "role-ack", mode: "observe" }]);
    off();
    socket.disconnect();
    session.on((frame) => events.push(frame));
    expect(events).toHaveLength(1);
    session.close();
  });

  it("keeps the same scope while views unsubscribe and accepts a held receipt with no mounted pane", () => {
    const { session, socket, store } = setup();
    start(session, socket);
    const scope = session.scope;
    const owner = paneStorageId("local", "w1:p1");
    const off = session.on(() => {});
    socket.receive({ type: "pending-messages", pane_id: "w1:p1", messages: [message("p1")] });
    off();
    // Detach's reply can arrive after the component and its xterm have gone away.
    socket.receive({ type: "pending-messages", pane_id: "w1:p1", messages: [message("p1", "held")] });
    expect(session.scope).toBe(scope);
    expect(socket.closes).toBe(0);
    expect(store.read(owner)).toMatchObject([{ id: "p1", state: "held", serverOwned: true }]);
    expect(store.isOwned(owner, "p1", session.scope)).toBe(true);
    session.close();
  });

  it("keeps newer stream state when a queued submit promise is handled later", async () => {
    for (const state of ["held", "sending", "uncertain"] as const) {
      const { session, socket, store } = setup();
      start(session, socket);
      const owner = paneStorageId("local", "w1:p1"), epoch = session.epoch;
      const accepted = message("p1");
      socket.receive({ type: "pending-messages", pane_id: "w1:p1", messages: [accepted] });
      const settled = Promise.resolve().then(() => session.acceptPending("w1:p1", accepted, epoch));
      const current = { ...message("p1", state), error: { code: "newer_state", message: "Review the current pane state" } };
      socket.receive({ type: "pending-messages", pane_id: "w1:p1", messages: [current] });
      await settled;
      expect(store.read(owner)).toEqual([{ ...current, serverOwned: true }]);
      expect(store.isOwned(owner, "p1", session.scope)).toBe(true);
      session.close();
    }
  });

  it("publishes a matching removal and remembers sent chat before notifying a view", () => {
    const { session, socket, store } = setup("receipt-test-pc");
    start(session, socket);
    const owner = paneStorageId("receipt-test-pc", "w1:p1");
    socket.receive({ type: "pending-messages", pane_id: "w1:p1", messages: [message("p1")] });
    let sentCount = 0;
    session.on((frame, sent) => {
      if (frame.type !== "pending-messages" || !sent) return;
      sentCount++;
      expect(store.read(owner)).toEqual([]);
      expect(greetingMemory(owner).sent).toBe(true);
    });
    const removal: ServerMessage = { type: "pending-messages", pane_id: "w1:p1", messages: [], removed: [{ id: "p1", outcome: "sent" }] };
    socket.receive(removal);
    socket.receive(removal);
    expect(sentCount).toBe(1);
    // A delayed acceptance receipt cannot recreate an already delivered item.
    session.acceptPending("w1:p1", message("p1"), session.epoch);
    expect(store.read(owner)).toEqual([]);
    session.close();
  });

  it("accepts an unmounted pane's submit receipt on its captured live connection", () => {
    const { session, socket, store } = setup();
    start(session, socket);
    const epoch = session.epoch;
    const off = session.on(() => {});
    off();
    session.acceptPending("w1:p1", message("p1"), epoch);
    const owner = paneStorageId("local", "w1:p1");
    expect(store.isOwned(owner, "p1", session.scope)).toBe(true);
    expect(store.read(owner)[0]?.state).toBe("queued");
    session.close();
  });

  it("suspends ownership on a real disconnect before view callbacks and never revives it on reconnect", () => {
    const { session, socket, store } = setup();
    start(session, socket);
    const epoch = session.epoch, oldScope = session.scope;
    const owner = paneStorageId("local", "w1:p1");
    session.acceptPending("w1:p1", message("queued"), epoch);
    session.acceptPending("w1:p1", message("held", "held"), epoch);
    session.onDisconnect(() => {
      expect(session.scope).toBeNull();
      expect(session.epoch).toBe(epoch + 1);
      expect(store.read(owner).map(({ state, serverOwned }) => [state, serverOwned])).toEqual([["uncertain", false], ["held", false]]);
    });
    socket.disconnect();
    start(session, socket);
    expect(session.scope).not.toBe(oldScope);
    socket.receive({ type: "pending-messages", pane_id: "w1:p1", messages: [] });
    session.acceptPending("w1:p1", message("queued"), epoch);
    expect(store.read(owner).map(({ state, serverOwned }) => [state, serverOwned])).toEqual([["uncertain", false], ["held", false]]);
    session.close();
  });

  it("isolates identical pane and pending IDs across PCs and closes only the selected registry entry", () => {
    const sessions = new Map<string, ReturnType<typeof setup>>();
    const sharedStore = setup("store-only").store;
    const registry = new MachineSessionRegistry((machineId) => {
      const item = setup(machineId, sharedStore); sessions.set(machineId, item); return item.session;
    });
    const local = registry.get("local"), remote = registry.get("remote");
    expect(registry.get("local")).toBe(local);
    start(local, sessions.get("local")!.socket);
    start(remote, sessions.get("remote")!.socket);
    local.acceptPending("w1:p1", message("same"), local.epoch);
    remote.acceptPending("w1:p1", message("same"), remote.epoch);
    expect(local.scope).not.toBe(remote.scope);
    expect(sharedStore.isOwned(paneStorageId("local", "w1:p1"), "same", local.scope)).toBe(true);
    expect(sharedStore.isOwned(paneStorageId("remote", "w1:p1"), "same", remote.scope)).toBe(true);
    registry.retainMachines(new Set(["remote"]));
    expect(sessions.get("local")!.socket.closes).toBe(1);
    expect(sessions.get("remote")!.socket.closes).toBe(0);
    expect(sessions.get("remote")!.store.isOwned(paneStorageId("remote", "w1:p1"), "same", remote.scope)).toBe(true);
    registry.closeAll();
  });

  it("closeAll clears ownership and is reusable after an effect restart", () => {
    const made: ReturnType<typeof setup>[] = [];
    const registry = new MachineSessionRegistry((machineId) => {
      const item = setup(machineId); made.push(item); return item.session;
    });
    const old = registry.get("local");
    start(old, made[0]!.socket);
    old.acceptPending("w1:p1", message("p1"), old.epoch);
    registry.closeAll();
    registry.closeAll();
    expect(made[0]!.socket.closes).toBe(1);
    expect(made[0]!.store.read("w1:p1")).toMatchObject([{ state: "uncertain", serverOwned: false }]);
    const next = registry.get("local");
    expect(next).not.toBe(old);
    expect(made[1]!.socket.connects).toBe(0);
    start(next, made[1]!.socket);
    expect(next.scope).not.toBeNull();
    registry.closeAll();
  });
});
