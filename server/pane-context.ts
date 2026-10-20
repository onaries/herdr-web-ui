/**
 * The agent a pane runs and the folder it works in, as herdr has them now: read by the HTTP routes and by
 * the core (server/core) alike, so it lives in neither.
 */
import type { HerdrPane } from "../shared/protocol.ts";
import { storeAgentVersion, type VersionSource } from "./agent-version.ts";
import { type NativeTranscript, paneProcessRoots } from "./conversation.ts";
import { HerdrError, paneGet } from "./herdr/client.ts";

/** What paneProcessRoots found in a pane's foreground: `omo` is set when omo itself runs there. */
export type PaneRoots = { omo: unknown } | null | undefined;

/**
 * The agent a pane runs, and the version of it its own session store records. herdr labels an omo pane
 * `pi` while it waits and `claude` while its claude-sdk child runs, so a pane whose `roots` find omo
 * is omo whatever the label says. Without `roots` the label stands. The version is read from `store`
 * (the transcript the conversation readers resolved for this pane) for the agents that record one, never
 * from a process, and is null for any other agent or an omo pane.
 */
export function resolveAgent(
  pane: Pick<HerdrPane, "agent" | "agent_session">,
  roots?: PaneRoots,
  store: VersionSource | null = null,
): { agent: string | null; version: string | null } {
  const agent = roots?.omo ? "omo" : pane.agent ?? pane.agent_session?.agent ?? null;
  return { agent, version: storeAgentVersion(agent, store) };
}

/** The session store of a resolved transcript, for the agents that keep their version in one. */
export function versionSourceOf(transcript: NativeTranscript): VersionSource | null {
  if (transcript.source === "opencode-transcript") return { path: transcript.path, sessionId: transcript.session };
  if (transcript.source === "claude-transcript" || transcript.source === "codex-transcript") return { path: transcript.path };
  return null;
}

/**
 * For what is typed into a pane, omo outranks herdr's label only when an omo process there holds a
 * session (omo's own holder record). A script that merely runs from an omo-ai checkout, beside Claude or
 * in a shell, is no omo: herdr's label keeps its draft checks and its paste mode.
 */
export function typingRoots(roots: { omo: { held: boolean } | null }): PaneRoots {
  return roots.omo?.held ? roots : null;
}

/** The agent a pane runs, a session-holding omo taking precedence over herdr's label, for shaping what is typed into it. */
export async function paneAgentOf(paneId: string): Promise<string | null> {
  return (await paneContext(paneId, typingRoots(await paneProcessRoots(paneId, null)))).agent;
}

/** `roots`: what paneProcessRoots found for this pane; null or none keeps herdr's label. */
export async function paneContext(paneId: string, roots?: PaneRoots): Promise<{ agent: string | null; cwd: string; pane: Awaited<ReturnType<typeof paneGet>> }> {
  const pane = await paneGet(paneId);
  const cwd = pane.foreground_cwd ?? pane.cwd;
  if (!cwd) throw new HerdrError("cwd_not_found", `pane ${paneId} has no working directory`);
  return { agent: resolveAgent(pane, roots).agent, cwd, pane };
}
