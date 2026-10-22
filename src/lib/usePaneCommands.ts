import { useEffect, useState } from "react";

import type { SlashCommand } from "../../shared/protocol.ts";
import { useMachineApi, useMachineId } from "./machineContext.tsx";
import { cachedPaneCommands, onPaneCommandsInvalidated } from "./paneCommandCache.ts";

const EMPTY_COMMANDS: readonly SlashCommand[] = [];

/** The same catalog classifies menu picks, typed sends and sent rows, scoped to this PC and agent. */
export function usePaneCommands(paneId: string | null, agent?: string | null): readonly SlashCommand[] {
  const { fetchPaneCommands } = useMachineApi();
  const machineId = useMachineId();
  const key = `${machineId}:${paneId}:${agent ?? ""}`;
  const [loaded, setLoaded] = useState<{ key: string; commands: readonly SlashCommand[] } | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => onPaneCommandsInvalidated((pane, machine) => {
    if (pane === paneId && machine === machineId) setVersion((value) => value + 1);
  }), [paneId, machineId]);
  useEffect(() => {
    if (paneId === null) return;
    let live = true;
    void cachedPaneCommands(paneId, machineId, agent, fetchPaneCommands).then(
      (commands) => { if (live) setLoaded({ key, commands }); },
      () => { if (live) setLoaded({ key, commands: EMPTY_COMMANDS }); },
    );
    return () => { live = false; };
  }, [paneId, machineId, agent, fetchPaneCommands, key, version]);
  return loaded?.key === key ? loaded.commands : EMPTY_COMMANDS;
}
