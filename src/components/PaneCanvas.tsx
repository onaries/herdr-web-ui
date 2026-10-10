import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { Columns2, Ellipsis, Eraser, Maximize2, MousePointer2, Pencil, Rows2, ArrowLeftRight, X } from "lucide-react";
import { createPortal } from "react-dom";
import type { HerdrPane, PaneLayoutSnapshot, SessionSnapshot } from "../../shared/protocol.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import { PaneSubmitRetention } from "../lib/paneSubmitRetention.ts";
import { PanePresentedContext, PaneSubmitContext } from "../lib/paneSubmitContext.ts";
import { PaneAwayContext } from "../lib/paneAwayContext.ts";
import { ApiError, routeMissing } from "../lib/api.ts";
import { layoutCells, zoomMode } from "../lib/layoutMap.ts";
import { layoutTopology, paneContextPress, splitPath, splitRatioAt } from "../lib/paneCanvas.ts";
import { useT } from "../lib/i18n.ts";
import { useFocusTrap } from "../lib/useFocusTrap.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { displayPaneTitle } from "./Sidebar.tsx";
import { RowMenu, type RowMenuItem } from "./RowMenu.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import "./PaneCanvas.css";

type PaneLayoutSplit = PaneLayoutSnapshot["splits"][number];

interface Props {
  snapshot: SessionSnapshot | null;
  pane: HerdrPane | null;
  selectedPaneId: string | null;
  onSelect: (paneId: string, focusInput?: boolean) => void;
  onChanged: () => void;
  renderPane: (pane: HerdrPane | null, active: boolean) => ReactNode;
  isTerminal: (pane: HerdrPane) => boolean;
}
type Menu = { paneId: string; anchor: HTMLElement; point?: { x: number; y: number }; previousFocus: HTMLElement | null };
interface Drag {
  split: PaneLayoutSplit;
  layout: PaneLayoutSnapshot;
  path: boolean[];
  topology: string;
  box: DOMRect;
  pointerId: number;
  element: HTMLElement;
  latest: number | null;
  running: boolean;
  done: boolean;
  cancelled: boolean;
  lastSent: number;
  startX: number;
  startY: number;
  startRatio: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/** The active tab, drawn from herdr's rectangles. No browser-owned layout or PTY state. */
export function PaneCanvas({ snapshot, pane, selectedPaneId, onSelect, onChanged, renderPane, isTerminal }: Props) {
  const t = useT();
  const apple = /Mac|iPhone|iPad/.test(navigator.platform);
  const coarse = useMediaQuery("(pointer: coarse)");
  const api = useMachineApi();
  const canvas = useRef<HTMLDivElement>(null);
  // Survives workspace/tab switches, but the PC-keyed canvas owns this memory exclusively.
  const awayReleased = useRef(false);
  const [submits] = useState(() => new PaneSubmitRetention());
  const retainedIds = useSyncExternalStore(submits.subscribe, submits.snapshot, submits.snapshot);
  const lastCells = useRef(new Map<string, ReturnType<typeof layoutCells>[number]>());
  useEffect(() => {
    const live = new Set(snapshot?.panes.map((item) => item.pane_id) ?? []);
    submits.reconcile(live);
    for (const id of lastCells.current.keys()) if (!live.has(id)) lastCells.current.delete(id);
  }, [snapshot, submits]);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [renaming, setRenaming] = useState<HerdrPane | null>(null);
  const [closing, setClosing] = useState<HerdrPane | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [passthrough, setPassthrough] = useState<Set<string>>(() => new Set());
  // A new pane can be selected before its snapshot arrives, and a selected pane can close
  // before App confirms its replacement. Keep the prior tab's surviving mounts (and their
  // connection-owned pending sends) through either gap, with selection/input still pending.
  const previousPane = useRef(pane);
  if (pane) previousPane.current = pane;
  const previousTab = previousPane.current?.tab_id;
  const previousLayout = snapshot?.layouts.find((item) => item.tab_id === previousTab);
  const presented = pane
    ?? snapshot?.panes.find((item) => item.pane_id === previousPane.current?.pane_id)
    ?? snapshot?.panes.find((item) => item.tab_id === previousTab && item.pane_id === previousLayout?.focused_pane_id)
    ?? snapshot?.panes.find((item) => item.tab_id === previousTab)
    ?? null;
  const layout = snapshot?.layouts.find((item) => item.tab_id === presented?.tab_id) ?? null;
  const topology = layout ? layoutTopology(layout) : "";
  const latest = useRef({ topology, tabId: presented?.tab_id, paneId: selectedPaneId, selection: 0 });
  latest.current = { topology, tabId: presented?.tab_id, paneId: selectedPaneId,
    selection: latest.current.selection + (latest.current.paneId === selectedPaneId ? 0 : 1) };
  const alive = useRef(true);
  const drag = useRef<Drag | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const fail = (reason: unknown): void => {
    if (!alive.current) return;
    setError(routeMissing(reason) ? t("This PC's bridge does not offer this yet")
      : t("Layout change failed: {reason}", { reason: reason instanceof ApiError ? reason.detail : reason instanceof Error ? reason.message : String(reason) }));
  };
  const cancelDrag = (): void => {
    const current = drag.current;
    if (!current) return;
    current.cancelled = true;
    if (current.timer !== null) clearTimeout(current.timer);
    if (current.element.hasPointerCapture(current.pointerId)) current.element.releasePointerCapture(current.pointerId);
    drag.current = null;
  };
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; cancelDrag(); };
  }, []);
  useEffect(() => { cancelDrag(); }, [topology]);
  useEffect(() => { setMenu(null); setRenaming(null); setClosing(null); setError(null); }, [presented?.tab_id]);
  useEffect(() => { if (menu && !snapshot?.panes.some((item) => item.pane_id === menu.paneId)) setMenu(null); }, [snapshot, menu]);

  const run = (operation: () => Promise<unknown>): void => {
    const tabId = pane?.tab_id;
    setError(null);
    void operation().then(() => { if (alive.current) onChanged(); }).catch((reason) => {
      if (latest.current.tabId === tabId) fail(reason);
    });
  };
  const showMenu = (target: HerdrPane, anchor: HTMLElement, point?: { x: number; y: number }): void => {
    setMenu({ paneId: target.pane_id, anchor, point,
      previousFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null });
  };
  const sendsRightClick = (target: HerdrPane, event: MouseEvent<HTMLElement>): boolean =>
    passthrough.has(target.pane_id) && isTerminal(target) && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
      && event.target instanceof Element && !!event.target.closest('.pane-terminal[data-mouse-reporting]');
  const context = (event: MouseEvent<HTMLElement>, target: HerdrPane): void => {
    event.preventDefault();
    event.stopPropagation();
    if (sendsRightClick(target, event)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    showMenu(target, event.currentTarget, { x: event.clientX || rect.left + 8, y: event.clientY || rect.top + 8 });
  };
  const split = async (target: HerdrPane, direction: "right" | "down"): Promise<void> => {
    const tabId = latest.current.tabId;
    const selection = latest.current.selection;
    const made = await api.splitPane(target.pane_id, direction, true);
    if (alive.current && latest.current.tabId === tabId && latest.current.selection === selection) onSelect(made.pane_id);
  };
  const requestClose = (target: HerdrPane): void => {
    const inWorkspace = snapshot?.panes.filter((item) => item.workspace_id === target.workspace_id).length ?? 1;
    if (inWorkspace === 1 || target.agent_status === "working" || target.agent_status === "blocked") setClosing(target);
    else run(() => api.closePane(target.pane_id));
  };
  const target = menu ? snapshot?.panes.find((item) => item.pane_id === menu.paneId) : null;
  const items: RowMenuItem[] = target ? [
    { id: "rename", label: t("Rename pane"), icon: Pencil, run: () => setRenaming(target) },
    ...(target.label ? [{ id: "clear-name", label: t("Clear pane name"), icon: Eraser, run: () => run(() => api.renamePane(target.pane_id, "")) }] : []),
    ...(pane && target.pane_id !== pane.pane_id ? [{ id: "swap-focused", label: t("Swap with focused pane"), icon: ArrowLeftRight,
      run: () => run(() => api.swapPaneWith(pane.pane_id, target.pane_id)) }] : []),
    { id: "split-right", label: t("Split right"), icon: Columns2, run: () => run(() => split(target, "right")) },
    { id: "split-down", label: t("Split down"), icon: Rows2, run: () => run(() => split(target, "down")) },
    { id: "zoom", label: t(layout && zoomMode(layout, target.pane_id) === "off" ? "Unzoom pane" : "Zoom pane"), icon: Maximize2,
      run: () => run(async () => {
        const tabId = latest.current.tabId;
        const selection = latest.current.selection;
        await api.zoomPane(target.pane_id, layout ? zoomMode(layout, target.pane_id) : "on");
        if (alive.current && latest.current.tabId === tabId && latest.current.selection === selection) onSelect(target.pane_id);
      }) },
    { id: "right-click", label: t(passthrough.has(target.pane_id) ? "Use Herdr right-click menu" : "Send right-clicks to pane"), icon: MousePointer2,
      run: () => setPassthrough((old) => { const next = new Set(old); if (next.has(target.pane_id)) next.delete(target.pane_id); else next.add(target.pane_id); return next; }) },
    { id: "close", label: t("Close pane"), icon: X, danger: true, run: () => requestClose(target) },
  ] : [];

  // One in-flight ratio at a time; retain only the newest position and always flush release.
  const flush = (current: Drag): void => {
    if (current.cancelled || current.running || current.latest === null || latest.current.topology !== current.topology) return;
    const delay = 33 - (performance.now() - current.lastSent);
    if (!current.done && delay > 0) {
      if (current.timer === null) current.timer = setTimeout(() => { current.timer = null; flush(current); }, delay);
      return;
    }
    const ratio = current.latest;
    current.latest = null; current.running = true; current.lastSent = performance.now();
    void api.setSplitRatio(current.layout.tab_id, current.path, ratio).then(() => {
      if (!current.cancelled && alive.current) onChanged();
    }).catch((reason) => { if (!current.cancelled) fail(reason); current.cancelled = true; }).finally(() => {
      current.running = false;
      if (current.cancelled) return;
      if (current.latest !== null) flush(current);
      else if (current.done && drag.current === current) drag.current = null;
    });
  };
  const startDrag = (event: PointerEvent<HTMLDivElement>, item: PaneLayoutSplit): void => {
    const path = splitPath(item.id);
    if (event.button !== 0 || !layout || !canvas.current || path === null) return;
    event.preventDefault(); event.stopPropagation(); cancelDrag();
    const element = event.currentTarget;
    element.setPointerCapture(event.pointerId);
    drag.current = { split: item, layout, path, topology, box: canvas.current.getBoundingClientRect(),
      pointerId: event.pointerId, element, latest: null, running: false, done: false, cancelled: false, lastSent: 0, timer: null,
      startX: event.clientX, startY: event.clientY, startRatio: item.ratio };
  };
  const moveDrag = (event: PointerEvent<HTMLDivElement>, done = false): void => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId || current.cancelled) return;
    event.preventDefault(); event.stopPropagation();
    const initial = splitRatioAt(current.split, current.layout, current.box, current.startX, current.startY);
    current.latest = Math.max(0.1, Math.min(0.9, current.startRatio + splitRatioAt(current.split, current.layout, current.box, event.clientX, event.clientY) - initial));
    current.done = done;
    if (done && current.element.hasPointerCapture(event.pointerId)) current.element.releasePointerCapture(event.pointerId);
    flush(current);
  };
  const cells = layout ? layoutCells(layout) : pane ? [{ paneId: pane.pane_id, left: 0, top: 0, width: 100, height: 100, focused: true }] : [];
  for (const cell of cells) lastCells.current.set(cell.paneId, cell);
  const shownIds = new Set(cells.map((cell) => cell.paneId));
  // Every frame stays under the same keyed array, including a frame returning before its ACK.
  // Retention ends at the receipt, disconnect timeout, native close, or PC canvas teardown.
  const mountedCells = [...cells.map((cell) => ({ ...cell, retained: false })), ...retainedIds.flatMap((id) => {
    const cell = lastCells.current.get(id);
    return !shownIds.has(id) && cell ? [{ ...cell, retained: true }] : [];
  })];
  // herdr's zoomed pane, whatever the web selected: the selection follows it (App)
  const zoomed = layout?.zoomed ? layout.focused_pane_id : null;
  return <PaneSubmitContext.Provider value={submits}><PaneAwayContext.Provider value={awayReleased}><div className={`pane-canvas${!pane && presented ? " is-pending" : ""}`} ref={canvas} aria-busy={!pane && presented ? true : undefined}>
    {cells.length === 0 && renderPane(pane, true)}
    {mountedCells.map((cell) => {
      const item = snapshot?.panes.find((item) => item.pane_id === cell.paneId);
      if (!item) return null;
      const active = !cell.retained && item.pane_id === selectedPaneId;
      const hidden = cell.retained || (zoomed !== null && zoomed !== item.pane_id);
      const single = cells.length === 1 || zoomed === item.pane_id;
      // Capture contextmenu before xterm focuses its helper textarea; the menu keeps focus on the original pane.
      return <section key={item.pane_id} data-layout-pane={item.pane_id}
        className={`pane-frame${active ? " is-current" : ""}${single ? " is-single" : ""}${hidden ? " is-hidden" : ""}`}
        aria-label={displayPaneTitle(item)} aria-current={active ? "true" : undefined} aria-hidden={hidden || undefined} tabIndex={-1}
        style={zoomed === item.pane_id ? { left: 0, top: 0, width: "100%", height: "100%" }
          : { left: `${cell.left}%`, top: `${cell.top}%`, width: `${cell.width}%`, height: `${cell.height}%` }}
        onPointerDownCapture={(event) => {
          // A right press must not change focus before the menu's Swap with focused pane.
          if (event.button === 0 && !paneContextPress(event, apple) && !active) {
            onSelect(item.pane_id, false);
          }
          const element = event.target instanceof Element ? event.target : null;
          const titleOrFrame = element?.closest(".pane-frame-head") || element === event.currentTarget;
          if (event.button === 0 && !paneContextPress(event, apple) && !coarse && titleOrFrame && !element?.closest("button")) {
            // A title has no native focus action. Prevent its default blur and take typing
            // even when this pane was already selected but a menu/tab still held focus.
            event.preventDefault();
            const frame = event.currentTarget;
            const input = frame.querySelector<HTMLElement>(".secret-input input")
              ?? frame.querySelector<HTMLElement>(".find-bar input")
              ?? (frame.querySelector(".terminal-stack.is-chat")
                ? frame.querySelector<HTMLElement>(".composer-text")
                : frame.querySelector<HTMLElement>(".terminal-input textarea") ?? frame.querySelector<HTMLElement>(".xterm-helper-textarea"));
            input?.focus({ preventScroll: true });
          }
        }}
        onDropCapture={() => { if (!active) onSelect(item.pane_id, false); }}
        onFocusCapture={(event) => { if (!active && event.currentTarget.contains(event.target)) onSelect(item.pane_id, false); }}
        onMouseDownCapture={(event) => {
          if (paneContextPress(event, apple) && !sendsRightClick(item, event)) { event.preventDefault(); event.stopPropagation(); }
        }}
        onMouseUpCapture={(event) => {
          if (paneContextPress(event, apple) && !sendsRightClick(item, event)) { event.preventDefault(); event.stopPropagation(); }
        }}
        onContextMenuCapture={(event) => context(event, item)}>
        <div className="pane-frame-head">
          <span className="pane-frame-title">{displayPaneTitle(item)}</span>
          <button type="button" className="icon-button pane-frame-menu" aria-label={t("Pane actions for {name}", { name: displayPaneTitle(item) })}
            onClick={(event) => showMenu(item, event.currentTarget)}><Ellipsis aria-hidden="true" /></button>
        </div>
        <div className="pane-frame-body"><PanePresentedContext.Provider value={!cell.retained}>{renderPane(item, active)}</PanePresentedContext.Provider></div>
      </section>;
    })}
    {!layout?.zoomed && layout?.splits.map((item) => {
      const vertical = item.direction === "right";
      const path = splitPath(item.id);
      if (path === null) return null;
      const area = layout.area;
      const left = ((item.rect.x - area.x + (vertical ? item.rect.width * item.ratio : 0)) / Math.max(1, area.width)) * 100;
      const top = ((item.rect.y - area.y + (vertical ? 0 : item.rect.height * item.ratio)) / Math.max(1, area.height)) * 100;
      return <div key={item.id} role="separator" tabIndex={0} aria-label={t("Resize split")}
        aria-orientation={vertical ? "vertical" : "horizontal"} aria-valuemin={10} aria-valuemax={90} aria-valuenow={Math.round(item.ratio * 100)}
        className={`pane-divider ${vertical ? "is-vertical" : "is-horizontal"}`}
        style={vertical ? { left: `${left}%`, top: `${top}%`, height: `${item.rect.height / area.height * 100}%` }
          : { left: `${left}%`, top: `${top}%`, width: `${item.rect.width / area.width * 100}%` }}
        onPointerDown={(event) => startDrag(event, item)} onPointerMove={(event) => moveDrag(event)} onPointerUp={(event) => moveDrag(event, true)}
        onPointerCancel={cancelDrag} onLostPointerCapture={() => { if (drag.current && !drag.current.done) cancelDrag(); }}
        onKeyDown={(event) => {
          const step = event.key === (vertical ? "ArrowLeft" : "ArrowUp") ? -0.05 : event.key === (vertical ? "ArrowRight" : "ArrowDown") ? 0.05 : 0;
          if (!step) return;
          event.preventDefault(); event.stopPropagation();
          run(() => api.setSplitRatio(layout.tab_id, path, Math.max(0.1, Math.min(0.9, item.ratio + step))));
        }} />;
    })}
    {error && <div className="pane-canvas-error" role="alert">{error}<button className="icon-button" aria-label={t("Dismiss")} onClick={() => setError(null)}><X /></button></div>}
    {menu && target && <RowMenu anchor={menu.anchor} point={menu.point} restoreFocusTo={menu.previousFocus} title={t("Pane actions for {name}", { name: displayPaneTitle(target) })} items={items} onClose={closeMenu} />}
    {renaming && <PaneRename pane={renaming} onClose={() => setRenaming(null)} onSave={async (label) => { await api.renamePane(renaming.pane_id, label); onChanged(); }} />}
    {closing && <ConfirmDialog title={t("Close pane {name}?", { name: displayPaneTitle(closing) })}
      body={t("The pane's running processes will stop. Closing its last pane also closes the workspace.")}
      confirmLabel={t("Close pane")} onClose={() => setClosing(null)} onConfirm={async () => { await api.closePane(closing.pane_id); setClosing(null); onChanged(); }} />}
  </div></PaneAwayContext.Provider></PaneSubmitContext.Provider>;
}

function PaneRename({ pane, onClose, onSave }: { pane: HerdrPane; onClose: () => void; onSave: (label: string) => Promise<void> }) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const surface = useFocusTrap<HTMLDivElement>(true, { initialFocus: input });
  const [value, setValue] = useState(pane.label ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!busy) onClose(); } };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [busy, onClose]);
  return createPortal(<div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div ref={surface} className="modal" role="dialog" aria-modal="true" aria-label={t("Rename pane")}>
      <form className="pane-rename-form" onSubmit={(event) => { event.preventDefault(); if (busy) return; setBusy(true); void onSave(value.trim()).then(onClose, (reason) => { setError(String(reason)); setBusy(false); }); }}>
        <header className="modal-header"><h2 className="modal-title">{t("Rename pane")}</h2></header>
        <div className="modal-body"><label>{t("Pane name")}<input ref={input} className="input" value={value} disabled={busy} maxLength={80} onFocus={(event) => event.currentTarget.select()} onChange={(event) => setValue(event.target.value)} /></label>{error && <p role="alert">{error}</p>}</div>
        <footer className="modal-footer"><button type="button" className="btn" disabled={busy} onClick={onClose}>{t("Cancel")}</button><button className="btn btn-primary" disabled={busy}>{t("Save")}</button></footer>
      </form>
    </div>
  </div>, document.body);
}
