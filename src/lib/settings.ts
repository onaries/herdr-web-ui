/**
 * User preferences: one localStorage record, one React context, applied to the
 * document as `data-theme` / `data-density` / `data-chat-width` attributes that src/styles.css keys
 * its token overrides on. xterm reads no CSS, so `terminalTheme()` mirrors the
 * `--term-*` tokens of each theme for PaneTerminal's theme object.
 */

import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { LANGUAGE_SETTINGS, LOCALE_TAGS, resolveLanguage, setCurrentLanguage, type Language, type LanguageSetting } from "./i18n.ts";
import type { AlertPrefs, DoneAlerts } from "../../shared/notify-policy.ts";
import { chatFontStack, sanitizeFontFamily } from "./fontFamily.ts";
import { sanitizeKeyBarExtras, type KeyBarExtra } from "./keys.ts";
import { DEFAULT_KEY_BAR_ITEMS, migrateKeyBarItems, sanitizeKeyBarItems, type KeyBarItem } from "./keyBar.ts";

export type ThemeSetting = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";
export type Density = "compact" | "comfortable";
/** One line names the workspace; two lines say what its pane is doing, with the workspace under it. */
export type SidebarRows = "one" | "two";
/** the Agents list's order: herdr's workspace order, or a waiting agent first and then the latest change */
export type AgentOrder = "workspace" | "activity";
/** what the plan meters count: the share of a limit used, or what is left of it */
export type UsageCount = "used" | "left";
/** the limit a plan meter shows: the plan's week, or its short session (5 hours on Claude and Codex) */
export type UsageGlance = "week" | "session";
/** amber: the herdr look (the default); report: the dark technical report look; charcoal: neutral Ghostty-style dark;
 *  catppuccin: Catppuccin Mocha in dark, Latte in light; lilac: lavender surfaces and indigo accents */
export type Palette = "amber" | "report" | "charcoal" | "catppuccin" | "lilac";
/** the chat lane's widest: the transcript, the composer column and the held list share it (--chat-w in src/styles.css).
 *  narrow: 820px; default: follows the pane, up to 60rem (chatLaneWidth); wide: 72rem; full: the pane, less the gutters */
export type ChatWidth = "narrow" | "default" | "wide" | "full";
export const CHAT_WIDTHS: readonly ChatWidth[] = ["narrow", "default", "wide", "full"];
/** the microphone button. auto: in the chat composer off a phone, and only where dictation can work;
 *  on: there, on a phone and in the terminal input line, disabled with its reason where it cannot work; off: nowhere */
export type VoiceButton = "auto" | "on" | "off";
export const VOICE_BUTTONS: readonly VoiceButton[] = ["auto", "on", "off"];
/** the lens a pane opens in until it is switched there: auto is chat for an agent on a touch screen, else terminal */
export type DefaultView = "auto" | "chat" | "terminal";

import { sanitizeShortcutOverrides, type ShortcutOverrides } from "./shortcutBindings.ts";

export interface Settings {
  terminalInputMode: "auto" | "line" | "direct";
  /** Kept for migration of the old fixed-order bar. New layouts use keyBarItems. */
  keyBarExtras: KeyBarExtra[];
  /** This device's terminal keys, sticky modifiers and exact chords, in display order. */
  keyBarItems: KeyBarItem[];
  shortcutOverrides: ShortcutOverrides;
  theme: ThemeSetting;
  density: Density;
  /** How much a workspace row says: its name, or its pane's title over its place. */
  sidebarRows: SidebarRows;
  /** The Agents list's order. Activity is display-only: herdr's own order never changes. */
  agentOrder: AgentOrder;
  /** a DONE opened here since it finished reads as ready, as herdr's own view would make it (per browser and PC) */
  quietOpenedDone: boolean;
  /** the chrome color family, keyed as data-palette in src/styles.css */
  palette: Palette;
  /** xterm font size in px */
  terminalFontSize: number;
  /** mouse reports sent to herdr per wheel event in the terminal: 1 is what xterm sends by itself */
  terminalWheelSpeed: number;
  /** fonts tried before the built-in terminal stack, as a CSS font-family list; "" keeps the built-in one */
  terminalFontFamily: string;
  /** let a pane's OSC 52 sequence write the clipboard (lib/osc52.ts), as vim, tmux and Claude Code copy;
   *  on unless chosen off, since any process in the pane can then plant text the user pastes elsewhere.
   *  Stored under this key, not 0.4.1's `terminalOsc52`: settings are saved whole, so a `false` there
   *  was written by any change at all, not chosen, and is ignored. */
  paneClipboard: boolean;
  /** chat text size in px (its body text; the rest scales with it); null follows the density */
  chatFontSize: number | null;
  /** fonts tried before the UI font in the chat's prose (code stays mono), as a CSS font-family list; "" keeps the UI font */
  chatFontFamily: string;
  /** how wide the chat lane may run on a large screen, keyed as data-chat-width in src/styles.css; default follows the pane
   *  (chatLaneWidth, written by PaneTerminal); a narrower pane is never affected */
  chatWidth: ChatWidth;
  /** true: Enter sends in the composer, Shift+Enter breaks the line; false: Ctrl/Cmd+Enter sends */
  enterSends: boolean;
  /** show the agent's folded reasoning blocks in the chat view */
  showThinking: boolean;
  /** request a screen wake lock while a pane is open in this visible tab */
  keepScreenOn: boolean;
  /** UI language; `system` follows the browser (src/lib/i18n.ts) */
  language: LanguageSetting;
  /** alerts on this device at all: the bell turns them off (push subscription dropped) and on */
  alertsOn: boolean;
  /** alert this device when an agent waits on the user (shared/notify-policy.ts AlertPrefs) */
  alertInput: boolean;
  /** alert this device when a turn finishes: never, after a long one, or every one */
  alertDone: DoneAlerts;
  /** while the app is on screen, the same alerts drop in from the top edge (components/Droplet.tsx) */
  alertInApp: boolean;
  /** an open tab chimes for the same alerts (lib/alertSound.ts), heard also when a Focus silences notifications; off until chosen */
  alertSound: boolean;
  /** one-tap replies above the composer, in order; blank ones are kept while being typed, never shown */
  quickReplies: string[];
  /** whether the quick replies show above the composer at all */
  showQuickReplies: boolean;
  /** touch screens: a chip above the message box takes the prompt Claude suggests next */
  showSuggestionChip: boolean;
  /** the plan meters beside Settings in the sidebar (GET /api/usage); off until chosen, as it sends this PC's sign-ins out */
  showUsage: boolean;
  usageCount: UsageCount;
  usageGlance: UsageGlance;
  /** every pane's lens until switched in that pane; changing it puts every pane back on it */
  defaultView: DefaultView;
  /** the plan meters' order by ProviderUsage.key; accounts not in it follow as the server lists them */
  usageOrder: string[];
  /** accounts left out of the plan meters, strip and popover alike, by ProviderUsage.key */
  usageHidden: string[];
  /** the microphone button in the composer and the terminal input line; nothing is recorded until it is pressed */
  voiceInput: VoiceButton;
  voicePolishChat: boolean;
  /** off by default: a terminal line is usually a command, kept as spoken */
  voicePolishTerminal: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  terminalInputMode: "auto",
  keyBarExtras: ["alt"],
  keyBarItems: DEFAULT_KEY_BAR_ITEMS,
  shortcutOverrides: {},
  theme: "dark",
  density: "comfortable",
  sidebarRows: "two",
  agentOrder: "workspace",
  quietOpenedDone: false,
  palette: "amber",
  terminalFontSize: 13,
  terminalWheelSpeed: 1,
  terminalFontFamily: "",
  paneClipboard: true,
  chatFontSize: null,
  chatFontFamily: "",
  chatWidth: "default",
  enterSends: true,
  showThinking: false,
  keepScreenOn: false,
  language: "system",
  alertsOn: true,
  alertInput: true,
  alertDone: "long",
  alertInApp: true,
  alertSound: false,
  quickReplies: ["continue", "yes", "no", "commit and push", "retry"],
  showQuickReplies: false,
  showSuggestionChip: true,
  showUsage: false,
  usageCount: "used",
  usageGlance: "week",
  defaultView: "auto",
  usageOrder: [],
  usageHidden: [],
  voiceInput: "auto",
  voicePolishChat: true,
  voicePolishTerminal: false,
};

export const QUICK_REPLIES_MAX = 12;
/** accounts the usage order and hiding remember; more are a hand-edited record */
export const USAGE_KEYS_MAX = 64;

/** A list of usage keys: strings only, each once, bounded. */
function usageKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((key): key is string => typeof key === "string" && key.length > 0 && key.length <= 512))].slice(0, USAGE_KEYS_MAX);
}
export const QUICK_REPLY_MAX_CHARS = 200;

/**
 * A record from before the button had a place of its own holds a boolean: on stays on. Its off
 * was also what a device that never chose held, so it follows the default.
 */
function voiceButton(value: unknown): VoiceButton {
  if (value === true) return "on";
  return VOICE_BUTTONS.includes(value as VoiceButton) ? value as VoiceButton : DEFAULT_SETTINGS.voiceInput;
}

/** Whether an input asks for dictation at all: auto leaves the terminal input line and a phone's composer alone. */
export function wantsVoiceInput(setting: VoiceButton, mode: "chat" | "terminal", phone: boolean): boolean {
  return setting === "on" || (setting === "auto" && mode === "chat" && !phone);
}

/** The replies worth a button: what the list holds, without the blank ones still being written. */
export function quickReplyButtons(settings: Settings): string[] {
  return settings.quickReplies.filter((reply) => reply.trim() !== "");
}

/** This device's alert choices, as the server keeps them with its push subscription. */
export function alertPrefs(settings: Settings): AlertPrefs {
  return { input: settings.alertInput, done: settings.alertDone };
}

const STORAGE_KEY = "herdr-web-ui:settings";
export const TERMINAL_FONT_MIN = 10;
export const TERMINAL_FONT_MAX = 22;
export const TERMINAL_WHEEL_SPEED_MIN = 1;
export const TERMINAL_WHEEL_SPEED_MAX = 10;

export const CHAT_FONT_MIN = 11;
export const CHAT_FONT_MAX = 24;
/** each density's body size, --fs-md in src/styles.css: the chat's size when none is chosen */
const CHAT_BASE_FONT: Record<Density, number> = { comfortable: 14, compact: 13 };

function clampFont(size: number): number {
  return Math.min(TERMINAL_FONT_MAX, Math.max(TERMINAL_FONT_MIN, Math.round(size)));
}

/** The chat's body text size in px: the chosen one, or the density's. */
export function chatFontSize(settings: Settings): number {
  return settings.chatFontSize ?? CHAT_BASE_FONT[settings.density];
}

/** The Default chat lane never runs narrower than this, in px: --content-w, the Narrow step. */
export const CHAT_LANE_MIN = 820;
/** ...or wider than this, in rem: 960px at a 16px root. In rem because Wide is (72rem, styles.css),
 *  so Default stays the narrower of the two at a root font of 11.39px and up; under that the
 *  820px floor wins and is itself wider than Wide (see chatLaneLength). */
export const CHAT_LANE_MAX_REM = 60;
/** The share of its pane the Default chat lane takes between the two. */
export const CHAT_LANE_RATIO = 0.7143;
/** The root font size chatLaneWidth resolves the rem ceiling with when none is given. */
export const ROOT_FONT_PX = 16;

/** The Default lane's pane-following part in whole px, before the rem ceiling: 71.43% of the pane, min 820px. */
function chatLaneFollow(paneWidth: number): number {
  if (!Number.isFinite(paneWidth)) return CHAT_LANE_MIN;
  return Math.max(CHAT_LANE_MIN, Math.round(paneWidth * CHAT_LANE_RATIO));
}

/**
 * The Default chat lane for a pane this wide, as the CSS length PaneTerminal writes to --chat-w:
 * 71.43% of the pane, min 820px, max 60rem.
 * A length with no percentage in it: the lane's columns sit in boxes of different widths (the
 * transcript and the composer column inside a gutter, the held list and the menus outside it),
 * and one length is what keeps them equal. A pane narrower than the result is unaffected:
 * every column is min(100%, lane).
 * The ceiling is left to the stylesheet engine as 60rem, not resolved here: Wide's 72rem follows
 * the root font size the moment it changes, and so must this, or Default would be the wider of
 * the two until the pane was next measured.
 * Where the two ends cross (60rem is under 820px below a 13.67px root) the floor wins: Default is
 * then the same lane as Narrow, never narrower than it, and still no wider than Wide down to an
 * 11.39px root, under which Narrow's own 820px is already wider than Wide's 72rem.
 */
export function chatLaneLength(paneWidth: number): string {
  return `min(max(${CHAT_LANE_MIN}px, ${CHAT_LANE_MAX_REM}rem), ${chatLaneFollow(paneWidth)}px)`;
}

/** What chatLaneLength resolves to at this root font size, in px (960 at most at 16px): the rule in numbers. */
export function chatLaneWidth(paneWidth: number, rootFontPx: number = ROOT_FONT_PX): number {
  const root = Number.isFinite(rootFontPx) && rootFontPx > 0 ? rootFontPx : ROOT_FONT_PX;
  return Math.min(Math.max(CHAT_LANE_MIN, CHAT_LANE_MAX_REM * root), chatLaneFollow(paneWidth));
}

/** Only known keys with the right type survive: a stale or hand-edited record never breaks the UI. */
export function sanitizeSettings(raw: unknown): Settings {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const theme = record["theme"];
  const density = record["density"];
  const font = record["terminalFontSize"];
  const chatFont = record["chatFontSize"];
  const keyBarExtras = sanitizeKeyBarExtras(record["keyBarExtras"], DEFAULT_SETTINGS.keyBarExtras);
  const keyBarFallback = Array.isArray(record["keyBarExtras"])
    ? migrateKeyBarItems(keyBarExtras)
    : DEFAULT_KEY_BAR_ITEMS;
  return {
    terminalInputMode: record["terminalInputMode"] === "line" || record["terminalInputMode"] === "direct" ? record["terminalInputMode"] : "auto",
    keyBarExtras,
    keyBarItems: sanitizeKeyBarItems(record["keyBarItems"], keyBarFallback),
    shortcutOverrides: sanitizeShortcutOverrides(record["shortcutOverrides"]),
    theme: theme === "dark" || theme === "light" || theme === "system" ? theme : DEFAULT_SETTINGS.theme,
    density: density === "compact" || density === "comfortable" ? density : DEFAULT_SETTINGS.density,
    sidebarRows: record["sidebarRows"] === "one" || record["sidebarRows"] === "two" ? record["sidebarRows"] : DEFAULT_SETTINGS.sidebarRows,
    agentOrder: record["agentOrder"] === "workspace" || record["agentOrder"] === "activity" ? record["agentOrder"] : DEFAULT_SETTINGS.agentOrder,
    quietOpenedDone: record["quietOpenedDone"] === true,
    palette: record["palette"] === "amber" || record["palette"] === "report" || record["palette"] === "charcoal" || record["palette"] === "catppuccin" || record["palette"] === "lilac" ? record["palette"] : DEFAULT_SETTINGS.palette,
    terminalFontSize: typeof font === "number" && Number.isFinite(font) ? clampFont(font) : DEFAULT_SETTINGS.terminalFontSize,
    terminalWheelSpeed: typeof record["terminalWheelSpeed"] === "number" && Number.isFinite(record["terminalWheelSpeed"])
      ? Math.min(TERMINAL_WHEEL_SPEED_MAX, Math.max(TERMINAL_WHEEL_SPEED_MIN, Math.round(record["terminalWheelSpeed"])))
      : DEFAULT_SETTINGS.terminalWheelSpeed,
    chatFontSize: typeof chatFont === "number" && Number.isFinite(chatFont)
      ? Math.min(CHAT_FONT_MAX, Math.max(CHAT_FONT_MIN, Math.round(chatFont)))
      : DEFAULT_SETTINGS.chatFontSize,
    terminalFontFamily: sanitizeFontFamily(record["terminalFontFamily"]),
    paneClipboard: typeof record["paneClipboard"] === "boolean" ? record["paneClipboard"] : DEFAULT_SETTINGS.paneClipboard,
    chatFontFamily: sanitizeFontFamily(record["chatFontFamily"]),
    chatWidth: CHAT_WIDTHS.includes(record["chatWidth"] as ChatWidth) ? record["chatWidth"] as ChatWidth : DEFAULT_SETTINGS.chatWidth,
    enterSends: typeof record["enterSends"] === "boolean" ? record["enterSends"] : DEFAULT_SETTINGS.enterSends,
    showThinking: typeof record["showThinking"] === "boolean" ? record["showThinking"] : DEFAULT_SETTINGS.showThinking,
    keepScreenOn: typeof record["keepScreenOn"] === "boolean" ? record["keepScreenOn"] : DEFAULT_SETTINGS.keepScreenOn,
    language: LANGUAGE_SETTINGS.includes(record["language"] as LanguageSetting) ? record["language"] as LanguageSetting : DEFAULT_SETTINGS.language,
    alertsOn: typeof record["alertsOn"] === "boolean" ? record["alertsOn"] : DEFAULT_SETTINGS.alertsOn,
    alertInput: typeof record["alertInput"] === "boolean" ? record["alertInput"] : DEFAULT_SETTINGS.alertInput,
    alertDone: record["alertDone"] === "off" || record["alertDone"] === "long" || record["alertDone"] === "always" ? record["alertDone"] : DEFAULT_SETTINGS.alertDone,
    alertInApp: typeof record["alertInApp"] === "boolean" ? record["alertInApp"] : DEFAULT_SETTINGS.alertInApp,
    alertSound: typeof record["alertSound"] === "boolean" ? record["alertSound"] : DEFAULT_SETTINGS.alertSound,
    // kept as typed (a trailing space is the next word being started), only bounded
    quickReplies: Array.isArray(record["quickReplies"])
      ? record["quickReplies"].filter((reply): reply is string => typeof reply === "string").slice(0, QUICK_REPLIES_MAX).map((reply) => reply.slice(0, QUICK_REPLY_MAX_CHARS))
      : [...DEFAULT_SETTINGS.quickReplies],
    showQuickReplies: typeof record["showQuickReplies"] === "boolean" ? record["showQuickReplies"] : DEFAULT_SETTINGS.showQuickReplies,
    showSuggestionChip: typeof record["showSuggestionChip"] === "boolean" ? record["showSuggestionChip"] : DEFAULT_SETTINGS.showSuggestionChip,
    showUsage: typeof record["showUsage"] === "boolean" ? record["showUsage"] : DEFAULT_SETTINGS.showUsage,
    usageCount: record["usageCount"] === "used" || record["usageCount"] === "left" ? record["usageCount"] : DEFAULT_SETTINGS.usageCount,
    usageGlance: record["usageGlance"] === "week" || record["usageGlance"] === "session" ? record["usageGlance"] : DEFAULT_SETTINGS.usageGlance,
    defaultView: record["defaultView"] === "chat" || record["defaultView"] === "terminal" || record["defaultView"] === "auto" ? record["defaultView"] : DEFAULT_SETTINGS.defaultView,
    usageOrder: usageKeys(record["usageOrder"]),
    usageHidden: usageKeys(record["usageHidden"]),
    voiceInput: voiceButton(record["voiceInput"]),
    voicePolishChat: typeof record["voicePolishChat"] === "boolean" ? record["voicePolishChat"] : DEFAULT_SETTINGS.voicePolishChat,
    voicePolishTerminal: typeof record["voicePolishTerminal"] === "boolean" ? record["voicePolishTerminal"] : DEFAULT_SETTINGS.voicePolishTerminal,
  };
}

export function loadSettings(): Settings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === null ? DEFAULT_SETTINGS : sanitizeSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(settings: Settings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* private mode: preferences last for the session */
  }
}

const DARK_QUERY = "(prefers-color-scheme: dark)";

export function resolveTheme(setting: ThemeSetting): ResolvedTheme {
  if (setting !== "system") return setting;
  return typeof window !== "undefined" && window.matchMedia?.(DARK_QUERY).matches === false ? "light" : "dark";
}

type TerminalColors = { background: string; foreground: string; cursor: string; selectionBackground: string };

/** The xterm theme for a resolved theme and palette: the `--term-*` tokens of src/styles.css, verbatim. */
const TERMINAL_THEMES: Record<Palette, Record<ResolvedTheme, TerminalColors>> = {
  amber: {
    light: { background: "#faf8f3", foreground: "#2a251f", cursor: "#8c5000", selectionBackground: "#f0d9ae" },
    dark: { background: "#181613", foreground: "#d8d0c3", cursor: "#f0a830", selectionBackground: "#4a3d26" },
  },
  report: {
    light: { background: "#fafaf9", foreground: "#242424", cursor: "#1f5fcc", selectionBackground: "#cfe0fb" },
    dark: { background: "#0f1319", foreground: "#c9d1dc", cursor: "#4c9aff", selectionBackground: "#1f3a66" },
  },
  charcoal: {
    light: { background: "#fafaf9", foreground: "#242424", cursor: "#242424", selectionBackground: "#dedad3" },
    dark: { background: "#171717", foreground: "#cbc7c0", cursor: "#cbc7c0", selectionBackground: "#49443d" },
  },
  catppuccin: {
    light: { background: "#eff1f5", foreground: "#4c4f69", cursor: "#dc8a78", selectionBackground: "#d2d4dc" },
    dark: { background: "#1e1e2e", foreground: "#cdd6f4", cursor: "#f5e0dc", selectionBackground: "#3b3d4f" },
  },
  lilac: {
    light: { background: "#f8f7fe", foreground: "#2b2d4d", cursor: "#4a42c2", selectionBackground: "#dcd7f8" },
    dark: { background: "#18172f", foreground: "#dcdaf4", cursor: "#b3abff", selectionBackground: "#3a3768" },
  },
};

export function terminalTheme(theme: ResolvedTheme, palette: Palette = "amber"): TerminalColors {
  return TERMINAL_THEMES[palette][theme];
}

/** `<meta name="theme-color">` follows the panel surface so the PWA title bar matches. */
const THEME_COLOR: Record<Palette, Record<ResolvedTheme, string>> = {
  amber: { dark: "#181613", light: "#faf8f3" },
  report: { dark: "#0f1319", light: "#fafaf9" },
  charcoal: { dark: "#171717", light: "#fafaf9" },
  catppuccin: { dark: "#181825", light: "#e6e9ef" },
  lilac: { dark: "#1c1b34", light: "#f6f5fe" },
};

function applyToDocument(settings: Settings, resolved: ResolvedTheme, language: Language): void {
  const root = document.documentElement;
  root.lang = LOCALE_TAGS[language];
  root.dataset["theme"] = resolved;
  root.dataset["density"] = settings.density;
  root.dataset["palette"] = settings.palette;
  root.dataset["chatWidth"] = settings.chatWidth;
  // ChatView.css scales its type tokens by this: the chosen size over the density's
  root.style.setProperty("--chat-scale", String(chatFontSize(settings) / CHAT_BASE_FONT[settings.density]));
  // ChatView.css sets the transcript's prose in this, and falls back to --font-ui without it
  const chatFont = chatFontStack(settings.chatFontFamily);
  if (chatFont === null) root.style.removeProperty("--font-chat");
  else root.style.setProperty("--font-chat", chatFont);
  root.style.colorScheme = resolved;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR[settings.palette][resolved]);
}

interface SettingsContextValue {
  settings: Settings;
  /** the theme after resolving `system` against the OS preference */
  resolvedTheme: ResolvedTheme;
  /** the language after resolving `system` against the browser's */
  resolvedLanguage: Language;
  update: (patch: Partial<Settings>) => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [systemDark, setSystemDark] = useState(() => resolveTheme("system") === "dark");

  useEffect(() => {
    const query = window.matchMedia?.(DARK_QUERY);
    if (!query) return;
    const onChange = (event: MediaQueryListEvent): void => setSystemDark(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const resolvedTheme: ResolvedTheme = settings.theme === "system" ? (systemDark ? "dark" : "light") : settings.theme;

  const [browserLanguages, setBrowserLanguages] = useState<readonly string[]>(() => (typeof navigator !== "undefined" ? navigator.languages : []));
  useEffect(() => {
    const onChange = (): void => setBrowserLanguages([...navigator.languages]);
    window.addEventListener("languagechange", onChange);
    return () => window.removeEventListener("languagechange", onChange);
  }, []);
  const resolvedLanguage = resolveLanguage(settings.language, browserLanguages);
  // helpers outside React read this during the same render, so it is set before the children render
  setCurrentLanguage(resolvedLanguage);

  useEffect(() => {
    applyToDocument(settings, resolvedTheme, resolvedLanguage);
  }, [settings, resolvedTheme, resolvedLanguage]);

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((current) => {
      const next = sanitizeSettings({ ...current, ...patch });
      saveSettings(next);
      return next;
    });
  }, []);

  const value = useMemo(() => ({ settings, resolvedTheme, resolvedLanguage, update }), [settings, resolvedTheme, resolvedLanguage, update]);
  return createElement(SettingsContext.Provider, { value }, children);
}

export function useSettings(): SettingsContextValue {
  const value = useContext(SettingsContext);
  if (value === null) throw new Error("useSettings needs a SettingsProvider above it");
  return value;
}

export const PANE_VIEW_KEY_PREFIX = "herdr-web-ui:view:";

/** Forgets every pane's own lens on this device, so each opens in the default one again. */
export function forgetPaneViews(given?: Pick<Storage, "length" | "key" | "removeItem">): number {
  const keys: string[] = [];
  try {
    // inside the try: reading localStorage itself throws where storage is blocked
    const storage = given ?? window.localStorage;
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (key?.startsWith(PANE_VIEW_KEY_PREFIX)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    /* private mode: there is nothing remembered to forget */
  }
  return keys.length;
}
