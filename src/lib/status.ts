import type { AgentStatus } from "../../shared/protocol.ts";

export type KnownStatus = "idle" | "working" | "blocked" | "done" | "waiting" | "unknown";

/** The one word every surface (sidebar, palette, composer) uses for an agent state. */
export const STATUS_WORD: Readonly<Record<KnownStatus, string>> = {
  idle: "READY",
  working: "RUN",
  blocked: "INPUT",
  done: "DONE",
  waiting: "BG",
  unknown: "—",
};

const KNOWN: Readonly<Record<string, KnownStatus>> = { idle: "idle", working: "working", blocked: "blocked", done: "done", waiting: "waiting" };

/** herdr's AgentStatus is open-ended; the UI knows its states and files the rest under unknown. */
export function knownStatus(status?: AgentStatus): KnownStatus {
  return (status !== undefined && KNOWN[status]) || "unknown";
}

/**
 * What a pane reads as. One at rest while work its turn started still runs in the background
 * (`background_wait`, server/background-wait.ts) is waiting on it, and says BG in place of DONE
 * or READY: that work's end starts the next turn by itself.
 */
export function paneStatus(pane: { agent_status?: AgentStatus; background_wait?: true }): KnownStatus {
  const known = knownStatus(pane.agent_status);
  return pane.background_wait && known !== "working" && known !== "blocked" ? "waiting" : known;
}

/**
 * herdr's roll-up order, on its server (workspace aggregate) and in its sidebar: a blocked agent
 * colours the whole workspace, then one that finished and was not looked at yet, then a working one,
 * then one waiting on its turn's background work (working in all but name).
 */
const ROLLUP: readonly KnownStatus[] = ["blocked", "done", "working", "waiting", "idle"];

/**
 * One state for a row that stands for several panes, as herdr rolls a workspace's agents up:
 * blocked wins, then done, then working, then waiting on background work, then ready; unknown only
 * when no pane says more.
 */
export function rollupStatus(statuses: ReadonlyArray<AgentStatus | undefined>): KnownStatus {
  const known = statuses.map((status) => knownStatus(status));
  return ROLLUP.find((state) => known.includes(state)) ?? "unknown";
}

/**
 * Whether a pushed status change should read the conversation now instead of at the next poll:
 * a turn starts or ends when the pane enters or leaves `working`, and the chat's last block
 * follows the status while the transcript it holds is up to POLL_MS old.
 */
export function statusEdgeRead(previous: AgentStatus | undefined, next: AgentStatus | undefined): boolean {
  return previous !== next && (previous === "working" || next === "working");
}
