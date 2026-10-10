import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { ArrowUp, FileText, Plus, Square, X } from "lucide-react";

import "./Composer.css";

import type { AgentStatus, ConversationMetadata, SlashCommand } from "../../shared/protocol.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { composerDrafts } from "../lib/composerDraft.ts";
import { paneStorageId } from "../../shared/machines.ts";
import {
  agentDisplayLabel,
  composerModelDraw,
  composerSendShown,
  composerStatusCompact,
  composerStatusHint,
  composerStatusWord,
  contextLeftPercent,
  formatTokens,
  imageMention,
  insertMention,
  MAX_COMPOSER_CHARS,
  rankSlashCommands,
  terminalOnlyCommand,
} from "../lib/compose.ts";
import { paneStatus } from "../lib/status.ts";
import { modelLabel } from "../lib/modelName.ts";
import { useFacesArrived } from "../lib/fontFaces.ts";
import { activeTrigger, applyCompletion, type ActiveTrigger } from "../lib/mentions.ts";
import { quickReplyButtons, useSettings } from "../lib/settings.ts";
import { composerUsage, formatPercent, formatResetIn, HIGH_PERCENT, meterPercent, meterText, providerForAgent, statusWindows, usageName, useUsage, windowLabel } from "../lib/usage.ts";
import { AgentMark } from "./AgentMark.tsx";
import { BackgroundTasks } from "./BackgroundTasks.tsx";
import { MicButton, VoiceRecordingPill, useDictation } from "./VoiceInput.tsx";
import { useT } from "../lib/i18n.ts";

export interface ComposerProps {
  connected: boolean;
  paneId: string;
  /** false: appearing must not take the keyboard (App switched to this pane on its own) */
  autoFocus?: boolean;
  agent: string | null;
  agentStatus?: AgentStatus;
  /** an OmO pane's running background tasks: the status line opens their list */
  backgroundTasks?: number;
  /** the pane's turn ended on work still running in the background: its word is BG, not DONE (lib/status.ts paneStatus) */
  backgroundWait?: boolean;
  metadata?: ConversationMetadata | null;
  /** replaces the placeholder: how a message answers the agent's waiting prompt */
  answerHint?: string | null;
  /** what the agent suggests typing next (Claude's grey input text): the placeholder, taken with Tab */
  suggestion?: string | null;
  /** an empty chat's greeting: it stands over the composer's column and takes no row of its own */
  greeting?: ReactNode;
  /** true: sent, clear the box; a string: keep the text and say why; a promise settles to either */
  onSend: (text: string) => boolean | string | Promise<boolean | string>;
  onAbort: () => void;
  onUploadImage: (file: File) => Promise<string>;
}

const MAX_IMAGES_PER_ACTION = 4;
/**
 * Any file can be attached (an icon, a PDF, a log): the server stores it beside the pane
 * and the message mentions its path. These image types also get a thumbnail.
 */
const PREVIEW_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"] as const;
const COMMAND_CACHE_MS = 60_000;
const SLASH_USAGE_KEY = "herdr-web-ui:slash-usage";
/** One height for every pane on this device: it is the screen, not the conversation, that decides it. */
const COMPOSER_HEIGHT_KEY = "herdr-web-ui:composer-height";
const COMPOSER_HEIGHT_MAX = 480;
const COMPOSER_HEIGHT_STEP = 24;
/** How far a press on the grip must travel to become a resize: a tap or a resting finger sets nothing. */
const RESIZE_SLACK = { mouse: 3, touch: 10 } as const;
/** Two taps on the grip this close return the box to its automatic height (iOS may send no dblclick). */
const DOUBLE_TAP_MS = 350;
const COMMAND_SOURCES = ["builtin", "user", "project", "skill", "plugin"] as const;
export const SOURCE_LABEL: Record<SlashCommand["source"], string> = {
  builtin: "Built in",
  user: "User",
  project: "Project",
  skill: "Skills",
  plugin: "Plugins",
};

type CommandCacheEntry = { loadedAt: number; commands: SlashCommand[] };
const commandCache = new Map<string, CommandCacheEntry>();
let attachmentSequence = 0;

type Attachment = {
  id: number;
  file: File;
  previewUrl: string;
  path: string | null;
  state: "uploading" | "ready" | "error";
};

function readSlashUsage(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(SLASH_USAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
    );
  } catch {
    return {};
  }
}

/** A saved manual height, or null for the automatic one (also for anything malformed). */
function readComposerHeight(): number | null {
  try {
    const value = Number(window.localStorage.getItem(COMPOSER_HEIGHT_KEY));
    return Number.isFinite(value) && value > 0 && value <= COMPOSER_HEIGHT_MAX ? Math.round(value) : null;
  } catch {
    return null;
  }
}

function saveComposerHeight(value: number | null): void {
  try {
    if (value === null) window.localStorage.removeItem(COMPOSER_HEIGHT_KEY);
    else window.localStorage.setItem(COMPOSER_HEIGHT_KEY, String(value));
  } catch {
    // Without storage the height still holds until reload.
  }
}

/** Half the visible viewport at most, so a raised keyboard never leaves the transcript without room. */
function composerHeightLimit(): number {
  const viewport = window.visualViewport?.height ?? window.innerHeight;
  return Math.min(COMPOSER_HEIGHT_MAX, Math.floor(viewport / 2));
}

async function cachedPaneCommands(paneId: string, machineId: string, fetchCommands: (pane: string) => Promise<SlashCommand[]>): Promise<SlashCommand[]> {
  const cached = commandCache.get(paneStorageId(machineId, paneId));
  if (cached && Date.now() - cached.loadedAt < COMMAND_CACHE_MS) return cached.commands;
  const commands = await fetchCommands(paneId);
  commandCache.set(paneStorageId(machineId, paneId), { loadedAt: Date.now(), commands });
  return commands;
}

/**
 * What is left of the context, as a ring filled by what is used (as Codex's app shows it):
 * red when little is left. The number is on hover, and on a tap beside the ring (a touch
 * screen has no hover). A window the transcript does not name draws no ring. Whether the number
 * is open is the composer's to keep: its text takes room in the row the model label is fitted to.
 */
function ContextRing({ context, shown, readOnly = false, onToggle }: { context: NonNullable<ConversationMetadata["context"]>; shown: boolean; readOnly?: boolean; onToggle: () => void }) {
  const t = useT();
  const left = contextLeftPercent(context);
  if (left === null || context.window === null) return null;
  const label = t("Context {percent}% left", { percent: left });
  const detail = t("{used} of {window} tokens", { used: formatTokens(context.used), window: formatTokens(context.window) });
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  if (readOnly) return <span className={`composer-context composer-context-readonly${left <= 20 ? " is-low" : ""}`}>
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle className="composer-context-track" cx="8" cy="8" r={radius} />
      <circle className="composer-context-used" cx="8" cy="8" r={radius}
        strokeDasharray={`${circumference * (100 - left) / 100} ${circumference}`} transform="rotate(-90 8 8)" />
    </svg>
    <span className="visually-hidden">{label} · {detail}</span>
  </span>;
  return (
    <button
      type="button"
      className={`composer-context${left <= 20 ? " is-low" : ""}`}
      aria-label={`${label} · ${detail}`}
      title={`${label} · ${detail}`}
      aria-expanded={shown}
      onClick={onToggle}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle className="composer-context-track" cx="8" cy="8" r={radius} />
        <circle className="composer-context-used" cx="8" cy="8" r={radius}
          strokeDasharray={`${circumference * (100 - left) / 100} ${circumference}`} transform="rotate(-90 8 8)" />
      </svg>
      {shown && <span className="composer-context-text">{label}</span>}
    </button>
  );
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia?.(query).matches === true);
  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return;
    const refresh = () => setMatches(media.matches);
    refresh();
    media.addEventListener("change", refresh);
    return () => media.removeEventListener("change", refresh);
  }, [query]);
  return matches;
}

/** Chat-style input surface with pane-local drafts, command/file completion, and image mentions. */
export function Composer({
  connected,
  paneId,
  autoFocus = true,
  agent,
  agentStatus,
  backgroundTasks = 0,
  backgroundWait = false,
  metadata,
  answerHint = null,
  suggestion = null,
  greeting = null,
  onSend,
  onAbort,
  onUploadImage,
}: ComposerProps) {
  const t = useT();
  const machineId = useMachineId();
  const { fetchPaneCommands, fetchPaneFiles } = useMachineApi();
  const { settings } = useSettings();
  const mobile = useMediaQuery("(max-width: 640px), (pointer: coarse)");
  const usageEnabled = settings.showUsage && !mobile && machineId === "local" && providerForAgent(agent) !== null;
  const { report: usageReport } = useUsage(usageEnabled);
  const usage = usageEnabled && usageReport !== null ? composerUsage(usageReport.providers, agent, settings.usageOrder, settings.usageHidden) : undefined;
  const usageWindows = usage === undefined ? [] : statusWindows(usage);
  const usageLimit = usageWindows[0];
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const statusRef = useRef<HTMLDivElement | null>(null);
  const hintRef = useRef<HTMLSpanElement | null>(null);
  /** the card's own width: a narrow one shows the task chip's count */
  const [cardWidth, setCardWidth] = useState(0);
  const [contextShown, setContextShown] = useState(false);
  const composingRef = useRef(false);
  // the chat lens's input surface takes the keyboard when it appears (a pane switch remounts
  // it), as the grid does in the terminal lens: a pane picked from the drawer is typed into
  // and once the user picks the pane App had switched to on its own
  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus({ preventScroll: true });
  }, [autoFocus]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const attachmentsRef = useRef<Attachment[]>([]);
  const removedAttachments = useRef(new Set<number>());
  const fileRequest = useRef(0);
  const draftKey = `herdr-web-ui:composer-draft:${paneStorageId(machineId, paneId)}`;
  const { text, sending } = useSyncExternalStore(composerDrafts.subscribe, () => composerDrafts.read(draftKey));
  const setText = useCallback((value: string | ((previous: string) => string)) => composerDrafts.set(draftKey, value), [draftKey]);
  const mounted = useRef(true);
  const [caret, setCaret] = useState(text.length);
  const textRef = useRef(text);
  const caretRef = useRef(caret);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [slashUsage, setSlashUsage] = useState<Record<string, number>>(readSlashUsage);
  const [storedIndex, setSelectedIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // shown only when chosen in Settings → Quick replies: a button beside the box was one more thing to read
  const quickOpen = settings.showQuickReplies;
  const quickReplies = quickReplyButtons(settings);
  const [manualHeight, setManualHeight] = useState<number | null>(readComposerHeight);
  /** the box's rendered height, for the grip to announce while the height is automatic */
  const [autoHeight, setAutoHeight] = useState(0);
  /** the box's width: its text rewraps when the lane does (Settings → Chat width, a resized pane), and the automatic height with it */
  const [boxWidth, setBoxWidth] = useState(0);
  /** the automatic height of an empty box (the textarea's CSS min-height): the grip's floor */
  const [minHeight, setMinHeight] = useState(0);
  const [heightLimit, setHeightLimit] = useState(composerHeightLimit);
  const lastGripTap = useRef(0);

  attachmentsRef.current = attachments;
  textRef.current = text;
  caretRef.current = caret;
  // Codex names its skills with `$`: only there does a `$` open a menu
  const trigger = useMemo(() => activeTrigger(text, caret, { skills: agent === "codex" }), [agent, caret, text]);
  /** a command the agent runs but the chat cannot finish, while it is what the box holds */
  const terminalOnly = useMemo(() => terminalOnlyCommand(agent, text), [agent, text]);
  const uploading = attachments.some((attachment) => attachment.state === "uploading");
  const agentLabel = agentDisplayLabel(agent);
  // the agent's suggestion stands in the empty box as it does in its own input, until anything is typed
  const offered = connected && answerHint === null && suggestion !== null ? suggestion : null;
  const placeholder = !connected
    ? t("Reconnecting… message held here, never queued")
    : answerHint ?? offered ?? t("Message {agent}…", { agent: agentLabel });

  useEffect(() => {
    let live = true;
    void cachedPaneCommands(paneId, machineId, fetchPaneCommands)
      .then((next) => {
        if (live) setCommands(next);
      })
      .catch(() => {
        if (live) setCommands([]);
      });
    return () => {
      live = false;
    };
  }, [paneId]);

  useEffect(() => {
    const request = ++fileRequest.current;
    if (trigger?.kind !== "file") {
      setFiles([]);
      return;
    }
    const timer = window.setTimeout(() => {
      void fetchPaneFiles(paneId, trigger.query, 20)
        .then((next) => {
          if (request === fileRequest.current) setFiles(next);
        })
        .catch(() => {
          if (request === fileRequest.current) setFiles([]);
        });
    }, 150);
    return () => window.clearTimeout(timer);
  }, [paneId, trigger?.kind, trigger?.query]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [trigger?.kind, trigger?.query]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const attachment of attachmentsRef.current) URL.revokeObjectURL(attachment.previewUrl);
    };
  }, []);

  // The app's faces swap in after the first paint (fonts/fonts.css, font-display: swap) and are
  // not as wide as the fallback they replace. No box changes size for that, so nothing else
  // would measure again: each face's arrival (lib/fontFaces.ts) renders the composer once more, which sizes the message
  // box (below) and fits the model label (fitStatus) with the face that is drawn.
  const facesLoaded = useFacesArrived();

  const sizeTextarea = useCallback(() => {
    const element = textareaRef.current;
    if (!element) return;
    const floor = Math.round(parseFloat(getComputedStyle(element).minHeight)) || 0;
    setMinHeight((current) => current === floor ? current : floor);
    if (manualHeight !== null) {
      element.style.height = `${manualHeight}px`;
      return;
    }
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
    const height = Math.round(element.getBoundingClientRect().height);
    setAutoHeight((current) => current === height ? current : height);
  }, [manualHeight]);

  useLayoutEffect(sizeTextarea, [sizeTextarea, text, placeholder, boxWidth, facesLoaded]);

  // SettingsProvider writes --chat-scale in a passive effect. Measure on the next frame,
  // after that CSS is applied, so a draft rewraps without waiting for another keystroke.
  useEffect(() => {
    const frame = requestAnimationFrame(sizeTextarea);
    return () => cancelAnimationFrame(frame);
  }, [sizeTextarea, settings.chatFontSize, settings.density]);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setBoxWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /**
   * Two things the controls row asks of the layout itself, since what fits depends on the
   * model's name, the mic, the chip and the language, not on a width.
   * - The model label: measured with everything drawn, then drawn as composerModelDraw says
   *   (stepped out whole while Queue shows, the effort word alone without it). Stepping out is
   *   CSS on the mark's attribute, so the label is still read. It runs after every render of the
   *   composer, which is why the context ring's open number is this component's state: opening it
   *   takes room from the label without changing the card's size.
   * - The sentence is never cut. Where it does not fit beside the model it wraps to a line of its
   *   own (CSS); there it is marked, so it takes the whole line and drops the dot that separated
   *   it from the model. The sentence alone wraps: the rest stays one row (.composer-status-meta),
   *   so beside a sentence too the label is measured clipped and steps out, not onto more lines.
   */
  const fitStatus = useCallback((): void => {
    const status = statusRef.current;
    if (!status) return;
    status.removeAttribute("data-model");
    status.removeAttribute("data-hint-alone");
    status.removeAttribute("data-meta-empty");
    const clipped = (selector: string): boolean => {
      const item = status.querySelector<HTMLElement>(selector);
      return item !== null && item.scrollWidth > item.clientWidth;
    };
    const draw = composerModelDraw({
      modelClipped: clipped(".composer-model"),
      effortClipped: clipped(".composer-reasoning"),
    });
    if (draw !== "full") status.setAttribute("data-model", draw);
    const hint = hintRef.current;
    if (!hint) return;
    // with the label stepped out and no ring, the row beside the sentence draws nothing: it gives
    // up its box, or it would keep an empty line over the sentence
    const meta = status.querySelector<HTMLElement>(".composer-status-meta")?.getBoundingClientRect();
    if (!meta || meta.width <= 1) status.setAttribute("data-meta-empty", "");
    const line = hint.getBoundingClientRect();
    const beside = meta !== undefined && meta.width > 1 && meta.bottom > line.top && meta.top < line.top + line.height / 2 && meta.right <= line.left + 1;
    if (!beside) status.setAttribute("data-hint-alone", "");
  }, []);
  useLayoutEffect(fitStatus);

  // the card's own width decides, not the window's: a sidebar or a narrow lane shrinks the card
  // in a wide window. Measured before the first paint, so a phone never draws the words first.
  // A resize fits the row on the next frame: marking it inside the observer's own callback can
  // change the card's height there, which the browser reports as a ResizeObserver loop
  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    let frame = 0;
    setCardWidth(Math.round(surface.getBoundingClientRect().width));
    const observer = new ResizeObserver(() => {
      setCardWidth(Math.round(surface.getBoundingClientRect().width));
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fitStatus);
    });
    observer.observe(surface);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, []);

  useEffect(() => {
    const viewport = window.visualViewport;
    const update = (): void => setHeightLimit(composerHeightLimit());
    viewport?.addEventListener("resize", update);
    window.addEventListener("resize", update);
    return () => {
      viewport?.removeEventListener("resize", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  const maxHeight = Math.max(minHeight, heightLimit);
  /** A grip height within the limits; at or below the automatic floor it is the automatic height again. */
  const gripHeight = (value: number): number | null => value <= minHeight ? null : Math.round(Math.min(maxHeight, value));

  /**
   * Dragging the grip up grows the box; the pointer stays captured, so a finger may leave the grip.
   * The height changes only once the press has moved past the slack, and is saved when it lets go.
   */
  const startResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const element = textareaRef.current;
    if (!element || event.button !== 0) return;
    event.preventDefault();
    const grip = event.currentTarget;
    grip.setPointerCapture(event.pointerId);
    const slack = event.pointerType === "mouse" ? RESIZE_SLACK.mouse : RESIZE_SLACK.touch;
    const startHeight = element.getBoundingClientRect().height;
    const startY = event.clientY;
    let resizing = false;
    let height = manualHeight;
    const move = (next: PointerEvent): void => {
      if (!resizing && Math.abs(next.clientY - startY) < slack) return;
      resizing = true;
      height = gripHeight(startHeight + startY - next.clientY);
      setManualHeight(height);
    };
    const end = (finished: PointerEvent): void => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", end);
      grip.removeEventListener("pointercancel", end);
      if (resizing) {
        lastGripTap.current = 0;
        saveComposerHeight(height);
      } else if (finished.type === "pointerup") {
        // a tap: the second of two quick ones returns the automatic height
        if (finished.timeStamp - lastGripTap.current < DOUBLE_TAP_MS) {
          lastGripTap.current = 0;
          setManualHeight(null);
          saveComposerHeight(null);
        } else {
          lastGripTap.current = finished.timeStamp;
        }
      }
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
  };

  const onResizeKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const current = manualHeight ?? textareaRef.current?.getBoundingClientRect().height ?? minHeight;
    const step = event.shiftKey ? COMPOSER_HEIGHT_STEP * 2 : COMPOSER_HEIGHT_STEP;
    let next: number | null;
    if (event.key === "ArrowUp") next = gripHeight(current + step);
    else if (event.key === "ArrowDown") next = gripHeight(current - step);
    else if (event.key === "Home") next = null;
    else return;
    event.preventDefault();
    setManualHeight(next);
    saveComposerHeight(next);
  };
  const gripValue = Math.round(Math.min(maxHeight, Math.max(minHeight, manualHeight ?? autoHeight)));

  const filteredCommands = useMemo(
    () => (trigger?.kind === "slash"
      ? rankSlashCommands(commands.filter((command) => (command.trigger ?? "/") === (trigger.prefix ?? "/")), trigger.query, slashUsage)
      : []),
    [commands, slashUsage, trigger],
  );
  // a typed query lists the matches in rank order, whatever their source (a plugin command whose
  // word starts with it must not sit under a built-in that only has its letters scattered);
  // the source then rides on each row. Only the bare `/` lists by group.
  const groupedBySource = trigger?.kind === "slash" && trigger.query === "";
  const orderedCommands = useMemo(
    () => groupedBySource ? COMMAND_SOURCES.flatMap((source) => filteredCommands.filter((command) => command.source === source)) : filteredCommands,
    [filteredCommands, groupedBySource],
  );
  const choices: readonly (SlashCommand | string)[] = trigger?.kind === "slash" ? orderedCommands : files;
  const menuOpen = !menuDismissed && trigger !== null && choices.length > 0;
  // clamped as the list is drawn, not by an effect after it: a Tab or Enter typed before that
  // effect's render found no row at the old index and did nothing
  const selectedIndex = Math.min(storedIndex, Math.max(0, choices.length - 1));

  // dictation lands at the caret without taking focus (a phone's keyboard stays as it was)
  const dictation = useDictation({
    mode: "chat",
    connected,
    phone: mobile,
    polish: settings.voicePolishChat,
    keywords: () => [...(agent ? [agentLabel] : []), ...commands.map((command) => command.name)],
    box: textareaRef,
    read: () => textRef.current,
    // a dictation that does not fit is refused whole: cutting would drop the draft after the caret
    maxLength: MAX_COMPOSER_CHARS,
    write: (value, at) => {
      textRef.current = value;
      caretRef.current = at;
      setText(value);
      setCaret(at);
      requestAnimationFrame(() => {
        const element = textareaRef.current;
        if (element) element.selectionStart = element.selectionEnd = at;
      });
    },
    onNote: setNote,
  });

  const setTextAndCaret = useCallback((nextText: string, nextCaret: number) => {
    const limitedText = nextText.slice(0, MAX_COMPOSER_CHARS);
    const clampedCaret = Math.min(nextCaret, MAX_COMPOSER_CHARS);
    textRef.current = limitedText;
    caretRef.current = clampedCaret;
    // committed now and the caret placed in the same task: a placement deferred to the next frame
    // would land on whatever was typed or selected meanwhile, behind a key typed right after a completion
    flushSync(() => {
      setText(limitedText);
      setCaret(clampedCaret);
      setMenuDismissed(false);
    });
    const element = textareaRef.current;
    if (!element) return;
    element.selectionStart = element.selectionEnd = clampedCaret;
    element.focus();
  }, []);

  const insertMentionAtCursor = useCallback(
    (mention: string) => {
      const element = textareaRef.current;
      const currentText = textRef.current;
      const selectionIsCurrent = element?.value === currentText;
      const start = selectionIsCurrent ? (element.selectionStart ?? caretRef.current) : caretRef.current;
      const end = selectionIsCurrent ? (element.selectionEnd ?? start) : start;
      const next = insertMention(currentText, start, end, mention);
      setTextAndCaret(next.text, next.caret);
    },
    [setTextAndCaret],
  );

  const selectCompletion = useCallback(
    (choice: SlashCommand | string, currentTrigger: ActiveTrigger) => {
      const replacement = currentTrigger.kind === "slash" ? `${currentTrigger.prefix ?? "/"}${(choice as SlashCommand).name} ` : `@${choice as string} `;
      const completed = applyCompletion(text, currentTrigger, replacement);
      setTextAndCaret(completed.text, completed.caret);
      setMenuDismissed(true);
      if (currentTrigger.kind === "slash") {
        const name = (choice as SlashCommand).name;
        setSlashUsage((current) => {
          const next = { ...current, [name]: (current[name] ?? 0) + 1 };
          try {
            window.localStorage.setItem(SLASH_USAGE_KEY, JSON.stringify(next));
          } catch {
            // Completion still works when storage is unavailable.
          }
          return next;
        });
      }
    },
    [setTextAndCaret, text],
  );

  const uploadImages = useCallback(
    async (incoming: readonly File[]) => {
      const images = incoming.slice(0, MAX_IMAGES_PER_ACTION);
      if (images.length === 0) return;

      const added = images.map<Attachment>((file) => ({
        id: ++attachmentSequence,
        file,
        previewUrl: (PREVIEW_TYPES as readonly string[]).includes(file.type) ? URL.createObjectURL(file) : "",
        path: null,
        state: "uploading",
      }));
      setAttachments((current) => [...current, ...added]);
      setNote(null);

      for (const attachment of added) {
        if (!mounted.current) break;
        try {
          const path = await onUploadImage(attachment.file);
          if (!mounted.current) break;
          if (removedAttachments.current.has(attachment.id)) continue;
          setAttachments((current) =>
            current.map((item) => (item.id === attachment.id ? { ...item, path, state: "ready" } : item)),
          );
          insertMentionAtCursor(imageMention(path));
        } catch (error) {
          if (!mounted.current) break;
          if (removedAttachments.current.has(attachment.id)) continue;
          setAttachments((current) =>
            current.map((item) => (item.id === attachment.id ? { ...item, state: "error" } : item)),
          );
          setNote(error instanceof Error ? error.message : String(error));
        }
      }
    },
    [insertMentionAtCursor, onUploadImage],
  );

  const removeAttachment = useCallback((attachment: Attachment) => {
    removedAttachments.current.add(attachment.id);
    URL.revokeObjectURL(attachment.previewUrl);
    setAttachments((current) => current.filter((item) => item.id !== attachment.id));
    if (attachment.path) {
      const mention = imageMention(attachment.path);
      setText((current) => {
        const next = current.replace(mention, "");
        textRef.current = next;
        caretRef.current = Math.min(caretRef.current, next.length);
        return next;
      });
    }
  }, []);

  const send = useCallback(() => {
    if (composingRef.current) return;
    if (!connected || uploading || sending || text.trim().length === 0) return;
    const sent = text;
    const sentAttachments = attachments;
    const settle = (result: boolean | string): void => {
      const acknowledged = result === true ? composerDrafts.settle(draftKey, sent) : null;
      if (!mounted.current) return;
      if (typeof result === "string") setNote(result);
      if (acknowledged === null) return;
      // only what was sent leaves the box: text added after it stays exactly as typed. Changed
      // inside while on its way, the whole edit stays, and the note says it was not sent
      const { text: rest, edited } = acknowledged;
      setCaret(rest.length);
      textRef.current = rest;
      caretRef.current = rest.length;
      setNote(edited ? t("Sent as it was. Your changes made while it was sending stayed here and were not sent.") : null);
      for (const attachment of sentAttachments) URL.revokeObjectURL(attachment.previewUrl);
      setAttachments((current) => current.filter((attachment) => !sentAttachments.includes(attachment)));
    };
    if (!composerDrafts.begin(draftKey, sent)) return;
    // a polish landing before the acknowledgement would count as an edit and keep the sent message here
    dictation.forget();
    try {
      const result = onSend(text);
      if (!(result instanceof Promise)) { settle(result); composerDrafts.end(draftKey); return; }
      void result.then(settle).catch(() => { if (mounted.current) setNote(t("Not confirmed. Check the terminal before sending again.")); }).finally(() => composerDrafts.end(draftKey));
    } catch {
      composerDrafts.end(draftKey);
      if (mounted.current) setNote(t("Not confirmed. Check the terminal before sending again."));
    }
  }, [attachments, connected, dictation.forget, draftKey, onSend, sending, text, uploading]);

  /** A quick reply follows the same delivery policy as Send, and leaves the box alone. */
  const sendQuick = useCallback((reply: string) => {
    if (!connected || sending) return;
    setNote(null);
    const settle = (result: boolean | string): void => {
      if (mounted.current && typeof result === "string") setNote(result);
    };
    if (!composerDrafts.begin(draftKey)) return;
    try {
      const result = onSend(reply);
      if (!(result instanceof Promise)) { settle(result); composerDrafts.end(draftKey); return; }
      void result.then(settle).catch(() => { if (mounted.current) setNote(t("Not confirmed. Check the terminal before sending again.")); }).finally(() => composerDrafts.end(draftKey));
    } catch {
      composerDrafts.end(draftKey);
      if (mounted.current) setNote(t("Not confirmed. Check the terminal before sending again."));
    }
  }, [connected, draftKey, onSend, sending]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      // an IME keeps its keys; WebKit can send the committing Enter after compositionend, as key code 229
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      if (menuOpen && trigger) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const direction = event.key === "ArrowDown" ? 1 : -1;
          setSelectedIndex((current) => (Math.min(current, choices.length - 1) + direction + choices.length) % choices.length);
          return;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          event.preventDefault();
          const choice = choices[selectedIndex];
          if (choice !== undefined) selectCompletion(choice, trigger);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setMenuDismissed(true);
          return;
        }
      }
      if (event.key === "Escape" && trigger && !menuDismissed) {
        setMenuDismissed(true);
        return;
      }
      // a draft puts Send where Stop was: Escape is then the Stop the agent's own input has
      if (event.key === "Escape" && connected && agentStatus === "working" && textRef.current.trim().length > 0) {
        event.preventDefault();
        onAbort();
        return;
      }
      // Tab takes the suggestion into the empty box, as in Claude's own input
      if (event.key === "Tab" && !event.shiftKey && offered !== null && textRef.current === "") {
        event.preventDefault();
        setTextAndCaret(offered, offered.length);
        return;
      }
      if (event.key !== "Enter") return;
      const shouldSend = settings.enterSends
        ? !event.shiftKey && !event.metaKey && !event.ctrlKey
        : (event.metaKey || event.ctrlKey) && !event.shiftKey;
      if (!shouldSend) return;
      event.preventDefault();
      send();
    },
    [agentStatus, choices, connected, menuDismissed, menuOpen, offered, onAbort, selectCompletion, selectedIndex, send, setTextAndCaret, settings.enterSends, trigger],
  );

  const onPaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const images = Array.from(event.clipboardData.items)
        .filter((item) => item.kind === "file")
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null);
      if (images.length === 0) return;
      event.preventDefault();
      void uploadImages(images);
    },
    [uploadImages],
  );

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setDragging(false);
      void uploadImages(Array.from(event.dataTransfer.files));
    },
    [uploadImages],
  );

  const isWorking = agentStatus === "working";
  // what the status line says; what may be sent, queued or stopped goes by the agent's own status
  const shownStatus = paneStatus({ agent_status: agentStatus, ...(backgroundWait ? { background_wait: true as const } : {}) });
  const statusCompact = composerStatusCompact(cardWidth);
  const sendShown = composerSendShown({ working: isWorking, text });
  const hint = composerStatusHint({ uploading, connected, text });
  const model = metadata?.model ? modelLabel(metadata.model) : null;
  const modelShown = Boolean(metadata?.model || metadata?.reasoning_effort);
  const usageDetail = usageWindows.map((window) => {
    const reset = formatResetIn(window.resets_at, Date.now());
    return `${windowLabel(window)} ${meterText(window, settings.usageCount)}${reset ? ` · ${t("Resets in {time}", { time: reset })}` : ""}`;
  }).join("\n");
  const usageCaption = usageLimit === undefined ? "" : `${usageLimit.kind === "session" ? "5h" : windowLabel(usageLimit)} ${formatPercent(meterPercent(usageLimit, settings.usageCount))}`;
  const usageAccessible = usage === undefined ? "" : `${t("Subscription usage")}: ${usageName(usage)}, ${usageDetail.replaceAll("\n", ", ")}`;
  const hintText = hint === null ? null : t(hint === "uploading" ? "Uploading file…" : "Reconnecting… message held here, never queued");
  const menuId = `composer-menu-${paneId}`;
  // the arrow keys move the selection, not the focus (it stays in the box), so the browser does not scroll to it
  useEffect(() => {
    if (menuOpen) document.getElementById(`${menuId}-${selectedIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [menuOpen, menuId, selectedIndex, choices]);

  return (
    <div className="composer" role="group" aria-label={t("Message composer")} data-dictating={dictation.voice.state !== "idle" ? "" : undefined}>
      {greeting}
      {/* no Tab key on a phone: the suggestion is a chip there that fills the box, unless Settings turns it off */}
      {settings.showSuggestionChip && offered !== null && text === "" && (
        <div className="composer-quick composer-suggestion-row">
          <button type="button" className="composer-quick-reply composer-suggestion" title={t("Use the suggestion")} onClick={() => setTextAndCaret(offered, offered.length)}>
            <span aria-hidden="true">↹ </span>{offered}
          </button>
        </div>
      )}

      {quickOpen && quickReplies.length > 0 && (
        <div className="composer-quick" role="group" aria-label={t("Quick replies")}>
          {quickReplies.map((reply, index) => (
            <button
              key={`${index}:${reply}`}
              type="button"
              className="composer-quick-reply"
              title={t("Send “{reply}”", { reply })}
              disabled={!connected || sending}
              onClick={() => sendQuick(reply)}
            >
              {reply}
            </button>
          ))}
        </div>
      )}

      <div
        ref={surfaceRef}
        className={`composer-surface${dragging ? " is-dragging" : ""}`}
        data-compact={statusCompact ? "" : undefined}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={onDrop}
      >
        <div
          className={`composer-resize${manualHeight !== null ? " is-sized" : ""}`}
          role="separator"
          aria-orientation="horizontal"
          aria-label={t("Resize message box")}
          aria-valuemin={minHeight}
          aria-valuemax={maxHeight}
          aria-valuenow={gripValue}
          aria-valuetext={manualHeight === null ? "automatic height" : `${gripValue} pixels`}
          tabIndex={0}
          title={t("Drag to resize · double-click to reset")}
          onPointerDown={startResize}
          onKeyDown={onResizeKey}
        />
        {menuOpen && trigger && (
          <div id={menuId} className="menu composer-menu" role="listbox" aria-label={t(trigger.kind === "slash" ? "Slash commands" : "Files")}>
            {trigger.kind === "slash" ? (
              (() => {
                const row = (command: SlashCommand, withSource: boolean) => {
                  const index = orderedCommands.indexOf(command);
                  return (
                    <button
                      id={`${menuId}-${index}`}
                      key={`${command.source}:${command.name}`}
                      type="button"
                      className="menu-item"
                      role="option"
                      aria-selected={index === selectedIndex}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => selectCompletion(command, trigger)}
                    >
                      <span className="menu-item-main">{command.trigger ?? "/"}{command.name}</span>
                      <span className="menu-item-hint">{withSource ? `${t(SOURCE_LABEL[command.source])}${command.description ? " · " : ""}` : ""}{command.description}</span>
                    </button>
                  );
                };
                if (!groupedBySource) return <div className="composer-menu-group">{orderedCommands.map((command) => row(command, true))}</div>;
                return COMMAND_SOURCES.map((source) => {
                  const group = filteredCommands.filter((command) => command.source === source);
                  if (group.length === 0) return null;
                  return (
                    <div className="composer-menu-group" key={source}>
                      <div className="menu-heading">{t(SOURCE_LABEL[source])}</div>
                      {group.map((command) => row(command, false))}
                    </div>
                  );
                });
              })()
            ) : (
              <div className="composer-menu-group">
                <div className="menu-heading">{t("Files")}</div>
                {files.map((file, index) => (
                  <button
                    id={`${menuId}-${index}`}
                    key={file}
                    type="button"
                    className="menu-item"
                    role="option"
                    aria-selected={index === selectedIndex}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => selectCompletion(file, trigger)}
                  >
                    <span className="menu-item-main">{file}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {attachments.length > 0 && (
          <div className="composer-attachments" aria-label={t("Attached files")}>
            {attachments.map((attachment) => (
              <div className={`composer-attachment is-${attachment.state}`} key={attachment.id}>
                {attachment.previewUrl ? <img src={attachment.previewUrl} alt={attachment.file.name} />
                  : <span className="composer-attachment-file" title={attachment.file.name}><FileText aria-hidden="true" /><span>{attachment.file.name}</span></span>}
                <span className="composer-attachment-state">
                  {t(attachment.state === "uploading" ? "Uploading" : attachment.state === "error" ? "Failed" : "Attached")}
                </span>
                <button type="button" aria-label={t("Remove {file}", { file: attachment.file.name })} onClick={() => removeAttachment(attachment)}>
                  <X aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        )}

        <textarea
          ref={textareaRef}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={() => { composingRef.current = false; }}
          className={`composer-text${manualHeight !== null ? " is-sized" : ""}`}
          rows={1}
          maxLength={MAX_COMPOSER_CHARS}
          value={text}
          placeholder={placeholder}
          aria-label={t("Message")}
          aria-controls={menuOpen ? menuId : undefined}
          aria-expanded={menuOpen}
          aria-activedescendant={menuOpen ? `${menuId}-${selectedIndex}` : undefined}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          // stays editable while the socket reconnects (sending waits for it): a phone's
          // dictation keyboard opens its own app and comes back, the socket may drop meanwhile,
          // and a disabled box would lose its focus and the dictated text with it
          onPaste={onPaste}
          onKeyDown={onKeyDown}
          onClick={(event) => {
            setCaret(event.currentTarget.selectionStart);
            setMenuDismissed(false);
          }}
          onKeyUp={(event) => setCaret(event.currentTarget.selectionStart)}
          onChange={(event) => {
            setText(event.target.value);
            setCaret(event.target.selectionStart);
            setMenuDismissed(false);
            setNote(null);
          }}
        />

        <div className="composer-controls composer-controls-left">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              const picked = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = "";
              void uploadImages(picked);
            }}
          />
          <button
            type="button"
            className="icon-button composer-attach"
            aria-label={t("Attach files")}
            title={t("Attach files")}
            disabled={!connected || uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            <Plus aria-hidden="true" />
          </button>
          {dictation.shown && <MicButton dictation={dictation} />}
          <BackgroundTasks paneId={paneId} count={backgroundTasks} omo={agent === "omo"} claude={agent === "claude"} />
        </div>
        {/* between the two control groups of the card's last row. The agent's name, its separator and the
            state word are read, not drawn: the mark and the header name the agent, and Stop, the live row and
            the prompt card say the state. All state words stay available to assistive tech only.
            Where the model label does not fit, it steps out and is still read (fitStatus marks data-model) */}
        <div ref={statusRef} className="composer-status" role="status" data-status={shownStatus}
          data-offline={connected ? undefined : ""} data-hint={hint ?? undefined}>
          {/* everything but the sentence: one row that never wraps, also where the sentence takes a line of its own */}
          <span className="composer-status-meta">
            <span className="composer-agent-label visually-hidden">{agentLabel}</span>
            <span className="composer-status-separator visually-hidden" aria-hidden="true">·</span>
            <strong className="visually-hidden">{t(composerStatusWord(shownStatus))}</strong>
            {/* the mark, the model, the level and the context ring as one quiet pill. It only shows: no role,
                no focus, nothing to press but the ring inside it. A pane that names no model draws no pill
                (.is-bare): the mark, a level if it has one, and the ring stand in the row as they are */}
            <span className={`composer-pill${metadata?.model ? "" : " is-bare"}`}>
              {agent && <AgentMark agent={agent} size={14} />}
              {modelShown && <span className="composer-model-info" aria-label={t("Model and reasoning")}>
                {/* a name only for an id modelLabel can name for certain; any other id is drawn as received, in the identifier face */}
                <span className={`composer-model${model ? model.named ? "" : " is-id" : " is-none"}`} title={metadata?.model ?? t("Model not available")}>{model?.text ?? t("Model —")}</span>
                {/* behind a name the id as received is still read; a touch cannot reach the title */}
                {model?.named && <span className="composer-model-id visually-hidden">{metadata?.model}</span>}
                {/* no level recorded: nothing is drawn for it, no dot and no dash; the sentence is still read */}
                <span className={`composer-reasoning${metadata?.reasoning_effort ? "" : " visually-hidden"}`} title={metadata?.reasoning_effort ? t("Reasoning effort: {effort}", { effort: metadata.reasoning_effort }) : t("Reasoning effort not available")}>
                  <span className="composer-reasoning-full visually-hidden">{t("Reasoning {effort}", { effort: metadata?.reasoning_effort ?? "—" })}</span>
                  {metadata?.reasoning_effort && <>
                    <span className="composer-reasoning-dot" aria-hidden="true">·</span>
                    <span className="composer-reasoning-short" aria-hidden="true">{metadata.reasoning_effort}</span>
                  </>}
                </span>
              </span>}
              {metadata?.context && <ContextRing context={metadata.context} shown={contextShown} readOnly={mobile} onToggle={() => setContextShown((open) => !open)} />}
              {usage !== undefined && usage.problem === null && usageLimit !== undefined && <span
                className={`composer-usage${usageLimit.used_percent >= HIGH_PERCENT ? " is-high" : ""}${usage.problem ? " has-problem" : ""}`}
                title={`${usageName(usage)}\n${usageDetail}`}
              >
                <span aria-hidden="true">{usageCaption}</span>
                <span className="visually-hidden">{usageAccessible}</span>
              </span>}
            </span>
            {/* the chip is a button in the left controls; its count is still said here, where a change is announced */}
            {backgroundTasks > 0 && <span className="composer-task-count visually-hidden">{t(backgroundTasks === 1 ? "{n} background task" : "{n} background tasks", { n: backgroundTasks })}</span>}
          </span>
          {hintText !== null && (
            <span ref={hintRef} className="composer-status-hint" title={hintText}>
              <span className="composer-status-hint-dot" aria-hidden="true">· </span>{hintText}
            </span>
          )}
        </div>
        <div className="composer-controls composer-controls-right">
          {!sendShown ? (
            <button
              type="button"
              className="composer-action composer-stop"
              aria-label={t("Stop agent")}
              title={t("Stop agent")}
              disabled={!connected}
              onClick={onAbort}
            >
              <Square aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              className="composer-action composer-send"
              aria-label={t("Send message")}
              title={t("Send message")}
              disabled={!connected || uploading || sending || text.trim().length === 0}
              onClick={() => send()}
            >
              <ArrowUp aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
      {note && <div className="composer-note" role="alert">{note}</div>}
      {/* said while typing, before the send: after it the browser is already open and the reader is
          already in the state the words describe. Not a block — the text still goes, and pi runs the
          command in the terminal the way its own palette would */}
      {!note && terminalOnly !== null && (
        <div className="composer-hint" role="status">{t("{command} opens a tree the chat cannot show. It runs in the terminal — tap the terminal button at the top of the screen to choose a branch.", { command: `/${terminalOnly}` })}</div>
      )}
      {/* above the whole composer: inside the surface it would cover the text being dictated */}
      {dictation.shown && <VoiceRecordingPill dictation={dictation} align="start" />}
    </div>
  );
}
