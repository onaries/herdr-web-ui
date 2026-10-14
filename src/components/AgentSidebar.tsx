import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Folder, Star, Terminal } from "lucide-react";

import type { Machine } from "../../shared/machines.ts";
import { paneStorageId } from "../../shared/machines.ts";
import type { AgentStatus, PlanSummary } from "../../shared/protocol.ts";
import { useT } from "../lib/i18n.ts";
import { agentContext, agentTabName, groupRows, paneMark, sidebarAgents, type SidebarAgent } from "../lib/sidebarAgents.ts";
import { useSettings } from "../lib/settings.ts";
import { useSidebarActivity } from "../lib/sidebarActivity.tsx";
import { activityOrder } from "../lib/sidebarOrder.ts";
import { loadSidebarPins, pruneSidebarPins, saveSidebarPins, sidebarPinKey, splitPinnedRows, toggleSidebarPin } from "../lib/sidebarPins.ts";
import { AgentMark, hasAgentMark } from "./AgentMark.tsx";
import { BackgroundBadge, displayPaneTitle, PlanBadge, StatusBadge } from "./Sidebar.tsx";
import "./AgentSidebar.css";

interface AgentRowBodyProps {
  /** the agent's kind or name; null draws a terminal, for a shell */
  mark: string | null;
  /** the kind the mark draws, left off the second line: said for a screen reader, since the mark is aria-hidden */
  markKind: string | null;
  title: string;
  /** the live name other tools address the agent by, when it has one */
  name: string | null;
  context: string;
  backgroundTasks?: number;
  plan?: PlanSummary;
  status?: AgentStatus;
}

/**
 * One agent in a list: the coding agent's mark, what it is working on, who and where it is, and
 * how it is doing.
 */
function AgentRowBody({ mark, markKind, title, name, context, backgroundTasks, plan, status }: AgentRowBodyProps) {
  return <>
    <span className="sidebar-mark" aria-hidden="true">{mark !== null ? <AgentMark agent={mark} size={18} /> : <Terminal />}</span>
    <span className="agent-copy">
      {markKind && <span className="visually-hidden">{markKind}: </span>}
      <span className="agent-title">{title}</span>
      {(name || context) && <span className="agent-context">
        {name && <span className="agent-name">{name}</span>}
        {name && context && " · "}
        {context}
      </span>}
    </span>
    <span className="agent-row-status"><BackgroundBadge count={backgroundTasks} /><PlanBadge plan={plan} /><StatusBadge status={status} compact /></span>
  </>;
}

export interface AgentSidebarProps {
  machines: Machine[];
  selectedMachineId: string;
  selectedPaneId: string | null;
  /** a PC's state in words, for the tooltip of a row whose PC is not connected */
  stateWord(machine: Machine): string;
  onSelect(machineId: string, paneId: string): void;
}

/** the width under which the sidebar is a drawer (src/styles.css) */
const DRAWER_QUERY = "(max-width: 768px)";
/** Settings → Pin agents off: saved pins stay stored, and none of them leads the list */
const NO_PINS: readonly string[] = [];

interface AgentRow { machine: Machine; entry: SidebarAgent }

/**
 * All PCs' live agents form a second list; workspace and PC folds do not hide these rows.
 * In the phone's drawer the list starts folded, leaving the room to the workspaces.
 * The pinned agents stand first. With Settings → Workspace cards on, herdr's order puts each
 * workspace's agents on a PC in a card under its name, a pinned agent first in its own card and
 * the cards that hold pins first; off (the default), or in Activity order, which mixes
 * workspaces, the rows stand alone.
 */
export function AgentSidebar({ machines, selectedMachineId, selectedPaneId, stateWord, onSelect }: AgentSidebarProps) {
  const t = useT();
  const listId = useId();
  const [collapsed, setCollapsed] = useState(() => window.matchMedia?.(DRAWER_QUERY).matches === true);
  const { settings } = useSettings();
  const [pinned, setPinned] = useState(loadSidebarPins);
  const activity = useSidebarActivity();
  // Settings → Agents order: herdr's order, or Activity within each PC (each herdr counts its own changes)
  const byActivity = settings.agentOrder === "activity";
  const rows = useMemo(() => machines.flatMap((machine) => {
    const agents = sidebarAgents(machine.snapshot);
    return (byActivity ? activityOrder(agents, (entry) => entry.pane, activity.seqs(machine.id)) : agents).map((entry): AgentRow => ({ machine, entry }));
  }), [machines, byActivity, activity]);
  // pins lead: alone, the pinned rows stand first; in cards, each stays in its own card, first there,
  // and a card that holds one comes before the cards that hold none
  const split = useMemo(() => splitPinnedRows(rows, settings.agentPins ? pinned : NO_PINS, ({ machine, entry }) => sidebarPinKey(machine.id, entry.pane.pane_id)), [rows, pinned, settings.agentPins]);
  useEffect(() => {
    const live = new Set(rows.map(({ machine, entry }) => sidebarPinKey(machine.id, entry.pane.pane_id)));
    const next = pruneSidebarPins(pinned, live, machines);
    if (next.length !== pinned.length) { setPinned(next); saveSidebarPins(next); }
  }, [machines, rows, pinned]);
  // a pin moves the row, and maybe its card, so React may draw a new star: a star that had the
  // keyboard focus hands it to its successor
  const sectionRef = useRef<HTMLElement>(null);
  const refocusPin = useRef<string | null>(null);
  useLayoutEffect(() => {
    const key = refocusPin.current;
    if (key === null) return;
    refocusPin.current = null;
    sectionRef.current?.querySelector<HTMLButtonElement>(`.agent-pin-toggle[data-pin-key="${CSS.escape(key)}"]`)?.focus();
  }, [pinned]);
  const setPin = (key: string, star: HTMLButtonElement): void => {
    if (document.activeElement === star) refocusPin.current = key;
    const next = toggleSidebarPin(pinned, key);
    setPinned(next);
    saveSidebarPins(next);
  };
  const carded = settings.agentCards && !byActivity;
  const groups = useMemo(() => !carded ? null : groupRows([...split.pinned, ...split.rest], ({ machine, entry }) => JSON.stringify([machine.id, entry.workspace.workspace_id])), [split, carded]);
  // herdr names a PC only beside another: the rows' line, and a card's head, do the same
  const machineName = (machine: Machine): string | null => machines.length > 1 ? machine.name : null;

  const agentItem = ({ machine, entry }: AgentRow, grouped: boolean) => {
    const { pane, workspace, tab, agent, agentLabel } = entry;
    const selected = machine.id === selectedMachineId && pane.pane_id === selectedPaneId;
    const online = machine.state === "connected";
    const title = pane.label?.trim() || agent?.title?.trim() || pane.title?.trim() || displayPaneTitle(pane);
    const name = agent?.name?.trim() || null;
    // the name has its own place on the line: the label beside it says the kind instead
    const kindLabel = name !== null && agentLabel === name ? entry.canonicalAgent ?? agent?.title?.trim() ?? null : agentLabel;
    const tabs = machine.snapshot?.tabs.filter((candidate) => candidate.workspace_id === workspace.workspace_id) ?? [];
    const mark = paneMark(entry);
    const markAgent = mark && hasAgentMark(mark) ? mark : null;
    const parts = { agentLabel: kindLabel, title, markAgent, machineName: machineName(machine), workspaceLabel: workspace.label, tabName: agentTabName(tab, tabs, t) };
    // a row in a card leaves its place to the card's head; the tooltip still says all of it
    const place = agentContext(parts).join(" · ");
    const contextParts = agentContext({ ...parts, grouped, named: name !== null });
    const context = contextParts.join(" · ");
    const kind = kindLabel?.trim() || null;
    const markKind = kind && kind !== title.trim() && !contextParts.includes(kind) ? kind : null;
    const tooltip = [...new Set([pane.pane_id, title, place, markKind, name, agent?.display_agent, pane.cwd, online ? null : stateWord(machine)].filter(Boolean))].join("\n");
    const pinKey = sidebarPinKey(machine.id, pane.pane_id);
    const isPinned = pinned.includes(pinKey);
    return <li className={`agent-item${selected ? " is-selected" : ""}${online ? "" : " is-offline"}`} key={paneStorageId(machine.id, pane.pane_id)} data-machine={machine.id} data-pane={pane.pane_id}>
      <button type="button" className="agent-select agent-row" disabled={!online} aria-current={selected ? "true" : undefined} title={tooltip} onClick={() => onSelect(machine.id, pane.pane_id)}>
        {/* a saved roster's state is not news: a PC that is away says nothing about its agents */}
        <AgentRowBody mark={mark} markKind={markKind} title={title} name={name} context={context} backgroundTasks={online ? pane.background_tasks : 0} plan={online ? pane.plan : undefined} status={online ? activity.status(machine.id, pane) : undefined} />
      </button>
      {settings.agentPins && <button type="button" className={`agent-pin-toggle${isPinned ? " is-pinned" : ""}`} aria-label={`${t("Pin agent")}: ${[title, machineName(machine), workspace.label].filter(Boolean).join(" · ")}`} aria-pressed={isPinned} title={t(isPinned ? "Unpin agent" : "Pin agent")} data-pin-key={pinKey} onClick={(event) => setPin(pinKey, event.currentTarget)}>
        <Star aria-hidden="true" fill={isPinned ? "currentColor" : "none"} />
      </button>}
    </li>;
  };

  return <section ref={sectionRef} className={`agents-sidebar${collapsed ? " is-collapsed" : ""}${rows.length === 0 ? " is-empty" : ""}`} aria-label={t("Agents")}>
    <button type="button" className="agent-section-toggle sidebar-section-label" aria-expanded={!collapsed} aria-controls={listId} onClick={() => setCollapsed(!collapsed)}>
      {collapsed ? <ChevronRight className="agent-section-caret" aria-hidden="true" /> : <ChevronDown className="agent-section-caret" aria-hidden="true" />}
      <span>{t("Agents")}</span>
      {collapsed && rows.length > 0 && <span className="agent-section-count">{rows.length}</span>}
    </button>
    <div className="agent-list-contents" id={listId} hidden={collapsed}>
      {rows.length === 0 ? <p className="agent-empty" role="status">{t("No agents running")}</p> : <ul className="agent-list">
        {groups ? groups.map(({ key, rows: members }, index) => {
          const { machine, entry } = members[0]!;
          const headId = `${listId}-group-${index}`;
          const name = [machineName(machine), entry.workspace.label].filter(Boolean).join(" · ");
          // the head is the card's name, not a control: a row opens a pane, and the workspace list opens workspaces
          return <li className={`agent-group${machine.state === "connected" ? "" : " is-offline"}`} key={key}>
            <div className="agent-group-head" id={headId}>
              <span className="agent-group-mark" aria-hidden="true"><Folder /></span>
              <span className="agent-group-name" title={name}>{name}</span>
            </div>
            <ul className="agent-group-rows" aria-labelledby={headId}>{members.map((row) => agentItem(row, true))}</ul>
          </li>;
        }) : [...split.pinned, ...split.rest].map((row) => agentItem(row, false))}
      </ul>}
    </div>
  </section>;
}
