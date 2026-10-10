/**
 * Where a pane can be moved (the "Move pane to…" menu) and what this browser keeps about a
 * pane under its id, carried over when a move gives the pane a new one.
 */
import type { PaneMoveReason } from "../../shared/herdr-api.generated.ts";
import { paneStorageId } from "../../shared/machines.ts";
import type { MovePaneDestination, PaneInfo, SessionSnapshot } from "../../shared/protocol.ts";
import { composerDrafts, type ComposerDraftStore } from "./composerDraft.ts";
import { tabLabel } from "./tabName.ts";
import { readTerminalDraft, terminalDraftSending, writeTerminalDraft } from "./terminalDraft.ts";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

export interface MoveTarget {
  id: string;
  kind: "new-tab" | "tab" | "workspace" | "new-workspace";
  label: string;
  destination: MovePaneDestination;
  /** the first of a group: drawn under a hairline */
  divider?: boolean;
}

/**
 * The menu's order: a new tab of the pane's workspace, that workspace's other tabs as the strip
 * orders them, every other workspace (the pane lands in a new tab there) in the sidebar's order,
 * then a workspace of its own. The pane's own tab is left out: herdr would answer same_tab.
 */
export function paneMoveTargets(snapshot: Pick<SessionSnapshot, "tabs" | "workspaces">, pane: Pick<PaneInfo, "workspace_id" | "tab_id">, t: Translate): MoveTarget[] {
  // snapshot order, as the strip shows them: after a reorder a tab's number no longer says its place
  const tabs = snapshot.tabs.filter((tab) => tab.workspace_id === pane.workspace_id);
  const own: MoveTarget[] = [
    { id: "new-tab", kind: "new-tab", label: t("New tab"), destination: { type: "new_tab" } },
    ...tabs.flatMap((tab, index): MoveTarget[] => tab.tab_id === pane.tab_id ? [] : [{ id: `tab:${tab.tab_id}`, kind: "tab", label: tabLabel(tab, t, index + 1), destination: { type: "tab", tab_id: tab.tab_id } }]),
  ];
  const others = snapshot.workspaces
    .filter((workspace) => workspace.workspace_id !== pane.workspace_id)
    .map((workspace, index): MoveTarget => ({ id: `workspace:${workspace.workspace_id}`, kind: "workspace", label: workspace.label, destination: { type: "new_tab", workspace_id: workspace.workspace_id }, divider: index === 0 }));
  return [...own, ...others, { id: "new-workspace", kind: "new-workspace", label: t("New workspace"), destination: { type: "new_workspace" }, divider: true }];
}

/**
 * herdr's reason for leaving the pane where it was (`changed: false`), in words for the error
 * line under the menu's button: what to do about a zoomed tab, a pane already in place, and any
 * reason this build does not know as herdr named it.
 */
export function moveRefusal(reason: PaneMoveReason | null | undefined, t: Translate): string {
  switch (reason) {
    case "zoomed_tab": return t("the tab is zoomed; unzoom it in herdr, then move the pane");
    case "same_tab": return t("the pane is already in that tab");
    default: return reason ? reason : t("herdr left the pane where it was");
  }
}

/*
 * The moves this client asked for and has no answer to yet, by PC and pane. A roster without a
 * pending move's pane is the move half done, not the pane gone: the answer names the id to
 * follow, and App's selection waits for it instead of falling back to herdr's focus, which a
 * roster update that outruns the answer would have it do. A move made elsewhere (the TUI,
 * another client) is never pending here.
 */
const pendingMoves = new Set<string>();
const moveListeners = new Set<() => void>();
let moveVersion = 0;
const movesChanged = (): void => { moveVersion += 1; for (const listener of moveListeners) listener(); };
export function subscribePaneMoves(listener: () => void): () => void { moveListeners.add(listener); return () => { moveListeners.delete(listener); }; }
/** another number each time a move begins or ends: an effect that must look again lists it */
export function paneMovesVersion(): number { return moveVersion; }
export function beginPaneMove(machineId: string, paneId: string): void { pendingMoves.add(paneStorageId(machineId, paneId)); movesChanged(); }
export function endPaneMove(machineId: string, paneId: string): void { pendingMoves.delete(paneStorageId(machineId, paneId)); movesChanged(); }
export function paneMovePending(machineId: string, paneId: string | null): boolean { return paneId !== null && pendingMoves.has(paneStorageId(machineId, paneId)); }

type CarriedStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
/** the phone's terminal line (lib/terminalDraft.ts): a store of its own, in memory where storage is blocked */
interface TerminalLines { read: (owner: string) => string; write: (owner: string, text: string) => void; sending: (owner: string) => boolean }
const terminalLines: TerminalLines = { read: readTerminalDraft, write: writeTerminalDraft, sending: terminalDraftSending };

/**
 * The records this browser keeps per pane that follow it to a new id: the lens it was last
 * viewed in and the three unsent drafts (the terminal's held input, the phone's terminal line and
 * the composer's). Text on its way stays under the old id: a send, this tab's or another's (the
 * composer's lease in storage is read first), is acknowledged under the owner that sent it, and
 * a held message or a pending send names a lease the server gave that pane, which the move does
 * not carry.
 */
export function carryPaneRecords(
  machineId: string,
  previousPaneId: string,
  paneId: string,
  deps: { storage: () => CarriedStorage; drafts: Pick<ComposerDraftStore, "read" | "set" | "refresh">; lines?: TerminalLines } = { storage: () => window.localStorage, drafts: composerDrafts },
): void {
  if (previousPaneId === paneId) return;
  const from = paneStorageId(machineId, previousPaneId);
  const to = paneStorageId(machineId, paneId);
  for (const prefix of ["herdr-web-ui:view:", "herdr-web-ui:terminal-draft:"]) {
    try {
      const value = deps.storage().getItem(prefix + from);
      if (value === null) continue;
      deps.storage().setItem(prefix + to, value);
      deps.storage().removeItem(prefix + from);
    } catch { /* storage blocked: the record stays where it was */ }
  }
  const lines = deps.lines ?? terminalLines;
  const line = lines.read(from);
  if (line !== "" && !lines.sending(from)) {
    lines.write(to, line);
    lines.write(from, "");
  }
  const draftKey = `herdr-web-ui:composer-draft:${from}`;
  // a store that never read this draft (the move came from the sidebar, the composer closed) would
  // seed it as not sending: the refresh reads the lease another tab's send left in storage
  deps.drafts.refresh(draftKey);
  const draft = deps.drafts.read(draftKey);
  if (draft.sending || draft.text === "") return;
  deps.drafts.set(`herdr-web-ui:composer-draft:${to}`, draft.text);
  deps.drafts.set(draftKey, "");
}
