import type { ClientMessage, ClientRole, PendingMessage, ServerFeature, ServerMessage } from "../../shared/protocol.ts";
import { OUTPUT_STALLED_CLOSE_CODE } from "../../shared/terminal-flow.ts";

type Handler = (message: ServerMessage) => void;

/** A submit was delivered, accepted into the bridge's pending queue, or refused. */
export type SubmitResult = { ok: true; pending?: PendingMessage } | { ok: false; code: string; message: string };

/** Right after a reconnect the snapshot that says what the server supports may still be on its way. */
const SNAPSHOT_WAIT_MS = 2000;
/**
 * A submit the server never answers: the composer stops waiting and keeps the text. The
 * server types nothing once 45s have passed since the message reached it (queued behind
 * others included) and a send that started in time ends within two more 10s RPCs, so a
 * message the client gave up on is never submitted later.
 */
const SUBMIT_TIMEOUT_MS = 90_000;
const DISCONNECTED: SubmitResult = { ok: false, code: "disconnected", message: "the connection dropped before the pane confirmed this message" };

interface AttachState {
  cols: number;
  rows: number;
  /** the chat lens covers the grid: attaches (a reconnect's too) leave the shared pty's size alone */
  keepSize: boolean;
}

function defaultUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

/**
 * Reconnecting client for /ws. Attachments are remembered with their geometry so a
 * dropped connection restores the live terminal at the right size instead of
 * leaving a stale screen behind.
 *
 * Two policies live here:
 * - The connection's role survives reconnects: an observe connection re-sends its
 *   role before the attach replay, so a reconnecting phone still cannot resize or
 *   type into the operator's pty.
 * - Terminal input is NEVER queued while disconnected (a command typed into a dead
 *   socket must not fire later, unannounced); PaneTerminal keeps it as a draft the
 *   user reviews instead. Control frames (attach/resize/role) replay as before.
 */
export class HerdrSocket {
  private socket: WebSocket | null = null;
  private readonly url: string;
  private readonly handlers = new Set<Handler>();
  private readonly disconnectHandlers = new Set<() => void>();
  private snapshotKnown = false;
  private readonly outputSeen = new Set<string>();
  private readonly inputReady = new Set<string>();
  private readonly attached = new Map<string, AttachState>();
  /** panes this tab views read-only while out of use (feature "watch"), at the grid it asked for; replayed after each snapshot */
  private readonly watched = new Map<string, { cols: number; rows: number }>();
  private retries = 0;
  private reconnectTimer: number | null = null;
  private disposed = false;
  private mode: ClientRole = "interact";
  private outputStopped = false;
  /** what the connected server listed in its snapshot: empty until it arrives, and on older bridges */
  private features = new Set<ServerFeature>();
  /** settles when this connection's snapshot arrives (or the connection ends) */
  private snapshotSeen: Promise<void> = Promise.resolve();
  private markSnapshot: () => void = () => {};
  private nextSubmit = 1;
  /** submits waiting for their submit-result, by id */
  private readonly submits = new Map<number, (result: SubmitResult) => void>();
  /** Receipts match the operation and captured target on this connection, never an ID alone. */
  private readonly requests = new Map<number, { type: "submit" | "pending-action" | "secret"; paneId: string; queued?: boolean; pendingId?: string }>();

  constructor(url: string = defaultUrl()) {
    this.url = url;
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    if (this.disposed) return;
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    const socket = new WebSocket(this.url);
    this.socket = socket;
    this.features = new Set();
    this.inputReady.clear();
    this.outputSeen.clear();
    this.snapshotKnown = false;
    this.snapshotSeen = new Promise((resolve) => { this.markSnapshot = resolve; });

    socket.addEventListener("open", () => {
      this.retries = 0;
      // always send the role, never only when non-default: a user can flip the role
      // while disconnected (setMode stores it without sending), so without this frame
      // the reconnect would leave the server on the stale role and no ack would ever
      // arrive - the UI would stay stuck in the old role while the header pill lies
      this.rawSend({ type: "role", mode: this.mode });
      for (const [paneId, state] of this.attached) {
        this.rawSend({ type: "attach", pane_id: paneId, cols: state.cols, rows: state.rows, flow_control: "ack", ...(state.keepSize ? { keep_size: true } : {}) });
      }
    });

    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        /* ignore malformed frame */
        return;
      }
      // The server can force this connection to observe. Apply its authority before
      // waking pending submits or notifying UI handlers about the acknowledged role.
      if (message.type === "role-ack") this.mode = message.mode;
      // a server without the read-only view (an older bridge after a reconnect) ends this tab's watches
      let unwatched: string[] = [];
      if (message.type === "snapshot") {
        this.features = new Set(message.features ?? []);
        this.snapshotKnown = true;
        if (!this.features.has("input-ready")) for (const pane of this.outputSeen) if (this.attached.has(pane)) this.inputReady.add(pane);
        if (this.features.has("watch")) {
          for (const [paneId, grid] of this.watched) this.rawSend({ type: "watch", pane_id: paneId, cols: grid.cols, rows: grid.rows });
        } else {
          unwatched = [...this.watched.keys()];
          this.watched.clear();
        }
        this.markSnapshot();
      }
      if (message.type === "watch-end") this.watched.delete(message.pane_id);
      if (message.type === "pty-data") this.outputSeen.add(message.pane_id);
      if ((message.type === "input-ready" && message.ready !== false) || (message.type === "pty-data" && this.snapshotKnown && !this.features.has("input-ready"))) {
        if (this.attached.has(message.pane_id)) this.inputReady.add(message.pane_id);
      }
      if ((message.type === "input-ready" && message.ready === false) || message.type === "pty-exit" || (message.type === "error" && message.pane_id && ["attach_held", "input_not_ready"].includes(message.code))) this.inputReady.delete(message.pane_id!);
      if (message.type === "submit-result" && this.matchesRequest(message.id, "submit", message.pane_id)) {
        this.resolveRequest(message.id, message.ok ? { ok: true, ...(message.pending ? { pending: message.pending } : {}) } : { ok: false, code: message.code ?? "submit_failed", message: message.message ?? "the pane did not take the message" });
      }
      if (message.type === "pending-messages") {
        // The owner-only live queue is also an acceptance receipt if its submit ACK
        // was lost. A reconnect's empty list never implies that an old item was sent.
        for (const pending of message.messages) {
          const request = this.requests.get(pending.request_id);
          if (request?.type !== "submit" || !request.queued || request.paneId !== message.pane_id) continue;
          this.resolveRequest(pending.request_id, { ok: true, pending });
        }
      }
      if (message.type === "pending-result" && this.matchesRequest(message.id, "pending-action", message.pane_id, message.pending_id)) {
        this.resolveRequest(message.id, message.ok ? { ok: true } : { ok: false, code: message.code ?? "pending_failed", message: message.message ?? "the pending message was not changed" });
      }
      if (message.type === "secret-result" && this.matchesRequest(message.id, "secret", message.pane_id)) {
        this.resolveRequest(message.id, message.ok ? { ok: true } : { ok: false, code: message.code ?? "secret_failed", message: "Secret was not sent. Check the prompt and enter it again." });
      }
      // A terminal/parser failure is not malformed JSON and must not disappear.
      this.emit(message);
      for (const paneId of unwatched) this.emit({ type: "watch-end", pane_id: paneId });
    });

    socket.addEventListener("close", (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      for (const handler of this.disconnectHandlers) handler();
      this.markSnapshot();
      this.settleSubmits(DISCONNECTED);
      if (event.code === OUTPUT_STALLED_CLOSE_CODE) {
        this.outputStopped = true;
        this.emit({ type: "error", code: "output_stalled", message: "Terminal output stopped because this device could not keep up." });
        return;
      }
      this.scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      socket.close();
    });
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== null) return;
    const delay = Math.min(5000, 250 * 2 ** this.retries);
    this.retries += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private rawSend(message: ClientMessage): void {
    this.socket?.send(JSON.stringify(message));
  }

  private send(message: ClientMessage): void {
    if (this.connected) this.rawSend(message);
    // Role/attach/geometry already live in state. Replaying both that state and
    // a queue used to attach twice and duplicate the initial terminal replay.
  }

  private emit(message: ServerMessage): void {
    for (const handler of this.handlers) handler(message);
  }

  on(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  onDisconnect(handler: () => void): () => void {
    this.disconnectHandlers.add(handler);
    return () => { this.disconnectHandlers.delete(handler); };
  }

  attach(paneId: string, cols: number, rows: number, keepSize = false): void {
    this.outputSeen.delete(paneId);
    this.inputReady.delete(paneId);
    this.attached.set(paneId, { cols, rows, keepSize });
    this.send({ type: "attach", pane_id: paneId, cols, rows, flow_control: "ack", ...(keepSize ? { keep_size: true } : {}) });
    if (this.outputStopped) {
      this.outputStopped = false;
      this.connect();
    }
  }

  /** Capture connection AND subscription before xterm's asynchronous write. Never queue ACKs. */
  outputAcknowledgement(message: Extract<ServerMessage, { type: "pty-data" }>): (() => void) | undefined {
    const flow = message.flow;
    if (!flow) return undefined;
    const connection = this.socket;
    const subscription = this.attached.get(message.pane_id);
    return () => {
      if (!connection || this.socket !== connection || !this.connected || !subscription
        || this.attached.get(message.pane_id) !== subscription) return;
      this.rawSend({ type: "pty-ack", pane_id: message.pane_id, stream_id: flow.stream_id, offset: flow.offset });
    };
  }

  detach(paneId: string): void {
    this.outputSeen.delete(paneId);
    this.inputReady.delete(paneId);
    this.attached.delete(paneId);
    this.send({ type: "detach", pane_id: paneId });
  }

  /**
   * Views the pane read-only at this grid, leaving its size to herdr's own window; replayed after
   * a reconnect's snapshot. False when the server cannot (no "watch" in its snapshot): the tab stays paused.
   */
  watch(paneId: string, cols: number, rows: number): boolean {
    if (this.snapshotKnown && !this.features.has("watch")) return false;
    this.watched.set(paneId, { cols, rows });
    // before the snapshot, the snapshot handler sends it
    if (this.connected && this.snapshotKnown) this.rawSend({ type: "watch", pane_id: paneId, cols, rows });
    return true;
  }

  unwatch(paneId: string): void {
    if (this.watched.delete(paneId) && this.connected && this.features.has("watch")) this.rawSend({ type: "unwatch", pane_id: paneId });
  }

  resize(paneId: string, cols: number, rows: number, force = false): void {
    const state = this.attached.get(paneId);
    // a pane this tab let go of (PaneTerminal's release) is sized by whoever holds it: the server
    // would apply the resize to their attach
    if (!state) return;
    // skip only redundant resizes of OUR OWN geometry: a force resize re-asserts
    // it after another client resized the shared pty (see PaneTerminal refit)
    if (!force && state.cols === cols && state.rows === rows) return;
    state.cols = cols;
    state.rows = rows;
    state.keepSize = false;
    this.send({ type: "resize", pane_id: paneId, cols, rows });
  }

  /** Whether this connection may take a held pane from another web bridge: a server that knows how, and not observing. */
  canTakeOver(): boolean {
    return this.connected && this.mode === "interact" && this.features.has("take-over");
  }

  /** Explicitly takes the pane's attach slot; never queued or replayed on reconnect. */
  takeOver(paneId: string): boolean {
    if (!this.canTakeOver() || !this.attached.has(paneId)) return false;
    this.rawSend({ type: "take-over", pane_id: paneId });
    return true;
  }

  /** The chat lens covers the grid again: a reconnect attaches without resizing, until the next resize. */
  keepSize(paneId: string): void {
    const state = this.attached.get(paneId);
    if (state) state.keepSize = true;
  }

  /** Sets the connection's role. Not queued: the role replays before the attaches on reconnect. */
  setMode(mode: ClientRole): void {
    this.mode = mode;
    if (this.connected) this.rawSend({ type: "role", mode });
  }

  canInput(paneId: string): boolean {
    return this.connected && this.mode === "interact" && this.inputReady.has(paneId);
  }

  /** Whether this connection can accept and manage pending messages on the bridge. */
  canQueueMessages(): boolean {
    return this.connected && this.mode === "interact" && this.features.has("submit") && this.features.has("pending-input");
  }

  sendInput(paneId: string, text: string): boolean {
    if (!this.canInput(paneId)) return false;
    try { this.rawSend({ type: "input", pane_id: paneId, text }); return true; } catch { return false; }
  }

  /**
   * Types a composer message and submits it, straight to the socket: a Ctrl armed on the
   * terminal key bar must not turn a one-letter message into a control key. A server
   * listing "submit" sends Enter itself, after a gap, and says how it went; an older
   * bridge gets the payload and its Enter in one frame, as before. Queue delivery
   * requires "pending-input": it never falls back to an immediate send. `text` is the message
   * as written, `payload` the same shaped for the pane's paste mode. null, sending
   * nothing, when offline.
   */
  /** `typed`: from the terminal's input line, typed into the pane like the keyboard (see ClientMessage) */
  submit(paneId: string, text: string, payload: string, typed = false, delivery: "immediate" | "queue" = "immediate"): Promise<SubmitResult> | null {
    const socket = this.socket;
    if (!this.connected || socket === null || this.mode === "observe") return null;
    return (async (): Promise<SubmitResult> => {
      await Promise.race([this.snapshotSeen, new Promise((resolve) => window.setTimeout(resolve, SNAPSHOT_WAIT_MS))]);
      if (!this.connected || this.socket !== socket) return DISCONNECTED;
      if (this.mode === "observe") return { ok: false, code: "read_only", message: "Observe connections cannot submit messages." };
      if (delivery === "queue" && !this.canQueueMessages()) return { ok: false, code: "pending_input_unsupported", message: "Update this PC to queue messages." };
      if (!this.features.has("submit")) {
        this.rawSend({ type: "input", pane_id: paneId, text: `${payload}\r` });
        return { ok: true };
      }
      const id = this.nextSubmit++;
      return this.submitRequest({ type: "submit", id, pane_id: paneId, text, payload, ...(typed ? { typed: true } : {}), ...(delivery === "queue" ? { delivery: "queue" as const } : {}) });
    })();
  }

  /** Explicitly steer or discard one server-owned pending item. Never queued or replayed. */
  pendingAction(paneId: string, pendingId: string, action: "steer" | "discard"): Promise<SubmitResult> | null {
    const socket = this.socket;
    if (!this.connected || socket === null || this.mode === "observe") return null;
    return (async (): Promise<SubmitResult> => {
      await Promise.race([this.snapshotSeen, new Promise((resolve) => window.setTimeout(resolve, SNAPSHOT_WAIT_MS))]);
      if (!this.connected || this.socket !== socket) return DISCONNECTED;
      if (this.mode === "observe") return { ok: false, code: "read_only", message: "Observe connections cannot change pending messages." };
      if (!this.canQueueMessages()) return { ok: false, code: "pending_input_unsupported", message: "Update this PC to manage pending messages." };
      return this.submitRequest({ type: "pending-action", id: this.nextSubmit++, pane_id: paneId, pending_id: pendingId, action });
    })();
  }

  /** Only an acknowledgement callback is retained, never a frame to resend. */
  private submitRequest(message: Extract<ClientMessage, { type: "submit" | "pending-action" }>): Promise<SubmitResult> {
    const id = message.id;
    this.requests.set(id, { type: message.type, paneId: message.pane_id, ...(message.type === "submit" ? { queued: message.delivery === "queue" } : { pendingId: message.pending_id }) });
    const result = new Promise<SubmitResult>((resolve) => {
      this.submits.set(id, resolve);
      window.setTimeout(() => {
        if (!this.submits.delete(id)) return;
        this.requests.delete(id);
        resolve({ ok: false, code: "timeout", message: "the pane did not confirm this request in time" });
      }, SUBMIT_TIMEOUT_MS);
    });
    try { this.rawSend(message); }
    catch {
      this.submits.get(id)?.(DISCONNECTED);
      this.submits.delete(id);
      this.requests.delete(id);
    }
    return result;
  }

  /** Send once on this connection. Only a result callback is retained, never the value. */
  sendSecret(paneId: string, prompt: string, secret: string): Promise<SubmitResult> | null {
    const socket = this.socket;
    if (!this.connected || socket === null || this.mode === "observe") return null;
    return (async (): Promise<SubmitResult> => {
      // right after a reconnect the terminal's output can arrive before the snapshot that says
      // whether the server takes masked input: wait for it, as a submit does
      await Promise.race([this.snapshotSeen, new Promise((resolve) => window.setTimeout(resolve, SNAPSHOT_WAIT_MS))]);
      if (!this.connected || this.socket !== socket) { secret = ""; return DISCONNECTED; }
      if (!this.features.has("secret-input")) { secret = ""; return { ok: false, code: "unsupported", message: "Update this PC to use masked input." }; }
      const id = this.nextSubmit++;
      this.requests.set(id, { type: "secret", paneId });
      const result = new Promise<SubmitResult>((resolve) => {
        this.submits.set(id, resolve);
        window.setTimeout(() => {
          if (this.submits.delete(id)) { this.requests.delete(id); resolve({ ok: false, code: "timeout", message: "Check the terminal before trying again." }); }
        }, 15_000);
      });
      try { this.rawSend({ type: "secret", id, pane_id: paneId, prompt, secret }); }
      catch {
        this.submits.get(id)?.(DISCONNECTED);
        this.submits.delete(id);
        this.requests.delete(id);
      } finally { secret = ""; }
      return result;
    })();
  }

  private matchesRequest(id: number, type: "submit" | "pending-action" | "secret", paneId: string, pendingId?: string): boolean {
    const request = this.requests.get(id);
    return request?.type === type && request.paneId === paneId && (type !== "pending-action" || request.pendingId === pendingId);
  }

  private resolveRequest(id: number, result: SubmitResult): void {
    const settle = this.submits.get(id);
    this.submits.delete(id);
    this.requests.delete(id);
    settle?.(result);
  }

  private settleSubmits(result: SubmitResult): void {
    for (const settle of this.submits.values()) settle(result);
    this.submits.clear();
    this.requests.clear();
  }

  sendKeys(paneId: string, keys: string[]): boolean {
    if (!this.canInput(paneId)) return false;
    try { this.rawSend({ type: "keys", pane_id: paneId, keys }); return true; } catch { return false; }
  }

  close(): void {
    this.disposed = true;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
    this.settleSubmits(DISCONNECTED);
    this.handlers.clear();
    this.disconnectHandlers.clear();
  }
}
