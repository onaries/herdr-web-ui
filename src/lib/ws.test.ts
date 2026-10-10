import { afterAll, beforeAll, expect, it } from "bun:test";
import { HerdrSocket } from "./ws.ts";
import type { PendingMessage } from "../../shared/protocol.ts";

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
  send(data: string): void { this.sent.push(JSON.parse(data)); }
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
