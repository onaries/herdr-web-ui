import type { AgentStatus, HerdrPane, SessionSnapshot } from "../../shared/protocol.ts";

/**
 * Merges a pushed `pane-status` into the last snapshot so the sidebar badge updates
 * instantly; the debounced /api/session refetch that follows brings the derived
 * workspace/tab rollups back in line. Pure: returns the same object when nothing changed.
 */
export function applyPaneStatus(snapshot: SessionSnapshot, paneId: string, status: AgentStatus, background?: number, waiting = false): SessionSnapshot {
  let paneChanged = false;
  const panes = snapshot.panes.map((pane: HerdrPane) => {
    // a frame that says nothing of background tasks leaves it as it was; every frame says whether the pane waits
    const tasks = background === undefined ? pane.background_tasks : background > 0 ? background : undefined;
    if (pane.pane_id !== paneId || (pane.agent_status === status && pane.background_tasks === tasks && (pane.background_wait === true) === waiting)) return pane;
    paneChanged = true;
    const { background_tasks: _before, background_wait: _waited, ...rest } = pane;
    return { ...rest, agent_status: status, ...(tasks === undefined ? {} : { background_tasks: tasks }), ...(waiting ? { background_wait: true as const } : {}) };
  });
  if (!paneChanged) return snapshot;
  const agents = snapshot.agents.map((agent) =>
    agent.pane_id === paneId && agent.agent_status !== status ? { ...agent, agent_status: status } : agent,
  );
  return { ...snapshot, panes, agents };
}
