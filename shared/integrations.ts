/**
 * GET /api/integrations: one of herdr's built-in agent integrations (`integration.list`, herdr
 * 0.9.3; the saved schema predates it, so the shape is written out here). `state` widens like the
 * generated enums: a newer herdr may report one this build does not know.
 */
export interface AgentIntegration {
  /** herdr's integration target, e.g. `claude`, `antigravity_cli` */
  target: string;
  /** the name herdr shows, also the argument `herdr integration install` takes */
  label: string;
  /** the agent's executable */
  command: string;
  /** whether that executable is on the PATH of the PC herdr runs on */
  available: boolean;
  state: "not_installed" | "current" | "outdated" | (string & {});
}

export interface IntegrationsResponse {
  integrations: AgentIntegration[];
}
