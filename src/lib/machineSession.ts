import type { PendingMessage, ServerMessage } from "../../shared/protocol.ts";
import { paneStorageId } from "../../shared/machines.ts";
import { afterSend, afterSettled, greetingMemory, rememberGreeting } from "./greeting.ts";
import { pendingMessages, type PendingMessageStore } from "./pendingMessages.ts";
import { HerdrSocket } from "./ws.ts";

type Handler = (message: ServerMessage, sent: boolean) => void;
type RoleAck = Extract<ServerMessage, { type: "role-ack" }>;
export interface MachineSessionOptions {
  socket?: HerdrSocket;
  pendingStore?: PendingMessageStore;
}
let nextSession = 1;

/** A PC's connection outlives its pane views. Detaching a view releases its input lease,
 * while this connection still receives the bridge's held state and delivery receipts. */
export class MachineSession {
  readonly socket: HerdrSocket;
  private readonly store: PendingMessageStore;
  private readonly identity = nextSession++;
  private currentScope: string | null = null;
  private currentEpoch = 0;
  private role: RoleAck | null = null;
  private readonly handlers = new Set<Handler>();
  private readonly offMessage: () => void;
  private readonly offDisconnect: () => void;
  private closed = false;

  constructor(readonly machineId: string, options: MachineSessionOptions = {}) {
    this.socket = options.socket ?? new HerdrSocket(`${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws?machine_id=${encodeURIComponent(machineId)}`);
    this.store = options.pendingStore ?? pendingMessages;
    // Installed before view subscribers, and kept even while this PC has no mounted pane.
    this.offMessage = this.socket.on((message) => {
      if (this.closed) return;
      if (message.type === "snapshot" && this.currentScope === null) this.currentScope = `${this.identity}:${this.currentEpoch}`;
      if (message.type === "role-ack") this.role = message;
      let sent = false;
      if (message.type === "pending-messages" && this.currentScope !== null) {
        const owner = paneStorageId(this.machineId, message.pane_id);
        const scope = this.currentScope;
        sent = message.removed?.some((item) => item.outcome === "sent" && this.store.isOwned(owner, item.id, scope)) ?? false;
        this.store.publish(owner, message.messages, message.removed ?? [], scope);
        if (sent) {
          const memory = greetingMemory(owner);
          rememberGreeting(owner, afterSettled(afterSend(memory), true, memory.history));
        }
      }
      for (const handler of this.handlers) handler(message, sent);
    });
    this.offDisconnect = this.socket.onDisconnect(() => this.disconnected());
  }

  get scope(): string | null { return this.currentScope; }
  get epoch(): number { return this.currentEpoch; }

  private disconnected(): void {
    if (this.currentScope !== null) this.store.suspendScope(this.currentScope);
    this.currentScope = null;
    this.currentEpoch++;
    this.role = null;
  }

  on(handler: Handler): () => void {
    if (this.closed) return () => {};
    this.handlers.add(handler);
    // A pane mounted on an existing connection must honor an enforced observe role.
    // Snapshots and terminal bytes are never replayed from a browser-owned cache.
    if (this.role !== null) handler(this.role, false);
    return () => { this.handlers.delete(handler); };
  }

  onDisconnect(handler: () => void): () => void { return this.socket.onDisconnect(handler); }
  connect(): void { if (!this.closed) this.socket.connect(); }

  /** A receipt belongs to the captured connection, whether its pane is still mounted or not. */
  acceptPending(paneId: string, message: PendingMessage, capturedEpoch: number): void {
    const scope = !this.closed && this.socket.connected && this.currentEpoch === capturedEpoch ? this.currentScope : null;
    const owner = paneStorageId(this.machineId, paneId);
    // The live stream may already have advanced this item to held, sending or uncertain
    // before a submit promise consumer runs. Its receipt only fills a missing record.
    if (this.store.isOwned(owner, message.id, scope)) return;
    this.store.accept(owner, message, scope);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.disconnected();
    this.offMessage();
    this.offDisconnect();
    this.handlers.clear();
    this.socket.close();
  }
}

/** Owned by the unlocked app, outside its PC-keyed canvas. Clearing it is reusable for
 * React's effect restart; selecting another PC does not close any existing connection. */
export class MachineSessionRegistry {
  private readonly sessions = new Map<string, MachineSession>();
  constructor(private readonly makeSession: (machineId: string) => MachineSession = (machineId) => new MachineSession(machineId)) {}

  get(machineId: string): MachineSession {
    let session = this.sessions.get(machineId);
    if (!session) { session = this.makeSession(machineId); this.sessions.set(machineId, session); }
    return session;
  }

  retainMachines(machineIds: ReadonlySet<string>): void {
    for (const [machineId, session] of this.sessions) {
      if (machineIds.has(machineId)) continue;
      this.sessions.delete(machineId);
      session.close();
    }
  }

  closeAll(): void {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of sessions) session.close();
  }
}
