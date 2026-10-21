/**
 * Earlier sessions of a workspace's folder, as GET /api/sessions/history lists them (#1314), and
 * what the client does with a row: Resume starts the row's own argv as the agent of a new tab in
 * the workspace, unless a pane of the workspace already shows that session, which is then
 * selected in the browser instead (never focused in herdr). A session is known to be shown by
 * the pane's `agent_session`, which herdr reports as the session's id or its file, or, until herdr
 * reports it, by the record of a Resume a moment ago (RecentResume, kept by App across the dialog's
 * openings): the dialog's own in-flight guard ends with the dialog, and a list reopened before
 * herdr has looked at the new pane would otherwise start a second agent on the same session.
 */
import type { CreateTabRequest, HerdrPane, SessionHistoryAgent, SessionHistoryRow } from "../../shared/protocol.ts";
import { formatChatTimestamp } from "./chatTimestamp.ts";
import type { Translate } from "./i18n.ts";

/** The agents whose own stores the route reads, as server/session-history.ts lists them. */
export const SESSION_HISTORY_AGENTS: readonly SessionHistoryAgent[] = ["claude", "codex", "pi", "omp", "gjc", "cmd", "omo", "opencode", "hermes", "grok", "agy", "devin"];

/**
 * The agent whose sessions a request lists. A pane's request (its chat's /resume) lists that pane's
 * own agent or nothing: a Copilot chat never gets Claude's sessions, whose Resume would start another
 * agent. A workspace's (its row's menu, which has an Agent field) lists the agent named, else the pane
 * in front's, else any of the workspace's, else Claude's.
 */
export function sessionHistoryListAgent(request: { agent?: string | null; scope?: "pane" | "workspace" } | undefined, front: string | null | undefined, workspaceAgents: readonly (string | null | undefined)[]): SessionHistoryAgent | null {
  const named = sessionHistoryAgent(request?.agent);
  if (request?.scope === "pane") return named;
  return named ?? sessionHistoryAgent(front) ?? workspaceAgents.map((agent) => sessionHistoryAgent(agent)).find((kind) => kind !== null) ?? "claude";
}

/** A pane's agent as the route names it; null for a shell or a program the route does not list. */
export function sessionHistoryAgent(agent: string | null | undefined): SessionHistoryAgent | null {
  return agent && (SESSION_HISTORY_AGENTS as readonly string[]).includes(agent) ? (agent as SessionHistoryAgent) : null;
}

/**
 * A session file's name says the session: Claude names the file by the id, Codex ends the rollout
 * name with it, pi's family puts it after the start time and an underscore.
 */
function fileNamesSession(path: string, id: string): boolean {
  const stem = (path.split(/[/\\]/).pop() ?? "").replace(/\.[^.]+$/, "");
  if (stem === id) return true;
  if (!stem.endsWith(id)) return false;
  return /[-_.]/.test(stem[stem.length - id.length - 1] ?? "");
}

/** The workspace's pane whose reported session is this one of `agent`, if any. */
export function paneShowingSession(panes: readonly HerdrPane[], workspaceId: string, agent: SessionHistoryAgent, id: string): HerdrPane | undefined {
  if (id === "") return undefined;
  return panes.find((pane) => {
    const session = pane.agent_session;
    if (pane.workspace_id !== workspaceId || !session || session.agent !== agent || typeof session.value !== "string" || session.value === "") return false;
    return session.kind === "id" ? session.value === id : session.kind === "path" && fileNamesSession(session.value, id);
  });
}

/** A session Resume started a moment ago: its new pane shows the session until herdr says so itself (or says otherwise). */
export interface RecentResume {
  machineId: string;
  workspaceId: string;
  agent: SessionHistoryAgent;
  id: string;
  /** the pane POST /api/tab/create answered with */
  paneId: string;
  /** Date.now() at the answer */
  at: number;
  /** the roster has listed the pane since: once it is gone again, the pane was closed */
  seen: boolean;
  /**
   * the roster has shown the pane running the resumed agent since: only after that does another agent
   * in it, or none, mean the agent stopped (while it starts the pane has no agent yet, and an omo pane
   * shows as pi or claude for a moment)
   */
  ran?: boolean;
}
/** How long a record whose pane the roster never lists stands: after that the pane never appeared, and the record ends. */
export const RECENT_RESUME_MS = 2 * 60_000;
/**
 * The record is over on evidence alone: herdr reported a session for the pane (whichever: then the
 * pane's own `agent_session` decides), the pane was seen running the resumed agent and no longer
 * runs it (back at its shell, or another agent in it), or the pane the roster had listed is gone. A pane still
 * listed without a session keeps it however long ago the Resume was: time alone never brings
 * Resume back for a pane that is there. Only a pane the roster never listed ends it, after
 * RECENT_RESUME_MS. A roster not known (the PC between snapshots) keeps it.
 */
export function recentResumeEnded(record: RecentResume, panes: readonly HerdrPane[] | undefined, now: number): boolean {
  if (panes === undefined) return false;
  const pane = panes.find((candidate) => candidate.pane_id === record.paneId);
  // a pane seen running the agent, now back at its shell or running another agent, no longer shows the session
  if (pane !== undefined && record.ran === true && sessionHistoryAgent(pane.agent) !== record.agent) return true;
  if (pane !== undefined) return pane.agent_session !== null && pane.agent_session !== undefined;
  if (record.seen) return true;
  return now - record.at > RECENT_RESUME_MS;
}
/** The record as the roster shows it now: `seen` once it lists the pane, `ran` once that pane runs the resumed agent. */
export function observeRecentResume(record: RecentResume, panes: readonly HerdrPane[] | undefined): RecentResume {
  const pane = panes?.find((candidate) => candidate.pane_id === record.paneId);
  if (pane === undefined) return record;
  const ran = record.ran === true || sessionHistoryAgent(pane.agent) === record.agent;
  return record.seen && record.ran === ran ? record : { ...record, seen: true, ran };
}
/** The standing record of this session's Resume, if there is one: no Resume is offered while it stands. */
export function standingResume(records: readonly RecentResume[], panes: readonly HerdrPane[] | undefined, machineId: string, workspaceId: string, agent: SessionHistoryAgent, id: string, now: number): RecentResume | undefined {
  return records.find((record) => record.machineId === machineId && record.workspaceId === workspaceId && record.agent === agent && record.id === id && !recentResumeEnded(record, panes, now));
}
/** The pane a standing record names, once the roster lists it: opened by selecting it, as a pane that reports the session is. */
export function recentlyResumedPane(records: readonly RecentResume[], panes: readonly HerdrPane[], machineId: string, workspaceId: string, agent: SessionHistoryAgent, id: string, now: number): HerdrPane | undefined {
  const record = standingResume(records, panes, machineId, workspaceId, agent, id, now);
  return record === undefined ? undefined : panes.find((pane) => pane.pane_id === record.paneId && pane.workspace_id === workspaceId);
}
/**
 * A row's time: its label is when the session was last touched; its tooltip also says when it
 * started, where the store records that. Null when the last touch is unreadable.
 */
export function sessionRowTime(row: Pick<SessionHistoryRow, "startedAt" | "updatedAt">, now: number, locale: string, t: Translate): { label: string; title: string } | null {
  const updated = formatChatTimestamp(row.updatedAt, now, locale, t);
  if (updated === null) return null;
  const started = formatChatTimestamp(row.startedAt, now, locale, t);
  return { label: updated.label, title: started === null ? updated.full : t("Started {started} · last active {updated}", { started: started.full, updated: updated.full }) };
}

/** POST /api/tab/create for the row: its argv's first word is the agent kind, the rest its arguments; null without a verified resume. */
export function resumeTabRequest(row: SessionHistoryRow, workspaceId: string, cwd: string | null): CreateTabRequest | null {
  const [kind, ...args] = row.resume?.argv ?? [];
  if (!kind) return null;
  return { workspace_id: workspaceId, cwd, label: null, agent: { kind, args } };
}

/** One task at a time: `run` refuses (null) while an earlier task has not settled, so a double click starts one agent. */
export function inFlightGuard(): { busy: () => boolean; run: <T>(task: () => Promise<T>) => Promise<T> | null } {
  let inFlight: Promise<unknown> | null = null;
  return {
    busy: () => inFlight !== null,
    run: <T>(task: () => Promise<T>): Promise<T> | null => {
      if (inFlight !== null) return null;
      const started = task().finally(() => { if (inFlight === started) inFlight = null; });
      inFlight = started;
      return started;
    },
  };
}
