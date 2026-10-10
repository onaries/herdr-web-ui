/**
 * What both sidebar lists share for Settings → Agents order and Quiet opened finishes: herdr's
 * state_change_seq per pane on each PC, kept in step with pushed statuses, and this browser's
 * record of the finishes looked at here. MachineSidebar owns it (`useSidebarActivityState`) and
 * provides it; the workspace rows and the Agents list read it (`useSidebarActivity`). The logic
 * itself is in lib/sidebarOrder.ts.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Machine } from "../../shared/machines.ts";
import type { AgentStatus, HerdrPane } from "../../shared/protocol.ts";
import { useSettings } from "./settings.ts";
import { anySeen, carrySeen, forgetSeen, liveSeqs, loadSeen, markSeen, newSeqMemory, persistableSeen, pruneSeen, saveSeen, seedSeen, seenAfterRestart, shownStatus, type SeenRecord, type SeqMemory } from "./sidebarOrder.ts";

export interface SidebarActivity {
  /** herdr's state_change_seq per pane on a PC, a pushed status change dated at once */
  seqs(machineId: string): ReadonlyMap<string, number>;
  /** the status a row draws for a pane: with Quiet opened finishes on, a DONE looked at here reads as ready */
  status(machineId: string, pane: Pick<HerdrPane, "pane_id" | "agent_status" | "background_wait">): AgentStatus | undefined;
}

const NO_SEQS: ReadonlyMap<string, number> = new Map();
const SidebarActivityContext = createContext<SidebarActivity>({ seqs: () => NO_SEQS, status: (_machineId, pane) => shownStatus(pane, NO_SEQS, null) });
export const SidebarActivityProvider = SidebarActivityContext.Provider;
export const useSidebarActivity = (): SidebarActivity => useContext(SidebarActivityContext);

export function useSidebarActivityState(machines: readonly Machine[], selectedMachineId: string, selectedPaneId: string | null): SidebarActivity {
  const { settings } = useSettings();
  const memories = useRef(new Map<string, SeqMemory>());
  const seqsByMachine = useMemo(() => new Map(machines.map((machine) => {
    let memory = memories.current.get(machine.id);
    if (!memory) memories.current.set(machine.id, memory = newSeqMemory());
    return [machine.id, liveSeqs(machine.snapshot, memory)] as const;
  })), [machines]);

  // The pane on screen, while the page is visible, is looked at at its current counter. The first
  // time the setting is on in this browser, everything open counts as looked at, so the lists
  // start quiet; a PC first seen after that starts with nothing looked at.
  const [seen, setSeen] = useState<ReadonlyMap<string, SeenRecord>>(() => new Map());
  // per PC, the herdr restarts (SeqMemory.restarts) its record was last kept through
  const restartsHandled = useRef(new Map<string, number>());
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const onVisibility = () => setPageVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);
  useEffect(() => {
    if (!settings.quietOpenedDone) return;
    const firstUse = !anySeen();
    // read here, not in the updater: an updater can run twice, and after a newer roster read
    const handled = new Map(restartsHandled.current);
    const restarts = new Map(machines.map((machine) => [machine.id, memories.current.get(machine.id)?.restarts ?? 0]));
    for (const machine of machines) {
      if (!machine.snapshot || machine.state !== "connected") continue;
      // the stored record goes too, or persistableSeen would bring an old counter back for a look
      // recorded at a stand-in after the restart
      if (restarts.get(machine.id)! > (handled.get(machine.id) ?? 0)) saveSeen(machine.id, {});
      restartsHandled.current.set(machine.id, restarts.get(machine.id)!);
    }
    setSeen((current) => {
      let next: Map<string, SeenRecord> | null = null;
      for (const machine of machines) {
        // a PC that is away keeps its record: its saved roster says nothing new
        if (!machine.snapshot || machine.state !== "connected") continue;
        const seqs = seqsByMachine.get(machine.id) ?? NO_SEQS;
        const before = current.get(machine.id);
        // after a herdr restart the whole record is from the earlier session, in storage too (#591)
        const kept = before ?? loadSeen(machine.id);
        let record = kept ? seenAfterRestart(kept, restarts.get(machine.id)!, handled.get(machine.id) ?? 0) : firstUse ? seedSeen(machine.snapshot.panes, seqs) : {};
        // a look recorded at a stand-in counter follows it to herdr's own (lib/sidebarOrder.ts carrySeen)
        record = carrySeen(record, memories.current.get(machine.id)?.promoted ?? new Map());
        const seq = machine.id === selectedMachineId && selectedPaneId && pageVisible ? seqs.get(selectedPaneId) : undefined;
        if (selectedPaneId && seq !== undefined) record = markSeen(record, selectedPaneId, seq);
        record = pruneSeen(record, machine.snapshot.panes, seqs);
        if (record !== before) (next ??= new Map(current)).set(machine.id, record);
      }
      return next ?? current;
    });
  }, [settings.quietOpenedDone, machines, seqsByMachine, selectedMachineId, selectedPaneId, pageVisible]);
  useEffect(() => {
    // storage gets herdr's counters only: a stand-in waits in memory until it is carried (persistableSeen)
    for (const [machineId, record] of seen) saveSeen(machineId, persistableSeen(record, loadSeen(machineId)));
  }, [seen]);
  // a removed PC takes its record with it; an empty roster is one still loading
  useEffect(() => {
    if (machines.length === 0) return;
    const ids = new Set(machines.map((machine) => machine.id));
    forgetSeen(ids);
    setSeen((current) => [...current.keys()].every((id) => ids.has(id)) ? current : new Map([...current].filter(([id]) => ids.has(id))));
  }, [machines]);

  // drawn with the carry applied too, so a finish looked at does not flash its dot for the one
  // render between the roster read and the effect above
  const carryOpened = (machineId: string): SeenRecord | null => {
    const record = seen.get(machineId);
    const memory = memories.current.get(machineId);
    // a restart this render's roster read noticed: the record is dropped by the effect above, not drawn meanwhile
    if (memory && memory.restarts > (restartsHandled.current.get(machineId) ?? 0)) return null;
    return record ? carrySeen(record, memories.current.get(machineId)?.promoted ?? new Map()) : null;
  };
  return useMemo<SidebarActivity>(() => ({
    seqs: (machineId) => seqsByMachine.get(machineId) ?? NO_SEQS,
    status: (machineId, pane) => shownStatus(pane, seqsByMachine.get(machineId) ?? NO_SEQS, settings.quietOpenedDone ? carryOpened(machineId) : null),
  }), [seqsByMachine, seen, settings.quietOpenedDone]);
}
