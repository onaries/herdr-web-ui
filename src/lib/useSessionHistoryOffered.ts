import { useEffect, useState } from "react";
import { LOCAL_MACHINE } from "../../shared/machines.ts";
import { useMachineApi, useMachineId } from "./machineContext.tsx";

const probes = new Map<string, Promise<boolean>>();

/**
 * One probe per PC, shared by every pane and menu that asks while the PC stays online: a PC is asked
 * once, not once per terminal pane. A probe that fails is forgotten, so the next caller asks again.
 */
export function sharedSessionHistoryProbe(machineId: string, ask: () => Promise<boolean>): Promise<boolean> {
  const known = probes.get(machineId);
  if (known) return known;
  const probe = ask();
  probes.set(machineId, probe);
  probe.catch(() => { if (probes.get(machineId) === probe) probes.delete(machineId); });
  return probe;
}

/** The PC went away: once it is back it is asked again (its bridge may have been updated meanwhile). */
export function forgetSessionHistoryProbe(machineId: string): void {
  probes.delete(machineId);
}

/**
 * Forgets the answer of every PC the PCs' own states show away (not connected, or no longer listed),
 * so a PC that comes back is asked again whether or not a pane or menu of it was mounted to see it
 * go. App calls it with every change of the PC list, which owns their connection states.
 */
export function forgetSessionHistoryProbesOfPcsAway(machines: readonly { id: string; state: string }[]): void {
  for (const machineId of [...probes.keys()]) {
    if (!machines.some((machine) => machine.id === machineId && machine.state === "connected")) probes.delete(machineId);
  }
}

/**
 * Whether this PC's bridge lists earlier sessions (GET /api/sessions/history): this PC's bridge
 * does; another PC's is asked once while it is online, without listing anything (a bridge from
 * before the route answers 404), and again whenever it comes back. The workspace row's menu and
 * the chat's /resume offer the list only where it is.
 */
export function useSessionHistoryOffered(online: boolean): boolean {
  const machineId = useMachineId();
  const { sessionHistoryOffered } = useMachineApi();
  const [offered, setOffered] = useState(machineId === LOCAL_MACHINE);
  useEffect(() => {
    // a PC away is forgotten by App from the PCs' states (forgetSessionHistoryProbesOfPcsAway)
    if (machineId === LOCAL_MACHINE || !online) return;
    let live = true;
    sharedSessionHistoryProbe(machineId, sessionHistoryOffered).then((answer) => { if (live) setOffered(answer); }, () => { /* not reached: asked again when it is back */ });
    return () => { live = false; };
  }, [machineId, online, sessionHistoryOffered]);
  return offered;
}
