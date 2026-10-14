import { afterAll, beforeAll, expect, it } from "bun:test";
import { HerdrSocket } from "./ws.ts";
import type { PendingMessage } from "../../shared/protocol.ts";
import { OUTPUT_STALLED_CLOSE_CODE } from "../../shared/terminal-flow.ts";

/** A WebSocket the test drives: it opens, receives and records what the client sends. */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static last: FakeSocket;
  readyState = FakeSocket.CONNECTING;
  readonly sent: { type: string; [key: string]: unknown }[] = [];
  private readonly listeners = new Map<string, ((event: any) => void)[]>();
  constructor(readonly url: string) { FakeSocket.last = this; }
  addEventListener(type: string, listener: (event: any) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  send(data: string): void { const frame = JSON.parse(data); this.sent.push(frame); this.emit("sent", frame); }
  nextSubmission(type = "submit"): Promise<{ id: number }> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("no submit frame")), 1_000);
      this.addEventListener("sent", (frame) => {
        if (frame.type === type) { clearTimeout(timeout); resolve(frame); }
      });
    });
  }
  close(): void { this.readyState = 3; }
  disconnect(): void { this.readyState = 3; this.emit("close", { code: 1006 }); }
  private emit(type: string, event: unknown): void { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  open(): void { this.readyState = FakeSocket.OPEN; this.emit("open", {}); }
  receive(message: unknown): void { this.emit("message", { data: JSON.stringify(message) }); }
}

const globals = globalThis as unknown as { WebSocket?: unknown; window?: unknown };
const before = { WebSocket: globals.WebSocket, window: globals.window };
beforeAll(() => { globals.WebSocket = FakeSocket; globals.window = globalThis; });
afterAll(() => { globals.WebSocket = before.WebSocket; globals.window = before.window; });

const snapshot = (features: string[]) => ({ type: "snapshot", snapshot: { workspaces: [], panes: [], agents: [], layouts: [] }, features });
const secrets = (socket: FakeSocket) => socket.sent.filter((frame) => frame.type === "secret");
const submissions = (socket: FakeSocket) => socket.sent.filter((frame) => ["submit", "input", "keys"].includes(frame.type));

it("requires the distinct pending native queue feature before sending any action", async () => {
  for (const features of [[], ["submit", "agent-queue"], ["submit", "pending-input", "agent-queue"], ["pending-agent-queue"]]) {
    const client = new HerdrSocket("ws://test/ws");
    client.connect();
    const socket = FakeSocket.last;
    socket.open(); socket.receive(snapshot(features));
    try {
      expect(client.canQueuePendingMessages()).toBe(false);
      expect(await client.pendingAction("w1:p1", "held-id", "agent-queue")).toMatchObject({ ok: false, code: "agent_queue_unsupported" });
      expect(socket.sent.filter((frame) => ["pending-action", "submit", "input", "keys"].includes(frame.type))).toEqual([]);
    } finally { client.close(); }
  }
});

it("transfers a pending ID once and matches only its own pending receipt", async () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  const sent = socket.nextSubmission("pending-action");
  const result = client.pendingAction("w1:p1", "held-id", "agent-queue");
  socket.receive(snapshot(["submit", "pending-input", "pending-agent-queue"]));
  try {
    expect(client.canQueuePendingMessages()).toBe(true);
    const frame = await sent;
    expect(frame).toMatchObject({ type: "pending-action", pane_id: "w1:p1", pending_id: "held-id", action: "agent-queue" });
    let resolved = false;
    void result?.then(() => { resolved = true; });
    socket.receive({ type: "pending-result", id: frame.id, pane_id: "w1:p1", pending_id: "other-id", ok: true });
    socket.receive({ type: "submit-result", id: frame.id, pane_id: "w1:p1", ok: true });
    await Promise.resolve();
    expect(resolved).toBe(false);
    socket.receive({ type: "pending-result", id: frame.id, pane_id: "w1:p1", pending_id: "held-id", ok: true });
    expect(await result).toEqual({ ok: true });
    expect(submissions(socket)).toEqual([]);
    socket.disconnect();
    client.connect();
    FakeSocket.last.open();
    FakeSocket.last.receive(snapshot(["submit", "pending-input", "pending-agent-queue"]));
    expect(FakeSocket.last.sent.filter((item) => item.type === "pending-action")).toEqual([]);
  } finally { client.close(); }
});

it("refuses native queue delivery on unsupported peers without fallback Enter", async () => {
  for (const features of [[], ["submit"], ["agent-queue"], ["submit", "pending-input"]]) {
    const client = new HerdrSocket("ws://test/ws");
    client.connect();
    const socket = FakeSocket.last;
    socket.open();
    socket.receive(snapshot(features));
    try {
      expect(await client.submit("w1:p1", "follow-up", "follow-up", false, "agent-queue"))
        .toMatchObject({ ok: false, code: "agent_queue_unsupported" });
      expect(submissions(socket)).toEqual([]);
    } finally { client.close(); }
  }
});

it("sends native queue once after capability discovery and matches its key-delivery receipt", async () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  const sent = socket.nextSubmission();
  const result = client.submit("w1:p1", "follow-up", "follow-up", false, "agent-queue");
  expect(submissions(socket)).toEqual([]);
  socket.receive(snapshot(["submit", "agent-queue"]));
  try {
    const frame = await sent;
    expect(frame).toMatchObject({ type: "submit", pane_id: "w1:p1", delivery: "agent-queue" });
    let resolved = false;
    void result?.then(() => { resolved = true; });
    socket.receive({ type: "submit-result", id: frame.id, pane_id: "w1:p2", ok: true });
    socket.receive({ type: "pending-messages", pane_id: "w1:p1", messages: [{ id: "bridge-only", request_id: frame.id, text: "follow-up", state: "queued", created_at: "2026-10-14T00:00:00Z" }] });
    await Promise.resolve();
    expect(resolved).toBe(false);
    socket.receive({ type: "submit-result", id: frame.id, pane_id: "w1:p1", ok: true });
    expect(await result).toEqual({ ok: true });
    socket.receive(snapshot(["submit", "agent-queue"]));
    expect(submissions(socket)).toHaveLength(1);
  } finally { client.close(); }
});

it("never replays an unacknowledged native queue submission after disconnect", async () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  socket.receive(snapshot(["submit", "agent-queue"]));
  const sent = socket.nextSubmission();
  const result = client.submit("w1:p1", "follow-up", "follow-up", false, "agent-queue");
  await sent;
  socket.disconnect();
  expect(await result).toMatchObject({ ok: false, code: "disconnected" });
  client.connect();
  const next = FakeSocket.last;
  next.open();
  next.receive(snapshot(["submit", "agent-queue"]));
  expect(submissions(next)).toEqual([]);
  client.close();
});

it("refuses clear-and-send on a legacy bridge without sending payload or Enter", async () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  socket.receive(snapshot([]));
  try {
    expect(await client.submit("w1:p1", "chat message", "chat message", false, "immediate", "named draft"))
      .toMatchObject({ ok: false, code: "unsupported" });
    expect(submissions(socket)).toEqual([]);
  } finally {
    client.close();
  }
});

it("keeps ordinary immediate sends working on a legacy bridge", async () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  socket.receive(snapshot([]));
  try {
    expect(await client.submit("w1:p1", "chat message", "chat message")).toEqual({ ok: true });
    expect(submissions(socket)).toEqual([{ type: "input", pane_id: "w1:p1", text: "chat message\r" }]);
  } finally {
    client.close();
  }
});

it("delivers partial clear outcomes unchanged and never retries the submission", async () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  socket.receive(snapshot(["submit"]));
  try {
    const sent = socket.nextSubmission();
    const result = client.submit("w1:p1", "keep composer text", "keep composer text", false, "immediate", "named draft");
    const frame = await sent;
    const fault = { ok: false, code: "submit_partial", message: "partial-outcome-fixture" };
    socket.receive({ type: "submit-result", id: frame.id, pane_id: "w1:p1", ...fault });
    expect(await result).toEqual(fault);
    expect(submissions(socket)).toHaveLength(1);
  } finally {
    client.close();
  }
});

it("waits for the bridge's pending-input capability before sending an explicit next turn", async () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  expect(client.canQueueMessages()).toBe(false);
  const result = client.submit("w1:p1", "next turn", "\x1b[200~next turn\x1b[201~", false, "queue");
  await Promise.resolve();
  expect(submissions(socket)).toEqual([]);
  socket.receive(snapshot(["submit", "pending-input"]));
  expect(client.canQueueMessages()).toBe(true);
  for (let turn = 0; turn < 10 && submissions(socket).length === 0; turn++) await Promise.resolve();
  expect(submissions(socket)).toEqual([{ type: "submit", id: 1, pane_id: "w1:p1", text: "next turn", payload: "\x1b[200~next turn\x1b[201~", delivery: "queue" }]);
  const pending: PendingMessage = { id: "pending-1", request_id: 1, text: "next turn", state: "queued", created_at: "2026-10-06T00:00:00Z" };
  socket.receive({ type: "submit-result", id: 1, pane_id: "w1:p1", ok: true, pending });
  expect(await result).toEqual({ ok: true, pending });
  client.close();
});

it("refuses queued delivery on older bridges without writing its text or a fallback key", async () => {
  for (const features of [[], ["submit"], ["pending-input"]]) {
    const client = new HerdrSocket("ws://test/ws");
    client.connect();
    const socket = FakeSocket.last;
    socket.open();
    socket.receive(snapshot(features));
    expect(client.canQueueMessages()).toBe(false);
    expect(await client.submit("w1:p1", "keep this draft", "keep this draft", false, "queue")).toMatchObject({ ok: false, code: "pending_input_unsupported" });
    expect(submissions(socket)).toEqual([]);
    client.close();
  }
});

it("holds a message for Send now on bridges that list pending-hold, and queues it on older ones", async () => {
  for (const [features, delivery] of [[["submit", "pending-input"], "queue"], [["submit", "pending-input", "pending-hold"], "hold"]] as const) {
    const client = new HerdrSocket("ws://test/ws");
    client.connect();
    const socket = FakeSocket.last;
    socket.open();
    socket.receive(snapshot([...features]));
    expect(client.canHoldMessages()).toBe(delivery === "hold");
    const result = client.submit("w1:p1", "later", "later", false, "hold");
    for (let turn = 0; turn < 10 && submissions(socket).length === 0; turn++) await Promise.resolve();
    expect(submissions(socket)).toEqual([{ type: "submit", id: 1, pane_id: "w1:p1", text: "later", payload: "later", delivery }]);
    const pending: PendingMessage = { id: "pending-1", request_id: 1, text: "later", state: delivery === "hold" ? "held" : "queued", created_at: "2026-10-06T00:00:00Z" };
    socket.receive({ type: "submit-result", id: 1, pane_id: "w1:p1", ok: true, pending });
    expect(await result).toEqual({ ok: true, pending });
    client.close();
  }
});

it("decides a hold once the snapshot arrives, so a Send before it still holds", async () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  const result = client.submit("w1:p1", "later", "later", false, "hold");
  await Promise.resolve();
  expect(submissions(socket)).toEqual([]);
  socket.receive(snapshot(["submit", "pending-input", "pending-hold"]));
  for (let turn = 0; turn < 10 && submissions(socket).length === 0; turn++) await Promise.resolve();
  expect(submissions(socket)).toEqual([{ type: "submit", id: 1, pane_id: "w1:p1", text: "later", payload: "later", delivery: "hold" }]);
  socket.receive({ type: "submit-result", id: 1, pane_id: "w1:p1", ok: false, code: "agent_not_ready", message: "fixture" });
  await result;
  client.close();
});

it("accepts an owner-only pending item as the submit receipt when its separate ACK was lost", async () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  socket.receive(snapshot(["submit", "pending-input"]));
  const result = client.submit("w1:p1", "one accepted message", "one accepted message", false, "queue");
  for (let turn = 0; turn < 10 && submissions(socket).length === 0; turn++) await Promise.resolve();
  const pending: PendingMessage = { id: "pending-1", request_id: 1, text: "one accepted message", state: "queued", created_at: "2026-10-06T00:00:00Z" };
  socket.receive({ type: "pending-messages", pane_id: "w1:p1", messages: [pending] });
  expect(await result).toEqual({ ok: true, pending });
  socket.receive({ type: "submit-result", id: 1, pane_id: "w1:p1", ok: true, pending });
  expect(submissions(socket)).toHaveLength(1);
  client.close();
});

it("matches live queue receipts only to queued submits for the same captured pane", async () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  socket.receive(snapshot(["submit", "pending-input"]));
  const queued = client.submit("w1:p1", "queued", "queued", false, "queue");
  const immediate = client.submit("w1:p1", "immediate", "immediate");
  const action = client.pendingAction("w1:p1", "pending-other", "steer");
  const settled: string[] = [];
  void queued?.then(() => settled.push("queued"));
  void immediate?.then(() => settled.push("immediate"));
  void action?.then(() => settled.push("action"));
  for (let turn = 0; turn < 10 && socket.sent.filter((frame) => frame.type === "pending-action").length === 0; turn++) await Promise.resolve();
  const pending: PendingMessage = { id: "pending-1", request_id: 1, text: "queued", state: "queued", created_at: "2026-10-06T00:00:00Z" };
  socket.receive({ type: "pending-messages", pane_id: "w1:p2", messages: [pending] });
  socket.receive({ type: "pending-messages", pane_id: "w1:p1", messages: [{ ...pending, request_id: 2 }, { ...pending, request_id: 3 }] });
  await Promise.resolve();
  expect(settled).toEqual([]);
  socket.receive({ type: "pending-messages", pane_id: "w1:p1", messages: [pending] });
  expect(await queued).toEqual({ ok: true, pending });
  expect(settled).toEqual(["queued"]);
  socket.receive({ type: "submit-result", id: 2, pane_id: "w1:p1", ok: true });
  socket.receive({ type: "pending-result", id: 3, pane_id: "w1:p1", pending_id: "pending-other", ok: true });
  expect(await immediate).toEqual({ ok: true });
  expect(await action).toEqual({ ok: true });
  client.close();
});

it("ignores a receipt from an old socket even when its request ID matches a new connection's queued submit", async () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const old = FakeSocket.last;
  old.open();
  old.receive(snapshot(["submit", "pending-input"]));
  old.disconnect();
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  socket.receive(snapshot(["submit", "pending-input"]));
  let settled = false;
  const result = client.submit("w1:p1", "new connection", "new connection", false, "queue");
  void result?.then(() => { settled = true; });
  for (let turn = 0; turn < 10 && submissions(socket).length === 0; turn++) await Promise.resolve();
  const pending: PendingMessage = { id: "new-pending", request_id: 1, text: "new connection", state: "queued", created_at: "2026-10-06T00:00:00Z" };
  old.receive({ type: "pending-messages", pane_id: "w1:p1", messages: [pending] });
  await Promise.resolve();
  expect(settled).toBe(false);
  socket.receive({ type: "pending-messages", pane_id: "w1:p1", messages: [pending] });
  expect(await result).toEqual({ ok: true, pending });
  client.close();
});

it("steers or discards an opaque pending ID once and waits for its action acknowledgement", async () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  socket.receive(snapshot(["submit", "pending-input"]));
  for (const [index, action] of ["steer", "discard"].entries()) {
    const result = client.pendingAction("w1:p1", "pending-1", action as "steer" | "discard");
    for (let turn = 0; turn < 10 && socket.sent.filter((frame) => frame.type === "pending-action").length <= index; turn++) await Promise.resolve();
    const frame = socket.sent.filter((frame) => frame.type === "pending-action")[index]!;
    expect(frame).toEqual({ type: "pending-action", id: index + 1, pane_id: "w1:p1", pending_id: "pending-1", action });
    socket.receive({ type: "pending-result", id: index + 1, pane_id: "w1:p1", pending_id: "pending-1", ok: index === 0, ...(index === 1 ? { code: "pending_not_found", message: "already sent" } : {}) });
    expect(await result).toEqual(index === 0 ? { ok: true } : { ok: false, code: "pending_not_found", message: "already sent" });
  }
  client.close();
});

it("requires acknowledgement kind and target to match, so pending results cannot confirm an immediate submit or secret", async () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  socket.receive(snapshot(["submit", "pending-input", "secret-input"]));
  const immediate = client.submit("w1:p1", "immediate", "immediate");
  const secret = client.sendSecret("w1:p1", "Password:", "private");
  const action = client.pendingAction("w1:p1", "pending-1", "steer");
  const settled: string[] = [];
  void immediate?.then(() => settled.push("immediate"));
  void secret?.then(() => settled.push("secret"));
  void action?.then(() => settled.push("action"));
  for (let turn = 0; turn < 10 && socket.sent.filter((frame) => frame.type === "pending-action").length === 0; turn++) await Promise.resolve();
  for (const id of [1, 2]) socket.receive({ type: "pending-result", id, pane_id: "w1:p1", pending_id: "pending-1", ok: true });
  socket.receive({ type: "submit-result", id: 3, pane_id: "w1:p1", ok: true });
  socket.receive({ type: "secret-result", id: 1, pane_id: "w1:p1", ok: true });
  socket.receive({ type: "pending-result", id: 3, pane_id: "w1:p2", pending_id: "pending-1", ok: true });
  socket.receive({ type: "pending-result", id: 3, pane_id: "w1:p1", pending_id: "foreign-pending", ok: true });
  await Promise.resolve();
  expect(settled).toEqual([]);
  socket.receive({ type: "submit-result", id: 1, pane_id: "w1:p1", ok: true });
  socket.receive({ type: "secret-result", id: 2, pane_id: "w1:p1", ok: true });
  socket.receive({ type: "pending-result", id: 3, pane_id: "w1:p1", pending_id: "pending-1", ok: true });
  expect(await immediate).toEqual({ ok: true });
  expect(await secret).toEqual({ ok: true });
  expect(await action).toEqual({ ok: true });
  client.close();
});

it("refuses unsupported pending actions and never replays an action after disconnect", async () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  socket.receive(snapshot(["submit"]));
  expect(await client.pendingAction("w1:p1", "pending-1", "steer")).toMatchObject({ ok: false, code: "pending_input_unsupported" });
  expect(socket.sent.filter((frame) => frame.type === "pending-action")).toEqual([]);
  socket.receive(snapshot(["submit", "pending-input"]));
  const result = client.pendingAction("w1:p1", "pending-1", "steer");
  for (let turn = 0; turn < 10 && socket.sent.filter((frame) => frame.type === "pending-action").length === 0; turn++) await Promise.resolve();
  socket.disconnect();
  expect(await result).toMatchObject({ ok: false, code: "disconnected" });
  expect(client.pendingAction("w1:p1", "pending-1", "discard")).toBeNull();
  client.connect();
  const reconnect = FakeSocket.last;
  reconnect.open();
  reconnect.receive(snapshot(["submit", "pending-input"]));
  expect(reconnect.sent.map((frame) => frame.type)).toEqual(["role"]);
  client.setMode("observe");
  expect(client.pendingAction("w1:p1", "pending-1", "steer")).toBeNull();
  client.close();
});

it("keeps existing Enter submits and the older bridge's input fallback compatible", async () => {
  for (const features of [[], ["submit"], ["submit", "pending-input"]]) {
    const client = new HerdrSocket("ws://test/ws");
    client.connect();
    const socket = FakeSocket.last;
    socket.open();
    socket.receive(snapshot(features));
    const result = client.submit("w1:p1", "steer now", "steer now", true);
    for (let turn = 0; turn < 10 && submissions(socket).length === 0; turn++) await Promise.resolve();
    if (features.includes("submit")) {
      expect(submissions(socket)).toEqual([{ type: "submit", id: 1, pane_id: "w1:p1", text: "steer now", payload: "steer now", typed: true }]);
      socket.receive({ type: "submit-result", id: 1, pane_id: "w1:p1", ok: true });
    } else expect(submissions(socket)).toEqual([{ type: "input", pane_id: "w1:p1", text: "steer now\r" }]);
    expect(await result).toEqual({ ok: true });
    client.close();
  }
});

it("never replays a queued submit after disconnecting, including before its capability snapshot arrives", async () => {
  for (const known of [false, true]) {
    const client = new HerdrSocket("ws://test/ws");
    client.connect();
    const socket = FakeSocket.last;
    socket.open();
    client.attach("w1:p1", 80, 24);
    if (known) socket.receive(snapshot(["submit", "pending-input"]));
    const result = client.submit("w1:p1", "do not replay", "do not replay", false, "queue");
    for (let turn = 0; turn < 10 && known && submissions(socket).length === 0; turn++) await Promise.resolve();
    socket.disconnect();
    expect(await result).toMatchObject({ ok: false, code: "disconnected" });
    expect(client.canQueueMessages()).toBe(false);
    expect(client.submit("w1:p1", "offline", "offline", false, "queue")).toBeNull();
    client.connect();
    const reconnect = FakeSocket.last;
    reconnect.open();
    reconnect.receive(snapshot(["submit", "pending-input"]));
    await Promise.resolve();
    expect(reconnect.sent.map((frame) => frame.type)).toEqual(["role", "attach"]);
    expect(submissions(socket).length).toBe(known ? 1 : 0);
    client.close();
  }
});

it("sends no submit while observing, including a role change while waiting for the snapshot", async () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  const pending = client.submit("w1:p1", "not while observing", "not while observing", false, "queue");
  client.setMode("observe");
  socket.receive(snapshot(["submit", "pending-input"]));
  expect(await pending).toMatchObject({ ok: false, code: "read_only" });
  expect(client.canQueueMessages()).toBe(false);
  expect(client.submit("w1:p1", "no Enter either", "no Enter either")).toBeNull();
  expect(submissions(socket)).toEqual([]);
  client.close();
});

it("applies a server-forced observe acknowledgement before a pending submit wakes on the first snapshot", async () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  const pending = client.submit("w1:p1", "keep this draft", "keep this draft", false, "queue");
  socket.receive({ type: "role-ack", mode: "observe" });
  socket.receive(snapshot(["submit", "pending-input"]));
  expect(await pending).toMatchObject({ ok: false, code: "read_only" });
  expect(client.canQueueMessages()).toBe(false);
  expect(client.submit("w1:p1", "no input while watching", "no input while watching")).toBeNull();
  expect(submissions(socket)).toEqual([]);
  socket.receive({ type: "role-ack", mode: "interact" });
  expect(client.canQueueMessages()).toBe(true);
  client.on((message) => { if (message.type === "role-ack") expect(client.canQueueMessages()).toBe(false); });
  socket.receive({ type: "role-ack", mode: "observe" });
  expect(submissions(socket)).toEqual([]);
  client.close();
});

it("sends a secret entered before the reconnect's snapshot arrived, once the snapshot lists masked input", async () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  // terminal output is already on screen and the masked field is up; the snapshot is still on its way
  const result = client.sendSecret("w1:p1", "Password:", "hunter2");
  expect(result).not.toBeNull();
  await Promise.resolve();
  expect(secrets(socket)).toEqual([]);
  socket.receive(snapshot(["submit", "secret-input"]));
  // the secret goes out as soon as the snapshot is in, not at the wait's deadline
  for (let turn = 0; turn < 10 && secrets(socket).length === 0; turn++) await Promise.resolve();
  expect(secrets(socket)).toMatchObject([{ type: "secret", pane_id: "w1:p1", prompt: "Password:", secret: "hunter2" }]);
  socket.receive({ type: "secret-result", id: secrets(socket)[0]!["id"], pane_id: "w1:p1", ok: true });
  expect(await result).toEqual({ ok: true });
  client.close();
});

it("answers unsupported, sending nothing, when the snapshot lists no masked input", async () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  socket.receive(snapshot(["submit"]));
  expect(await client.sendSecret("w1:p1", "Password:", "hunter2")).toMatchObject({ ok: false, code: "unsupported" });
  expect(secrets(socket)).toEqual([]);
  client.close();
});

it("requires attachment readiness and never replays held input after a detach", () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  socket.receive(snapshot(["submit", "input-ready"]));
  client.attach("w1:p1", 80, 24);
  expect(client.sendInput("w1:p1", "lost?")).toBe(false);
  expect(client.sendKeys("w1:p1", ["ctrl+alt+shift+left"])).toBe(false);
  socket.receive({ type: "pty-data", pane_id: "w1:p1", data: "screen" });
  expect(client.canInput("w1:p1")).toBe(false);
  socket.receive({ type: "input-ready", pane_id: "w1:p1" });
  expect(client.sendInput("w1:p1", "한글")).toBe(true);
  expect(client.sendKeys("w1:p1", ["ctrl+alt+shift+left"])).toBe(true);
  // a key or text of an attach that has gone is refused with `input_failed`: this attach stays ready
  socket.receive({ type: "error", code: "input_failed", message: "stale", pane_id: "w1:p1" });
  expect(client.canInput("w1:p1")).toBe(true);
  socket.receive({ type: "error", code: "input_not_ready", message: "not ready", pane_id: "w1:p1" });
  expect(client.canInput("w1:p1")).toBe(false);
  socket.receive({ type: "input-ready", pane_id: "w1:p1" });
  expect(client.canInput("w1:p1")).toBe(true);
  client.detach("w1:p1");
  socket.receive({ type: "input-ready", pane_id: "w1:p1" });
  expect(client.sendInput("w1:p1", "wrong pane")).toBe(false);
  expect(client.sendKeys("w1:p1", ["ctrl+alt+shift+left"])).toBe(false);
  expect(socket.sent.filter((m) => m.type === "keys")).toEqual([{ type: "keys", pane_id: "w1:p1", keys: ["ctrl+alt+shift+left"] }]);
  expect(socket.sent.filter((m) => m.type === "input")).toEqual([{ type: "input", pane_id: "w1:p1", text: "한글" }]);
  client.close();
});

it("takes a held pane only from a server that knows how, while interacting with an attached pane", () => {
  const takes = (socket: FakeSocket) => socket.sent.filter((m) => m.type === "take-over");
  const old = new HerdrSocket("ws://test/ws");
  old.connect();
  const oldSocket = FakeSocket.last;
  oldSocket.open();
  oldSocket.receive(snapshot(["submit", "input-ready"]));
  old.attach("w1:p1", 80, 24);
  expect(old.canTakeOver()).toBe(false);
  expect(old.takeOver("w1:p1")).toBe(false);
  expect(takes(oldSocket)).toEqual([]);
  old.close();

  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  socket.receive(snapshot(["submit", "input-ready", "take-over"]));
  expect(client.takeOver("w1:p1")).toBe(false);
  client.attach("w1:p1", 80, 24);
  expect(client.takeOver("w1:p1")).toBe(true);
  // The open handler replays role and attach state, never the explicit takeover.
  socket.open();
  socket.receive(snapshot(["submit", "input-ready", "take-over"]));
  expect(takes(socket)).toEqual([{ type: "take-over", pane_id: "w1:p1" }]);
  client.setMode("observe");
  expect(client.takeOver("w1:p1")).toBe(false);
  expect(takes(socket)).toEqual([{ type: "take-over", pane_id: "w1:p1" }]);
  client.close();
  expect(client.takeOver("w1:p1")).toBe(false);
});

it("attaches a grid the chat lens covers without resizing the shared pty, on a reconnect too, until it drives the size again", () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  const lastAttach = () => socket.sent.filter((m) => m.type === "attach").at(-1);
  // attached before the socket opened: the open replays it, as a reconnect does
  client.attach("w1:p1", 40, 20, true);
  socket.open();
  expect(lastAttach()).toEqual({ type: "attach", pane_id: "w1:p1", cols: 40, rows: 20, flow_control: "ack", keep_size: true });
  // the terminal lens is shown and resizes: from then on it drives the size
  client.resize("w1:p1", 100, 30, true);
  socket.open();
  expect(lastAttach()).toEqual({ type: "attach", pane_id: "w1:p1", cols: 100, rows: 30, flow_control: "ack" });
  // the chat lens covers it again
  client.keepSize("w1:p1");
  socket.open();
  expect(lastAttach()).toEqual({ type: "attach", pane_id: "w1:p1", cols: 100, rows: 30, flow_control: "ack", keep_size: true });
  client.close();
});

it("sends no resize for a pane it let go of, and does not attach it again on a reconnect", () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  client.attach("w1:p1", 100, 30);
  // a tab out of use lets go of its pane: herdr gives the pane back to its own TUI
  client.detach("w1:p1");
  const after = socket.sent.length;
  // the server would apply this to the attach of whoever holds the pane now
  client.resize("w1:p1", 120, 40, true);
  socket.open();
  expect(socket.sent.slice(after).filter((m) => m.type === "attach" || m.type === "resize")).toEqual([]);
  // the user is back: it attaches at its own size again
  client.attach("w1:p1", 120, 40);
  expect(socket.sent.at(-1)).toEqual({ type: "attach", pane_id: "w1:p1", cols: 120, rows: 40, flow_control: "ack" });
  client.close();
});

it("watches a pane it let go of only on a server that can, again after a reconnect, and ends the watch on one that cannot", () => {
  const client = new HerdrSocket("ws://test/ws");
  const ended: string[] = [];
  client.on((message) => { if (message.type === "watch-end") ended.push(message.pane_id); });
  client.connect();
  let socket = FakeSocket.last;
  socket.open();
  // asked before the snapshot says what the server can: it goes out once the snapshot does
  expect(client.watch("w1:p1", 100, 30)).toBe(true);
  expect(socket.sent.filter((m) => m.type === "watch")).toEqual([]);
  socket.receive(snapshot(["watch"]));
  expect(socket.sent.filter((m) => m.type === "watch")).toEqual([{ type: "watch", pane_id: "w1:p1", cols: 100, rows: 30 }]);
  // a reconnect watches again, at the grid last asked for, and attaches nothing
  expect(client.watch("w1:p1", 120, 40)).toBe(true);
  socket.disconnect();
  client.connect();
  socket = FakeSocket.last;
  socket.open();
  socket.receive(snapshot(["watch"]));
  expect(socket.sent.filter((m) => m.type !== "role")).toEqual([{ type: "watch", pane_id: "w1:p1", cols: 120, rows: 40 }]);
  // the server ended it: a later reconnect does not ask for it again
  socket.receive({ type: "watch-end", pane_id: "w1:p1" });
  socket.disconnect();
  client.connect();
  socket = FakeSocket.last;
  socket.open();
  socket.receive(snapshot(["watch"]));
  expect(socket.sent.filter((m) => m.type === "watch")).toEqual([]);
  // a reconnect to a bridge without the view ends the tab's watch instead of sending a frame it does not know
  expect(client.watch("w1:p2", 80, 24)).toBe(true);
  socket.disconnect();
  client.connect();
  socket = FakeSocket.last;
  socket.open();
  socket.receive(snapshot(["submit"]));
  expect(socket.sent.filter((m) => m.type === "watch")).toEqual([]);
  expect(ended).toEqual(["w1:p1", "w1:p2"]);
  expect(client.watch("w1:p2", 80, 24)).toBe(false);
  client.close();
});

it("waits for capabilities when output precedes snapshot, and supports old bridges", () => {
  for (const features of [["input-ready"], []]) {
    const client = new HerdrSocket("ws://test/ws"); client.connect();
    const socket = FakeSocket.last; socket.open(); client.attach("w1:p1", 80, 24);
    socket.receive({ type: "pty-data", pane_id: "w1:p1", data: "screen" });
    expect(client.canInput("w1:p1")).toBe(false);
    socket.receive(snapshot(features));
    expect(client.canInput("w1:p1")).toBe(features.length === 0);
    socket.receive({ type: "input-ready", pane_id: "w1:p1" });
    expect(client.canInput("w1:p1")).toBe(true);
    socket.receive({ type: "input-ready", pane_id: "w1:p1", ready: false });
    expect(client.sendInput("w1:p1", "no replay")).toBe(false);
    client.close();
  }
});

it("asks again for a visible chat's conversation pushes when its pane is attached again", () => {
  const client = new HerdrSocket("ws://test/ws"); client.connect();
  const socket = FakeSocket.last; socket.open();
  socket.receive(snapshot(["conversation-watch"]));
  const watches = () => socket.sent.filter((frame) => frame.type === "conversation-watch");
  // the chat can ask before its pane's attach goes out; the attach carries the interest
  client.watchConversation("w1:p1", true);
  expect(watches()).toEqual([]);
  client.attach("w1:p1", 80, 24, true);
  expect(watches()).toEqual([{ type: "conversation-watch", pane_id: "w1:p1", enabled: true }]);
  // a tab out of use lets go of its pane: the bridge drops the interest, the visible chat keeps it
  client.detach("w1:p1");
  client.attach("w1:p1", 80, 24, true);
  expect(watches()).toHaveLength(2);
  // a chat that took its interest back is not watched by the next attach
  client.watchConversation("w1:p1", false);
  client.detach("w1:p1");
  client.attach("w1:p1", 80, 24, true);
  expect(watches()).toEqual([
    { type: "conversation-watch", pane_id: "w1:p1", enabled: true },
    { type: "conversation-watch", pane_id: "w1:p1", enabled: true },
    { type: "conversation-watch", pane_id: "w1:p1", enabled: false },
  ]);
  client.close();
});

it("sends no conversation-watch to a bridge without the feature, and reports no pushes so the chat polls", () => {
  const client = new HerdrSocket("ws://test/ws"); client.connect();
  let socket = FakeSocket.last; socket.open();
  socket.receive(snapshot(["submit", "pending-input", "secret-input", "input-ready", "take-over", "watch"]));
  client.watchConversation("w1:p1", true);
  client.attach("w1:p1", 80, 24, true);
  expect(socket.sent.filter((frame) => frame.type === "conversation-watch")).toEqual([]);
  expect(client.conversationPushes()).toBe(false);
  // a reconnect to the same older bridge does not replay the interest either
  socket.disconnect();
  client.connect();
  socket = FakeSocket.last; socket.open();
  socket.receive(snapshot(["submit"]));
  expect(socket.sent.filter((frame) => frame.type === "conversation-watch")).toEqual([]);
  expect(client.conversationPushes()).toBe(false);
  client.close();
});

it("tells the server whether the page is in use: on connect, on a change, and again after a reconnect", () => {
  const presence = (socket: FakeSocket) => socket.sent.filter((frame) => frame.type === "presence");
  const client = new HerdrSocket("ws://test/ws");
  client.setPresence(true);
  client.connect();
  const first = FakeSocket.last;
  first.open();
  expect(first.sent.map((frame) => frame.type)).toEqual(["role", "presence"]);
  client.setPresence(true);
  client.setPresence(false);
  expect(presence(first)).toEqual([{ type: "presence", active: true }, { type: "presence", active: false }]);
  first.disconnect();
  client.connect();
  const second = FakeSocket.last;
  second.open();
  expect(presence(second)).toEqual([{ type: "presence", active: false }]);
  client.close();
});

it("reconnects at once when the page wakes instead of waiting out the backoff, and starts the backoff over", () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const first = FakeSocket.last;
  first.open();
  // a phone asleep: each attempt fails and the backoff grows toward its cap
  first.disconnect();
  for (let attempt = 0; attempt < 5; attempt++) {
    client.wake();
    FakeSocket.last.disconnect();
  }
  const sleeping = FakeSocket.last;
  client.wake();
  expect(FakeSocket.last).not.toBe(sleeping);
  const woken = FakeSocket.last;
  woken.open();
  expect(woken.sent.map((frame) => frame.type)).toEqual(["role"]);
  // a live connection has no timer to skip: waking opens nothing more
  client.wake();
  expect(FakeSocket.last).toBe(woken);
  client.close();
});

it("does not wake a connection whose output stopped, nor one that was closed", () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  (socket as unknown as { emit(type: string, event: unknown): void }).emit("close", { code: OUTPUT_STALLED_CLOSE_CODE });
  client.wake();
  expect(FakeSocket.last).toBe(socket);
  client.close();
  client.wake();
  expect(FakeSocket.last).toBe(socket);
});
