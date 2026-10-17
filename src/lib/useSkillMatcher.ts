import { useEffect, useState } from "react";

import { skillSyntax } from "../../shared/skill-syntax.ts";
import { useMachineApi, useMachineId } from "./machineContext.tsx";
import { cachedPaneCommands } from "./paneCommandCache.ts";
import { createSkillMatcher, type SkillMatcher } from "./skillMentions.ts";

/** The pane's skill names as a matcher, from its command list; null until it loads, or when it fails. */
export function useSkillMatcher(paneId: string, agent?: string | null): SkillMatcher | null {
  const { fetchPaneCommands } = useMachineApi();
  const machineId = useMachineId();
  const [loaded, setLoaded] = useState<{ key: string; matcher: SkillMatcher | null } | null>(null);
  const key = `${machineId}:${paneId}:${agent ?? ""}`;
  useEffect(() => {
    let live = true;
    cachedPaneCommands(paneId, machineId, agent, fetchPaneCommands).then(
      (commands) => { if (live) setLoaded({ key, matcher: createSkillMatcher(commands, skillSyntax(agent)) }); },
      () => { if (live) setLoaded({ key, matcher: null }); },
    );
    return () => { live = false; };
  }, [fetchPaneCommands, paneId, machineId, key, agent]);
  return loaded?.key === key ? loaded.matcher : null;
}
