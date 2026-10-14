import { useEffect, useRef, useState, type PointerEvent } from "react";
import type { Terminal } from "@xterm/xterm";
import type { PaneFindResponse, PaneScrollInfo } from "../../shared/protocol.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import type { ViewportIntentGate } from "../lib/viewportIntent.ts";
import { ApiError } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { useSettings } from "../lib/settings.ts";
import { pageScrollDistance } from "../lib/pageScroll.ts";
import { offsetAtThumb, scrollPollDelay, scrollThumb, validScroll, visibleFindRects, type FindCellRect } from "../lib/terminalViewport.ts";
import "./TerminalViewportTools.css";

export interface TerminalSearchState { query: string; result: PaneFindResponse }
interface Box { left: number; top: number; width: number; height: number; cols: number; rows: number; trackTop: number; trackHeight: number }
interface Props {
  viewportIntent: ViewportIntentGate;
  terminal: Terminal | null;
  paneId: string;
  pageScroll?: { current: ((direction: -1 | 1) => void) | null };
  onApplicationPage?: (direction: -1 | 1) => void;
  viewportId: string;
  enabled: boolean;
  interactive: boolean;
  search: TerminalSearchState | null;
  onError(message: string): void;
}

/** UI over the attach stream. History belongs to herdr; xterm still has zero scrollback. */
/** how long a page asked for on stale metrics waits for the read that tells history from a program's screen */
const HELD_PAGE_MS = 1000;

export function TerminalViewportTools({ viewportIntent, terminal, paneId, pageScroll, onApplicationPage, viewportId, enabled, interactive, search, onError }: Props) {
  const t = useT();
  const api = useMachineApi();
  const { settings } = useSettings();
  const overlapRef = useRef(settings.pageOverlapRows); overlapRef.current = settings.pageOverlapRows;
  const layer = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState<PaneScrollInfo | null>(null);
  const scrollRef = useRef(scroll); scrollRef.current = scroll;
  const [box, setBox] = useState<Box | null>(null);
  const [hits, setHits] = useState<FindCellRect[]>([]);
  const [preview, setPreview] = useState<number | null>(null);
  const previewRef = useRef<number | null>(null);
  const drag = useRef<{ pointer: number; top: number; height: number; grab: number; thumb: number } | null>(null);
  const searchRef = useRef(search); searchRef.current = search;
  const errorRef = useRef(onError); errorRef.current = onError;
  const refreshRef = useRef<() => void>(() => {});
  const writeRef = useRef<(offset: number) => void>(() => {});
  // Old bridges ignore unknown request fields and would scroll on an automatic search.
  // Only a new explicit result advertises the no-jump range response contract.
  const query = interactive && search && Array.isArray(search.result.matches) && search.result.scroll !== undefined ? search.query : "";

  useEffect(() => {
    if (!terminal || !enabled) { setScroll(null); setHits([]); setPreview(null); previewRef.current = null; if (pageScroll) pageScroll.current = null; return; }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let timerDue = 0;
    let pending = false;
    let writing = false;
    let desired: number | null = null;
    let dirty = false;
    // metrics reads in a row with nothing in between that could move them: the poll backs off
    let idle = 0;
    let version = 0;
    let outputVersion = 0;
    // the output the current metrics were read after: a program leaving its alternate screen hands the
    // history back, and until the next read says so its zero-history metrics must not turn a page into
    // keys for the shell. A page asked for meanwhile waits for that read, briefly.
    let metricsOutput = -1;
    let heldPage: { direction: -1 | 1; at: number } | null = null;
    let data: PaneFindResponse | null = null;
    let lastKey = "";
    const showing = () => document.visibilityState !== "hidden" && !!terminal.element?.getClientRects().length
      && getComputedStyle(terminal.element).visibility !== "hidden";
    const clearHits = () => { data = null; lastKey = ""; setHits((old) => old.length ? [] : old); };
    const screen = terminal.element?.querySelector<HTMLElement>(".xterm-screen") ?? null;
    /** Box geometry: only a resize, a mount scroll or a refresh moves it, never a rendered frame. */
    const paintBox = () => {
      if (!alive || !showing()) return;
      const parent = layer.current?.parentElement;
      if (!screen || !parent) return;
      const rect = screen.getBoundingClientRect(), outer = parent.getBoundingClientRect();
      const next = { left: rect.left - outer.left, top: rect.top - outer.top, width: rect.width, height: rect.height, cols: terminal.cols, rows: terminal.rows,
        trackTop: Math.max(rect.top, outer.top) - outer.top, trackHeight: Math.max(0, Math.min(rect.bottom, outer.bottom) - Math.max(rect.top, outer.top)) };
      setBox((old) => old && Object.keys(next).every((key) => old[key as keyof Box] === next[key as keyof Box]) ? old : next);
    };
    /** Find rectangles: the cells under them change with every frame, so this runs on render, and
     * reads nothing from the layout unless a search has a result to place. */
    const paintHits = () => {
      if (!alive) return;
      const active = searchRef.current;
      if (!active || !data) {
        if (lastKey !== "[]") { lastKey = "[]"; setHits((old) => old.length ? [] : old); }
        return;
      }
      if (!showing()) return;
      const matches = data?.matches ?? [];
      const nativeScroll = data?.scroll;
      // A newer native window revalidates the same range before it can stay current;
      // local buffer validation below still refuses stale or moved cells. Navigation retains
      // its original revision and is rejected server-side if that revision no longer exists.
      const rectangles = active && data && validScroll(nativeScroll) ? visibleFindRects(matches, nativeScroll, active.query, terminal.cols, terminal.rows,
        (row, col) => {
          const cell = terminal.buffer.active.getLine(terminal.buffer.active.viewportY + row)?.getCell(col);
          return cell ? { chars: cell.getChars(), width: cell.getWidth() } : undefined;
        }, active.result.match) : [];
      const key = JSON.stringify(rectangles);
      if (key !== lastKey) { lastKey = key; setHits((old) => old.length === 0 && rectangles.length === 0 ? old : rectangles); }
    };
    const paint = () => { paintBox(); paintHits(); };
    const schedule = (delay = 250) => {
      if (!alive || document.visibilityState === "hidden") return;
      const due = Date.now() + delay;
      if (timer !== null && timerDue <= due) return;
      if (timer !== null) clearTimeout(timer);
      timerDue = due;
      timer = setTimeout(() => { timer = null; void read(); }, delay);
    };
    const read = async () => {
      if (!alive) return;
      if (pending || writing) { dirty = true; return; }
      if (!showing()) { idle = 0; schedule(1000); return; }
      pending = true; dirty = false;
      const revision = version;
      const output = outputVersion;
      const cols = terminal.cols, rows = terminal.rows;
      try {
        let found: PaneFindResponse | null = null;
        if (query) {
          try { found = await api.findPane({ pane_id: paneId, query, direction: "forward", jump: false }); }
          catch { /* Moving output can invalidate search while its scroll metrics remain useful. */ }
        }
        const metrics = found?.scroll ?? await api.fetchPaneScroll(paneId);
        if (!alive || revision !== version || cols !== terminal.cols || rows !== terminal.rows) return;
        setScroll((old) => validScroll(metrics) ? old && old.offset_from_bottom === metrics.offset_from_bottom && old.max_offset_from_bottom === metrics.max_offset_from_bottom && old.viewport_rows === metrics.viewport_rows ? old : metrics : null);
        if (validScroll(metrics)) {
          // metrics that moved without output (another client, history growing under a held view) mean the pane is not idle
          const last = scrollRef.current;
          if (last && (last.offset_from_bottom !== metrics.offset_from_bottom || last.max_offset_from_bottom !== metrics.max_offset_from_bottom)) idle = 0;
          scrollRef.current = metrics; metricsOutput = output;
        }
        data = output === outputVersion ? found : null;
        // also the box: a pane shown again by its visibility style, not its size, gets no ResizeObserver call
        paint();
        // a page held on stale metrics runs on the first read after the latest output, while it is recent
        if (heldPage && output === outputVersion) {
          const held = heldPage;
          heldPage = null;
          if (Date.now() - held.at < HELD_PAGE_MS) scrollPage(held.direction);
        }
      } catch {
        // a failed read retries on the first step, not the idle backoff: the scrollbar and page keys wait on it
        if (alive && revision === version) { clearHits(); if (!query) setScroll(null); idle = 0; }
      } finally {
        pending = false;
        // an idle pane at the bottom backs off; output, a scroll, a resize, moved metrics or coming back into view resets it
        if (alive) schedule(scrollPollDelay(dirty, idle++, scrollRef.current));
      }
    };
    const wake = () => { dirty = true; idle = 0; schedule(); };
    const flush = async () => {
      if (writing || desired === null || !alive || viewportIntent.isSearching()) return;
      writing = true;
      const target = desired; desired = null;
      version++;
      clearHits();
      try {
        const output = outputVersion;
        const request = viewportIntent.scroll(() => api.scrollPane(paneId, target));
        if (!request) return;
        const metrics = await request;
        if (alive && validScroll(metrics)) { scrollRef.current = metrics; metricsOutput = output; setScroll(metrics); }
      } catch (cause) {
        if (alive) {
          desired = null;
          errorRef.current(t("Scroll failed: {reason}", { reason: cause instanceof ApiError ? cause.detail : cause instanceof Error ? cause.message : String(cause) }));
        }
      } finally {
        writing = false;
        if (alive) {
          if (desired !== null) void flush();
          else { previewRef.current = null; setPreview(null); wake(); }
        }
      }
    };
    writeRef.current = (offset) => {
      const metrics = scrollRef.current;
      if (!interactive || !alive || viewportIntent.isSearching() || !validScroll(metrics) || !showing()) return;
      desired = Math.max(0, Math.min(metrics.max_offset_from_bottom, Math.round(offset)));
      previewRef.current = desired;
      setPreview(desired);
      void flush();
    };
    const scrollPage = (direction: -1 | 1) => {
      const metrics = scrollRef.current;
      if (!interactive || !alive || viewportIntent.isSearching() || !showing()) return;
      if (validScroll(metrics) && metrics.max_offset_from_bottom === 0) {
        // keys for the program only on metrics read after its latest output: it may just have left
        // its alternate screen, and the shell behind it has history to scroll instead
        if (metricsOutput !== outputVersion) { heldPage = { direction, at: Date.now() }; dirty = true; schedule(0); return; }
        onApplicationPage?.(direction);
        return;
      }
      if (validScroll(metrics)) writeRef.current((previewRef.current ?? metrics.offset_from_bottom) - direction * pageScrollDistance(metrics.viewport_rows, 1, overlapRef.current));
      // no metrics (a failed read): ask for a fresh read now rather than at the next poll
      else { dirty = true; idle = 0; schedule(0); }
    };
    if (pageScroll) pageScroll.current = scrollPage;
    const unregisterCancellation = viewportIntent.registerScrollCancellation(() => {
      desired = null; drag.current = null; version++;
      previewRef.current = null;
      setPreview(null); clearHits();
    });
    refreshRef.current = () => { dirty = true; idle = 0; paint(); schedule(0); };
    const parsed = terminal.onWriteParsed(() => { outputVersion++; clearHits(); wake(); });
    const rendered = terminal.onRender(paintHits);
    const resized = terminal.onResize(() => { version++; clearHits(); setScroll(null); wake(); paint(); });
    const visibility = () => {
      if (document.visibilityState === "hidden") { if (timer !== null) clearTimeout(timer); timer = null; clearHits(); }
      else wake();
    };
    const observer = new ResizeObserver(() => { paint(); wake(); });
    if (layer.current?.parentElement) observer.observe(layer.current.parentElement);
    // the screen's own size follows the renderer's cell metrics (a font load, a zoom), not only the mount
    if (screen) observer.observe(screen);
    const mount = terminal.element?.parentElement;
    mount?.addEventListener("scroll", paint, { passive: true });
    document.addEventListener("visibilitychange", visibility);
    paint(); void read();
    return () => {
      alive = false; desired = null; version++; heldPage = null;
      if (pageScroll?.current === scrollPage) pageScroll.current = null;
      previewRef.current = null;
      unregisterCancellation();
      if (timer !== null) clearTimeout(timer);
      parsed.dispose(); rendered.dispose(); resized.dispose(); observer.disconnect();
      mount?.removeEventListener("scroll", paint);
      document.removeEventListener("visibilitychange", visibility);
      refreshRef.current = () => {}; writeRef.current = () => {};
      drag.current = null;
    };
  }, [terminal, paneId, enabled, interactive, query, api, t, viewportIntent, pageScroll, onApplicationPage]);

  useEffect(() => { refreshRef.current(); }, [search?.result]);
  const metrics = validScroll(scroll) ? { ...scroll, offset_from_bottom: preview === null ? scroll.offset_from_bottom : Math.min(scroll.max_offset_from_bottom, preview) } : null;
  const thumb = box && metrics ? scrollThumb(metrics, box.trackHeight) : null;
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const held = drag.current;
    if (!held || event.pointerId !== held.pointer || !metrics) return;
    writeRef.current(offsetAtThumb(metrics, event.clientY - held.top - held.grab, held.height, held.thumb));
  };
  return <div ref={layer} className="terminal-viewport-tools" aria-hidden={!enabled || undefined}>
    {enabled && search && box && hits.map((hit, index) => <span key={index} className={`terminal-find-hit${hit.current ? " is-current" : ""}`} aria-hidden="true"
      style={{ left: box.left + hit.col * box.width / box.cols, top: box.top + hit.row * box.height / box.rows, width: hit.width * box.width / box.cols, height: box.height / box.rows }} />)}
    {enabled && box && box.trackHeight > 0 && metrics && metrics.max_offset_from_bottom > 0 && thumb && <div ref={track} className="terminal-history-scrollbar"
      role="scrollbar" aria-label={t("Terminal scrollback")} aria-controls={viewportId} aria-orientation="vertical"
      aria-valuemin={0} aria-valuemax={metrics.max_offset_from_bottom} aria-valuenow={metrics.max_offset_from_bottom - metrics.offset_from_bottom}
      aria-disabled={!interactive || undefined} tabIndex={interactive ? 0 : -1} style={{ top: box.trackTop, height: box.trackHeight }}
      onPointerDown={(event) => {
        if (!interactive || event.button !== 0) return;
        event.preventDefault(); event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        const onThumb = event.clientY >= rect.top + thumb.top && event.clientY <= rect.top + thumb.top + thumb.height;
        drag.current = { pointer: event.pointerId, top: rect.top, height: rect.height, grab: onThumb ? event.clientY - rect.top - thumb.top : thumb.height / 2, thumb: thumb.height };
        event.currentTarget.setPointerCapture(event.pointerId);
        move(event);
      }} onPointerMove={move} onPointerUp={(event) => {
        if (drag.current?.pointer !== event.pointerId) return;
        move(event); drag.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
      onKeyDown={(event) => {
        if (event.defaultPrevented || !interactive) return;
        const offset = metrics.offset_from_bottom;
        const target = event.key === "Home" ? metrics.max_offset_from_bottom : event.key === "End" ? 0
          : event.key === "ArrowUp" ? offset + 1 : event.key === "ArrowDown" ? offset - 1
          : event.key === "PageUp" ? offset + pageScrollDistance(metrics.viewport_rows, 1, settings.pageOverlapRows) : event.key === "PageDown" ? offset - pageScrollDistance(metrics.viewport_rows, 1, settings.pageOverlapRows) : null;
        if (target === null) return;
        event.preventDefault(); event.stopPropagation(); writeRef.current(target);
      }}>
      <span className="terminal-history-thumb" style={{ top: thumb.top, height: thumb.height }} />
    </div>}
  </div>;
}
