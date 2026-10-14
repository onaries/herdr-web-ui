/**
 * A phone's bottom sheet is a history entry, so the system Back closes it instead of going to the
 * pane before (deep links make each pane its own entry). The entry keeps the address it opened on.
 * What an item of the sheet does with the history takes the sheet's entry over: a navigation it
 * pushes (another pane, Settings, a file) replaces the entry, a sheet it opens reuses it, and an
 * address it changes on the entry (the New tab dialog) keeps it. A sheet closed any other way steps
 * back off its entry once whatever it ran has written its own history. A sheet closed by Back
 * leaves its entry ahead of the app; Forward onto it goes on to the next. A sheet opened while
 * that step back is on its way (the browser runs a traversal later) is not closed by the step's
 * popstate: its entry is made again over where the step landed.
 */
import { useEffect, useRef } from "react";
import { SHEET_QUERY } from "./sheets.ts";
import { useMediaQuery } from "./useMediaQuery.ts";

const KEY = "herdr-web-ui:sheet";

/** what Back does to each open sheet: false refuses it (the sheet is busy), and the sheet keeps its entry */
const open = new Map<string, () => boolean | void>();
const leaving = new Map<string, ReturnType<typeof setTimeout>>();
/** the address each sheet's entry was made on */
const addresses = new Map<string, string>();
let pushing = false;
/**
 * while a closed sheet's step back is on its way: the sheets that made their entry meanwhile, which
 * its popstate leaves open. The step always lands somewhere (a sheet's entry is made over another),
 * so its popstate comes and clears this; the next step starts a set of its own.
 */
let stepping: Set<string> | null = null;

function sheetOf(state: unknown): string | null {
  if (state === null || typeof state !== "object") return null;
  const id = (state as Record<string, unknown>)[KEY];
  return typeof id === "string" ? id : null;
}

function without(state: unknown): unknown {
  if (state === null || typeof state !== "object") return state;
  const { [KEY]: _, ...rest } = state as Record<string, unknown>;
  return rest;
}

/** whether the entry the state names belongs to a sheet that is up, or just closed and not yet stepped off */
function owned(state: unknown): boolean {
  const id = sheetOf(state);
  return id !== null && (open.has(id) || leaving.has(id));
}

/** Makes the sheet's entry (RowMenu's effect on mount; exported for its test). */
export function enterSheet(onBack: () => boolean | void, reuse: string | null): string {
  // StrictMode's second mount, or a sheet reopened before its entry went: the same entry
  const timer = reuse === null ? undefined : leaving.get(reuse);
  if (reuse !== null && timer !== undefined && sheetOf(window.history.state) === reuse) {
    clearTimeout(timer);
    leaving.delete(reuse);
    open.set(reuse, onBack);
    return reuse;
  }
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const base = window.history.state;
  const state = { ...(base !== null && typeof base === "object" ? base : {}), [KEY]: id };
  pushing = true;
  try {
    // a sheet opened from another sheet takes that sheet's entry: one Back closes it
    if (owned(base)) window.history.replaceState(state, "");
    else window.history.pushState(state, "");
  } finally { pushing = false; }
  open.set(id, onBack);
  addresses.set(id, window.location.href);
  stepping?.add(id);
  return id;
}

/** Makes the sheet's entry again over the one the history is on (Back refused, or a step that was not Back for it). */
function remake(id: string, onBack: () => boolean | void): void {
  const base = window.history.state;
  pushing = true;
  try { window.history.pushState({ ...(base !== null && typeof base === "object" ? base : {}), [KEY]: id }, ""); }
  finally { pushing = false; }
  open.set(id, onBack);
  addresses.set(id, window.location.href);
}

/** Steps off the sheet's entry once the closing click's effects are through (RowMenu's effect on unmount). */
export function leaveSheet(id: string): void {
  if (!open.delete(id)) return;
  // after the closing click's commit and effects, which may write history of their own
  leaving.set(id, setTimeout(() => {
    leaving.delete(id);
    const address = addresses.get(id);
    addresses.delete(id);
    if (sheetOf(window.history.state) !== id) return;
    // an item that changed the address on the sheet's entry (the New tab dialog) keeps the entry as its own
    if (window.location.href !== address) window.history.replaceState(without(window.history.state), "");
    else {
      // the traversal runs later: a sheet that opens before its popstate keeps its entry
      stepping = new Set();
      window.history.back();
    }
  }, 0));
}

if (typeof window !== "undefined") {
  const history = window.history;
  const push = history.pushState.bind(history);
  history.pushState = ((state: unknown, ...rest: [string, (string | URL | null)?]) => {
    if (pushing) return push(state, ...rest);
    // a navigation made from a sheet (an item that opened another pane, Settings, a file) takes the
    // sheet's entry: Back from there goes to the pane before the sheet, and no entry is left between
    if (owned(history.state)) return history.replaceState(without(state), ...rest);
    // an entry pushed over a sheet's copies its state (the file viewer's does): only the sheet's own carries its mark
    return push(without(state), ...rest);
  }) as History["pushState"];
  window.addEventListener("popstate", (event) => {
    const landed = sheetOf(event.state);
    // the step off a closed sheet's entry: not a Back for the sheets that opened while it was on its way
    const step = stepping;
    stepping = null;
    // the sheets that stay: their entries are made again over where the history landed
    const again: Array<[string, () => boolean | void]> = [];
    for (const [id, onBack] of [...open]) {
      if (id === landed) continue;
      open.delete(id);
      // a sheet busy at Back refuses it and stays; one that opened during the step was never asked
      if (step?.has(id) || onBack() === false) again.push([id, onBack]);
    }
    // the entry of a sheet that Back closed lies ahead of the app: Forward lands on it and goes on,
    // and the entry is an ordinary one from here
    const retired = landed !== null && !open.has(landed) && !leaving.has(landed);
    if (retired) window.history.replaceState(without(event.state), "");
    for (const [id, onBack] of again) remake(id, onBack);
    if (retired && again.length === 0) window.history.forward();
  });
  // a reload keeps the history and not the sheet: its entry is an ordinary one now
  if (sheetOf(window.history.state) !== null) window.history.replaceState(without(window.history.state), "");
}

/** While `active`, the sheet holds a history entry; Back calls `onBack`, which may return false to refuse (a busy sheet keeps its entry). */
export function useSheetHistory(active: boolean, onBack: () => boolean | void): void {
  const latest = useRef(onBack);
  latest.current = onBack;
  const id = useRef<string | null>(null);
  useEffect(() => {
    if (!active) return;
    const entry = enterSheet(() => latest.current(), id.current);
    id.current = entry;
    return () => leaveSheet(entry);
  }, [active]);
}

/**
 * A dialog that is a bottom sheet at phone width: there, while `open`, Back closes it (`onBack`) as
 * it does a ⋯ menu; `onBack` returning false (the dialog is busy) keeps it and its entry. A wider
 * screen keeps Back for the panes, with the dialog over them. A dialog that mounts another over
 * itself (the file list under a file) passes `open` false meanwhile, so the one on top has the entry.
 */
export function usePhoneSheetBack(onBack: () => boolean | void, open = true): void {
  useSheetHistory(useMediaQuery(SHEET_QUERY) && open, onBack);
}
