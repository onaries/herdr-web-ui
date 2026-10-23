/** GET /api/agents: one agent kind herdr can start (`agent.start` kind), with a display label. */
export interface AgentKind {
  kind: string;
  label: string;
  /** whether the server finds the agent's command (its kind) on its PATH; absent from an older bridge */
  installed?: boolean;
}
