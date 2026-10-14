import { useEffect, useState } from "react";

import { useMachineApi, useMachineId } from "./machineContext.tsx";
import { cachedPaneCommands } from "./paneCommandCache.ts";
import { createSkillMatcher, type SkillMatcher } from "./skillMentions.ts";

/** The pane's skill names as a matcher, from its command list; null until it loads, or when it fails. */
export function useSkillMatcher(paneId: string): SkillMatcher | null {
  const { fetchPaneCommands } = useMachineApi();
  const machineId = useMachineId();
  const [loaded, setLoaded] = useState<{ key: string; matcher: SkillMatcher | null } | null>(null);
  const key = `${machineId}:${paneId}`;
  useEffect(() => {
    let live = true;
    cachedPaneCommands(paneId, machineId, fetchPaneCommands).then(
      (commands) => { if (live) setLoaded({ key, matcher: createSkillMatcher(commands) }); },
      () => { if (live) setLoaded({ key, matcher: null }); },
    );
    return () => { live = false; };
  }, [fetchPaneCommands, paneId, machineId, key]);
  return loaded?.key === key ? loaded.matcher : null;
}
