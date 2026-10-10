/**
 * Settings in the browser's history. The system Back button (Android's, a swipe from the screen's
 * edge) traverses history, and a dialog that is no entry of it is skipped: Back left the app
 * instead of the page. So each step into Settings is an entry above the app: the dialog, the
 * page a phone opens from its list, the key bar editor. Back takes them off one at a time.
 *
 * The dialog says what is shown as a list of levels (`recordSettings`); this module makes the
 * history hold exactly those entries, pushing the missing ones and stepping back over the ones
 * no longer shown (a Back control in the dialog, its X, Escape). It tells its listeners when a
 * traversal lands, and whether it was one of its own.
 */

const KEY = "herdr-web-ui:settings";
/** how long to wait before releasing the traversal's busy state, not its ownership */
const LANDING_MS = 1000;

/** One step into Settings: the page shown (null: a phone's list of pages) and the key bar editor over it. */
export interface SettingsLevel {
  page: string | null;
  keyBar: boolean;
}

export interface SettingsEntry extends SettingsLevel {
  /** how many entries of Settings the history holds up to this one */
  depth: number;
}

/**
 * What the dialog shows, as the steps that led there. A phone lists the pages first, so its
 * list is a step of its own; a wider dialog opens on a page, and turning to another replaces it.
 */
export function settingsLevels(narrow: boolean, page: string | null, keyBar: boolean): SettingsLevel[] {
  const levels: SettingsLevel[] = narrow ? [{ page: null, keyBar: false }] : [];
  if (page !== null) levels.push({ page, keyBar: false });
  if (page !== null && keyBar) levels.push({ page, keyBar: true });
  return levels;
}

/** The Settings entry a history state holds, or null: state is whatever another script left there. */
export function settingsEntry(state: unknown): SettingsEntry | null {
  if (state === null || typeof state !== "object") return null;
  const entry = (state as Record<string, unknown>)[KEY];
  if (entry === null || typeof entry !== "object") return null;
  const { page, keyBar, depth } = entry as Record<string, unknown>;
  if ((page !== null && typeof page !== "string") || typeof keyBar !== "boolean") return null;
  if (typeof depth !== "number" || !Number.isInteger(depth) || depth < 1 || depth > 3) return null;
  return { page, keyBar, depth };
}

type Listener = (entry: SettingsEntry | null, own: boolean) => void;
const listeners = new Set<Listener>();
let wanted: readonly SettingsLevel[] = [];
/** the steps this module knows the history holds for Settings, by depth; null for one it did not push and cannot see */
let held: Array<SettingsLevel | null> = [];
const same = (a: SettingsLevel | null, b: SettingsLevel): boolean => a !== null && a.page === b.page && a.keyBar === b.keyBar;
/** traversals asked for here that have not landed yet: nothing is pushed while one is under way */
let rewinding = 0;
let landing: ReturnType<typeof setTimeout> | undefined;
let pending: { from: unknown; depth: number; level: SettingsLevel | null; expired: boolean; reopened: boolean; claim: boolean } | null = null;
let observed: unknown = typeof window === "undefined" ? undefined : window.history.state;
let writing = false;

function releasePending(): void { pending = null; rewinding = 0; clearTimeout(landing); }

function writeState(method: "pushState" | "replaceState", state: unknown): void {
  writing = true;
  try { window.history[method](state, ""); }
  finally { writing = false; observed = window.history.state; }
}

function rewind(by: number): void {
  if (pending !== null) return;
  const depth = (settingsEntry(window.history.state)?.depth ?? 0) - by;
  const request = { from: window.history.state, depth, level: held[depth - 1] ?? null, expired: false, reopened: false, claim: true };
  pending = request;
  rewinding = 1;
  clearTimeout(landing);
  landing = setTimeout(() => {
    if (pending !== request) return;
    rewinding = 0;
    request.expired = true;
    if (request.reopened) request.claim = false;
  }, LANDING_MS);
  window.history.go(-by);
}

function reconcile(): void {
  const state: unknown = window.history.state;
  if (pending !== null && state !== observed) releasePending();
  observed = state;
  if (rewinding > 0) return;
  const current = settingsEntry(state);
  const have = current?.depth ?? 0;
  // what the history holds up to here: a Back landed under what was recorded; the step shown is
  // read from the state; one this module did not push (a reload or a Forward landed on entries
  // of an earlier opening) is unknown, never taken on trust, and rebuilt like a differing one
  held = held.slice(0, have);
  while (held.length < have) held.push(null);
  if (have > 0 && current) held[have - 1] = { page: current.page, keyBar: current.keyBar };
  if (have > wanted.length) { rewind(have - wanted.length); return; }
  // the first step that differs from what is wanted. An earlier one (the window changed width:
  // a phone's list belongs under a page a wider dialog had opened directly, or no longer does)
  // is stepped back to and the steps above it are made anew
  let differs = 0;
  while (differs < have && differs < wanted.length && same(held[differs]!, wanted[differs]!)) differs++;
  if (differs < have - 1) { rewind(have - differs - 1); return; }
  const base = state !== null && typeof state === "object" ? state : {};
  if (have > 0 && differs === have - 1) {
    // the step shown is another: a wider dialog turned its page, or the list took a page's place
    writeState("replaceState", { ...base, [KEY]: { ...wanted[have - 1], depth: have } });
    held[have - 1] = wanted[have - 1]!;
  }
  for (let depth = have + 1; depth <= wanted.length; depth++) {
    writeState("pushState", { ...base, [KEY]: { ...wanted[depth - 1], depth } });
    held.push(wanted[depth - 1]!);
  }
}

/** Makes the history hold these steps into Settings, in order; none when the dialog is closed. */
export function recordSettings(levels: readonly SettingsLevel[]): void {
  const reopening = wanted.length === 0 && levels.length > 0;
  wanted = levels;
  if (reopening && pending !== null) { pending.reopened = true; if (pending.expired) pending.claim = false; }
  if (typeof window !== "undefined") reconcile();
}

/**
 * Tells when the history moved: the Settings entry it landed on (null: under the dialog), and
 * whether the move was this module's own stepping back, which the dialog already shows.
 */
export function onSettingsHistory(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

if (typeof window !== "undefined") {
  for (const method of ["pushState", "replaceState"] as const) {
    const history = window.history;
    const write = history[method].bind(history);
    history[method] = ((...args: Parameters<History["pushState"]>) => {
      write(...args);
      observed = history.state;
      if (!writing) releasePending();
    }) as History["pushState"];
  }
  window.addEventListener("popstate", (event) => {
    observed = event.state;
    const entry = settingsEntry(event.state);
    const matches = pending !== null && (entry?.depth ?? 0) === pending.depth
      && (pending.level === null || (entry !== null && same(pending.level, entry)));
    const own = matches && pending?.claim === true;
    if (pending !== null && (matches || event.state !== pending.from)) releasePending();
    for (const listener of [...listeners]) listener(entry, own);
    // what was asked for while the traversal was under way is done now
    if (own) reconcile();
  });
  // a reload keeps the history and not the dialog: step out of the entries it left
  const left = settingsEntry(window.history.state);
  if (left !== null) rewind(left.depth);
}
