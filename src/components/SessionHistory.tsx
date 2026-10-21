/**
 * Earlier sessions of a workspace's folder (#1314), from the workspace row's ⋯ menu and from
 * /resume in the chat: one agent's sessions as its own store lists them (GET /api/sessions/history),
 * newest first, each with its title (else its first prompt), its first prompt and the time it was
 * last touched. Resume starts the row's verified argv as the agent of a new tab in the workspace,
 * one at a time (lib/sessionHistory.ts inFlightGuard), so a double click starts one agent; a
 * session a pane of the workspace already shows is reached by selecting that pane in the browser
 * (herdr's focus stays where it is), and so is one Resume started a moment ago whose pane herdr has
 * not reported on yet (App's RecentResume records, `recent`): the list reopened in that window
 * offers Open, not a second Resume, for as long as the pane is listed without a session. A row
 * whose resume syntax is not verified is listed with no button. Escape, the scrim and Cancel close
 * it, Tab stays inside, arrows move along the rows, and focus returns to what opened it. The design follows the resume pickers of Codex CLI (`/resume`)
 * and Claude Code (`claude --resume`): one session per row, newest first, the first prompt as its
 * text and the time it was last touched beside it, Enter resuming; here in the worktree dialog's
 * row anatomy, with the agent as a field above the rows.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import "./SessionHistory.css";
import type { AgentKind, HerdrPane, SessionHistoryAgent, SessionHistoryResponse, SessionHistoryRow, TabCreated, WorkspaceInfo } from "../../shared/protocol.ts";
import { ApiError, routeMissing } from "../lib/api.ts";
import { useLocale, useT } from "../lib/i18n.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { inFlightGuard, paneShowingSession, resumeTabRequest, sessionHistoryAgent, sessionRowTime, standingResume, type RecentResume } from "../lib/sessionHistory.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";

interface Props {
  workspace: WorkspaceInfo;
  /** the PC's panes: the one already showing a listed session is selected instead of a new tab */
  panes: readonly HerdrPane[];
  /** the agent listed first: the pane's, or the workspace row's */
  agent: SessionHistoryAgent;
  /** the Resumes of a moment ago whose panes have not reported their session yet (lib/useRecentResumes.ts) */
  recent?: readonly RecentResume[];
  onClose: () => void;
  /** browser selection only: herdr's focus stays where it is */
  onSelectPane: (paneId: string) => void;
  /** the tab herdr made for the row's session, which the caller records until herdr reports it */
  onResumed: (opened: TabCreated, session: { agent: SessionHistoryAgent; id: string }) => void;
}

const said = (reason: unknown): string => reason instanceof ApiError ? reason.detail : reason instanceof Error ? reason.message : String(reason);

const NO_RECENT: readonly RecentResume[] = [];

export function SessionHistory({ workspace, panes, agent: firstAgent, recent = NO_RECENT, onClose, onSelectPane, onResumed }: Props) {
  const t = useT();
  const locale = useLocale();
  const id = useId();
  const machineId = useMachineId();
  const { createTab, fetchAgentKinds, fetchSessionHistory } = useMachineApi();
  const [agent, setAgent] = useState<SessionHistoryAgent>(firstAgent);
  const [kinds, setKinds] = useState<AgentKind[]>([]);
  const [answer, setAnswer] = useState<SessionHistoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const guard = useRef(inFlightGuard());
  const surface = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const select = useRef<HTMLSelectElement>(null);
  useSheetSwipe(surface, pending ? null : onClose);
  usePhoneSheetBack(() => { if (pending) return false; onClose(); });
  const opener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => { if (opener.current?.isConnected) opener.current.focus({ preventScroll: true }); };
  }, []);
  // the first row's button takes the focus once the rows are in; until then the agent field. Focus
  // the user moved meanwhile (Tab to Cancel, the field opened) stays where they put it
  const placed = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const active = document.activeElement;
      if (surface.current?.contains(active) && active !== placed.current) return;
      const target = list.current?.querySelector<HTMLElement>("button:not(:disabled)") ?? select.current;
      target?.focus();
      placed.current = target ?? null;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [answer]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      const active = document.activeElement;
      if (active && active !== document.body && !surface.current?.contains(active)) return;
      event.stopPropagation();
      event.preventDefault();
      if (!pending) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, pending]);
  useEffect(() => {
    let cancelled = false;
    fetchAgentKinds().then((next) => { if (!cancelled) setKinds(next); }, () => { /* the first agent alone is offered */ });
    return () => { cancelled = true; };
  }, [fetchAgentKinds]);
  useEffect(() => {
    let cancelled = false;
    setAnswer(null);
    setError(null);
    fetchSessionHistory(workspace.workspace_id, agent).then(
      (listing) => { if (!cancelled) setAnswer(listing); },
      (reason: unknown) => { if (!cancelled) setError(routeMissing(reason) ? t("This PC's bridge does not offer this yet") : said(reason)); },
    );
    return () => { cancelled = true; };
  }, [agent, fetchSessionHistory, t, workspace.workspace_id]);
  const options = useMemo(() => {
    const listed = kinds.flatMap((kind) => { const named = sessionHistoryAgent(kind.kind); return named === null ? [] : [{ kind: named, label: kind.label }]; });
    return listed.some((option) => option.kind === firstAgent) ? listed : [{ kind: firstAgent, label: firstAgent }, ...listed];
  }, [firstAgent, kinds]);
  const agentLabel = options.find((option) => option.kind === agent)?.label ?? agent;
  const now = useMemo(() => Date.now(), [answer]);
  const resume = (row: SessionHistoryRow): void => {
    const request = resumeTabRequest(row, workspace.workspace_id, answer?.cwd ?? null);
    if (request === null) return;
    const started = guard.current.run(() => createTab(request));
    if (started === null) return;
    setPending(row.id);
    setError(null);
    started.then(
      (opened) => {
        if (opened.agent_started === false && opened.error) { setPending(null); setError(opened.error.message); return; }
        onResumed(opened, { agent, id: row.id });
      },
      (reason: unknown) => { setPending(null); setError(said(reason)); },
    );
  };
  const closeFromScrim = (event: MouseEvent<HTMLDivElement>): void => {
    if (!pending && event.target === event.currentTarget) onClose();
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Tab" || !surface.current) return;
    const stops = [...surface.current.querySelectorAll<HTMLElement>("select:not(:disabled), button:not(:disabled)")];
    if (stops.length === 0) return;
    const index = stops.indexOf(document.activeElement as HTMLElement);
    const next = event.shiftKey ? (index <= 0 ? stops.length - 1 : index - 1) : (index < 0 || index === stops.length - 1 ? 0 : index + 1);
    event.preventDefault();
    stops[next]?.focus();
  };
  const moveAlongRows = (event: ReactKeyboardEvent<HTMLUListElement>): void => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || !list.current) return;
    const buttons = [...list.current.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    if (buttons.length === 0) return;
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
      : event.key === "ArrowDown" ? Math.min(buttons.length - 1, index + 1) : Math.max(0, index - 1);
    event.preventDefault();
    buttons[next]?.focus();
  };
  const rows = answer?.sessions ?? null;
  const momentAgo = Date.now();
  return createPortal(
    <div className="modal-scrim" onMouseDown={closeFromScrim}>
      <div ref={surface} className="modal session-modal" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} onKeyDown={onKeyDown}>
        <header className="modal-header">
          <h2 className="modal-title" id={`${id}-title`}>{t("Earlier sessions · {name}", { name: workspace.label })}</h2>
          <button type="button" className="icon-button" aria-label={t("Close session list")} disabled={pending !== null} onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="modal-body">
          <label className="field session-agent">
            <span className="field-label">{t("Agent")}</span>
            <select ref={select} className="select" value={agent} disabled={pending !== null} onChange={(event) => setAgent(event.target.value as SessionHistoryAgent)}>
              {options.map((option) => <option key={option.kind} value={option.kind}>{option.label}</option>)}
            </select>
            {answer && <span className="field-hint session-folder">{t("Sessions started in {folder}", { folder: "\u0000" }).split("\u0000").map((part, index) => index === 0 ? <span key="before">{part}</span> : <span key="after"><code>{answer.cwd}</code>{part}</span>)}</span>}
          </label>
          {rows === null && !error ? (
            <p className="field-hint" role="status">{t("Reading sessions…")}</p>
          ) : rows && rows.length === 0 ? (
            <p className="field-hint session-empty">{t("No earlier {agent} sessions in this folder.", { agent: agentLabel })}</p>
          ) : rows && (
            <ul ref={list} className="session-list" aria-label={t("Earlier sessions")} onKeyDown={moveAlongRows}>
              {rows.map((row) => {
                const title = row.title ?? row.firstMessage ?? row.id;
                const detail = row.title !== null ? row.firstMessage : null;
                const when = sessionRowTime(row, now, locale, t);
                // a pane that reports the session, else the pane of a Resume a moment ago; a record whose pane
                // the roster has not listed yet withholds Resume and offers nothing to open until it does
                const resumed = standingResume(recent, panes, machineId, workspace.workspace_id, agent, row.id, momentAgo);
                const shown = paneShowingSession(panes, workspace.workspace_id, agent, row.id) ?? (resumed === undefined ? undefined : panes.find((pane) => pane.pane_id === resumed.paneId && pane.workspace_id === workspace.workspace_id));
                const withheld = resumed !== undefined && shown === undefined;
                const resumable = row.resume !== null && row.resume.argv.length > 0;
                return (
                  <li key={row.id} className={`session-row${pending === row.id ? " is-pending" : ""}`} aria-label={when ? `${title} · ${when.label}` : title}>
                    <span className="session-copy">
                      <span className={`session-title${row.title === null && row.firstMessage === null ? " session-id" : ""}`}>{title}</span>
                      {detail !== null && <span className="session-detail">{detail}</span>}
                    </span>
                    <span className="session-meta">
                      {when && <time className="session-time" dateTime={row.updatedAt} title={when.title}>{when.label}</time>}
                      {shown || withheld ? (
                        <span className="session-actions">
                          <span className="pill">{t("Already open")}</span>
                          <button type="button" className="btn session-action" disabled={pending !== null || shown === undefined} aria-label={t("Open the pane showing {title}", { title })} onClick={() => { if (shown) onSelectPane(shown.pane_id); }}>{t("Open")}</button>
                        </span>
                      ) : resumable && (
                        <button type="button" className="btn session-action" disabled={pending !== null} aria-label={t("Resume {title}", { title })} onClick={() => resume(row)}>{t("Resume")}</button>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {pending !== null && <p className="field-hint" role="status">{t("Resuming…")}</p>}
          {error && <p className="field-hint session-error" role="alert">{error}</p>}
        </div>
        <footer className="modal-footer">
          <button type="button" className="btn btn-ghost" disabled={pending !== null} onClick={onClose}>{t("Cancel")}</button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
