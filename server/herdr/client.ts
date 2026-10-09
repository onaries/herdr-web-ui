import { stripVTControlCharacters } from "node:util";
import type {
  PaneReadResult,
  ReadFormat,
  ReadSource,
  SessionSnapshot,
} from "../../shared/protocol.ts";
import type { AgentManifestInfo, AgentStartParams, PaneInfo, PaneScrollInfo, TabInfo, WorkspaceInfo } from "../../shared/herdr-api.generated.ts";
import type { HerdrIdentity } from "../../shared/machines.ts";

const DEFAULT_TIMEOUT_MS = 10_000;

/** herdr's default socket: ~/.config/herdr on Unix, %APPDATA%\herdr on Windows. */
export function herdrSocketPath(): string {
  if (process.env.HERDR_SOCKET) return process.env.HERDR_SOCKET;
  if (process.platform === "win32") return `${process.env.APPDATA ?? ""}\\herdr\\herdr.sock`;
  return `${process.env.HOME ?? ""}/.config/herdr/herdr.sock`;
}

/**
 * On Windows herdr.sock is a marker file (`pid:start`), and the server listens on a named
 * pipe of the same name: `\\.\pipe\C:\Users\…\herdr.sock` (live-verified, herdr 0.9.3).
 */
export function socketAddress(socketPath: string): string {
  return process.platform === "win32" && !socketPath.startsWith("\\\\.\\pipe\\") ? `\\\\.\\pipe\\${socketPath}` : socketPath;
}

/** herdr's `terminal attach` exists on Unix only (herdrdev/herdr#4821); its ping does not say so yet. */
export function terminalAttachSupported(capabilities?: Record<string, unknown>): boolean {
  const declared = capabilities?.["direct_terminal_attach"];
  return typeof declared === "boolean" ? declared : process.platform !== "win32";
}

export class HerdrError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "HerdrError";
    this.code = code;
  }
}

let requestCounter = 0;
function nextId(): string {
  requestCounter += 1;
  return `br-${Date.now().toString(36)}-${requestCounter}`;
}

/**
 * Splits a growing buffer into complete newline-terminated frames.
 * herdr frames arrive split across reads, so partial tails must be retained.
 */
function makeLineReader(onLine: (line: string) => void): (chunk: Uint8Array) => void {
  const decoder = new TextDecoder();
  let buffer = "";
  return (chunk: Uint8Array) => {
    buffer += decoder.decode(chunk, { stream: true });
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length > 0) onLine(line);
      index = buffer.indexOf("\n");
    }
  };
}

/**
 * One request, one connection.
 * The herdr server closes the connection after a single response, so a pooled
 * or reused socket would never see a second reply.
 *
 * `guard`, when given, is asked once more right before the request is written: the
 * connect is awaited, and a caller's right to send can lapse meanwhile. A guard that
 * answers false sends nothing and rejects with `cancelled`.
 */
export async function herdrRpc<T = unknown>(
  method: string,
  params: Record<string, unknown>,
  socketPath: string = herdrSocketPath(),
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  guard?: () => boolean,
): Promise<T> {
  const id = nextId();
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    let socket: { end: () => void } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        socket?.end();
      } catch {
        /* the server may already have closed it */
      }
      fn();
    };

    timer = setTimeout(
      () => finish(() => reject(new HerdrError("timeout", `herdr ${method} timed out after ${timeoutMs}ms`))),
      timeoutMs,
    );

    const handleLine = (line: string) => {
      let frame: { id?: string; result?: unknown; error?: { code?: string; message?: string } };
      try {
        frame = JSON.parse(line) as typeof frame;
      } catch {
        finish(() => reject(new HerdrError("bad_frame", `herdr sent unparseable frame: ${line.slice(0, 200)}`)));
        return;
      }
      if (frame.error) {
        const { code = "herdr_error", message = "herdr request failed" } = frame.error;
        finish(() => reject(new HerdrError(code, message)));
        return;
      }
      finish(() => resolve(frame.result as T));
    };

    const onData = makeLineReader(handleLine);

    Bun.connect({
      unix: socketAddress(socketPath),
      socket: {
        data(_sock, chunk) {
          onData(chunk);
        },
        error(_sock, err) {
          finish(() => reject(new HerdrError("socket_error", err?.message ?? "herdr socket error")));
        },
        close() {
          finish(() => reject(new HerdrError("closed", `herdr closed the connection before answering ${method}`)));
        },
      },
    })
      .then((sock) => {
        socket = sock;
        if (settled) {
          try {
            sock.end();
          } catch {
            /* already gone */
          }
          return;
        }
        if (guard && !guard()) {
          finish(() => reject(new HerdrError("cancelled", `herdr ${method} was not sent: the sender may no longer send`)));
          return;
        }
        sock.write(`${JSON.stringify({ id, method, params })}\n`);
      })
      .catch((err: Error) => {
        finish(() =>
          reject(new HerdrError("connect_failed", `cannot reach herdr at ${socketPath}: ${err.message}`)),
        );
      });
  });
}

export async function ping(socketPath?: string): Promise<HerdrIdentity> {
  const result = await herdrRpc<{ version: string; protocol: number; capabilities?: Record<string, unknown> }>("ping", {}, socketPath);
  const attach = terminalAttachSupported(result.capabilities);
  // without attach the web server repaints the pane's screen instead (server/mirror.ts)
  return { version: result.version, protocol: result.protocol, terminal_attach: attach, ...(attach ? {} : { terminal_mirror: true }) };
}

export async function sessionSnapshot(socketPath?: string, timeoutMs?: number): Promise<SessionSnapshot> {
  const result = await herdrRpc<{ snapshot: SessionSnapshot }>("session.snapshot", {}, socketPath, timeoutMs);
  return result.snapshot;
}

export async function agentManifests(socketPath?: string): Promise<{ manifests: AgentManifestInfo[] }> {
  return herdrRpc("server.agent_manifests", {}, socketPath);
}

export interface WorkspaceCreateResult {
  type: "workspace_created";
  workspace: WorkspaceInfo;
  tab: TabInfo;
  root_pane: PaneInfo;
}

export async function workspaceCreate(
  options: { cwd?: string; label?: string },
  socketPath?: string,
): Promise<WorkspaceCreateResult> {
  return herdrRpc(
    "workspace.create",
    { ...(options.cwd === undefined ? {} : { cwd: options.cwd }), ...(options.label === undefined ? {} : { label: options.label }), focus: false },
    socketPath,
  );
}

export interface TabCreateResult {
  type: "tab_created";
  tab: TabInfo;
  root_pane: PaneInfo;
}

/** Another tab in an existing workspace. Without `cwd` herdr uses the workspace's folder. */
export async function tabCreate(
  options: { workspaceId: string; cwd?: string; label?: string },
  socketPath?: string,
): Promise<TabCreateResult> {
  return herdrRpc(
    "tab.create",
    { workspace_id: options.workspaceId, ...(options.cwd === undefined ? {} : { cwd: options.cwd }), ...(options.label === undefined ? {} : { label: options.label }), focus: false },
    socketPath,
  );
}

/** herdr keeps the label as given: an empty one leaves the tab without a name, so callers refuse it. */
export async function tabRename(tabId: string, label: string, socketPath?: string): Promise<void> {
  await herdrRpc("tab.rename", { tab_id: tabId, label }, socketPath);
}

/** Closes the tab and every pane in it; a workspace's last tab takes the workspace with it. */
export async function tabClose(tabId: string, socketPath?: string): Promise<void> {
  await herdrRpc("tab.close", { tab_id: tabId }, socketPath);
}

export async function agentStart(
  options: { name: string; kind: string; paneId: string; args?: string[]; timeoutMs?: number },
  socketPath?: string,
): Promise<unknown> {
  return herdrRpc(
    "agent.start",
    {
      name: options.name,
      kind: options.kind,
      pane_id: options.paneId,
      ...(options.args === undefined ? {} : { args: options.args }),
      ...(options.timeoutMs === undefined ? {} : { timeout_ms: options.timeoutMs }),
    } satisfies AgentStartParams,
    socketPath,
    options.timeoutMs,
  );
}

export async function paneRename(paneId: string, label: string | null, socketPath?: string): Promise<void> {
  await herdrRpc("pane.rename", { pane_id: paneId, label }, socketPath);
}

export async function workspaceRename(workspaceId: string, label: string, socketPath?: string): Promise<void> {
  await herdrRpc("workspace.rename", { workspace_id: workspaceId, label }, socketPath);
}

export async function workspaceMove(workspaceId: string, insertIndex: number, socketPath?: string): Promise<void> {
  await herdrRpc("workspace.move", { workspace_id: workspaceId, insert_index: insertIndex }, socketPath);
}

/** closeGroup takes a repository workspace's open worktree workspaces with it; herdr refuses otherwise. */
export async function workspaceClose(workspaceId: string, socketPath?: string, closeGroup = false): Promise<void> {
  await herdrRpc("workspace.close", { workspace_id: workspaceId, ...(closeGroup ? { close_group: true } : {}) }, socketPath);
}

/** `git worktree add` or `remove` on a large checkout can take well over the default 10 s. */
const WORKTREE_GIT_TIMEOUT_MS = 60_000;

/** `git worktree remove` of the workspace's checkout; herdr closes the workspace with it and keeps the branch. */
export async function worktreeRemove(workspaceId: string, force: boolean, socketPath?: string): Promise<{ type: "worktree_removed"; workspace_id: string; path: string; forced: boolean }> {
  return herdrRpc("worktree.remove", { workspace_id: workspaceId, force }, socketPath, WORKTREE_GIT_TIMEOUT_MS);
}

/** herdr's view of one git checkout: `worktree.list` entries, and what create/open hand back. */
export interface WorktreeInfo {
  path: string;
  branch: string | null;
  label: string;
  is_linked_worktree: boolean;
  is_bare: boolean;
  is_detached: boolean;
  is_prunable: boolean;
  open_workspace_id: string | null;
}

export interface WorktreeSourceInfo {
  repo_key: string;
  repo_name: string;
  repo_root: string;
  source_checkout_path: string;
  source_workspace_id: string | null;
}

export interface WorktreeOpenResult {
  type: "worktree_created" | "worktree_opened";
  workspace: WorkspaceInfo;
  tab: TabInfo;
  root_pane: PaneInfo;
  worktree: WorktreeInfo;
  /** worktree_opened only: the checkout was a workspace before the call */
  already_open?: boolean;
}

/** A git worktree of the workspace's repository, opened as a new workspace grouped with it. */
export async function worktreeCreate(
  options: { workspaceId: string; branch: string; base?: string; label?: string; path?: string },
  socketPath?: string,
): Promise<WorktreeOpenResult> {
  return herdrRpc("worktree.create", {
    workspace_id: options.workspaceId,
    branch: options.branch,
    ...(options.base === undefined ? {} : { base: options.base }),
    ...(options.label === undefined ? {} : { label: options.label }),
    ...(options.path === undefined ? {} : { path: options.path }),
    focus: false,
  }, socketPath, WORKTREE_GIT_TIMEOUT_MS);
}

export async function worktreeList(workspaceId: string, socketPath?: string): Promise<{ source: WorktreeSourceInfo; worktrees: WorktreeInfo[] }> {
  return herdrRpc("worktree.list", { workspace_id: workspaceId }, socketPath);
}

export async function worktreeOpen(
  options: { workspaceId: string; path?: string; branch?: string; label?: string },
  socketPath?: string,
): Promise<WorktreeOpenResult> {
  return herdrRpc("worktree.open", {
    workspace_id: options.workspaceId,
    ...(options.path === undefined ? {} : { path: options.path }),
    ...(options.branch === undefined ? {} : { branch: options.branch }),
    ...(options.label === undefined ? {} : { label: options.label }),
    focus: false,
  }, socketPath);
}

export interface PaneReadOptions {
  paneId: string;
  source?: ReadSource;
  format?: ReadFormat;
  lines?: number;
  stripAnsi?: boolean;
  /** how long the answer is waited for; herdrRpc's default otherwise */
  timeoutMs?: number;
}

export async function paneRead(options: PaneReadOptions, socketPath?: string): Promise<PaneReadResult> {
  const { paneId, source = "visible", format = "text", lines, stripAnsi, timeoutMs } = options;
  // Escape sequences must survive for xterm.js, so an ansi read defaults to strip_ansi:false.
  const strip = stripAnsi ?? format !== "ansi";
  // Recent text reads can scroll an idle agent's TUI to harvest history. ANSI reads
  // only snapshot stored rows, so automatic polling must convert those to text locally.
  const passiveText = format === "text" && (source === "recent" || source === "recent_unwrapped");
  const params: Record<string, unknown> = { pane_id: paneId, source, format: passiveText ? "ansi" : format, strip_ansi: strip };
  if (lines !== undefined) params["lines"] = lines;
  const result = await herdrRpc<{ read: PaneReadResult }>("pane.read", params, socketPath, timeoutMs);
  return passiveText ? { ...result.read, format, text: strip ? stripVTControlCharacters(result.read.text) : result.read.text } : result.read;
}

/** A cell in a pane's whole history: rows count from the top of the scrollback. */
export interface PaneTextPoint { row: number; col: number }

/** Where the pane's viewport sits in its scrollback; null when herdr reports none. */
export async function paneScrollInfo(paneId: string, socketPath?: string): Promise<PaneScrollInfo | null> {
  const result = await herdrRpc<{ pane: PaneInfo }>("pane.get", { pane_id: paneId }, socketPath);
  return result.pane.scroll ?? null;
}

/** Scrolls the pane's viewport; herdr redraws every attached terminal. */
export async function paneScroll(paneId: string, offsetFromBottom: number, socketPath?: string): Promise<PaneScrollInfo | null> {
  const result = await herdrRpc<{ pane: PaneInfo }>("pane.scroll", { pane_id: paneId, offset_from_bottom: offsetFromBottom }, socketPath);
  return result.pane.scroll ?? null;
}

/**
 * The text between two cells of the pane's whole history, both inclusive, in either
 * order. Rows count from the top of the scrollback; soft-wrapped lines come back joined.
 */
export async function paneSelectionRead(paneId: string, anchor: PaneTextPoint, cursor: PaneTextPoint, socketPath?: string): Promise<string> {
  const result = await herdrRpc<{ text: string }>("pane.selection.read", { pane_id: paneId, anchor, cursor }, socketPath);
  return result.text;
}

export async function paneSendText(paneId: string, text: string, socketPath?: string, guard?: () => boolean): Promise<void> {
  await herdrRpc("pane.send_text", { pane_id: paneId, text }, socketPath, undefined, guard);
}

/**
 * herdr's own agent.prompt: pastes `text` into the pane's agent (bracketed), then its
 * Enter 300ms later, and returns after the Enter. Refuses with agent_blocked while the
 * agent waits for an answer, agent_not_found / agent_not_ready without an agent in front.
 */
export async function agentPrompt(target: string, text: string, socketPath?: string): Promise<void> {
  await herdrRpc("agent.prompt", { target, text }, socketPath);
}

export async function paneSendKeys(paneId: string, keys: string[], socketPath?: string, guard?: () => boolean): Promise<void> {
  await herdrRpc("pane.send_keys", { pane_id: paneId, keys }, socketPath, undefined, guard);
}

export async function paneClose(paneId: string, socketPath?: string): Promise<void> {
  await herdrRpc("pane.close", { pane_id: paneId }, socketPath);
}

export interface HerdrSubscription {
  type: string;
  pane_id?: string;
  [key: string]: unknown;
}

export interface EventFrame {
  event?: string;
  data?: Record<string, unknown>;
}

export interface SubscribeHandlers {
  onEvent: (frame: EventFrame) => void;
  onStarted?: () => void;
  onError?: (err: Error) => void;
  onClose?: () => void;
}

export interface Subscription {
  close: () => void;
}

/**
 * Long-lived connection. Unlike ordinary RPC, events.subscribe keeps the socket
 * open and streams frames until the caller closes it.
 */
export function subscribeEvents(
  subscriptions: HerdrSubscription[],
  handlers: SubscribeHandlers,
  socketPath: string = herdrSocketPath(),
): Subscription {
  let closed = false;
  let socket: { end: () => void } | null = null;
  let started = false;

  const onData = makeLineReader((line) => {
    // closed by the caller: frames still buffered belong to a subscription it replaced
    if (closed) return;
    let frame: { id?: string; result?: { type?: string }; error?: { code?: string; message?: string } } & EventFrame;
    try {
      frame = JSON.parse(line) as typeof frame;
    } catch {
      return;
    }
    if (frame.error) {
      handlers.onError?.(new HerdrError(frame.error.code ?? "herdr_error", frame.error.message ?? "subscription failed"));
      return;
    }
    if (!started && frame.result?.type === "subscription_started") {
      started = true;
      handlers.onStarted?.();
      return;
    }
    handlers.onEvent(frame);
  });

  Bun.connect({
    unix: socketAddress(socketPath),
    socket: {
      data(_sock, chunk) {
        onData(chunk);
      },
      error(_sock, err) {
        if (!closed) handlers.onError?.(new HerdrError("socket_error", err?.message ?? "herdr socket error"));
      },
      close() {
        if (!closed) {
          closed = true;
          handlers.onClose?.();
        }
      },
    },
  })
    .then((sock) => {
      socket = sock;
      if (closed) {
        try {
          sock.end();
        } catch {
          /* already gone */
        }
        return;
      }
      sock.write(`${JSON.stringify({ id: nextId(), method: "events.subscribe", params: { subscriptions } })}\n`);
    })
    .catch((err: Error) => {
      handlers.onError?.(new HerdrError("connect_failed", err.message));
      // a connect that never opened never closes either: report it as closed, or a
      // subscriber that retries on close (the status collector) waits forever after
      // one failed reconnect, e.g. while herdr restarts
      if (!closed) {
        closed = true;
        handlers.onClose?.();
      }
    });

  return {
    close() {
      if (closed) return;
      closed = true;
      try {
        socket?.end();
      } catch {
        /* already gone */
      }
    },
  };
}
