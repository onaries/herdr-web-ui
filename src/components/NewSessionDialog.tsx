import { useEffect, useRef, useState, type MouseEvent } from "react";
import { FolderOpen, X } from "lucide-react";

import "./NewSessionDialog.css";

import type { AgentKind } from "../../shared/protocol.ts";
import { MAX_LABEL_CHARS } from "../../shared/labels.ts";
import { ApiError } from "../lib/api.ts";
import { AgentPicker, rememberAgent, rememberedAgent } from "./AgentPicker.tsx";
import { DirectoryBrowser } from "./DirectoryBrowser.tsx";
import { RecentFolderChips } from "./RecentFolderChips.tsx";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { useT } from "../lib/i18n.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { passingFolder, recentDirectories } from "../lib/recent-directories.ts";

/** The dialog as New tab: the workspace the tab joins, whose folder it uses, and the number herdr will give it. */
export interface NewTabTarget {
  workspaceId: string;
  workspaceLabel: string;
  cwd: string | null;
  number: number;
}

export interface NewSessionDialogProps {
  open: boolean;
  machineName?: string;
  defaultCwd: string | null;
  /** set, the dialog makes a tab in that workspace instead of a workspace */
  tab?: NewTabTarget | null;
  onClose: () => void;
  /** `agentStarted`: the pane runs the agent asked for, so it opens in an agent's lens */
  onCreated: (paneId: string, agentStarted: boolean) => void;
  /** fields a link fills for this opening (`?new=`, lib/deepLink.ts); an agent herdr does not offer is left out */
  prefill?: DialogFields | null;
  /** what the fields say, a moment after they change, for the address */
  onDraft?: (fields: DialogFields) => void;
  /** the PC's open linked worktree checkouts: no project to offer among the recent folders */
  worktrees?: readonly string[];
}

export interface DialogFields {
  cwd: string | null;
  name: string | null;
  /** "" is a shell; null keeps the last agent picked */
  agent: string | null;
}

/** how long the fields rest before the address follows them: Safari refuses a burst of history writes */
const DRAFT_MS = 400;
/** recent folders offered: one row a phone swipes sideways; a wider screen fits what one row holds and lists the rest under "+N" */
const RECENT_FOLDERS_SHOWN = 8;

function directoryBasename(value: string): string {
  const trimmed = value.replace(/\\/g, "/").replace(/\/+$/, "");
  return trimmed.split("/").pop() || value;
}

export function NewSessionDialog({ open, defaultCwd, tab = null, onClose, onCreated, machineName, prefill = null, onDraft, worktrees = [] }: NewSessionDialogProps) {
  const t = useT();
  const machineId = useMachineId();
  const { createTab, createWorkspace, fetchAgentKinds } = useMachineApi();
  const [agents, setAgents] = useState<AgentKind[]>([]);
  const [agentKind, setAgentKind] = useState(rememberedAgent);
  const [cwd, setCwd] = useState(defaultCwd ?? "");
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdPaneId, setCreatedPaneId] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [recentFolders, setRecentFolders] = useState(() => recentDirectories.read(machineId));
  // folders kept before worktrees and temporary folders were left out are left out here too
  const shownFolders = recentFolders.filter((path) => !passingFolder(path, worktrees)).slice(0, RECENT_FOLDERS_SHOWN);
  const firstFieldRef = useRef<HTMLButtonElement>(null);
  const surface = useFocusTrap<HTMLFormElement>(open, { initialFocus: firstFieldRef });
  useSheetSwipe(surface, pending ? null : onClose);
  const defaultCwdRef = useRef(defaultCwd);
  defaultCwdRef.current = defaultCwd;
  const prefillRef = useRef(prefill);
  prefillRef.current = prefill;

  useEffect(() => {
    if (!open) return;
    const filled = prefillRef.current;
    setCwd(filled?.cwd ?? defaultCwdRef.current ?? "");
    setName(filled?.name ?? "");
    setError(null);
    setPending(false);
    setCreatedPaneId(null);
    setBrowsing(false);
    setRecentFolders(recentDirectories.read(machineId));
    const remembered = rememberedAgent();
    const stored = filled?.agent ?? remembered;
    setAgentKind(stored);
    let cancelled = false;
    void fetchAgentKinds()
      .then((next) => {
        if (cancelled) return;
        setAgents(next);
        // a linked agent herdr does not offer gives way to the last one picked, as an unknown remembered one does to a shell
        if (stored && !next.some((agent) => agent.kind === stored)) setAgentKind(stored !== remembered && next.some((agent) => agent.kind === remembered) ? remembered : "");
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open || !onDraft) return;
    const timer = window.setTimeout(() => onDraft({ cwd: cwd || null, name: name || null, agent: agentKind }), DRAFT_MS);
    return () => window.clearTimeout(timer);
  }, [open, onDraft, cwd, name, agentKind]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      // a native modal over it (Add PC, from the palette) takes its own Escape
      if (event.key !== "Escape" || nativeModalOver(surface.current)) return;
      event.preventDefault();
      if (!pending) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose, pending]);

  if (!open) return null;

  const selectedAgent = agents.find((agent) => agent.kind === agentKind);
  const pendingLabel = selectedAgent ? t("Starting {agent}… up to 60s", { agent: selectedAgent.label }) : t("Starting shell…");
  const fieldsDisabled = pending || createdPaneId !== null;

  const startWorkspace = async (directory: string): Promise<void> => {
    if (pending) return;
    if (createdPaneId !== null) { onCreated(createdPaneId, false); return; }
    setPending(true);
    setError(null);
    try {
      rememberAgent(agentKind);
      const agent = agentKind ? { kind: agentKind } : null;
      // a tab keeps the workspace's folder, which the dialog shows and does not ask for
      const result = tab
        ? await createTab({ workspace_id: tab.workspaceId, cwd: tab.cwd, label: name.trim() || null, agent })
        : await createWorkspace({ cwd: directory.trim() || null, label: name.trim() || null, agent });
      if (agentKind && !result.agent_started && result.error?.message) {
        setPending(false);
        setError(result.error.message);
        setCreatedPaneId(result.pane_id);
        return;
      }
      if (!tab && (!agentKind || result.agent_started)) {
        setRecentFolders(recentDirectories.remember(machineId, [directory.trim()], true));
      }
      // the dialog closes on this: left pending, its next opening would start a frame with the
      // fields disabled and Escape ignored, until the open effect's reset has rendered
      setPending(false);
      onCreated(result.pane_id, agentKind !== "" && result.agent_started !== false);
    } catch (reason: unknown) {
      setPending(false);
      if (reason instanceof ApiError && reason.code === "invalid_cwd") setError(t("Directory not found"));
      else setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const closeFromScrim = (event: MouseEvent<HTMLDivElement>): void => {
    if (!pending && event.target === event.currentTarget) onClose();
  };

  return (
    <div className="modal-scrim new-session-scrim" onMouseDown={closeFromScrim}>
      <form ref={surface} className="modal new-session-modal" role="dialog" aria-modal="true" aria-labelledby="new-session-title" tabIndex={-1} onSubmit={(event) => { event.preventDefault(); void startWorkspace(cwd); }}>
        <header className="modal-header">
          <h2 className="modal-title" id="new-session-title">{tab ? `${t("New tab")} · ${tab.workspaceLabel}` : `${t("New workspace")} · ${machineName ?? machineId}`}</h2>
          <button type="button" className="icon-button" aria-label={t("Close dialog")} disabled={pending} onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="modal-body">
          <div className="field">
            <span className="field-label" id="new-session-agent">{t("Agent")}</span>
            <AgentPicker ref={firstFieldRef} agents={agents} value={agentKind} disabled={fieldsDisabled} labelledBy="new-session-agent" onChange={setAgentKind} />
          </div>
          {tab ? (
            <div className="field">
              <span className="field-label">{t("Directory")}</span>
              <div className="new-session-folder">
                <FolderOpen aria-hidden="true" />
                <span>{tab.cwd ?? tab.workspaceLabel}</span>
              </div>
              <span className="field-hint">{t("Uses the workspace's folder")}</span>
            </div>
          ) : (
            <div className="field">
              <label className="field-label" htmlFor="new-session-cwd">{t("Directory")}</label>
              <div className="new-session-cwd">
                <input id="new-session-cwd" className="input" value={cwd} disabled={fieldsDisabled} autoComplete="off" onChange={(event) => setCwd(event.target.value)} />
                <button type="button" className="btn" aria-expanded={browsing} disabled={fieldsDisabled} onClick={() => setBrowsing((open) => !open)}>
                  <FolderOpen aria-hidden="true" />
                  {t("Browse")}
                </button>
              </div>
              {browsing && <DirectoryBrowser start={cwd} onPick={(picked) => { setCwd(picked); setBrowsing(false); }} />}
              <span className="field-hint">{t("absolute path or ~/…")}</span>
            </div>
          )}
          {!tab && shownFolders.length > 0 && <div className="field new-session-recents">
            <span className="field-label" id="new-session-recents">{t("Recent folders")}</span>
            <RecentFolderChips folders={shownFolders} disabled={fieldsDisabled} labelledBy="new-session-recents" basename={directoryBasename}
              onPick={(path) => { setCwd(path); setBrowsing(false); }} />
          </div>}
          <label className="field">
            <span className="field-label">{t("Name")}</span>
            <input
              className="input"
              value={name}
              maxLength={MAX_LABEL_CHARS}
              disabled={fieldsDisabled}
              autoComplete="off"
              placeholder={tab ? String(tab.number) : directoryBasename(cwd)}
              onChange={(event) => setName(event.target.value)}
            />
            <span className="field-hint">{t(tab ? "Tab name (optional)" : "Optional workspace label")}</span>
          </label>
          {pending && <p className="new-session-note" role="status">{pendingLabel}</p>}
          {error && <p className="field-hint new-session-error" role="alert">{error}</p>}
        </div>
        <footer className="modal-footer">
          <button type="button" className="btn btn-ghost" disabled={pending} onClick={onClose}>{t("Cancel")}</button>
          <button type="submit" className="btn btn-primary" disabled={pending}>{t(pending ? "Starting…" : createdPaneId !== null ? "Open" : "Start")}</button>
        </footer>
      </form>
    </div>
  );
}
