/**
 * The terminal peek (DESIGN.md, the terminal-command handoff): a command that runs in the terminal,
 * sent from Chat, shows the pane's own terminal over the chat's transcript. The chat stays mounted
 * under it, so its place and its reads go on; the composer stays too, inert. It is this browser's
 * state only: the pane's saved lens and the address keep saying Chat, nothing is attached anew (the
 * grid under the chat is the attached one), and herdr's focus never moves.
 *
 * The chat comes back by hand (Back to Chat, the header's Chat, Mod+Shift+J, a phone's Back), and
 * on its own after a command its agent is known to close in a way the chat can see:
 * - Claude Code records a `local_command` answer when one of its panels closes ("Settings dialog
 *   dismissed"), and the chat reads it as a local-command notice. Only a notice written after the
 *   send's own outcome was created counts; both times are the PC's clock, never this browser's.
 * - The other agents with a recorded input row (lib/inputRow.ts) draw that row again, empty, when
 *   the screen closes: the peek watches the grid's frames, arms once the row has gone (or been
 *   covered) after the send, and ends on the first frame that shows it back.
 *
 * A peek ended by hand while the command's screen is still open leaves a guard on the composer
 * (PaneTerminal's still-open notice): the next message would be typed into that screen.
 */

import type { CommandOutcome, ConversationTurn } from "../../shared/protocol.ts";
import type { PaneView } from "./actions.ts";
import type { InputRowState } from "./inputRow.ts";
import type { SplitSlot } from "./split.ts";

/** What PaneTerminal asks App to show; App adds where (its slot, the PC and the pane). */
export interface PeekRequest {
  /** the command as the head names it, its trigger included (`/usage`) */
  command: string;
  /** the text that was sent, which finds the send's own outcome; null: opened by hand */
  text: string | null;
  /** the outcome ids the chat had read when the text left; null: none read yet, or opened by hand */
  knownOutcomeIds: readonly string[] | null;
  /** the chat comes back by itself once the agent records, or its screen shows, that the command's screen closed */
  auto: boolean;
  /** the agent whose input row brings the chat back (SCREEN_AUTO_RETURN); null: Claude's record, or by hand */
  watch: string | null;
  /**
   * the agent's empty input row was on screen as the text left, or as the peek opened by hand: its
   * recognizer (lib/inputRow.ts) reads this screen, so the screen's return can be watched, and a
   * screen still open when the peek ends by hand can be told
   */
  inputRowSeen: boolean;
}

export interface TerminalPeek extends PeekRequest {
  /** the split half it opened in: the other half never shows it */
  slot: SplitSlot;
  machineId: string;
  paneId: string;
}

/**
 * The Claude Code commands whose screen, closed and only then, makes Claude record a
 * `local_command` answer the chat reads as a local-command notice (recorded with Claude Code
 * 2.1.306, each sent bare): "Settings dialog dismissed" for /usage, /cost and /status, "<X> dialog
 * dismissed" for /stats, /help, /config, /permissions, /hooks, /skills, /workflows and /passes,
 * "Theme picker dismissed", "Resume cancelled", "Power-ups closed" and "Fast mode ON/OFF".
 *
 * An allow list, so every other command (a custom or unknown one included) comes back by hand:
 * /diff records when its panel opens, which would end the peek at once; /export, /plugin, /mobile,
 * /autocompact, /add-dir, /mcp and /scroll-speed record entries the chat does not show; /sandbox
 * and /tasks record nothing; /memory hands a picked file to the editor. Claude's fullscreen renderer
 * records nothing for most of these, and a session records nothing before its first message: the
 * peek never waits on the record, it only comes back sooner when there is one.
 */
export const CLAUDE_AUTO_RETURN: ReadonlySet<string> = new Set([
  "usage", "cost", "status", "stats", "help", "config", "theme", "permissions", "hooks", "skills", "workflows", "passes",
  "resume", "powerup", "fast",
]);

/** The peek a pane shows: App's one peek, when it is this half's, this PC's and this pane's. */
export function peekFor(peek: TerminalPeek | null, slot: SplitSlot, machineId: string, paneId: string | null): TerminalPeek | null {
  return peek !== null && peek.slot === slot && peek.machineId === machineId && peek.paneId === paneId ? peek : null;
}

/**
 * What the lens and the peek leave mounted and covered: the chat (its transcript, composer, queue
 * and prompt dock) is mounted whenever the lens is Chat, and covers the grid only while no peek
 * shows it. Everything that sizes, focuses or types into the grid follows `gridCovered`.
 */
export function paneLensFlags(view: PaneView, peek: TerminalPeek | null): { chatMounted: boolean; gridCovered: boolean } {
  const chatMounted = view === "chat";
  return { chatMounted, gridCovered: chatMounted && peek === null };
}

/**
 * Whether the chat comes back by itself after `text`, which invokes `command` (its name, no
 * trigger), is sent to `agent`: Claude Code's record, and only a bare command the recording covers
 * (`/fast on` sets the mode with no screen to close, and no other form was recorded).
 */
export function autoReturnArmed(agent: string | null, text: string, command: string): boolean {
  return agent === "claude" && /^\S+$/u.test(text.trim()) && CLAUDE_AUTO_RETURN.has(command.toLocaleLowerCase());
}

/** How an agent's screen says one of its commands' screens has closed (lib/inputRow.ts). */
export interface ScreenReturn {
  /** the commands, sent bare, whose screen hides the input row and draws it back empty at its close */
  bare: ReadonlySet<string>;
  /** the commands whose recording covered a form with arguments too */
  withArguments: ReadonlySet<string>;
  /** what an open screen does to the row: the frame that shows it arms the return */
  arm: ReadonlySet<InputRowState>;
}

const GONE: ReadonlySet<InputRowState> = new Set(["gone"]);
const GONE_OR_COVERED: ReadonlySet<InputRowState> = new Set(["gone", "covered"]);
const NONE: ReadonlySet<string> = new Set();

/**
 * The agents whose chat comes back by itself, from their screens, and after which commands: those
 * whose recording (2026-10-22, each at 119 or 120 and at 40 columns, opened, then closed with Escape
 * or `q`) hid the input row while open and drew it back empty when closed. An allow list, so a
 * command that prints and keeps the row (Codex /status, omp /plan, pi /hotkeys, gjc /hotkeys, Devin
 * /mcp…), one that hands off to $EDITOR (Hermes /prompt, agy /open), one whose close leaves text in
 * the row (Hermes /palette, Grok /model, Codex /mention), Codex's /side and /btw (their side thread
 * draws a composer of its own) and every unrecorded command come back by hand.
 * - Codex 0.163.0: `/cd` with a folder it does not trust shows the trust screen; a trusted one only
 *   prints, keeps the row and never arms. /diff is a pager that `q` closes.
 * - Hermes' classic CLI draws its row again, empty, for a moment after every slash command, before the
 *   screen opens: only a covered row (a picker over it, a confirmation in its place) arms it.
 * - agy's and Grok's panels and omp's /context at 119 columns leave the row drawn under the screen:
 *   a covered row arms these too.
 * - omp's bare /switch and gjc's bare /model were recorded too, but Chat answers them with its own
 *   model card (server/skills): they never reach the terminal, so they are not listed.
 * OpenCode is not here: only its home screen was recorded, not the in-session layout its screens
 * open over.
 */
export const SCREEN_AUTO_RETURN: Readonly<Record<string, ScreenReturn>> = {
  codex: {
    bare: new Set(["permissions", "theme", "statusline", "resume", "review", "rename", "new", "fork", "usage", "diff"]),
    withArguments: new Set(["cd"]),
    arm: GONE,
  },
  omp: {
    bare: new Set(["settings", "hotkeys", "tree", "resume", "extensions", "agents", "usage", "context", "btw"]),
    withArguments: NONE,
    arm: GONE_OR_COVERED,
  },
  pi: { bare: new Set(["settings", "tree", "resume", "scoped-models"]), withArguments: NONE, arm: GONE },
  gjc: {
    bare: new Set(["settings", "theme", "tree", "resume", "sessions", "transcript", "routing"]),
    withArguments: NONE,
    arm: GONE,
  },
  omo: {
    bare: new Set(["settings", "tree", "thinking", "scoped-models", "favorite-models", "sessions", "resume", "rename", "share", "trust"]),
    withArguments: NONE,
    arm: GONE,
  },
  hermes: { bare: new Set(["model", "reload-mcp", "new", "reset", "clear"]), withArguments: NONE, arm: new Set(["covered"]) },
  devin: {
    bare: new Set(["model", "models", "config", "resume", "theme", "shortcuts", "mode", "btw"]),
    withArguments: NONE,
    arm: GONE,
  },
  agy: {
    bare: new Set(["model", "resume", "config", "permissions", "mcp", "skills", "usage", "context", "help", "tasks", "rewind", "artifact",
      "codesearch", "diff", "changelog"]),
    withArguments: NONE,
    arm: GONE_OR_COVERED,
  },
  grok: {
    bare: new Set(["settings", "sessions", "resume", "plugins", "skills", "hooks", "help", "usage", "context", "history"]),
    withArguments: NONE,
    arm: GONE_OR_COVERED,
  },
};

/** Whether `agent`'s screen brings the chat back after `text`, which invokes `command` (its name, no trigger). */
export function screenReturnArmed(agent: string | null, text: string, command: string): boolean {
  const known = agent === null ? undefined : SCREEN_AUTO_RETURN[agent];
  if (known === undefined || !Object.hasOwn(SCREEN_AUTO_RETURN, agent!)) return false;
  const name = command.toLocaleLowerCase();
  return /^\S+$/u.test(text.trim()) ? known.bare.has(name) : known.withArguments.has(name);
}

/** Where a watched peek stands after a frame: still waiting (armed or not), back, or left to the reader. */
export type WatchStep = { step: "wait"; armed: boolean } | { step: "return" } | { step: "manual" };

/**
 * One frame of a watched peek (no timer, no key): the first frame whose row is in the agent's arm
 * set arms it, and the first ready frame after that brings the chat back. A ready frame before it
 * (the row still drawn as the command leaves, Hermes' moment before its screen) and a draft (the
 * command echoed in the row) never arm; a draft after it (a screen that closed onto text) leaves
 * the return to the reader. A blank frame says nothing.
 */
export function watchReturn(agent: string, armed: boolean, state: InputRowState): WatchStep {
  const known = Object.hasOwn(SCREEN_AUTO_RETURN, agent) ? SCREEN_AUTO_RETURN[agent] : undefined;
  if (known === undefined) return { step: "manual" };
  if (state === "unknown") return { step: "wait", armed };
  if (!armed) return { step: "wait", armed: known.arm.has(state) };
  if (state === "ready") return { step: "return" };
  if (state === "draft") return { step: "manual" };
  return { step: "wait", armed: true };
}

/**
 * The send's own outcome: the newest one with the sent text that the chat had not read when the
 * text left (the bridge lists them oldest first). An older identical send was read already and is
 * passed over; so is one sent just before that no read had listed yet, whose earlier close notice
 * would otherwise end this peek at once. A later identical send (another device's) is taken
 * instead, which only leaves the return to the reader. None listed yet is null.
 */
export function sentOutcome(peek: PeekRequest, outcomes: readonly CommandOutcome[]): CommandOutcome | null {
  if (peek.text === null || peek.knownOutcomeIds === null) return null;
  const known = new Set(peek.knownOutcomeIds);
  const text = peek.text.trim();
  for (let index = outcomes.length - 1; index >= 0; index -= 1) {
    const outcome = outcomes[index]!;
    if (!known.has(outcome.id) && outcome.text.trim() === text) return outcome;
  }
  return null;
}

/**
 * Whether the command's screen has closed: Claude Code wrote a local-command notice after the
 * send's outcome was created (`sentAt`, that outcome's `created_at`). No other agent says so in
 * its transcript; their peek stays until the reader leaves it.
 */
export function commandScreenClosed(peek: PeekRequest, agent: string | null, sentAt: string | null, turns: readonly ConversationTurn[]): boolean {
  if (!peek.auto || agent !== "claude" || sentAt === null) return false;
  const sent = Date.parse(sentAt);
  if (!Number.isFinite(sent)) return false;
  return turns.some((turn) => turn.role === "user" && turn.ts !== null && Date.parse(turn.ts) > sent
    && turn.parts.some((part) => part.kind === "notice" && part.source === "local-command"));
}

/** What keeps the chat from coming back by itself: the return is then left to the reader. */
export interface ReturnBlockers {
  /** terminal input held for review (typed while the pane could not take it) */
  heldDraft: boolean;
  /** the terminal's find bar is open */
  findOpen: boolean;
  /** an IME composition is under way in the grid or in its input line (the return would unmount the line) */
  composing: boolean;
}

export function returnBlocked(blockers: ReturnBlockers): boolean {
  return blockers.heldDraft || blockers.findOpen || blockers.composing;
}
