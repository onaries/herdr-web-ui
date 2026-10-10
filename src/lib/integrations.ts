import type { AgentIntegration } from "../../shared/protocol.ts";
import { ApiError } from "./api.ts";

/** What asking one PC for its agent integrations came to. */
export type IntegrationsOutcome =
  | { kind: "list"; integrations: AgentIntegration[] }
  /** a bridge from before the endpoint existed: it answers 404 for the route */
  | { kind: "unsupported" }
  | { kind: "error"; message: string };

/** An outcome tagged with the PC it was asked of, so it is never shown for another one. */
export interface IntegrationsResult {
  machineId: string;
  outcome: IntegrationsOutcome;
}

export async function loadIntegrations(fetchList: () => Promise<AgentIntegration[]>): Promise<IntegrationsOutcome> {
  try {
    return { kind: "list", integrations: await fetchList() };
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 404) return { kind: "unsupported" };
    return { kind: "error", message: cause instanceof Error ? cause.message : String(cause) };
  }
}

/** The outcome to show for `machineId`: null (still loading) until that PC's own answer has arrived. */
export function outcomeFor(result: IntegrationsResult | null, machineId: string): IntegrationsOutcome | null {
  return result !== null && result.machineId === machineId ? result.outcome : null;
}
