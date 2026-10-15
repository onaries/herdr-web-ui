/**
 * What both sidebar lists share for Settings → Agents order: herdr's state_change_seq per pane on
 * each PC, kept in step with pushed statuses. MachineSidebar owns it (`useSidebarActivityState`)
 * and provides it; the workspace rows and the Agents list read it (`useSidebarActivity`). The
 * logic itself is in lib/sidebarOrder.ts.
 */
import { createContext, useContext, useMemo, useRef } from "react";
import type { Machine } from "../../shared/machines.ts";
import type { AgentStatus, HerdrPane } from "../../shared/protocol.ts";
import { liveSeqs, newSeqMemory, shownStatus, type SeqMemory } from "./sidebarOrder.ts";

export interface SidebarActivity {
  /** herdr's state_change_seq per pane on a PC, a pushed status change dated at once */
  seqs(machineId: string): ReadonlyMap<string, number>;
  /** the status a row draws for a pane */
  status(machineId: string, pane: Pick<HerdrPane, "pane_id" | "agent_status" | "background_wait">): AgentStatus | undefined;
}

const NO_SEQS: ReadonlyMap<string, number> = new Map();
const SidebarActivityContext = createContext<SidebarActivity>({ seqs: () => NO_SEQS, status: (_machineId, pane) => shownStatus(pane) });
export const SidebarActivityProvider = SidebarActivityContext.Provider;
export const useSidebarActivity = (): SidebarActivity => useContext(SidebarActivityContext);

export function useSidebarActivityState(machines: readonly Machine[]): SidebarActivity {
  const memories = useRef(new Map<string, SeqMemory>());
  const seqsByMachine = useMemo(() => new Map(machines.map((machine) => {
    let memory = memories.current.get(machine.id);
    if (!memory) memories.current.set(machine.id, memory = newSeqMemory());
    return [machine.id, liveSeqs(machine.snapshot, memory)] as const;
  })), [machines]);
  return useMemo<SidebarActivity>(() => ({
    seqs: (machineId) => seqsByMachine.get(machineId) ?? NO_SEQS,
    status: (_machineId, pane) => shownStatus(pane),
  }), [seqsByMachine]);
}
