/**
 * The sidebar's Activity order for the Agents list.
 *
 * Activity keeps a waiting agent on top and then the latest change, so the latest work is where
 * you look. Recency is herdr's `state_change_seq`, one counter per herdr session bumped on every
 * agent state change. `session.snapshot` leaves it off `panes` and carries it on `agents`.
 */
import type { AgentStatus, HerdrPane, PaneInfo, SessionSnapshot } from "../../shared/protocol.ts";
import { knownStatus, paneStatus } from "./status.ts";

/** Each agent pane's `state_change_seq`. Panes without an agent have none. */
export function stateSeqs(snapshot: Pick<SessionSnapshot, "agents"> | null | undefined): Map<string, number> {
  const seqs = new Map<string, number>();
  for (const agent of snapshot?.agents ?? []) {
    const seq = agent.state_change_seq;
    if (seq !== undefined && Number.isFinite(seq)) seqs.set(agent.pane_id, seq);
  }
  return seqs;
}

/**
 * What `liveSeqs` remembers between snapshots: each pane's last status, the changes it dated
 * itself (`bumped`), and herdr's own counter per pane at the last call (`real`).
 */
export interface SeqMemory { status: Map<string, unknown>; bumped: Map<string, number>; real: Map<string, number> }
export const newSeqMemory = (): SeqMemory => ({ status: new Map(), bumped: new Map(), real: new Map() });

/**
 * `stateSeqs`, kept in step with pushed statuses. A pane-status push lands in the snapshot at once
 * (applyPaneStatus), but the counter only comes with the next roster read, up to POLL_MS later: a
 * pane sent a message would sit in its old place. So a status that changed since the last call is
 * dated now, just above every counter known; herdr's own counter for that change is higher and takes
 * over when it comes. A change that arrives with a new counter of herdr's (a roster read that saw it
 * first) keeps that counter, so herdr's order between changes stands, and drops the pane's earlier
 * stand-in, which dated an older change. A counter that went back means herdr restarted: every
 * stand-in is dropped. Mutates `memory`.
 */
export function liveSeqs(snapshot: Pick<SessionSnapshot, "agents" | "panes"> | null | undefined, memory: SeqMemory): Map<string, number> {
  const seqs = stateSeqs(snapshot);
  const panes = snapshot?.panes ?? [];
  if ([...seqs].some(([id, real]) => real < (memory.real.get(id) ?? real))) memory.bumped.clear();
  let top = Math.max(0, ...seqs.values(), ...memory.bumped.values());
  for (const pane of panes) {
    const changed = memory.status.has(pane.pane_id) && memory.status.get(pane.pane_id) !== pane.agent_status;
    const real = seqs.get(pane.pane_id);
    const before = memory.real.get(pane.pane_id);
    if (changed && real !== undefined) {
      if (before !== undefined && real <= before) memory.bumped.set(pane.pane_id, top += 0.001);
      // herdr's counter moved with the change: it dates it, and a stand-in from before is stale
      else memory.bumped.delete(pane.pane_id);
    }
    memory.status.set(pane.pane_id, pane.agent_status);
  }
  for (const [id, real] of seqs) memory.real.set(id, real);
  const open = new Set(panes.map((pane) => pane.pane_id));
  if (panes.length > 0) {
    for (const id of memory.status.keys()) if (!open.has(id)) memory.status.delete(id);
    for (const id of memory.real.keys()) if (!open.has(id)) memory.real.delete(id);
  }
  for (const [id, bump] of memory.bumped) {
    const real = seqs.get(id);
    if (real === undefined || real > bump) memory.bumped.delete(id);
    else seqs.set(id, bump);
  }
  return seqs;
}

/** The status to draw: herdr's own, or BG while the pane holds its turn for background work. */
export function shownStatus(pane: Pick<HerdrPane, "agent_status" | "background_wait">): AgentStatus | undefined {
  return pane.background_wait ? paneStatus(pane) : pane.agent_status;
}

/**
 * Rows in Activity order: a blocked one first, then the most recent state change, then the
 * order given. State is not ranked otherwise: ranking moved a row the moment its state changed (a
 * pane sent a message fell below every DONE while it ran and jumped back when it finished), where
 * recency keeps the row just worked in on top while it runs and after it finishes.
 */
export function activityOrder<T>(rows: readonly T[], paneOf: (row: T) => Pick<PaneInfo, "pane_id" | "agent_status">, seqs: ReadonlyMap<string, number>): T[] {
  return rows
    .map((row, index) => {
      const pane = paneOf(row);
      return { row, index, rank: knownStatus(pane.agent_status) === "blocked" ? 0 : 1, recent: seqs.get(pane.pane_id) ?? -1 };
    })
    .sort((a, b) => a.rank - b.rank || b.recent - a.recent || a.index - b.index)
    .map((entry) => entry.row);
}
