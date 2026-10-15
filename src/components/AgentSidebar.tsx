import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ChevronDown, ChevronRight, Ellipsis, Pin, PinOff, Terminal } from "lucide-react";

import type { Machine } from "../../shared/machines.ts";
import { paneStorageId } from "../../shared/machines.ts";
import type { AgentStatus, PlanSummary } from "../../shared/protocol.ts";
import { useT } from "../lib/i18n.ts";
import { agentContext, agentTabName, paneMark, sidebarAgents, type SidebarAgent } from "../lib/sidebarAgents.ts";
import { useSettings } from "../lib/settings.ts";
import { useSidebarActivity } from "../lib/sidebarActivity.tsx";
import { activityOrder } from "../lib/sidebarOrder.ts";
import { currentSidebarPins, pruneSidebarPins, setSidebarPins, sidebarPinKey, splitPinnedRows, subscribeSidebarPins, toggleSidebarPin } from "../lib/sidebarPins.ts";
import { PANE_DRAG_TYPE, paneDragData } from "../lib/split.ts";
import { AgentMark, hasAgentMark } from "./AgentMark.tsx";
import { RowMenu } from "./RowMenu.tsx";
import { BackgroundBadge, displayPaneTitle, onRowContextMenu, PlanBadge, StatusBadge } from "./Sidebar.tsx";
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
  /** a pinned row carries a pin after its title; its list says so to a screen reader */
  pinned?: boolean;
}

/**
 * One agent in a list: the coding agent's mark, what it is working on, who and where it is, and
 * how it is doing.
 */
function AgentRowBody({ mark, markKind, title, name, context, backgroundTasks, plan, status, pinned }: AgentRowBodyProps) {
  return <>
    <span className="sidebar-mark" aria-hidden="true">{mark !== null ? <AgentMark agent={mark} size={18} /> : <Terminal />}</span>
    <span className="agent-copy">
      {markKind && <span className="visually-hidden">{markKind}: </span>}
      <span className="agent-title-line">
        <span className="agent-title">{title}</span>
        {pinned && <Pin className="sidebar-pin-mark" aria-hidden="true" />}
      </span>
      {(name || context) && <span className="agent-context">
        {name && <span className="agent-name">{name}</span>}
        {name && context && " · "}
        {context}
      </span>}
    </span>
    <span className="agent-row-status"><BackgroundBadge count={backgroundTasks} /><PlanBadge plan={plan} /></span>
    {/* drawn at the row's right edge, after its ⋯, as a workspace row's state is (AgentSidebar.css) */}
    <span className="agent-row-state"><StatusBadge status={status} compact /></span>
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
interface AgentRow { machine: Machine; entry: SidebarAgent }
/** The row whose menu is open, by its pin key: at its ⋯, or at the pointer for a right-click */
interface PinMenu { key: string; anchor: HTMLElement; point?: { x: number; y: number }; previousFocus?: HTMLElement | null; title: string; place: string }

/**
 * All PCs' live agents form a second list; workspace and PC folds do not hide these rows.
 * In the phone's drawer the list starts folded, leaving the room to the workspaces.
 * The pinned agents stand first, in a card, each with a pin; on a desktop only a
 * right-click (or the context-menu key) opens the menu. A row's ⋯, or a right-click on it, opens its
 * menu, which pins or unpins it.
 */
export function AgentSidebar({ machines, selectedMachineId, selectedPaneId, stateWord, onSelect }: AgentSidebarProps) {
  const t = useT();
  const listId = useId();
  const [collapsed, setCollapsed] = useState(() => window.matchMedia?.(DRAWER_QUERY).matches === true);
  const { settings } = useSettings();
  // shared with the other browsers of this server (lib/preferencesSync.ts)
  const pinned = useSyncExternalStore(subscribeSidebarPins, currentSidebarPins, currentSidebarPins);
  const activity = useSidebarActivity();
  // Settings → Agents order: herdr's order, or Activity within each PC (each herdr counts its own changes)
  const byActivity = settings.agentOrder === "activity";
  const rows = useMemo(() => machines.flatMap((machine) => {
    const agents = sidebarAgents(machine.snapshot);
    return (byActivity ? activityOrder(agents, (entry) => entry.pane, activity.seqs(machine.id)) : agents).map((entry): AgentRow => ({ machine, entry }));
  }), [machines, byActivity, activity]);
  // the pinned rows stand first, in the order they were pinned
  const split = useMemo(() => splitPinnedRows(rows, pinned, ({ machine, entry }) => sidebarPinKey(machine.id, entry.pane.pane_id)), [rows, pinned]);
  const togglePin = (key: string): void => {
    // pins of panes gone from this server leave with a change of the user's, never by themselves: the
    // list is shared, and a pane this page has not seen yet (a PC still loading) is not gone
    const live = new Set(rows.map(({ machine, entry }) => sidebarPinKey(machine.id, entry.pane.pane_id)));
    setSidebarPins(toggleSidebarPin(pruneSidebarPins(pinned, live, machines), key));
  };
  // a pin moves the row to the other list, so React draws it anew: the control of the row that had
  // the focus (its row or its ⋯) gets it back
  const sectionRef = useRef<HTMLElement>(null);
  const refocusPin = useRef<{ key: string; control: string } | null>(null);
  useLayoutEffect(() => {
    const target = refocusPin.current;
    if (target === null) return;
    refocusPin.current = null;
    sectionRef.current?.querySelector<HTMLButtonElement>(`.agent-item[data-pin-key="${CSS.escape(target.key)}"] .${target.control}`)?.focus({ preventScroll: true });
  }, [pinned]);
  const [menu, setMenu] = useState<PinMenu | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  // a row that left the list (its pane closed) takes its menu with it
  useEffect(() => {
    if (menu && !menu.anchor.isConnected) setMenu(null);
  }, [menu, split]);
  // herdr names a PC only beside another: the rows' line does the same
  const machineName = (machine: Machine): string | null => machines.length > 1 ? machine.name : null;

  const agentItem = ({ machine, entry }: AgentRow) => {
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
    const contextParts = agentContext(parts);
    const context = contextParts.join(" · ");
    const kind = kindLabel?.trim() || null;
    const markKind = kind && kind !== title.trim() && !contextParts.includes(kind) ? kind : null;
    const tooltip = [...new Set([pane.pane_id, title, context, markKind, name, agent?.display_agent, pane.cwd, online ? null : stateWord(machine)].filter(Boolean))].join("\n");
    const pinKey = sidebarPinKey(machine.id, pane.pane_id);
    const menuOpen = menu?.key === pinKey;
    // one menu for the ⋯ and a right-click, which opens it at the pointer and leaves the focus where it was
    const toggleMenu = (anchor: HTMLElement, point?: { x: number; y: number }, previousFocus?: HTMLElement | null): void =>
      setMenu(menuOpen ? null : { key: pinKey, anchor, point, previousFocus, title, place: context });
    return <li className={`agent-item${selected ? " is-selected" : ""}${online ? "" : " is-offline"}`} key={paneStorageId(machine.id, pane.pane_id)} data-machine={machine.id} data-pane={pane.pane_id} data-pin-key={pinKey}
      onMouseDownCapture={(event) => { if (event.button === 2 || (event.button === 0 && event.ctrlKey)) event.preventDefault(); }}
      onContextMenu={(event) => onRowContextMenu(event, toggleMenu)}>
      <button type="button" className="agent-select agent-row" disabled={!online} aria-current={selected ? "true" : undefined} title={tooltip} onClick={() => onSelect(machine.id, pane.pane_id)}
        draggable={online}
        // dropped on the pane area, the row opens its pane in half of it (lib/split.ts)
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData(PANE_DRAG_TYPE, paneDragData({ machineId: machine.id, paneId: pane.pane_id }));
        }}>
        {/* a saved roster's state is not news: a PC that is away says nothing about its agents */}
        <AgentRowBody mark={mark} markKind={markKind} title={title} name={name} context={context} backgroundTasks={online ? pane.background_tasks : 0} plan={online ? pane.plan : undefined} status={online ? activity.status(machine.id, pane) : undefined} pinned={pinned.includes(pinKey)} />
      </button>
      <div className="agent-actions">
        <button type="button" className="sidebar-row-action row-menu-toggle" aria-label={t("More for {title}", { title })} aria-haspopup="menu" aria-expanded={menuOpen} onClick={(event) => toggleMenu(event.currentTarget)}>
          <Ellipsis aria-hidden="true" />
        </button>
      </div>
    </li>;
  };

  const menuPinned = menu !== null && pinned.includes(menu.key);
  const runPin = (state: PinMenu): void => {
    // where the menu hands the focus back (lib RowMenu): the ⋯ itself unless the right-click said otherwise
    const back = state.previousFocus === undefined ? state.anchor : state.previousFocus;
    const control = back?.closest(`.agent-item[data-pin-key="${CSS.escape(state.key)}"]`) ? back.classList.contains("row-menu-toggle") ? "row-menu-toggle" : "agent-select" : null;
    if (control) refocusPin.current = { key: state.key, control };
    togglePin(state.key);
  };
  return <section ref={sectionRef} className={`agents-sidebar${collapsed ? " is-collapsed" : ""}${rows.length === 0 ? " is-empty" : ""}`} aria-label={t("Agents")}>
    <button type="button" className="agent-section-toggle sidebar-section-label" aria-expanded={!collapsed} aria-controls={listId} onClick={() => setCollapsed(!collapsed)}>
      {collapsed ? <ChevronRight className="agent-section-caret" aria-hidden="true" /> : <ChevronDown className="agent-section-caret" aria-hidden="true" />}
      <span>{t("Agents")}</span>
      {collapsed && rows.length > 0 && <span className="agent-section-count">{rows.length}</span>}
    </button>
    <div className="agent-list-contents" id={listId} hidden={collapsed}>
      {rows.length === 0 ? <p className="agent-empty" role="status">{t("No agents running")}</p> : <>
        {split.pinned.length > 0 && <ul className="agent-list agent-list-pinned sidebar-pinned" aria-label={t("Pinned")}>{split.pinned.map(agentItem)}</ul>}
        {split.rest.length > 0 && <ul className="agent-list">{split.rest.map(agentItem)}</ul>}
      </>}
    </div>
    {menu && <RowMenu anchor={menu.anchor} point={menu.point} restoreFocusTo={menu.previousFocus} title={menu.title} subtitle={menu.place} onClose={closeMenu} items={[
      menuPinned
        ? { id: "unpin", label: t("Unpin agent"), icon: PinOff, run: () => runPin(menu) }
        : { id: "pin", label: t("Pin agent"), icon: Pin, run: () => runPin(menu) },
    ]} />}
  </section>;
}
