/**
 * Starting the agent a create request names in the pane herdr just made: the request's own check
 * of `agent`, then the start, which retries a pane whose shell is not up yet and a name another
 * agent took. Workspace, tab and worktree creation share it.
 */
import { freeAgentName } from "./agent-name.ts";
import { launchedAgents } from "./launched-agents.ts";
import { isShellAgentKind, startShellAgent } from "./shell-agent.ts";
import { agentStart, HerdrError, sessionSnapshot } from "./herdr/client.ts";

export type AgentPayload = { kind?: unknown; name?: unknown; args?: unknown };

/** What is wrong with a request's `agent`, in the API's words; null when it can be started. */
export function agentFault(agent: AgentPayload | undefined): string | null {
  if (agent === undefined) return null;
  if (typeof agent !== "object" || typeof agent.kind !== "string" || agent.kind.length === 0) return "agent.kind is required";
  if ((agent.name !== undefined && typeof agent.name !== "string")
    || (agent.args !== undefined && (!Array.isArray(agent.args) || !agent.args.every((arg) => typeof arg === "string")))) {
    return "agent.name must be a string and agent.args must be an array of strings";
  }
  return null;
}

/**
 * Starts a checked `agent` in a pane herdr just made. A failure is answered, not thrown: the
 * workspace, tab or worktree around the pane is there either way.
 */
export async function agentLaunch(paneId: string, agent: AgentPayload): Promise<{ agent_started: true } | { agent_started: false; error: { code: string; message: string } }> {
  try {
    const kind = agent.kind as string;
    const args = agent.args as string[] | undefined;
    if (isShellAgentKind(kind)) await startShellAgent(kind, paneId, args);
    else {
      const given = typeof agent.name === "string" && agent.name.length > 0 ? agent.name : null;
      // herdr refuses a name another agent holds. Two creations at once can pick the same
      // free one: the refused one picks again. It also refuses a pane whose shell is not up
      // yet (`agent_pane_busy`, herdr 0.9.3), which a pane made a moment ago can be.
      const shellDeadline = Date.now() + 10_000;
      for (let attempt = 1; ; ) {
        try {
          await agentStart({
            name: given ?? freeAgentName(kind, (await sessionSnapshot()).agents.map((running) => running.name)),
            kind,
            paneId,
            ...(args === undefined ? {} : { args }),
            timeoutMs: 60_000,
          });
          break;
        } catch (error) {
          if (!(error instanceof HerdrError)) throw error;
          if (error.code === "agent_pane_busy" && Date.now() < shellDeadline) {
            await Bun.sleep(100);
            continue;
          }
          if (given !== null || attempt === 3 || error.code !== "agent_name_taken") throw error;
          attempt += 1;
        }
      }
    }
    launchedAgents.launched(paneId, kind);
    return { agent_started: true };
  } catch (error) {
    return {
      agent_started: false,
      error: {
        code: error instanceof HerdrError ? error.code : "agent_start_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
