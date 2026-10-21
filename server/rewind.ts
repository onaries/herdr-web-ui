/**
 * "Rewind to here" from Chat (POST /api/pane/rewind). For Claude Code the server opens /rewind,
 * moves its list's cursor to the message the user picked, and opens that message's confirm step:
 * the claude-rewind card (server/dialogs/claude.ts) then asks what to restore, as any card does.
 * Every key is one the recordings show the dialog taking (2.1.304: ↑ moves up the list, Enter opens a
 * message's confirm step, "Never mind" there goes back to the list, Esc closes it), and each is sent
 * only after the screen shows what the one before it did. Once the card's Restore conversation is
 * seen done (the dialog gone, the message back in Claude's input box), the chat follows at once
 * (followClaudeRestore). grok and agy keep their rewinds where their readers follow them, but nothing
 * here reads their input box, so a draft there cannot be ruled out: the route refuses them, and the
 * chat offers the action for Claude Code alone.
 */
import type { ParsedPrompt } from "./dialogs/shared.ts";
import type { PaneRewindResponse } from "../shared/protocol.ts";
import { CLAUDE_REWIND_CHOICES, parseClaudeRewindConfirm, parseClaudeRewindList, type ClaudeRewindConfirm, type ClaudeRewindList } from "./dialogs/claude.ts";
import { KEY, normalizeText } from "./dialogs/shared.ts";
import { badRequest, conflictResponse, errorResponse, isCount, jsonResponse, readJsonObject } from "./http.ts";
import { agentPrompt, HerdrError, paneRead, paneScrollInfo, paneSendKeys } from "./herdr/client.ts";
import { paneContext } from "./pane-context.ts";
import { claudeInputBoxContent, claudeInputDraft, claudeRewindOpen, forgetChatSendsAfter, parseInteractivePrompt, viewportShowsLive } from "./prompt.ts";
import { claudeCutQuoteUnambiguous, rewindClaudeTranscript } from "./conversation.ts";

/** The requester disconnected: nothing more is typed for it (AGENTS.md: nothing is sent automatically after a disconnect). */
class RequesterGone extends Error {}

/** agents with a rewind of their own but no reader of their input box: refused, a draft there could join the command */
const UNREAD_INPUT = new Set(["grok", "agy"]);

/** the message each pane's rewind was walked to, for the restore that may follow (followClaudeRestore) */
const asked = new Map<string, { text: string; later: number }>();

/** The message a walk opened on this pane (`later` newer copies past), for the restore that may follow. */
export function rememberRewind(paneId: string, text: string, later: number): void {
  asked.delete(paneId);
  asked.set(paneId, { text, later });
  if (asked.size > 128) asked.delete(asked.keys().next().value!);
}

/** how long the dialog may take to show what a key did */
const STEP_MS = 3000;
/** list rows walked at most: a session longer than this is rewound from the terminal */
const MAX_ROWS = 400;
const POLL_MS = 40;

export interface RewindIo {
  read(): Promise<string>;
  keys(keys: string[]): Promise<void>;
  command(text: string): Promise<void>;
  /** whether a quote Claude Code cut stands for the message alone among the user's messages; absent: not known */
  unambiguous?(quote: string): Promise<boolean>;
}

export type RewindWalk = "shown" | "not_found" | "changed" | "ambiguous";

/**
 * Claude Code 2.1.304 cuts a confirm step's quote at 500 characters, with no mark (recorded, a
 * 610-character message): a quote this long that the message starts with may be that message cut.
 */
const QUOTE_CUT_MIN = 450;

/** The list's row and the message it may stand for: whole, or cut short with `…` by a narrow pane. */
function rowMatches(label: string, text: string): boolean {
  const message = normalizeText(text);
  const shown = normalizeText(label);
  if (shown === message) return true;
  return shown.endsWith("…") && shown.length > 1 && message.startsWith(shown.slice(0, -1).trimEnd());
}

/** The confirm step quotes the whole message, which tells two messages a cut row reads the same for apart. */
function quoteMatches(confirm: ClaudeRewindConfirm, text: string): boolean {
  return confirm.message === normalizeText(text);
}

/** A quote Claude Code cut short that the message may be: as long as its cuts, and the message's start. */
function quoteCut(confirm: ClaudeRewindConfirm, text: string): boolean {
  const message = normalizeText(text);
  return confirm.message.length >= QUOTE_CUT_MIN && confirm.message.length < message.length && message.startsWith(confirm.message);
}

/** Reads until `accept` takes the screen, within `ms`; null when it never does. */
async function waitFor<T>(io: Pick<RewindIo, "read">, accept: (screen: string) => T | null, ms: number): Promise<T | null> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const found = accept(await io.read());
    if (found !== null) return found;
    await Bun.sleep(POLL_MS);
  }
  return null;
}

/**
 * Whether Claude Code's own input box holds a draft, read as the chat's sends read it (core/composer.ts
 * claudeBoxReads): an empty box at once, else again with the viewport's colors where they show the
 * live screen, so a grey suggestion is no draft.
 */
async function claudeBoxHoldsDraft(paneId: string): Promise<boolean> {
  const before = (await paneRead({ paneId, source: "detection", format: "text" })).text;
  if (!claudeInputDraft(before, null)) return false;
  const scrollBefore = await paneScrollInfo(paneId);
  const colors = (await paneRead({ paneId, source: "visible", format: "ansi" })).text;
  const scrollAfter = await paneScrollInfo(paneId);
  const live = (await paneRead({ paneId, source: "detection", format: "text" })).text;
  return claudeInputDraft(live, viewportShowsLive(scrollBefore, scrollAfter, colors, before, live) ? colors : null);
}

/**
 * Whether the screen shows Claude Code after Restore conversation for `message` (recorded at 40 and 120
 * columns, 2.1.304): no rewind panel left, and the message back in its input box.
 */
export function restoredOnScreen(screen: string, message: string): boolean {
  if (parseClaudeRewindConfirm(screen) !== null || parseClaudeRewindList(screen) !== null) return false;
  const box = claudeInputBoxContent(screen);
  return box !== null && normalizeText(box.replace(/^❯\s*/, "")) === normalizeText(message);
}

/**
 * Restore conversation was answered on the rewind card: once Claude Code shows it done, the chat
 * ends before that message and the message in Claude's box is the chat's own again, both tied to
 * the pane's one Claude process (conversation.ts rewindClaudeTranscript, claudeRestoredOwned), so the
 * composer offers it and the next send empties the box first. Nothing is kept when the screen does not show the restore within STEP_MS.
 */
export async function followClaudeRestore(paneId: string, parsed: ParsedPrompt, stepMs = STEP_MS): Promise<void> {
  // a confirm step's card whose first choice is Restore conversation (the cursor was on it); a card
  // that offers Never mind alone answered no restore with its first choice
  if (parsed.menuLabels.join("\n") !== CLAUDE_REWIND_CHOICES.join("\n") || parsed.options[0]?.label !== CLAUDE_REWIND_CHOICES[0] || !parsed.body) return;
  const quoted = parsed.body.split("\n")[0]!;
  const walked = asked.get(paneId);
  asked.delete(paneId);
  // the message the walk opened, its quote whole or cut at 500 characters (quoteCut): the restored box
  // and the transcript hold all of it
  const words = walked === undefined ? "" : normalizeText(walked.text);
  const ours = walked !== undefined && (words === quoted || (quoted.length >= QUOTE_CUT_MIN && quoted.length < words.length && words.startsWith(quoted)));
  const message = ours ? walked.text : quoted;
  // a dialog the chat did not walk (opened in the terminal, or the list's own card): which copy of a
  // repeated message was picked is not known, so only a message's one copy is kept
  const later = ours ? walked.later : null;
  const read = async () => (await paneRead({ paneId, source: "detection", format: "text" })).text;
  if (await waitFor({ read }, (screen) => restoredOnScreen(screen, message) ? true : null, stepMs) === null) return;
  try {
    const cut = await rewindClaudeTranscript(paneId, message, later);
    // the chat's sends after the restored message went with it: their outcomes would claim evidence no longer there
    if (cut?.at != null) forgetChatSendsAfter(paneId, cut.at);
  } catch (error) {
    console.error(`rewind: the chat could not follow pane ${paneId}'s restore: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const cursorOf = (list: ClaudeRewindList): string => list.rows[list.cursor]!.label;

/**
 * Never mind on the rewind card: its Esc took Claude Code back to the list (recorded), which the chat
 * offers no way out of. Once the list shows, one more Esc closes it (recorded); nothing is sent when the
 * list does not show within `stepMs`, so Claude's own input box never gets an Esc from here. Nor once the
 * requester is `gone`, checked before the Esc and again by herdr's client right before its write.
 */
export async function followClaudeNeverMind(paneId: string, stepMs = STEP_MS, gone: () => boolean = () => false): Promise<void> {
  // no restore follows the walk Never mind answered: a later one (another copy opened in the terminal) is not the walked copy
  asked.delete(paneId);
  const read = async () => (await paneRead({ paneId, source: "detection", format: "text" })).text;
  if (await waitFor({ read }, parseClaudeRewindList, stepMs) === null || gone()) return;
  try {
    await paneSendKeys(paneId, [KEY.escape], undefined, () => !gone());
  } catch (error) {
    // the guard kept the Esc back: the requester left while it connected
    if (!(error instanceof HerdrError && error.code === "cancelled")) throw error;
  }
}

/**
 * From a confirm step back to the list, the cursor on `label` again: one Esc, which 2.1.304 takes on
 * any of the step's rows (recorded). Never over the rows: on a Summarize row the step is an
 * add-context field, which typed text and Enter commit. null: the list did not come back on that
 * row within `stepMs`; no further key is sent here.
 */
async function backToList(io: RewindIo, label: string, stepMs: number): Promise<ClaudeRewindList | null> {
  await io.keys([KEY.escape]);
  return await waitFor(io, (screen) => {
    const shown = parseClaudeRewindList(screen);
    return shown !== null && cursorOf(shown) === label ? shown : null;
  }, stepMs);
}

/**
 * Leaves no rewind dialog behind: Esc while the screen still shows Claude Code's rewind panel, read or
 * not, at most three times (recorded: on a confirm step or its add-context field Esc goes back to the
 * list, on the list it closes it). Esc commits nothing there; once the panel is gone nothing is sent,
 * so Claude's own input box never gets an Esc from here.
 */
async function closeRewind(io: RewindIo, stepMs: number): Promise<void> {
  for (let presses = 0; presses < 3; presses += 1) {
    const screen = await io.read();
    if (!claudeRewindOpen(screen)) return;
    await io.keys([KEY.escape]);
    if (await waitFor(io, (shown) => shown !== screen ? true : null, stepMs) === null) return;
  }
}
/** where the list stands: the row under the cursor and how much lies above it */
const placeOf = (list: ClaudeRewindList): string => `${list.above}\0${list.cursor}\0${list.rows.map((row) => row.label).join("\n")}`;

/**
 * Opens Claude Code's /rewind and walks its list up to the message `text`, `later` other messages with
 * the same words being newer ones, then opens that message's confirm step. "shown": the step is on
 * screen, for the user to answer from its card. "not_found": the list holds no such message and was
 * closed again. "changed": the dialog did not show what a key should have done; no key but Esc follows,
 * and only while a rewind panel is still on screen: whatever the walk ends in other than "shown", it
 * leaves no dialog open.
 */
export async function walkClaudeRewind(io: RewindIo, text: string, later: number, stepMs = STEP_MS): Promise<RewindWalk> {
  const walked = await walkRewindList(io, text, later, stepMs);
  if (walked !== "shown") await closeRewind(io, stepMs);
  return walked;
}

async function walkRewindList(io: RewindIo, text: string, later: number, stepMs: number): Promise<RewindWalk> {
  await io.command("/rewind");
  let list = await waitFor(io, parseClaudeRewindList, stepMs);
  if (list === null) return "changed";
  let skip = later;
  for (let rows = 0; rows < MAX_ROWS; rows += 1) {
    const label = cursorOf(list);
    if (label !== "(current)" && rowMatches(label, text)) {
      // a whole row is this message; a row cut short may be another one that starts the same, so only
      // its confirm step's quote counts it as one of the newer copies. A row ending in "…" is opened
      // even when it reads as the message: a message may itself end in "…", as a longer one is cut to
      if (skip > 0 && normalizeText(label) === normalizeText(text) && !label.endsWith("…")) skip -= 1;
      else {
        await io.keys([KEY.enter]);
        const confirm = await waitFor(io, parseClaudeRewindConfirm, stepMs);
        if (confirm === null) return "changed";
        // a quote cut short tells this message from another only when no other one starts the same; one as
        // long as Claude Code's cuts may be a longer message cut short even where it is all of this one
        const cutLength = quoteCut(confirm, text) || (quoteMatches(confirm, text) && confirm.message.length >= QUOTE_CUT_MIN);
        if (cutLength && await io.unambiguous?.(confirm.message) !== true) return "ambiguous";
        const same = quoteMatches(confirm, text) || quoteCut(confirm, text);
        if (same && skip === 0) return "shown";
        if (same) skip -= 1;
        // a newer copy, or another message the cut row reads the same for: back to the list, on the same row
        const back = await backToList(io, label, stepMs);
        if (back === null) return "changed";
        list = back;
      }
    }
    // the first message: nothing above it
    if (list.cursor === 0 && list.above === 0) {
      await io.keys([KEY.escape]);
      return "not_found";
    }
    const before = placeOf(list);
    await io.keys([KEY.up]);
    const moved = await waitFor(io, (screen) => {
      const shown = parseClaudeRewindList(screen);
      return shown !== null && placeOf(shown) !== before ? shown : null;
    }, stepMs);
    if (moved === null) return "changed";
    list = moved;
  }
  return "changed";
}

/**
 * POST /api/pane/rewind `{ pane_id, text, later? }`. Refused while the agent works or its own input
 * box holds a draft (the browser checks its composer too). A watching device never reaches here: the
 * access gate refuses its mutations.
 */
export async function handleRewindRequest(request: Request, serialize: <T>(paneId: string, task: () => Promise<T>) => Promise<T>): Promise<Response> {
  if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
  const payload = await readJsonObject<{ pane_id?: unknown; text?: unknown; later?: unknown }>(request);
  if (payload instanceof Response) return payload;
  if (typeof payload.pane_id !== "string" || !payload.pane_id.trim()) return badRequest("missing_pane_id", "pane_id is required");
  if (typeof payload.text !== "string" || !payload.text.trim()) return badRequest("missing_text", "text is required");
  if (payload.later !== undefined && !isCount(payload.later)) return badRequest("invalid_later", "later must be a non-negative integer");
  const paneId = payload.pane_id;
  const text = payload.text;
  const later = payload.later ?? 0;
  try {
    const gone = (): boolean => request.signal.aborted;
    return await serialize(paneId, async () => {
      // the rewind waited its turn in the pane's input order: a requester gone meanwhile gets nothing typed
      if (gone()) return conflictResponse("requester_gone", "The rewind was asked by a connection that is gone");
      const { agent, pane } = await paneContext(paneId);
      if (agent !== "claude" && !UNREAD_INPUT.has(agent ?? "")) return badRequest("rewind_unsupported", "this agent has no rewind from Chat");
      if (pane.agent_status !== "idle" && pane.agent_status !== "done") return conflictResponse("agent_busy", "The agent is not waiting for a message; rewind once it is");
      // its input box is read by nothing here: it cannot be known empty, and /rewind typed over a draft would join it
      if (agent !== "claude") return conflictResponse("input_draft", "The agent's input box cannot be read here to be empty; rewind from the terminal");
      // herdr reports Claude Code idle while one of its dialogs is up (this rewind's own confirm step, from
      // any device, or one opened in the terminal), and a dialog shows no input box: the prompt's Enter
      // would take the choice under its cursor. One rewind per pane: the next waits until its card is
      // answered or dismissed.
      const shown = (await paneRead({ paneId, source: "detection", format: "text" })).text;
      if (claudeInputBoxContent(shown) === null || parseInteractivePrompt("claude", shown) !== null) {
        return conflictResponse("dialog_open", "Claude Code is showing a dialog; answer or close it first");
      }
      if (await claudeBoxHoldsDraft(paneId)) return conflictResponse("input_draft", "Claude Code's input box holds a draft; send or clear it first");
      // a disconnect mid-walk stops the keys after it
      const walked = gone() ? "changed" : await walkClaudeRewind({
        read: async () => (await paneRead({ paneId, source: "detection", format: "text" })).text,
        // checked once more by herdr's client once connected, right before the write (herdrRpc's guard)
        keys: async (keys) => { if (gone()) throw new RequesterGone(); await paneSendKeys(paneId, keys, undefined, () => !gone()); },
        command: async (command) => { if (gone()) throw new RequesterGone(); await agentPrompt(paneId, command, undefined, () => !gone()); },
        unambiguous: (quote) => claudeCutQuoteUnambiguous(paneId, text, quote).catch(() => false),
      }, text, later).catch((error: unknown) => {
        // herdr's guard refused the write: the requester left while it connected
        if (error instanceof RequesterGone || (error instanceof HerdrError && error.code === "cancelled" && gone())) return "changed" as const;
        throw error;
      });
      if (walked === "not_found") return conflictResponse("rewind_not_found", "Claude Code's rewind list does not hold this message");
      if (walked === "ambiguous") return conflictResponse("rewind_ambiguous", "Claude Code's rewind dialog shows this message cut short, and another message starts the same; rewind from the terminal");
      if (walked === "changed") return conflictResponse("prompt_changed", "Claude Code's rewind dialog did not show what was expected; finish it in the terminal");
      rememberRewind(paneId, text, later);
      return jsonResponse({ ok: true, outcome: "interaction-required" } satisfies PaneRewindResponse);
    });
  } catch (error) {
    return errorResponse(error);
  }
}
