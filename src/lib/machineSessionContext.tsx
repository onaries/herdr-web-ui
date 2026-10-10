import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { MachineSessionRegistry } from "./machineSession.ts";

const MachineSessionsContext = createContext<MachineSessionRegistry | null>(null);
export const useMachineSessions = () => useContext(MachineSessionsContext);

/** Authenticated app lifetime, across PC and pane switches. A terminal owns only its attach. */
export function MachineSessionsProvider({ machineIds, children }: { machineIds: readonly string[]; children: ReactNode }) {
  const [sessions] = useState(() => new MachineSessionRegistry());
  const ids = JSON.stringify(machineIds);
  useEffect(() => {
    // An initial empty roster is not evidence that every PC was removed.
    if (machineIds.length) sessions.retainMachines(new Set(machineIds));
  }, [sessions, ids]);
  useEffect(() => () => sessions.closeAll(), [sessions]);
  return <MachineSessionsContext.Provider value={sessions}>{children}</MachineSessionsContext.Provider>;
}
