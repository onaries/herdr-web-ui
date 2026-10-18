/**
 * Keeps the shared settings and the pins (shared/preferences.ts) the same in every browser of this
 * server. Loaded once the app is in (never before the access gate): what the server holds is laid
 * over this browser's settings, setting by setting; a setting nobody has shared yet stays this
 * browser's own, and opening a page writes nothing. A change here sends just what changed, once the
 * settings rest; another browser's arrives as a `preferences` event, and the server sends its whole
 * document each time the event stream opens, so a reconnected page catches up. Last write wins,
 * setting by setting: a change made here and not yet sent stays, and goes out over what arrived.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { mirrorPalette, SHARED_SETTING_KEYS, type PreferencesChange, type SharedPreferences, type SharedSettingKey } from "../../shared/preferences.ts";
import { ApiError, fetchPreferences, savePreferences } from "./api.ts";
import { DEFAULT_THEME } from "./themes.ts";
import { sanitizeSettings, sharedSettings, useSettings, type Settings } from "./settings.ts";
import { currentSidebarPins, setSidebarPins, subscribeSidebarPins } from "./sidebarPins.ts";

const SEND_AFTER_MS = 600;
/** a request that failed on the way (the network, a restart) is tried again after this */
const RETRY_MS = 5_000;

type Shared = Partial<Record<SharedSettingKey, unknown>>;
/** What this browser last knew the server to hold; `pins` is null while the server has held none. */
export interface Baseline { settings: Shared; pins: readonly string[] | null }
/** What this browser holds. */
export interface Local { settings: Settings; pins: readonly string[] }

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * What changed here since `base`: the shared settings that differ, and the pins when they do; null
 * when nothing did. While the server has held no pins, this browser's ride along with its first change,
 * so the pins of the browser that shares first are not lost.
 */
export function preferencesChange(base: Baseline, local: Local): PreferencesChange | null {
  const now = sharedSettings(local.settings);
  const settings = Object.fromEntries(Object.entries(now).filter(([key, value]) => !same(value, base.settings[key as SharedSettingKey])));
  const pinsChanged = base.pins !== null && !same(local.pins, base.pins);
  if (Object.keys(settings).length === 0 && !pinsChanged) return null;
  return pinsChanged || base.pins === null ? { settings, pins: [...local.pins] } : { settings };
}

export interface Taken {
  base: Baseline;
  /** the settings to set here */
  patch: Partial<Settings>;
  /** the pins to set here; null leaves them */
  pins: string[] | null;
}

/**
 * What a document from the server does here. Each setting it holds replaces this browser's, except
 * one changed here since `base` and not yet sent (it goes out next and wins), and one this browser
 * cannot read (a newer release's value stays the others'). `inFlight` is the change the document
 * answers: a value the server took is no longer this browser's own, so the document's stands (a
 * document from before the change landed is held until the answer, lib/preferencesSync.ts). With
 * `force` (a watching device, which sends nothing) every value is taken. The
 * baseline takes the server's values either way. The first pins the server holds join this browser's:
 * nobody loses pins when a server begins sharing them; after that the last write wins.
 */
export function takePreferences(base: Baseline, local: Local, remote: SharedPreferences, inFlight: PreferencesChange | null, force = false): Taken {
  const settings: Shared = { ...base.settings };
  const patch: Record<string, unknown> = {};
  const incoming = { ...remote.settings };
  // Read an old document's fixed-mode appearance into its active side. System's palette
  // was unused, so it must not replace this device's migrated pair. This is passive
  // migration only: the derived side advances the baseline too, never a correcting PUT.
  if (!("darkTheme" in incoming) && !("lightTheme" in incoming) && "palette" in incoming) {
    const mode = incoming.theme ?? base.settings.theme;
    if (mode === "dark") incoming.darkTheme = incoming.palette;
    if (mode === "light") incoming.lightTheme = incoming.palette;
  }
  for (const key of SHARED_SETTING_KEYS) {
    if (!(key in incoming)) continue;
    const value = incoming[key];
    if (!same(sanitizeSettings({ [key]: value })[key], value)) continue;
    const sent = inFlight !== null && key in inFlight.settings && same(inFlight.settings[key], local.settings[key]);
    const edited = !same(local.settings[key], base.settings[key]) && !sent;
    settings[key] = value;
    if (force || !edited) patch[key] = value;
  }
  // Palette is a derived mirror, not an independent local edit. A legacy document with no
  // sides must not overwrite a device's migrated System pair or provoke a correcting PUT.
  settings.palette = mirrorPalette(settings.theme, settings.darkTheme ?? DEFAULT_THEME, settings.lightTheme ?? DEFAULT_THEME);
  let pins: string[] | null = null;
  if (remote.pins !== undefined) {
    if (base.pins === null && !force) pins = [...remote.pins, ...local.pins.filter((pin) => !remote.pins!.includes(pin))];
    else {
      const sent = inFlight?.pins !== undefined && same(inFlight.pins, local.pins);
      const edited = !same(local.pins, base.pins) && !sent;
      if (force || !edited) pins = [...remote.pins];
    }
  }
  return { base: { settings, pins: remote.pins === undefined ? base.pins : [...remote.pins] }, patch: patch as Partial<Settings>, pins };
}

export function usePreferencesSync(enabled: boolean): (preferences: SharedPreferences) => void {
  const { settings, update } = useSettings();
  const pins = useSyncExternalStore(subscribeSidebarPins, currentSidebarPins, currentSidebarPins);
  const latest = useRef<Local>({ settings, pins });
  latest.current = { settings, pins };
  // what this browser last knew the server to hold; until a document arrives, what it holds itself
  const base = useRef<Baseline>({ settings: sharedSettings(settings), pins: null });
  const revision = useRef(0);
  // a document has arrived (the GET, or the event stream's opening): sending begins then
  const loadedRef = useRef(false);
  const [loaded, setLoaded] = useState(false);
  // a server without the route: sync stands down, settings stay this browser's
  const off = useRef(false);
  // a watching device: it takes what the others share and sends nothing; a change of its own lasts until the next shared one
  const readOnly = useRef(false);
  const inFlight = useRef<PreferencesChange | null>(null);
  // the newest document that arrived while a change was on its way: whether it is older or newer
  // than that change shows once the answer, with its revision, is here
  const held = useRef<SharedPreferences | null>(null);
  // the send effect runs again when this moves: after a send, or a failed one's wait
  const [attempt, setAttempt] = useState(0);
  const [loadAttempt, setLoadAttempt] = useState(0);
  // the baseline is a ref: a document that changes nothing here still moves what is pending
  const [, setTaken] = useState(0);

  const absorb = useCallback((remote: SharedPreferences) => {
    if (off.current || (loadedRef.current && remote.revision <= revision.current)) return;
    revision.current = Math.max(revision.current, remote.revision);
    const taken = takePreferences(base.current, latest.current, remote, inFlight.current, readOnly.current);
    base.current = taken.base;
    // a second document in the same tick compares against what this one set, not the last render
    latest.current = { settings: sanitizeSettings({ ...latest.current.settings, ...taken.patch }), pins: taken.pins ?? latest.current.pins };
    if (Object.keys(taken.patch).length > 0) update(taken.patch);
    if (taken.pins !== null) setSidebarPins(taken.pins);
    loadedRef.current = true;
    setLoaded(true);
    setTaken((count) => count + 1);
  }, [update]);

  const receive = useCallback((remote: SharedPreferences) => {
    if (inFlight.current === null) { absorb(remote); return; }
    if (held.current === null || remote.revision > held.current.revision) held.current = remote;
  }, [absorb]);

  // the change is answered or lost: what arrived meanwhile is read now (an older document is dropped by its revision)
  const settled = useCallback(() => {
    inFlight.current = null;
    const arrived = held.current;
    held.current = null;
    if (arrived !== null) absorb(arrived);
  }, [absorb]);

  useEffect(() => {
    if (!enabled || off.current || loaded) return;
    let cancelled = false;
    let retry: number | undefined;
    fetchPreferences().then((remote) => {
      if (cancelled) return;
      if (remote === null) { off.current = true; return; }
      receive(remote);
    }).catch(() => { if (!cancelled) retry = window.setTimeout(() => setLoadAttempt((count) => count + 1), RETRY_MS); });
    return () => { cancelled = true; window.clearTimeout(retry); };
  }, [enabled, loaded, loadAttempt, receive]);

  const change = loaded ? preferencesChange(base.current, { settings, pins }) : null;
  const pending = change === null ? null : JSON.stringify(change);
  useEffect(() => {
    if (!enabled || !loaded || off.current || readOnly.current || pending === null || inFlight.current !== null) return;
    let retry: number | undefined;
    const timer = window.setTimeout(() => {
      const body = JSON.parse(pending) as PreferencesChange;
      inFlight.current = body;
      savePreferences(body).then((saved) => {
        // An older server silently drops new names. Acknowledge exactly what was sent, not
        // today's local value: an edit made while the request was in flight still goes next.
        for (const key of SHARED_SETTING_KEYS) {
          if (key in body.settings && !(key in saved.settings)) base.current.settings[key] = body.settings[key];
        }
        // the answer is the whole document as this change left it: one from elsewhere that landed
        // before comes with it, one that landed after was held and is read now
        absorb(saved);
        settled();
        // what changed while this was on its way goes out now
        setAttempt((count) => count + 1);
      }).catch((error: unknown) => {
        settled();
        if (error instanceof ApiError && error.status === 403) readOnly.current = true;
        else if (error instanceof ApiError && error.status === 404) off.current = true;
        else retry = window.setTimeout(() => setAttempt((count) => count + 1), RETRY_MS);
      });
    }, SEND_AFTER_MS);
    return () => { window.clearTimeout(timer); window.clearTimeout(retry); };
  }, [enabled, loaded, pending, attempt, absorb, settled]);

  return receive;
}
