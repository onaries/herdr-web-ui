/**
 * Composer -> pty byte shaping. The composer sends "one message", but the pane's
 * program defines what a safe submission is, so the payload follows the pane's own
 * bracketed-paste mode (term.modes.bracketedPasteMode):
 * - mode on (agent TUIs): the text goes out as ONE bracketed paste - newlines stay
 *   literal inside the message - and a bare CR submits it, exactly like paste+Enter.
 * - mode off (plain shell): classic paste semantics - every newline submits its own
 *   line, and the trailing CR runs the last one.
 * Pure logic, DOM-free, so the policy is unit-testable (see compose.test.ts).
 */

import type { AgentStatus, SlashCommand } from "../../shared/protocol.ts";
import { skillSyntax } from "../../shared/skill-syntax.ts";
import { knownStatus, STATUS_WORD } from "./status.ts";
import { t } from "./i18n.ts";
import type { ActiveTrigger } from "./mentions.ts";

/** This cap keeps one composer message inside a single WS frame. */
export const MAX_COMPOSER_CHARS = 20_000;

const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

/** A composer message as written: trailing newlines are the composer's, not the text's; CRLF reads as one newline. */
export function composerMessage(text: string): string {
  return text.replace(/[\r\n]+$/, "").replace(/\r\n?/g, "\n");
}

/** The text a composer message types, without its submit (HerdrSocket.submit adds the Enter). */
export function composerPayload(text: string, bracketedPaste: boolean): string {
  const body = composerMessage(text).replace(/\n/g, "\r");
  return bracketedPaste ? PASTE_START + body + PASTE_END : body;
}

/** Why a composer message did not go (SubmitResult's code): the composer keeps the text and says this. */
/** The server refused the message before any of it reached the pane: nothing was typed. */
export function submitNotTyped(code: string): boolean {
  return ["agent_blocked", "read_only", "submit_timeout", "agent_not_ready", "pending_input_unsupported", "agent_queue_unsupported", "invalid_delivery", "invalid_submit_text",
    "invalid_submit_id", "pending_limit", "pending_not_found", "pending_busy", "invalid_pending_action", "pending_target_changed", "pending_lease_lost", "not_attached", "input_not_ready", "attach_held", "pane_not_found", "retired_submit_id", "input_draft",
    // refused by this view while the terminal holds input (PaneTerminal), before anything was sent
    "held_input",
    // the connection dropped before the request's frame left the browser (HerdrSocket)
    "not_transmitted"].includes(code);
}

/**
 * Whether a failed Send now or Discard of a bridge-owned row leaves it not confirmed. An action whose
 * frame never left (`not_transmitted`) proves only that a held row was not sent: a queued row may still
 * be typed by its turn's end, since the bridge keeps its lease until it notices the connection is gone.
 */
export function pendingActionUncertain(code: string, state: string): boolean {
  if (code === "not_transmitted") return state !== "held";
  return code === "pending_not_found" || !submitNotTyped(code);
}

/**
 * A send refused over Claude's terminal input box: the note, and either the one-row draft a send may
 * clear first (`draft`), or, where the server named none but showed the box, a send anyway (`anyway`).
 */
export type DraftRefusal = { note: string; draft: string } | { note: string; anyway: true };

/**
 * submitNote, or a DraftRefusal when the server named a draft it can clear (SubmitResult's `draft`)
 * or showed a box it could not tell empty (`box`; empty when it could not read one whole).
 */
export function submitRefusal(code: string, message: string, draft?: string, box?: string, agent?: string | null): string | DraftRefusal {
  if (code === "input_draft" && draft) return { note: t("Not sent: Claude Code's input box in the terminal already holds “{draft}”.", { draft }), draft };
  if (code === "input_draft" && box) return { note: t("Not sent: Claude Code's input box in the terminal may not be empty. It shows “{box}”.", { box }), anyway: true };
  return submitNote(code, message, agent);
}

/** The same message as typed, however a terminal wrapped or indented it: equal once all whitespace is gone. */
export function sameMessage(a: string, b: string): boolean {
  const bare = (text: string): string => text.replace(/[\s\u00a0]+/gu, "");
  return bare(a) !== "" && bare(a) === bare(b);
}
/** `agent`: the pane's agent, which names the input an input_draft refusal is about (Claude Code's when unknown) */
export function submitNote(code: string, message: string, agent?: string | null): string {
  if (code === "submit_partial") return t("Not confirmed: the terminal draft was cleared or may have changed. Your message stayed here. Check the terminal before sending again.");
  if (code === "agent_blocked") return t("Not sent: the agent is waiting for an answer in the terminal. Answer it first.");
  if (code === "read_only") return t("Not sent: this view only watches the pane.");
  if (code === "held_input") return t("Not sent: send or discard the held input first.");
  if (code === "input_draft" && agent === "hermes") return t("Not sent: Hermes' input in the terminal is not empty. Send or clear it there, then send this message.");
  if (code === "input_draft") return t("Not sent: Claude Code's input box in the terminal is not empty. Send or clear it there, then send this message.");
  if (code === "pending_input_unsupported") return t("Update this PC to send messages in the next turn. Your draft stayed here.");
  if (code === "submit_timeout") return t("Not sent: it waited too long behind an earlier message, and nothing was typed. Send it again.");
  if (code === "not_transmitted") return t("Not sent: the connection dropped before this message left. Send it again.");
  if (code === "disconnected" || code === "timeout") return t("Not confirmed: the pane did not confirm this message. Check the terminal before sending it again.");
  return t("Not sent: {message}", { message });
}

/**
 * How a stored image is referenced in the prompt: the agent TUI reads the file from
 * its path, so the mention is plain text the user can still edit before sending.
 */
export function imageMention(path: string): string {
  return `@${path} `;
}

/**
 * Where an attached file's mention goes: at the start of the message, after a leading `/command`
 * (it must stay first to be one), and after the mentions of files picked before it in the same
 * batch that are still there, so a batch reads in pick order however its uploads finish. An upload
 * finishes while the user may be typing, so the mention never goes where the caret is: the caller
 * shifts the caret and selection by `length` when they sit at or after `at`. The mention goes in
 * whole, with its separating space, or not at all (`length` 0): a cut `@path` would name a file
 * that does not exist, so the caller keeps the attachment waiting until there is room; `missing`
 * says how many characters the message is short of it.
 */
export function insertLeadingMention(
  text: string,
  mention: string,
  earlier: readonly string[],
): { text: string; at: number; length: number; missing?: number } {
  let at = /^\/\S+\s*/u.exec(text)?.[0].length ?? 0;
  for (const previous of earlier) {
    const found = text.indexOf(previous);
    if (found >= 0) at = Math.max(at, found + previous.length);
  }
  const before = text.slice(0, at);
  const snippet = before.length > 0 && !/\s$/u.test(before) ? ` ${mention}` : mention;
  const missing = text.length + snippet.length - MAX_COMPOSER_CHARS;
  if (missing > 0) return { text, at, length: 0, missing };
  return { text: before + snippet + text.slice(at), at, length: snippet.length };
}

/** Ready states affect the held-message hint only; sending always requires a user action. */
export const QUEUE_READY_STATUS: Readonly<Partial<Record<string, true>>> = { done: true, idle: true };

/**
 * Commands an agent runs that the chat can start but cannot finish, by the agents that have them.
 *
 * `/tree` opens pi's tree browser, and omp documents the same command, the same navigator and the
 * same three branch-summary choices — it moves the session's branch, and no entry names where the
 * leaf was left, so the browser that opens reads as nothing at all through the chat: no card (its
 * hint says "up/down move", not the hint a live dialog is read from), and the pane still reports
 * itself done while the terminal waits for arrow keys a phone cannot send. The chat keeps its half
 * honest — it says where a /tree left the conversation — and leaves navigating to the terminal.
 *
 * Deliberately not a block: the composer sends text as written and nothing filters it, so typing
 * these still reaches the agent. The point is that the chat no longer points at them and says why
 * when they are typed anyway. claude and codex are absent because there is no evidence they have
 * the command, and telling a reader about a browser their agent does not have is its own wrong; omo
 * and gjc are absent for the same reason, unverified rather than found wanting.
 */
const TERMINAL_ONLY_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  tree: ["pi", "omp"],
};

/** The command `text` types, if it is one of those: its name, or null. Case and arguments aside,
 * a message only has to *be* the command — prose that merely mentions it, or a word that only
 * begins like it (`/treemap`), is not one. */
export function terminalOnlyCommand(agent: string | null, text: string): string | null {
  if (agent === null) return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return null;
  const [word] = trimmed.slice(1).toLowerCase().split(/\s+/);
  const agents = TERMINAL_ONLY_COMMANDS[word ?? ""];
  return agents !== undefined && agents.includes(agent) ? (word ?? null) : null;
}

/** The composer's status word: the shared vocabulary, with a blank state reading as READY (a shell is always ready). */
export function composerStatusWord(status?: AgentStatus): string {
  const known = knownStatus(status);
  return known === "unknown" ? "READY" : STATUS_WORD[known];
}

/**
 * Below this card width the controls row cannot hold the background-task chip's words beside the
 * model, the effort and the offline sentence, so the chip shows its icon and count instead.
 * The input card is at most 820px wide (`--content-w`); a 1024px window with the sidebar open
 * still has a 672px card and keeps the words, a 940px one has 588px and gives them up.
 */
export const COMPOSER_STATUS_COMPACT_BELOW = 640;

/** Whether the controls row is compact at this card width. An unmeasured card (0) is not: nothing is drawn yet. */
export function composerStatusCompact(cardWidth: number): boolean {
  return cardWidth > 0 && cardWidth < COMPOSER_STATUS_COMPACT_BELOW;
}

/** The working agent rests with Stop; writing a message replaces it with Send. */
export function composerSendShown(state: { working: boolean; text: string }): boolean {
  return !state.working || state.text.trim().length > 0;
}

/** While an agent works, Send accepts a follow-up for its next turn. A shell sends immediately. */
export function composerDelivery(agent: string | null, status?: AgentStatus): "queue" | "immediate" {
  return agent !== null && status === "working" ? "queue" : "immediate";
}

/**
 * The sentence in the status content, if any. The reconnecting sentence is said once: it is the
 * placeholder while the box is empty, and moves here once there is a draft, which hides the
 * placeholder. It is said instead of an upload's, never both: the attachment's own tile says
 * it is uploading, and nothing else in the card would say why Stop and add are off. Otherwise
 * an upload says so while it runs.
 */
/** Characters left at which the composer starts counting them: further off, a count is noise. */
export const COMPOSER_CHARS_WARNING = 200;

/** `noRoom`: a finished upload's path waits for the message to be shortened. */
export function composerStatusHint(state: { uploading: boolean; connected: boolean; text: string; noRoom?: boolean }): "uploading" | "offline" | "no-room" | "near-limit" | null {
  if (!state.connected && state.text.length > 0) return "offline";
  if (state.noRoom) return "no-room";
  if (state.uploading) return "uploading";
  return MAX_COMPOSER_CHARS - state.text.length <= COMPOSER_CHARS_WARNING ? "near-limit" : null;
}

/**
 * How the model label (the mark, the model's name and the effort word) is drawn in the controls
 * row. Asked of the layout, not of a width: what fits depends on the name's length, the mic, the
 * task chip, the language and the font. `modelClipped` and `effortClipped` are measured with
 * everything drawn.
 * - "full": all of it fits.
 * - "out": while Queue is showing, a label that does not fit steps out whole (read, not drawn),
 *   so Queue keeps its word and no name is cut mid-word. It is back once the draft is sent, held
 *   or cleared.
 * - "no-effort": without Queue the effort word steps out whole before the name gives a letter,
 *   so a sliver of a word is never drawn. A name still too long is ellipsized as the last resort.
 */
export type ComposerModelDraw = "full" | "no-effort" | "out";

export function composerModelDraw(state: { modelClipped: boolean; effortClipped: boolean }): ComposerModelDraw {
  if (!state.modelClipped && !state.effortClipped) return "full";
  return "no-effort";
}

/** Herdr agent ids are machine-friendly; the composer presents a short human label. */
export function agentDisplayLabel(agent: string | null): string {
  if (!agent) return "Shell";
  return agent
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * How well a command matches what was typed after the `/`; lower is better, null is no match.
 * Plugin and skill names carry a namespace (`superpowers:brainstorming`), so a query is also
 * tried against each word of the name before it falls back to a substring, a run of letters in
 * order (`brst`), and the description.
 */
function slashMatchTier(command: SlashCommand, needle: string, prefixOnly: boolean): number | null {
  if (needle === "") return 0;
  const name = command.name.toLocaleLowerCase();
  if (name.startsWith(needle)) return 0;
  const first = name.indexOf(needle);
  for (let position = first; position >= 0; position = name.indexOf(needle, position + 1)) {
    if ((prefixOnly ? /[:-]/u : /[:\-_./]/u).test(name[position - 1]!)) return 1;
  }
  if (prefixOnly) return null;
  if (first >= 0) return 2;
  let at = 0;
  for (const letter of name) {
    if (needle.startsWith(letter, at)) at += letter.length;
    if (at === needle.length) return 3;
  }
  return needle.length >= 2 && command.description.toLocaleLowerCase().includes(needle) ? 4 : null;
}

/** Commands the agent can invoke at this position, before query ranking. */
export function commandsForTrigger(commands: readonly SlashCommand[], agent: string | null, trigger: ActiveTrigger): SlashCommand[] {
  const syntax = skillSyntax(agent);
  const prefix = trigger.prefix ?? "/";
  return commands.filter((command) => {
    if (trigger.start === 0) {
      return syntax.skillTriggers.length > 1
        ? prefix === "/" || command.source === "skill"
        : (command.trigger ?? "/") === prefix;
    }
    if (command.source !== "skill" || !syntax.inline.includes(prefix)) return false;
    if (agent === "codex") return command.trigger === "$";
    if (agent === "claude") return command.trigger === undefined;
    if (agent === "omp") return command.name.startsWith("skill:");
    return true;
  });
}

/**
 * A menu row's description down to its first sentence: a skill's goes on to say when to use it
 * and when not, which is for the agent, and on a phone it ran to five lines a row. A full stop
 * ends a sentence only before a capital (or a letter with no case) or as `\u3002`, so `e.g. foo`
 * and `v1.2` keep their text.
 */
export function briefDescription(description: string): string {
  const text = description.trim();
  const end = /[.!?](?=\s+[\p{Lu}\p{Lo}"'(])|\u3002/u.exec(text);
  return (end ? text.slice(0, end.index) : text).replace(/(?<!\.)[.\u3002]$/u, "");
}

/**
 * Where a bare `/` or `$` lists a command: a skill under where it comes from, yours before the
 * project's, then the ones without a known origin, the agent's own and its plugins'.
 */
export const COMMAND_GROUPS = ["builtin", "user", "project", "skill-user", "skill-project", "skill", "skill-bundled", "skill-plugin", "plugin"] as const;
export type CommandGroup = (typeof COMMAND_GROUPS)[number];

export function commandGroup(command: SlashCommand): CommandGroup {
  if (command.source === "skill" && command.origin !== undefined) return `skill-${command.origin}`;
  return command.source;
}

/** Multi-trigger skills use the typed prefix; others use the command's wire trigger. */
export function slashCommandReplacement(command: SlashCommand, agent: string | null, trigger: ActiveTrigger): string {
  const prefix = skillSyntax(agent).skillTriggers.length > 1 ? trigger.prefix ?? "/" : command.trigger ?? "/";
  return `${prefix}${command.name} `;
}

/**
 * Filter commands by what was typed - prefix first, then a word of the name, a substring, letters
 * in order, the description - and within a match kind prefer the commands the user selects most.
 * Away from line starts, `prefixOnly` excludes fuzzy matches that could rewrite paths such as `/tmp`.
 */
export function rankSlashCommands(
  commands: readonly SlashCommand[],
  query: string,
  usage: Readonly<Partial<Record<string, number>>>,
  prefixOnly = false,
): SlashCommand[] {
  const needle = query.toLocaleLowerCase();
  const ranked: { command: SlashCommand; tier: number }[] = [];
  for (const command of commands) {
    const tier = slashMatchTier(command, needle, prefixOnly);
    if (tier !== null) ranked.push({ command, tier });
  }
  return ranked
    .sort((left, right) => {
      const tier = left.tier - right.tier;
      const frequency = (usage[right.command.name] ?? 0) - (usage[left.command.name] ?? 0);
      return tier || frequency || left.command.name.localeCompare(right.command.name);
    })
    .map(({ command }) => command);
}

/** A token count the way a status line reads it: 950, 68k, 1.2M. */
export function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(Math.round(tokens));
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** What is left of the context, as the agents' own status lines put it; null when the window is unknown. */
export function contextLeftPercent(context: { used: number; window: number | null }): number | null {
  if (context.window === null || context.window <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((1 - context.used / context.window) * 100)));
}
