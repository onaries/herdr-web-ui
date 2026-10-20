import { createHash, randomBytes } from "node:crypto";
import type { HerdrPane, InteractivePrompt, InteractivePromptOption, PanePromptResponse, PromptAnswer, SessionSnapshot } from "../shared/protocol.ts";
import { builtinCommands, cachedPaneCommands } from "./commands.ts";
import { readCommandTranscript } from "./conversation.ts";
import { resolveAgent } from "./pane-context.ts";
import { commandInvocations, commandOutcome, CommandReservations, dialogSettlingScreen, ownsCommandDialog, WINDOW_MS as COMMAND_WINDOW_MS, type CommandSend } from "./outcome.ts";
import { codexTranscriptPath, paneCodexHome, unansweredCodexQuestions, type QueuedQuestion } from "./codex.ts";
import { HerdrError, paneRead, paneScrollInfo, paneSendKeys, paneSendText, sessionSnapshot } from "./herdr/client.ts";
import { omoTranscriptForPane } from "./omo.ts";
import { OmoAskReader, omoAsksAfter, type OmoAskCall, type OmoAsks } from "./omo-ask.ts";
import { badRequest, errorResponse, jsonResponse } from "./http.ts";
import { claudePlanFile } from "./claude-plan.ts";
import { listPendingQuestionForms, readOpenCodeService, replyOpenCodeForm } from "./opencode-service.ts";
import { opencodeSessionId } from "./opencode.ts";
import { registry } from "./dialogs/registry.ts";
import { ANSI_RE, type AnswerStep, KEY, type OmoAsk, type OpenCodePromptEntry, PI_MODEL_HINT_RE, type ParsedPrompt, SOLID_RULE_RE, cleanLine, findLastIndex, finishPrompt, isDivider, keySteps, navigationKeys, normalizeText, parsedByPublicPrompt, publicPrompt, wrapped } from "./dialogs/shared.ts";
import { executeInteractionPlan } from "./dialogs/interaction-plan.ts";
import { CODEX_ASK_HINT_RE, CODEX_ASYNC_ASK_HINT_RE, CODEX_CONTINUE_HINT_RE, CODEX_QUEUE_HEADER_RE, codexModelListWaits } from "./dialogs/codex.ts";
import { OMO_FOOTER_LINES, OMO_HINT_LINES, OMO_NOT_FOOTER_RE, OMO_OPTIONS_HINT_RE, OMO_PENDING_HINT_RE, OMO_REVIEW_HINT_RE, OMO_TYPING_HINT_RE, omoModelListWaits, sameText } from "./dialogs/omo.ts";
import { CLAUDE_ASK_HINT_RE, CLAUDE_CONFIRM_HINT_RE, CLAUDE_EFFORT_GUARD_RE, CLAUDE_EFFORT_HINT_RE, INVISIBLE_CHAR_RE, claudeModelListWaits, withoutClaudeTasks } from "./dialogs/claude.ts";
import { OMP_CLIPPED_SINGLE_HINT_RE, OMP_MULTI_HINT_RE, OMP_REVIEW_HINT_RE, OMP_SINGLE_CLIPPED_HINT_RE, OMP_SINGLE_HINT_RE } from "./dialogs/omp.ts";
import { HERMES_HINT_RE } from "./dialogs/hermes.ts";
import { PI_INPUT_HINT_RE, PI_MENU_HINT_RE, parsePiDialog } from "./dialogs/pi.ts";
import { parseFallbackPrompt } from "./dialogs/fallback.ts";
export { removedInvisible } from "./dialogs/claude.ts";
export { INVISIBLE_CHAR_RE } from "./dialogs/claude.ts";
export type { OmoAsk } from "./dialogs/shared.ts";
export { parseFallbackPrompt } from "./dialogs/fallback.ts";

const CODEX_QUEUE_COUNT_RE = /^\?\s*(\d+)\s+questions?\b/;
/**
 * A row of OmO's omo-task widget under the input box (omo-ai plugin/extensions/omo-task.js): a live row
 * `<spinner> <task> · <route> · <state>[ · <elapsed>]` with the route `agent:X`, `category:X` or `task`,
 * a finished row `<task>|<route> <mode> <status>`, or the `+N more` line after five rows.
 */
const OMO_TASK_ROW_RE = /^(?:[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏‖] .+? · (?:agent:|category:|task(?: ·|$))|[^|]+\|(?:agent:|category:|task\b)|\+\d+ more$)/u;
/** a spinner row with no task route: another program's output, never the widget */
const OMO_SPINNER_ROW_RE = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏‖] /u;
/** a narrow pane wraps a task row's last fields (ending in the elapsed time) onto one more short line */
const OMO_TASK_TAIL_RE = /^(?:[^\u00b7]+ \u00b7 )*\d+[hms](?: \d+[hms])*$/u;
const OMO_TASK_WRAP_MAX = 32;
/** where each of the form's hints ends, however a narrow pane wraps it */
const OMO_HINT_END_RE = /\besc (?:cancel|back|discard)$/;
/** OmO's apparently empty input box; never sufficient evidence for sending text into it. */
const OMO_EMPTY_BOX_RE = /^[❯›>]$/;

/**
 * How many questions wait in Codex's collapsed queue at the bottom of the screen, with the
 * main prompt right under it; 0 otherwise. The card (codexQueuedPrompt) and the send path
 * (codexQuestionsCollapsed) both read this count, so they cannot disagree.
 * - A message of the user's own waiting to be submitted replaces the questions' block
 *   (alt+↑ then opens nothing, checked on Codex 0.156.1): no count then.
 * - An open question (its "enter submit … skip" hint) or an approval under the queue holds the
 *   input itself: no count either.
 */
function queuedQuestionCount(screen: string): number {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/).map(cleanLine).filter(Boolean);
  const header = findLastIndex(lines, (line) => CODEX_QUEUE_HEADER_RE.test(line));
  // the queue sits right above the main prompt and its status line
  if (header < 0 || lines.length - header > 16) return 0;
  if (lines.slice(header).some((line) => /^↳\s/.test(line) || /Messages to be submitted/i.test(line) || CODEX_ASYNC_ASK_HINT_RE.test(line))) return 0;
  const at = lines.findIndex((line, index) => index > header && index <= header + 7 && CODEX_QUEUE_COUNT_RE.test(line));
  // (the main prompt, not a numbered menu row the parser did not recognise)
  if (at < 0 || !/\bto answer$/i.test(lines[at + 1] ?? "") || !/^›\s(?!\d+\.)/.test(lines[at + 2] ?? "")) return 0;
  return Number(lines[at]!.match(CODEX_QUEUE_COUNT_RE)![1]);
}

/** The question a pane's queue opened on, as it showed there, when that was not the card's. */
export interface QueueFront { question: string; options: string[] }

/**
 * The collapsed queue shows only a count: the card takes its first question from the
 * rollout, the newest `count` unanswered ones (a skipped question leaves no record).
 */
function queuedPrompt(count: number, unanswered: QueuedQuestion[], front: QueueFront | null = null): ParsedPrompt | null {
  const waiting = unanswered.slice(-count);
  // the question the queue opened on last time, when that was not the newest guess: by its
  // title and its options, the newest such one (an older skipped one may share the title)
  const first = (front !== null ? [...unanswered].reverse().find((question) => sameText(front.question, question.title)
    && question.options.length === front.options.length && question.options.every((option, index) => sameText(front.options[index]!, option))) : undefined)
    ?? waiting[0];
  if (!first || waiting.length !== count || !first.title.trim()) return null;
  return finishPrompt("codex", {
    kind: "question", title: count > 1 ? `Question 1 of ${count}` : "Question", question: normalizeText(first.title), body: null,
    options: first.options.map((label) => ({ label, description: null })),
    multi_select: false, custom_option_index: first.options.length, queued: "collapsed",
  }, {
    responder: "codex-queued-question", menuLabels: first.options.length ? [...first.options, "Other"] : [],
    selectedIndex: 0, checkedOptionIndices: [], customMenuIndex: first.options.length, rejectWithEscapeIndex: null,
  });
}

/** A call's questions, or null for arguments that are not the shape omo asks with. */
function omoAskOf(call: OmoAskCall): OmoAsk | null {
  const questions = (call.args as { questions?: unknown } | null | undefined)?.questions;
  if (!Array.isArray(questions) || questions.length === 0) return null;
  const ask: OmoAsk = { id: call.id, questions: [], wait: call.wait };
  for (const question of questions as Record<string, unknown>[]) {
    if (typeof question?.["header"] !== "string" || typeof question["question"] !== "string" || (question["options"] !== undefined && !Array.isArray(question["options"]))) return null;
    const options = ((question["options"] ?? []) as Record<string, unknown>[]).map((option) => ({
      label: typeof option?.["label"] === "string" ? option["label"] : "",
      description: typeof option?.["description"] === "string" && option["description"] ? option["description"] : null,
    }));
    if (options.some((option) => !option.label)) return null;
    ask.questions.push({ header: question["header"], question: question["question"], multiSelect: question["multiSelect"] === true, options });
  }
  return ask;
}

/** the records that can open or close a question; the rest of a session's tail is not parsed */
const OMO_ASK_RECORD_RE = /"role":"(?:assistant|toolResult|user)"|ask-user:settlement/;

/**
 * The questions omo's session (its .jsonl, or the tail of it) still has open (omo-ask.ts), newest
 * first: a waiting call until its tool result, a non-waiting call until it is settled. Calls whose arguments are not the shape omo asks
 * with are left out.
 */
export function openOmoAsks(jsonl: string): OmoAsk[] {
  let open: OmoAsks = [];
  for (const line of jsonl.split("\n")) {
    if (!OMO_ASK_RECORD_RE.test(line)) continue;
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; }
    if (typeof entry === "object" && entry !== null) open = omoAsksAfter(open, entry);
  }
  return open.flatMap((call) => omoAskOf(call) ?? []).reverse();
}

/** The newest question omo's session has open, or null. */
export function pendingOmoAsk(jsonl: string): OmoAsk | null {
  return openOmoAsks(jsonl)[0] ?? null;
}

/** What the chat last sent to each pane, while it carried invisible characters (noteSubmitted). */
const heldCandidates = new Map<string, { text: string; at: number }>();
/** Long enough to read the card and answer it; a message kept past this is the user's own business */
const HELD_WINDOW_MS = 10 * 60_000;
/** What the chat last sent to each pane: Claude Code puts that text back in its input box when the send is cancelled right after it. */
const chatSent = new Map<string, { text: string; commands: (CommandSend & { store: string | null })[]; reservations: CommandReservations }>();

const outcomeIdentity = (pane: HerdrPane): string => JSON.stringify([pane.terminal_id, pane.agent_session]);

/** Capture only existing data before delivery. Discovery and transcript reads belong to the poll. */
export function prepareCommandSend(pane: HerdrPane, text: string, screen = ""): (CommandSend & { store: string | null }) | undefined {
  if (!/(?:^|\s)[/$@]\S/u.test(text)) return undefined;
  const cached = cachedPaneCommands(pane);
  const agent = cached?.agent ?? resolveAgent(pane).agent;
  if (!agent) return undefined;
  const commands = cached?.commands ?? builtinCommands(agent);
  const invocations = commandInvocations(agent, text, commands);
  if (invocations.length === 0) return undefined;
  return { id: randomBytes(12).toString("hex"), text, at: Date.now(), agent, identity: outcomeIdentity(pane),
    screen, invocations, form: invocations[0]?.form ?? null, store: null };
}

/** A message the chat just sent to a pane: one with invisible characters may be held by Claude Code. */
export function noteSubmitted(paneId: string, text: string, command?: CommandSend & { store: string | null }): void {
  const previous = chatSent.get(paneId)?.commands ?? [];
  const reservations = chatSent.get(paneId)?.reservations ?? new CommandReservations();
  reservations.close(command?.text ?? text, command?.at ?? Date.now());
  if (command) reservations.add(command, registry.readersFor(command.agent));
  const commands = command ? [...previous, command].slice(-5) : previous;
  chatSent.delete(paneId);
  chatSent.set(paneId, { text, commands, reservations });
  if (chatSent.size > 128) chatSent.delete(chatSent.keys().next().value!);
  if (INVISIBLE_CHAR_RE.test(text)) heldCandidates.set(paneId, { text, at: Date.now() });
  else heldCandidates.delete(paneId);
}

/** The text of the pane's last successful chat send (noteSubmitted), or none. */
export function lastChatSubmitted(paneId: string): string | null {
  return chatSent.get(paneId)?.text ?? null;
}

/** Native observers must name the send they correlated; a timestamp or idle transition alone is not an event. */
export function noteCommandEvidence(paneId: string, id: string, evidence: NonNullable<Parameters<typeof commandOutcome>[2]["evidence"]>): void {
  const commands = chatSent.get(paneId)?.commands ?? [];
  const index = commands.findIndex((sent) => sent.id === id);
  const sent = commands[index];
  if (!sent) return;
  sent.outcome = commandOutcome(paneId, sent, { now: Date.now(), evidence, nextAt: commands[index + 1]?.at });
}

async function commandOutcomes(paneId: string, pane: HerdrPane, prompt: InteractivePrompt | null, screen: string | undefined, readSendId: string | undefined, codexHome?: string): Promise<NonNullable<PanePromptResponse["outcomes"]>> {
  if (!chatSent.get(paneId)?.commands.length) return [];
  chatSent.get(paneId)?.reservations.prune(Date.now());
  screen ??= await liveScreen(paneId).catch(() => "");
  const commands = chatSent.get(paneId)?.commands ?? [];
  const now = Date.now();
  // The transcript can be megabytes; read it only while a send can still change from it.
  const open = commands.some((sent) => sent.outcome?.state !== "result-observed" && sent.form?.interaction !== "terminal"
    && now < sent.at + COMMAND_WINDOW_MS);
  const transcript = open ? await readCommandTranscript(paneId, codexHome).catch(() => null) : null;
  if (transcript) chatSent.get(paneId)?.reservations.observeTranscript(outcomeIdentity(pane), transcript.identity, transcript.records, readSendId);
  const parsed = prompt ? parsedByPublicPrompt.get(prompt) : undefined;
  const readIndex = commands.findIndex((sent) => sent.id === readSendId);
  return commands.map((sent, index) => {
    // A send racing this GET must not inherit a screen read before that send.
    if (index > readIndex) return sent.outcome ?? commandOutcome(paneId, sent, { now });
    const same = sent.identity === outcomeIdentity(pane);
    const latest = index === commands.length - 1 && same && sent.closedAt === undefined && now < sent.at + COMMAND_WINDOW_MS;
    const reader = parsed ? registry.readerFor(parsed.responder) : undefined;
    const readers = registry.readersFor(sent.agent);
    const before = parsePrompt(sent.agent, sent.screen);
    const dialog = latest && prompt && parsed && reader && reader.kind !== "result" && !prompt.fallback && parsed.id !== before?.id
      && ownsCommandDialog(sent, parsed, screen, reader, readers)
      ? { id: prompt.id, reader: reader.id } : undefined;
    if (dialog && (!sent.form?.dialog || sent.form.dialog === dialog.reader)) {
      sent.dialogId = dialog.id;
      sent.dialogObserved = true;
    }
    else sent.dialogId = undefined;
    if (latest && pane.agent_status === "blocked" && !prompt && reader?.kind !== "result") sent.waitingSince ??= now;
    else sent.waitingSince = undefined;
    if (latest && sent.form?.interaction === "dialog" && !sent.dialogObserved && (!prompt || prompt.fallback)
      && (pane.agent_status === "idle" || pane.agent_status === "done")) {
      const content = dialogSettlingScreen(screen, sent.agent, readers);
      if (content === dialogSettlingScreen(sent.screen, sent.agent, readers)) sent.settled = undefined;
      else if (sent.settled?.screen !== content) sent.settled = { screen: content, since: now };
    } else sent.settled = undefined;
    const nextAt = commands[index + 1]?.at ?? (!same ? now : undefined);
    const observed = commandOutcome(paneId, sent, {
      now, nextAt, screen: latest ? screen : undefined, resultScreen: same ? screen : undefined,
      readers, dialog, settledSince: sent.settled?.since,
      waitingSince: sent.waitingSince,
      transcriptAt: same && sent.transcriptEvidence && sent.transcriptEvidence.at < (sent.transcriptClosedAt ?? Infinity)
        ? sent.transcriptEvidence.at : undefined,
    });
    sent.outcome = observed;
    return observed;
  });
}

/** What the chat sent a pane that Claude Code may be holding, for the readers that ask whether it waits. */
export function heldCandidate(paneId: string): string | null {
  const entry = heldCandidates.get(paneId);
  if (!entry) return null;
  if (Date.now() - entry.at > HELD_WINDOW_MS) { heldCandidates.delete(paneId); return null; }
  return entry.text;
}

/**
 * Whether a model list of Claude Code's or Codex's holds the end of the screen, read or not. Enter
 * there saves a default, so nothing that ends in Enter is typed while one is open.
 */
export function modelListWaits(agent: string, screen: string): boolean {
  return registry.waits(agent, screen);
}
/** the last row of Claude's review of several answers, which ends it in place of a hint */
const CLAUDE_SUBMIT_TAIL_RE = /^(?:[›>❯]\s*)?\d+\.\s+Cancel$/i;

/** The rule below an OmO form or composer, then extension task status and the native footer. */
function omoFooterIsActive(lines: string[]): boolean {
  let rules = 0;
  let footer = 0;
  let widget = false;
  let tail = false;
  for (const line of lines) {
    if (!line) continue;
    if (OMO_SPINNER_ROW_RE.test(line) && !OMO_TASK_ROW_RE.test(line)) return false;
    if (SOLID_RULE_RE.test(line)) {
      if (rules > 0 || footer > 0) return false;
      rules = 1;
    } else if (rules > 0 && footer === 0 && (
      /^(?:[▶◌✗✓] .*\bcategory:|▶ .* \bwave \d+\/\d+\b)/.test(line)
      || (widget && /^(?:\d+[hms]\s*)+$/.test(line))
    )) {
      tail = false;
      // A duration may wrap off the task row. Only these status rows precede the native footer;
      // arbitrary output, a second rule, or another program's input still invalidates the form.
      widget = true;
    } else if (rules > 0 && footer === 0 && !OMO_NOT_FOOTER_RE.test(line) && (
      OMO_TASK_ROW_RE.test(line)
      || (tail && line.length <= OMO_TASK_WRAP_MAX && OMO_TASK_TAIL_RE.test(line))
    )) {
      // a task row, or the one short line it wrapped onto
      tail = OMO_TASK_ROW_RE.test(line);
    } else if (rules === 0 || ++footer > OMO_FOOTER_LINES || OMO_NOT_FOOTER_RE.test(line)) return false;
  }
  return rules === 1;
}

function promptTailIsActive(prompt: ParsedPrompt, screen: string): boolean {
  const cleanLines = screen.replace(ANSI_RE, "").split(/\r?\n/).map(cleanLine);
  const visible = cleanLines.filter((line) => line && !isDivider(line));
  // Claude's review has no hint of its own: its last row ends the panel, the session's rule and task list come after it
  const shown = prompt.responder === "claude-submit" ? withoutClaudeTasks(visible, (lines, end) => CLAUDE_SUBMIT_TAIL_RE.test(lines[end - 1] ?? ""))
    : prompt.responder.startsWith("claude-") ? withoutClaudeTasks(visible) : visible;
  const last = shown.at(-1) ?? "";
  // The menu is still at the bottom. A narrow pane wraps its hint, so the last line alone can
  // be the hint's tail (`cancel`): the lines before it count only when the match runs into
  // the last one, never for a hint that ended above later output (an answered, stale menu).
  const ends = (re: RegExp): boolean => [1, 2, 3].some((span) =>
    re.test(shown.slice(-span).join(" ")) && (span === 1 || !re.test(shown.slice(-span, -1).join(" "))));
  if (prompt.responder === "omp-question") return ends(OMP_SINGLE_HINT_RE) || ends(OMP_CLIPPED_SINGLE_HINT_RE) || ends(OMP_SINGLE_CLIPPED_HINT_RE) || ends(OMP_MULTI_HINT_RE);
  if (prompt.responder === "omp-submit") return ends(OMP_REVIEW_HINT_RE);
  // Hermes keeps its status line (and maybe the hint's wrapped tail) under the hint; an answered
  // question leaves the screen, so a hint among the last few lines is the live one
  if (prompt.responder === "hermes-question" || prompt.responder === "hermes-input") return shown.slice(-4).some((line) => HERMES_HINT_RE.test(line));
  if (prompt.responder === "codex-menu") return ends(CODEX_CONTINUE_HINT_RE);
  if (prompt.responder === "codex-question") return ends(CODEX_ASK_HINT_RE);
  if (prompt.responder === "codex-async-question") return cleanLines.slice(-4).some((line) => CODEX_ASYNC_ASK_HINT_RE.test(line)) || ends(CODEX_ASYNC_ASK_HINT_RE);
  if (prompt.responder === "claude-question") return ends(CLAUDE_ASK_HINT_RE);
  if (prompt.responder === "claude-submit") return CLAUDE_SUBMIT_TAIL_RE.test(last);
  // the last row carries the cursor once a move has put it there
  // Codex's folder trust prompt ends "enter continue · esc back" or, from 0.163, "· esc quit".
  // Only those two: its update prompt ends "· esc skip" and must not read as an approval.
  if (prompt.responder === "codex-approval") return ends(/press enter to confirm|esc to cancel|enter continue\s*·\s*esc (?:back|quit)$|^(?:[›>❯]\s*)?\d+\.\s+(?:No|Reject|Cancel|Deny)\b/i);
  if (prompt.responder === "omp-approval") return ends(/^(?:[›>❯•]\s*)?(?:Approve|Deny)$|esc.*cancel/i);
  // Claude Code 2.1.29x ends with "Esc to cancel", optionally followed by its stop-agents
  // chord. Anchor that suffix so arbitrary trailing text cannot keep an old approval live.
  if (prompt.responder === "claude-approval") return ends(/esc to cancel.*(?:tab|ctrl\+e)|ctrl\+e to explain|^esc to cancel(?:\s*·\s*ctrl\+x ctrl\+k twice to stop background agents)?$/i);
  if (prompt.responder === "claude-confirm") return ends(CLAUDE_CONFIRM_HINT_RE);
  // its parser already found the hint over the input box with only the footer under it
  if (prompt.responder === "claude-held") return true;
  // so has omp's handoff status: only omp's status bar and editor under it
  if (prompt.responder === "omp-handoff") return true;
  // the goal dialog ends the screen with its own dismiss hint
  if (prompt.responder === "claude-goal") return ends(/esc to dismiss$/i);
  if (prompt.responder === "claude-model") return claudeModelListWaits(screen);
  if (prompt.responder === "claude-effort") return ends(CLAUDE_EFFORT_HINT_RE);
  if (prompt.responder === "codex-model") return ends(/(?:^|\s)enter select\s*·\s*esc back$|(?:^|\s)enter (?:default|apply)\s*·\s*s session\s*·\s*esc back$/i);
  if (prompt.responder === "omo-question" || prompt.responder === "omo-review" || prompt.responder === "omo-typing") {
    // The form is live only with OmO's footer and extension status under its hint: blank lines, one
    // rule, status widgets, then the footer's few lines (cwd, context, model). Anything else is the form's text
    // in another program (printed in a shell, quoted in a transcript over an input box), where
    // an answer's keys would be typed into that program.
    const hint = { "omo-question": OMO_OPTIONS_HINT_RE, "omo-review": OMO_REVIEW_HINT_RE, "omo-typing": OMO_TYPING_HINT_RE }[prompt.responder];
    const at = findLastIndex(cleanLines, (line, index) => line !== "" && hint.test(wrapped(cleanLines, index, OMO_HINT_LINES)));
    if (at < 0) return false;
    let end = at;
    while (end < at + OMO_HINT_LINES && !OMO_HINT_END_RE.test(cleanLines.slice(at, end + 1).join(" ").trim())) end += 1;
    if (end >= at + OMO_HINT_LINES) return false;
    return omoFooterIsActive(cleanLines.slice(end + 1));
  }
  if (prompt.responder === "omo-pending") {
    // The widget is live over OmO's input box, other widgets maybe between them: the box (a rule,
    // the box's line, empty, a rule) and then OmO's extension status and native footer.
    const at = findLastIndex(cleanLines, (line, index) => line !== "" && OMO_PENDING_HINT_RE.test(wrapped(cleanLines, index)));
    const box = cleanLines.findIndex((line, index) => index > at && OMO_EMPTY_BOX_RE.test(line));
    if (at < 0 || box < 0 || box - at > 60 || !cleanLines[box - 1]!.startsWith("─")) return false;
    return omoFooterIsActive(cleanLines.slice(box + 1));
  }
  // pi keeps its footer under every dialog — the pane's folder, then its context meter — so the
  // hint sits near the end without being it. A dialog already answered leaves its hint far
  // above whatever came after, which is what keeps this window narrow.
  if (prompt.responder === "pi-model") return hintAtEnd(shown, PI_MODEL_HINT_AT_END_RE, PI_FOOTER_LINES);
  if (prompt.responder === "omo-model") return omoModelListWaits(screen);
  // its reader already found the picker ending the screen, which only an open picker does
  if (prompt.responder === "omp-model") return true;
  if (prompt.responder === "pi-question" || prompt.responder === "pi-confirm" || prompt.responder === "pi-input") {
    return hintAtEnd(shown, PI_MENU_HINT_AT_END_RE, PI_FOOTER_LINES, 4)
      || hintAtEnd(shown, PI_INPUT_HINT_AT_END_RE, PI_FOOTER_LINES, 4);
  }
  // Command Code's permission footer names its keys at the dialog's end and wraps on a narrow
  // pane: `↑/↓ navigate · enter select · ctrl+e explain · Run cmd --yolo to bypass all …`
  if (prompt.responder === "cmd-question") return cmdFooterEnds(shown);
  return ends(/ctrl\+g to edit|shift\+tab to approve with this feedback/i);
}
/**
 * The same two hints told from the end of the window. A phone leaves pi a pane barely wide enough
 * for its hint, which wraps it, and pi keeps its footer underneath: the wrapped hint then sits
 * further from the bottom than a three-line window reaches, while a wider pane still has it as the
 * last thing. Anchored, because the footer's own lines complete a join that merely starts with the
 * hint's words, which would keep an answered dialog offering to press keys into the pane.
 */
const PI_MENU_HINT_AT_END_RE = new RegExp(`${PI_MENU_HINT_RE.source}$`, "i");
const PI_INPUT_HINT_AT_END_RE = new RegExp(`${PI_INPUT_HINT_RE.source}$`, "i");
/** Command Code's permission footer: `↑/↓ navigate · enter select · ctrl+e explain · Run cmd --yolo …` */
const CMD_HINT_RE = /↑\/↓ navigate.*enter select/i;
const CMD_FOOTER_WORDS = new Set(["·", "ctrl+e", "explain", "run", "cmd", "--yolo", "to", "bypass", "all", "permissions", "(docs", "↗)", "↗", "(docs↗)"]);
/**
 * The footer ends the screen: after its key hint only the footer's own words may follow, wrapped or
 * not. A line typed below a quoted or stale dialog (`❯ my next message`) means it is no live one.
 */
function cmdFooterEnds(shown: string[]): boolean {
  const at = findLastIndex(shown, (line) => CMD_HINT_RE.test(line));
  if (at < 0 || shown.length - at > 3) return false;
  const rest = [shown[at]!.replace(/^.*?enter select/i, ""), ...shown.slice(at + 1)].join(" ");
  return rest.split(/\s+/).filter(Boolean).every((word) => CMD_FOOTER_WORDS.has(word.toLowerCase()));
}
/** The same hint told from the end, so lines that follow it cannot complete a match of their own. */
const PI_MODEL_HINT_AT_END_RE = new RegExp(`${PI_MODEL_HINT_RE.source}$`, "i");
/**
 * pi's own footer, under `/model` and under every dialog alike: the pane's folder, then its
 * context meter. A hint is allowed this many lines of it before the bottom of the screen.
 */
const PI_FOOTER_LINES = 2;

/**
 * Whether a hint is the last thing before an agent's footer, allowing for a phone's pane being
 * too narrow to hold it on one line: a TUI hard-wraps, so the hint arrives split over two or
 * three lines with nothing marking the break. Anchored to the end of the joined window, because
 * a hint's words also match a join that merely starts with them — the footer's own lines read as
 * a hint that way, which would keep an answered, buried list offering a switch into whatever the
 * pane shows by then.
 */
function hintAtEnd(shown: string[], atEnd: RegExp, footerLines: number, span = 3): boolean {
  for (let end = shown.length - 1; end >= Math.max(0, shown.length - 1 - footerLines); end -= 1) {
    for (let size = 1; size <= span; size += 1) {
      const from = end - size + 1;
      if (from < 0) break;
      if (atEnd.test(shown.slice(from, end + 1).join(" "))) return true;
    }
  }
  return false;
}

function parsePrompt(agent: string, screen: string, omoAsk: OmoAsk | null = null, omoTrusted = true, omoOpen: OmoAsk[] = [], sent: string | null = null, working = false): ParsedPrompt | null {
  const ctx = { agent, omoAsk, omoTrusted, omoOpen, sent, working };
  // a result reader reads only below a send's own echo (outcome.ts), never a card on the whole screen
  const candidates = registry.readersFor(agent).filter((reader) => reader.kind !== "result").map((reader) => reader.parse(screen, ctx));
  return candidates.find((candidate): candidate is ParsedPrompt => candidate !== null && promptTailIsActive(candidate, screen)) ?? null;
}

/**
 * Codex 0.156 holds the questions it asked with request_user_input_async in a queue above
 * its main prompt, collapsed to "? 2 questions / alt+↑ to answer", and herdr reports the
 * agent blocked meanwhile. Yet the main prompt has the input and takes a message (Codex
 * then drops the questions). True only for that collapsed queue with the main prompt (›)
 * right under it and no other prompt on screen: an open question (its "enter submit …
 * skip" hint) or an approval below the queue holds the input itself.
 */
export function codexQuestionsCollapsed(screen: string): boolean {
  return parsePrompt("codex", screen) === null && queuedQuestionCount(screen) > 0;
}

/** The card for Codex's collapsed queue on this screen, from the rollout's unanswered questions. */
export function codexQueuedPrompt(screen: string, unanswered: QueuedQuestion[], front: QueueFront | null = null): InteractivePrompt | null {
  const count = queuedQuestionCount(screen);
  const queued = count > 0 ? queuedPrompt(count, unanswered, front) : null;
  return queued ? publicPrompt(queued) : null;
}

/**
 * `omoAsk`: the call an omo pane's session waits on (pendingOmoAsk), for its form's own text.
 * `omoTrusted` false: an omo form on the screen counts only when that call matches it.
 * `omoOpen`: every question the session has open (openOmoAsks), for omo's widget of the ones
 * asked without waiting.
 */
/** `sent`: what the chat last sent to the pane, and `working`: whether its agent is under a turn, for a message Claude Code holds back (parseClaudeHeld) */
export function parseInteractivePrompt(agent: string, screen: string, omoAsk: OmoAsk | null = null, omoTrusted = true, omoOpen: OmoAsk[] = [], sent: string | null = null, working = false): InteractivePrompt | null {
  const parsed = parsePrompt(agent, screen, omoAsk, omoTrusted, omoOpen, sent, working);
  return parsed ? publicPrompt(parsed) : null;
}

class InvalidAnswer extends Error {}

export function answerKeys(prompt: InteractivePrompt, answer: Pick<PromptAnswer, "option_index" | "option_indices" | "custom_text">): AnswerStep[] {
  const parsed = parsedByPublicPrompt.get(prompt);
  if (!parsed) throw new InvalidAnswer("The prompt was not produced by parseInteractivePrompt.");
  const supplied = [answer.option_index !== undefined, answer.option_indices !== undefined, answer.custom_text !== undefined].filter(Boolean).length;
  if (supplied !== 1) throw new InvalidAnswer("Exactly one answer is required.");

  if (answer.custom_text !== undefined) {
    if (typeof answer.custom_text !== "string") throw new InvalidAnswer("Custom text must be a string.");
    const text = answer.custom_text.trim();
    if (!text || parsed.customMenuIndex === null || (parsed.multi_select && parsed.responder !== "claude-question")) throw new InvalidAnswer("This prompt does not accept a custom answer.");
    if (parsed.customSteps) return parsed.customSteps(text);
    // Claude's multiple choice: typing into the row ticks it, and Enter on Submit, the row under
    // it, sends the choice (→ in the row would move the text's cursor; measured on 2.1.301)
    if (parsed.multi_select) return [...keySteps(navigationKeys(parsed.customMenuIndex - parsed.selectedIndex)), { text }, ...keySteps([KEY.down, KEY.enter])];
    const navigation = navigationKeys(parsed.customMenuIndex - parsed.selectedIndex);
    // Codex's queue types into its last row once it is selected: no enter first. pi's text
    // dialog is the same but for a worse reason: its `>` line already owns the input, so an
    // enter typed before the answer submits the dialog empty and leaves the answer behind to
    // be typed into the agent's own prompt.
    if (!["claude-question", "claude-plan", "codex-question", "codex-async-question", "pi-input"].includes(parsed.responder)) navigation.push(KEY.enter);
    if (parsed.responder === "codex-question") navigation.push(KEY.tab);
    // what was typed into pi's line in the terminal would stay around the answer: the line is
    // emptied first, after the cursor and before it (pi's editor keys, measured on 0.87.1)
    if (parsed.responder === "pi-input") navigation.push("ctrl+k", "ctrl+u");
    return [
      ...keySteps(navigation),
      { text },
      ...(parsed.responder === "claude-plan" ? keySteps([KEY.backtab]) : keySteps([KEY.enter])),
    ];
  }

  if (answer.option_indices !== undefined) {
    if (!Array.isArray(answer.option_indices)) throw new InvalidAnswer("Option indices must be an array.");
    if (!parsed.multi_select || answer.option_indices.length === 0) throw new InvalidAnswer("This prompt requires one or more selections.");
    const choices = [...new Set(answer.option_indices)];
    if (choices.some((choice) => !Number.isInteger(choice) || choice < 0 || choice >= parsed.options.length)) {
      throw new InvalidAnswer("An option index is outside the displayed range.");
    }
    if (parsed.multiSteps) return parsed.multiSteps(choices);
    const desired = new Set(choices);
    const checked = new Set(parsed.checkedOptionIndices);
    const toggles = parsed.options.flatMap((_, index) => desired.has(index) !== checked.has(index) ? [index] : []);
    let cursor = parsed.selectedIndex;
    const keys: string[] = [];
    for (const optionIndex of toggles) {
      keys.push(...navigationKeys(optionIndex - cursor), parsed.responder === "omp-question" ? KEY.space : KEY.enter);
      cursor = optionIndex;
    }
    if (parsed.responder === "omp-question") keys.push(KEY.tab, KEY.enter);
    // → leaves the choice for the next question or the review of the answers, never an
    // enter: on the next question it would pick that question's first option
    else if (parsed.responder === "claude-question") keys.push(KEY.right);
    else throw new InvalidAnswer("This agent does not support multiple selections.");
    return keySteps(keys);
  }

  const index = answer.option_index;
  if (!Number.isInteger(index) || index! < 0 || index! >= parsed.options.length || index === parsed.custom_option_index || parsed.multi_select) {
    throw new InvalidAnswer("A valid option index is required.");
  }
  if (parsed.optionSteps) return parsed.optionSteps[index!]!;
  if (parsed.rejectWithEscapeIndex === index) return keySteps([KEY.escape]);
  return keySteps([...navigationKeys(index! - parsed.selectedIndex), KEY.enter]);
}

/**
 * The panes whose current wait on an unknown screen is logged: once per wait, not per screen,
 * so a screen that keeps changing (a clock, a spinner) cannot log on every poll.
 */
const fallbackLogged = new Set<string>();
/** panes whose wait is logged at most; past it a new wait goes unlogged rather than relogging one */
const FALLBACK_LOGGED_MAX = 256;

/**
 * The question each pane's queue opened on when that was not the card's (a skipped
 * question leaves the rollout's newest-first guess behind): the next card shows it.
 */
const queueFronts = new Map<string, QueueFront & { rollout: string }>();

/**
 * Which asking of its prompt each pane shows. A prompt's own id is a hash of what it says, so the
 * same question asked twice in a row would be one card: an answer tapped for the first asking (or
 * a typed pick left waiting for Confirm) would go to the second. The id a card carries therefore
 * names the asking too, and a
 * new asking starts on any evidence that the last one ended: a read that showed no prompt or
 * another one, an answer sent from here, the agent back at work. With none of these (answered in
 * a terminal and asked again between two reads, by an agent that reports no work in between)
 * two askings cannot be told apart from the screen.
 */
interface Asking { content: string | null; n: number; queued: boolean }
const askings = new Map<string, Asking>();
/** counted across panes and never reused: a pane forgotten here starts no asking over */
let askingCount = 0;
/** this run of the server: a card read before a restart is not one of this run's askings */
const SERVER_RUN = randomBytes(6).toString("hex");
/**
 * The panes an answer is on its way to. Its keys redraw the menu (a move, a row opened for typing,
 * pi's dialog with its cursor off the first row), so what another read finds meanwhile says
 * nothing about the asking: it neither ends it nor starts one. The answer reads the screen
 * itself before its first key that is not a move, and promptWaitEnded still ends the asking
 * under it.
 */
const answersUnderWay = new Set<string>();
/**
 * How many answers have begun or ended on each pane. A read takes its time: one that began
 * before or under an answer and comes back after it shows a screen of that answer's, not of now,
 * so a read during which this number moved changes nothing either.
 */
const answerTurns = new Map<string, number>();

/**
 * The prompt a read found, under the id of its asking; a read without one ends the pane's asking.
 * `turns`: the pane's answerTurns when the read began.
 */
function asked(paneId: string, prompt: InteractivePrompt | null, turns: number): InteractivePrompt | null {
  let asking = askings.get(paneId);
  if (!answersUnderWay.has(paneId) && (answerTurns.get(paneId) ?? 0) === turns) {
    if (prompt === null) {
      if (asking) asking.content = null;
      return null;
    }
    if (asking?.content !== prompt.id) {
      // kept until its pane closes (readPrompt): a live asking is never dropped to make room
      asking = { content: prompt.id, n: askingCount += 1, queued: prompt.queued !== undefined };
      askings.set(paneId, asking);
    }
  }
  if (prompt === null) return null;
  prompt.id = createHash("sha256").update(JSON.stringify([prompt.id, SERVER_RUN, asking?.n ?? 0])).digest("hex").slice(0, 12);
  return prompt;
}

/** The pane's prompt was answered: the same prompt on its screen after this is asked anew. */
function askingEnded(paneId: string): void {
  const asking = askings.get(paneId);
  if (asking) asking.content = null;
}

/**
 * The pane's agent is back at work: it has had its answer, maybe from a terminal, and the same
 * prompt on its screen after this is asked anew. Not so for a question in Codex's queue, which
 * Codex asks while it works and goes on working under: its status says nothing about the
 * question.
 */
export function promptWaitEnded(paneId: string): void {
  if (!askings.get(paneId)?.queued) askingEnded(paneId);
}

/** A prompt's id as its text alone makes it, whichever asking it is. */
function contentId(prompt: InteractivePrompt | null): string | undefined {
  return prompt ? parsedByPublicPrompt.get(prompt)?.id : undefined;
}

/** When each pane's omo form was last answered from the chat (see readPrompt). */
const formsAnswered = new Map<string, number>();
const FORM_SETTLE_MS = 3_000;

/** Owned by one server; reads cannot overwrite progress made after they started. */
export class OpenCodePromptState {
  readonly entries = new Map<string, OpenCodePromptEntry>();
  private snapshotIssued = 0;
  private snapshotApplied = 0;
  private latestSnapshot: SessionSnapshot | null = null;
  constructor(readonly now: () => number = Date.now) {}

  checkpoint(): Map<string, { entry: OpenCodePromptEntry; revision: number }> {
    return new Map([...this.entries].map(([id, entry]) => [id, { entry, revision: entry.revision }]));
  }

  async snapshot(timeoutMs?: number): Promise<SessionSnapshot> {
    const issued = ++this.snapshotIssued;
    const snapshot = await sessionSnapshot(undefined, timeoutMs);
    if (issued > this.snapshotApplied) {
      this.snapshotApplied = issued;
      this.latestSnapshot = snapshot;
    }
    if (!this.latestSnapshot || issued === this.snapshotApplied) return snapshot;
    // Only native OpenCode drafts need this ordering. Other agents' screen readers keep the
    // snapshot that accompanies their own read, including a newer status in a delayed reply.
    const nativeIds = new Set([...snapshot.panes, ...this.latestSnapshot.panes]
      .filter((pane) => pane.agent === "opencode").map((pane) => pane.pane_id));
    return { ...snapshot, panes: [
      ...snapshot.panes.filter((pane) => !nativeIds.has(pane.pane_id)),
      ...this.latestSnapshot.panes.filter((pane) => nativeIds.has(pane.pane_id)),
    ] };
  }

  prune(): void {
    for (const [id, entry] of this.entries) if (this.now() - entry.updatedAt >= 30 * 60_000) this.entries.delete(id);
  }

  reconcile(panes: readonly HerdrPane[], before = this.checkpoint()): void {
    this.prune();
    for (const [id, entry] of this.entries) {
      const observed = before.get(id);
      if (observed?.entry !== entry || observed.revision !== entry.revision) continue;
      const pane = panes.find((pane) => pane.pane_id === id);
      if (!pane || opencodeSessionId(pane) !== entry.sessionID || pane.agent !== "opencode") this.entries.delete(id);
    }
  }

  begin(paneId: string, sessionID: string): OpenCodePromptEntry {
    this.prune();
    let entry = this.entries.get(paneId);
    if (!entry || entry.sessionID !== sessionID) {
      entry = { sessionID, form: null, listed: null, available: false, revision: 0, issued: 0, applied: 0, updatedAt: this.now() };
      this.entries.delete(paneId);
      this.entries.set(paneId, entry);
      if (this.entries.size > 64) this.entries.delete(this.entries.keys().next().value!);
    }
    return entry;
  }

  forget(paneId: string): void { this.entries.delete(paneId); }
  clear(): void { this.entries.clear(); }
}

const defaultOpenCodeState = new OpenCodePromptState();

/** Each pane's rollout, resolved for its collapsed queue: a poll every 2s would otherwise redo it. */
const queueRollouts = new Map<string, { path: string | null; at: number }>();
const QUEUE_ROLLOUT_MS = 15_000;

/** how long a prompt poll waits for the ANSI read behind Claude's suggestion before going without it */
const SUGGESTION_READ_MS = 1_500;

/** Claude's new-session tip in the empty input (`Try "how does <filepath> work?"`), not a suggestion. */
const CLAUDE_TIP_RE = /^Try "/;

/**
 * Claude Code's IDE pill, drawn right after the `❯` while an editor is connected: `[⧉ 3 lines
 * selected] ` or `[⧉ In src/foo.ts] ` (Claude Code 2.1.302 matches it as `\[⧉ [^\]\n]+\]`). It is
 * painted in the theme's IDE color, not dim, yet it is no input: typing and Ctrl+K/Ctrl+U leave it.
 */
const CLAUDE_IDE_PILL_RE = /^[ \u00a0]?\[⧉ [^\]\n]+\] ?/;

/** The text after the `❯` of an input row with Claude's IDE pill (CLAUDE_IDE_PILL_RE) taken out. */
const withoutIdePill = (afterPrompt: string): string => afterPrompt.replace(CLAUDE_IDE_PILL_RE, " ");

/**
 * How many characters after the `❯` of a plain input row Claude's IDE pill takes, with the space
 * before it: what a walk over that row skips. 0 without a pill.
 */
function idePillChars(afterPrompt: string): number {
  const match = CLAUDE_IDE_PILL_RE.exec(afterPrompt);
  return match === null ? 0 : Array.from(match[0]).length;
}

/**
 * Whether each character of an ANSI line is drawn dim (SGR 2) and inverse (SGR 7), as
 * [text, dim, inverse] runs. Only SGR sequences change the state; 38/48 colors are skipped whole,
 * so the 2 of `38;2;r;g;b` is a color mode, not dim. Other escapes are dropped.
 */
function sgrRuns(line: string): [string, boolean, boolean][] {
  const runs: [string, boolean, boolean][] = [];
  let dim = false;
  let inverse = false;
  let offset = 0;
  const escape = /\u001b(?:\[([0-?]*)[ -/]*([@-~])|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;
  for (const match of line.matchAll(escape)) {
    if (match.index! > offset) runs.push([line.slice(offset, match.index), dim, inverse]);
    offset = match.index! + match[0].length;
    if (match[2] !== "m") continue;
    const codes = (match[1] || "0").split(";").map((code) => Number(code || 0));
    for (let index = 0; index < codes.length; index++) {
      const code = codes[index]!;
      if (code === 38 || code === 48 || code === 58) index += codes[index + 1] === 5 ? 2 : codes[index + 1] === 2 ? 4 : 0;
      else if (code === 0) { dim = false; inverse = false; }
      else if (code === 22) dim = false;
      else if (code === 2) dim = true;
      else if (code === 27) inverse = false;
      else if (code === 7) inverse = true;
    }
  }
  if (offset < line.length) runs.push([line.slice(offset), dim, inverse]);
  return runs;
}

/** A bottom Codex composer with no draft. Placeholder words need verified dim colors. */
export function codexQueueInputEmpty(screen: string, colors: string | null = null): boolean {
  const rows = screen.split(/\r?\n/).filter((line) => line.trim()).map((line) => ({ text: line.trim(), indent: line.length - line.trimStart().length }));
  const lines = rows.map((row) => row.text);
  const indent = Math.min(...rows.filter((row) => row.text.startsWith("›")).map((row) => row.indent));
  const composer = rows.map((row) => row.indent === indent && row.text.startsWith("›")).lastIndexOf(true);
  if (composer < 0 || codexQuestionsCollapsed(screen)) return false;
  const footer = lines.slice(composer + 1);
  if (footer.length === 0 || footer.length > 4 || footer.some((line) =>
    !/^(?:\S+\s+(?:default|minimal|none|low|medium|high|xhigh|max|ultra)\s*·|\d+% context left\b|⚠\s*\d+\s*warnings?\b|(?:←[^·]*·\s*)?\?\s*for shortcuts\b)/i.test(line))) return false;
  if (!lines.slice(0, composer).some((line) => /^[•◦].*\((?:\d+[hms]\s*)+•\s*esc to interrupt\)$/.test(line))) return false;
  if (lines[composer] === "›") return true;
  if (!/^›\s+Ask Codex to do (?:anything|something)$/.test(lines[composer]!) || colors === null) return false;
  const colored = colors.split(/\r?\n/).reverse().find((line) => {
    const plain = line.replace(ANSI_RE, "");
    return plain.length - plain.trimStart().length === indent && plain.trim().startsWith("›");
  });
  if (!colored || colored.replace(ANSI_RE, "").trim() !== lines[composer]) return false;
  let marker = true;
  return sgrRuns(colored).every(([text, dim, inverse]) => [...text].every((char) => {
    if (marker) { if (char === "›") marker = false; return true; }
    return /\s/.test(char) || dim || inverse;
  }));
}

/**
 * The prompt Claude Code suggests next, grey in its empty input box: the `❯` line between the
 * screen's last two rules (the live input box, not an earlier one above a bash-mode input), all
 * of it dim but for Claude's own drawn cursor on its first character. None while anything is
 * typed there (typed text is not dim), for the new-session tip, or for an input box of more than
 * one line.
 */
export function parseClaudeSuggestion(ansi: string): string | null {
  const grey = claudeGreyInput(ansi);
  return grey === null || CLAUDE_TIP_RE.test(grey) ? null : grey;
}

/**
 * What Claude Code's input box shows in grey while it is empty (a suggested prompt, or the
 * new-session tip), null when the box holds typed text or nothing. Only an ANSI read tells grey
 * text from a message: as plain text both are `❯ words`.
 */
function claudeGreyInput(ansi: string): string | null {
  const lines = ansi.split("\n").map((line) => line.replace(/\r$/, ""));
  const plain = lines.map((line) => line.replace(ANSI_RE, "").replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, ""));
  let index = plain.length - 1;
  while (index >= 0 && !SOLID_RULE_RE.test(plain[index]!.trim())) index--;
  index--;
  if (index < 1 || !/^❯[\s\u00a0]/.test(plain[index]!) || !SOLID_RULE_RE.test(plain[index - 1]!.trim())) return null;
  let text = "";
  let seenPrompt = false;
  let cursor = false;
  // Claude's IDE pill before the grey text is neither typed nor suggested
  let pill = idePillChars(plain[index]!.slice(plain[index]!.indexOf("❯") + 1));
  for (const [run, dim, inverse] of sgrRuns(lines[index]!)) {
    for (const character of run) {
      if (!seenPrompt) { if (character === "❯") seenPrompt = true; continue; }
      if (pill > 0) { pill--; continue; }
      const blank = character.trim() === "" || character === "\u00a0";
      // the cursor Claude draws itself sits inverse on the first grey character
      if (!dim && !blank && !(inverse && text.trim() === "" && !cursor)) return null;
      if (!dim && !blank) cursor = true;
      text += character;
    }
  }
  // a cursor over typed text has nothing grey after it
  if (cursor && !sgrRuns(lines[index]!).some(([run, dim]) => dim && run.trim() !== "")) return null;
  const suggestion = text.replace(/\u00a0/g, " ").trim();
  return suggestion === "" ? null : suggestion;
}

/**
 * A labeled rule over an input box: Claude's named session (`──── my-session ─`), and OmO's own
 * box while it works (`── • Running eval (7s • esc to interrupt) ───`), which herdr reports as
 * Claude. Only the box reader takes the shorter lead; the task panel keeps LABELED_RULE_RE.
 */
const BOX_LABELED_RULE_RE = /^─{2,}\s.*─$/;

/**
 * Claude Code's input box: the rows between the screen's last two rules (a named session labels
 * its rule). "clipped" when only the bottom rule is on screen, as under a draft taller than the
 * pane; null when the screen has no rule at all.
 */
function claudeInputBox(screen: string): { plain: string[]; raw: string[] } | "clipped" | null {
  const raw = screen.split("\n").map((line) => line.replace(/\r$/, ""));
  const plain = raw.map((line) => line.replace(ANSI_RE, "").replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "").trimEnd());
  const rule = (line: string): boolean => SOLID_RULE_RE.test(line.trim()) || BOX_LABELED_RULE_RE.test(line.trim());
  let end = plain.length - 1;
  while (end >= 0 && !rule(plain[end]!)) end--;
  if (end < 0) return null;
  let start = end - 1;
  while (start >= 0 && !rule(plain[start]!)) start--;
  if (start < 0) return "clipped";
  return { plain: plain.slice(start + 1, end), raw: raw.slice(start + 1, end) };
}

/** Claude's new-session tip as a whole input row: `Try "how does <filepath> work?"`. */
const CLAUDE_TIP_ROW_RE = /^Try "[^"]+"$/;

/** Whether an ANSI read sets no color and no dim anywhere, as Claude Code draws under NO_COLOR. */
function colorless(ansi: string): boolean {
  for (const match of ansi.matchAll(/\u001b\[([0-9;:]*)m/g)) {
    for (const code of (match[1] || "0").split(/[;:]/).map((value) => Number(value || 0))) {
      if (code === 2 || (code >= 30 && code <= 38) || (code >= 40 && code <= 48) || (code >= 90 && code <= 97) || (code >= 100 && code <= 107)) return false;
    }
  }
  return true;
}

/** A screen row without its escapes, OSC sequences (titles, links) included. */
const plainRow = (row: string): string => row.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "").replace(ANSI_RE, "");

/** The screen's bottom-most row with a `❯`: Hermes' input, below every message it echoes. */
function hermesInputRow(screen: string): string | null {
  const rows = screen.split(/\r?\n/);
  for (let index = rows.length - 1; index >= 0; index--) if (plainRow(rows[index]!).includes("❯")) return rows[index]!;
  return null;
}

/**
 * Whether Hermes' input is not known to be empty, so that a paste would join what is there and the
 * Enter send both as one message (measured on Hermes 0.21.5, classic CLI and TUI). The input is the
 * bottom-most `❯` row, empty when nothing follows the `❯`. Hermes' own hint there is not a draft:
 * the classic CLI draws its placeholder italic (its skin's `placeholder: "{dim} italic"`), and the TUI
 * starts its hint with a synthetic cursor, a cell with a background color (ui-tui textInput.tsx
 * `hintCursorCell`); typed text has neither. `live` is the detection read; `colors` the viewport's
 * ANSI read, passed only once it is verified to show that screen (viewportShowsLive), else null, and
 * then any text after the `❯` counts as a draft. A screen without a `❯` row is not known to be empty.
 */
export function hermesInputDraft(live: string, colors: string | null): boolean {
  const row = hermesInputRow(live);
  if (row === null) return true;
  const plain = plainRow(row);
  // the row's first `❯` is the prompt: one after it is typed text
  if (plain.slice(plain.indexOf("❯") + 1).replace(/\u00a0/g, " ").trim() === "") return false;
  const shown = colors === null ? null : hermesInputRow(colors);
  if (shown === null || plainRow(shown).trimEnd() !== plain.trimEnd()) return true;
  const after = plainRow(shown).indexOf("❯");
  let column = 0;
  let italic = false;
  let background = false;
  // the first character after the `❯` decides: a TUI hint's cursor chip, or typed (not italic) text
  let decided: boolean | null = null;
  const visit = (text: string): void => {
    for (const character of text) {
      const at = column;
      column += character.length;
      if (decided !== null) return;
      if (at <= after || character.trim() === "" || character === "\u00a0") continue;
      if (background) { decided = false; return; }
      if (!italic) { decided = true; return; }
    }
  };
  const escape = /\u001b(?:\[([0-?]*)[ -/]*([@-~])|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;
  let offset = 0;
  for (const match of shown.matchAll(escape)) {
    visit(shown.slice(offset, match.index));
    offset = match.index! + match[0].length;
    if (match[2] !== "m") continue;
    const codes = (match[1] || "0").split(";").map((code) => Number(code || 0));
    for (let index = 0; index < codes.length; index++) {
      const code = codes[index]!;
      if (code === 38 || code === 58) index += codes[index + 1] === 5 ? 2 : codes[index + 1] === 2 ? 4 : 0;
      else if (code === 48) { background = true; index += codes[index + 1] === 5 ? 2 : codes[index + 1] === 2 ? 4 : 0; }
      else if (code === 0) { italic = false; background = false; }
      else if (code === 3) italic = true;
      else if (code === 23) italic = false;
      else if (code === 49) background = false;
      else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) background = true;
    }
  }
  visit(shown.slice(offset));
  // every character italic: the classic CLI's placeholder
  return decided ?? false;
}

/**
 * Whether Claude Code's input box is not known to be empty, so that a paste would land in what is
 * there and the Enter after it send both, or run it as a command: typed text, bash mode (`!`), a
 * box clipped by the pane, or a box that is not a `❯` input. Claude's own grey text (a suggested
 * prompt, its tip, on any number of rows) and its drawn cursor are not a draft. The box is read
 * from the live screen (`live`, a detection read, as the other pending checks); only the viewport
 * read carries colors (`colors`), and the caller passes it only once it is verified to show that
 * live screen (null otherwise): equal words do not prove it, since an older box in a scrolled
 * viewport, or a grey suggestion the user then typed out, reads the same. Without verified colors a
 * box that is not empty is a draft. False when the screen shows no rule at all.
 */
export function claudeInputDraft(live: string, colors: string | null): boolean {
  const box = claudeInputBox(live);
  if (box === null) return false;
  if (box === "clipped" || !box.plain[0]?.startsWith("❯")) return true;
  // Claude's IDE pill after the `❯` is no input (#1096): a box holding only it is empty
  const afterPill = withoutIdePill(box.plain[0]!.slice(1));
  if ([afterPill, ...box.plain.slice(1)].join("\n").replace(/\u00a0/g, " ").trim() === "") return false;
  // a paste or an image Claude folded into a placeholder is content, however it is colored
  if (/\[(?:Pasted text #\d+|Image #\d+)/.test(box.plain.join(" "))) return true;
  if (colors === null) return true;
  const shown = claudeInputBox(colors);
  if (shown === null || shown === "clipped" || shown.plain.join("\n") !== box.plain.join("\n")) return true;
  // Under NO_COLOR (#926) the tip is not dim: only its exact form as the box's whole one row, on a
  // screen drawn without any color, tells it from typed words. Typed `Try "…"` reads the same there.
  if (box.plain.length === 1 && CLAUDE_TIP_ROW_RE.test(afterPill.replace(/\u00a0/g, " ").trim()) && colorless(colors)) return false;
  let prompt = false;
  let pill = idePillChars(box.plain[0]!.slice(1));
  let first = true;
  let cursor = false;
  let grey = false;
  for (const row of shown.raw) {
    for (const [run, dim, inverse] of sgrRuns(row)) {
      for (const character of run) {
        if (!prompt) { prompt = character === "❯"; continue; }
        if (pill > 0) { pill--; continue; }
        if (character.trim() === "" || character === "\u00a0") continue;
        if (dim) grey = true;
        // the cursor Claude draws itself sits inverse on the first grey character
        else if (first && inverse) cursor = true;
        else return true;
        first = false;
      }
    }
  }
  // a cursor over a typed character has nothing grey after it
  return cursor && !grey;
}

/** Positive proof of an ordinary empty input box, never absence of a readable box. */
export function claudeInputEmpty(live: string, colors: string | null): boolean {
  const box = claudeInputBox(live);
  return box !== null && box !== "clipped" && box.plain[0]?.startsWith("❯") === true
    && !claudeInputDraft(live, colors);
}

/** What empties a one-row Claude input box: the row after the cursor, then before it (measured on 2.1.295; Ctrl+Y puts it back). */
export const CLAUDE_CLEAR_INPUT_KEYS = ["ctrl+k", "ctrl+u"];

/**
 * The draft the chat may offer to clear before it sends (claudeInputDraft with the same reads):
 * typed text on the only row of a `❯` box, read with verified colors, as the user sees it there.
 * CLAUDE_CLEAR_INPUT_KEYS edit one screen row, so a draft on more rows (a long line wraps), bash
 * mode, a pasted or image placeholder and a box read without colors are not offered: null.
 */
export function claudeClearableDraft(live: string, colors: string | null): string | null {
  if (colors === null || !claudeInputDraft(live, colors)) return null;
  const box = claudeInputBox(live);
  if (box === null || box === "clipped" || box.plain.length !== 1 || !box.plain[0]!.startsWith("❯")) return null;
  if (/\[(?:Pasted text #\d+|Image #\d+)/.test(box.plain[0]!)) return null;
  // plain rows trim their right edge for screen parsing. Match the raw row instead: a
  // trailing space, or another space after Claude's one separator, belongs to the user.
  const rowText = (row: string): string => row.replace(ANSI_RE, "").replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "");
  const row = rowText(box.raw[0]!);
  const shown = claudeInputBox(colors);
  if (shown === null || shown === "clipped" || shown.raw.length !== 1 || rowText(shown.raw[0]!) !== row) return null;
  // Claude's IDE pill is not the user's text, and the clearing keys leave it
  const afterPrompt = row.slice(1);
  const pill = CLAUDE_IDE_PILL_RE.exec(afterPrompt)?.[0];
  const draft = pill === undefined ? afterPrompt.replace(/^[ \u00a0]/, "") : afterPrompt.slice(pill.length);
  return draft.trim() === "" ? null : draft;
}

/** How much of the box an input_draft refusal shows: enough to tell a draft from Claude's own text. */
export const INPUT_BOX_SHOWN_CHARS = 200;

/**
 * The live input box (claudeInputBox) as plain text, whole: what a refusal that names no clearable
 * draft records, so a send anyway goes only over exactly that box. null when no box could be read
 * whole (none on screen, or clipped by the pane): such a box cannot be compared, so nothing is sent over it.
 */
export function claudeInputBoxContent(live: string): string | null {
  const box = claudeInputBox(live);
  if (box === null || box === "clipped") return null;
  return box.plain.map((row) => row.replace(/\u00a0/g, " ").trimEnd()).join("\n").trim();
}

/** What the user is shown of a box's content: enough to tell a real draft from a box misread. */
export function shownInputBox(content: string): string {
  return content.length > INPUT_BOX_SHOWN_CHARS ? `${content.slice(0, INPUT_BOX_SHOWN_CHARS)}…` : content;
}

/** The live input box as a refusal shows it (claudeInputBoxContent, cut by shownInputBox). */
export function claudeInputBoxText(live: string): string {
  return shownInputBox(claudeInputBoxContent(live) ?? "");
}

/**
 * The chat's own message back in Claude's box (claudeRestoredDraft), only when the live screen holds
 * it: a pane scrolled into its history can show an older box with the same words. The viewport read
 * the route already made is checked first, so a box without the copy costs no further read; then
 * the live screen's box is read as the send paths read it, with the viewport's colors only where
 * viewportShowsLive verifies they show that screen.
 */
async function restoredOnLiveScreen(paneId: string, viewport: string): Promise<string | null> {
  const sent = lastChatSubmitted(paneId);
  const plain = (text: string): string => text.replace(ANSI_RE, "").replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "");
  if (claudeRestoredDraft(plain(viewport), viewport, sent) === null) return null;
  const detection = async (): Promise<string> => (await paneRead({ paneId, source: "detection", format: "text", timeoutMs: SUGGESTION_READ_MS })).text;
  const before = await detection();
  if (!claudeInputDraft(before, null)) return null;
  const scrollBefore = await paneScrollInfo(paneId);
  const colors = (await paneRead({ paneId, source: "visible", format: "ansi", timeoutMs: SUGGESTION_READ_MS })).text;
  const scrollAfter = await paneScrollInfo(paneId);
  const live = await detection();
  return viewportShowsLive(scrollBefore, scrollAfter, colors, before, live) ? claudeRestoredDraft(live, colors, sent) : null;
}

/**
 * The chat's own last message back in Claude Code's input box as typed text, where Claude puts it
 * when the send right before is cancelled: `sent` when the box is a draft (`claudeInputDraft`, so
 * typed text on a verified viewport) holding exactly it — the `❯` of the first row dropped, the
 * wrapped rows joined with nothing (a split word) or one space (a wrap between words), each row's
 * own spaces as they are (U+00A0 read as a space). Anything else a
 * draft could be — bash mode, a clipped box, a `[Pasted text #`/`[Image #` placeholder, other or
 * edited words — and a box that is no known draft, unverified colors or nothing sent answer null.
 */
export function claudeRestoredDraft(live: string, colors: string | null, sent: string | null): string | null {
  if (sent === null || sent.trim() === "" || colors === null || !claudeInputDraft(live, colors)) return null;
  const box = claudeInputBox(live);
  if (box === null || box === "clipped" || !box.plain[0]?.startsWith("❯")) return null;
  if (/\[(?:Pasted text #\d+|Image #\d+)/.test(box.plain.join(" "))) return null;
  // each row's own words exactly (the box's U+00A0 as a space), its marker, indentation and padding
  // aside; where the terminal wrapped, a word split in two joins with nothing between, and a wrap
  // between words with one space or line break. Any other change to the spaces is the user's edit.
  const rows = box.plain.map((row, index) => (index === 0 ? withoutIdePill(row.slice(1)) : row).replace(/\u00a0/g, " ").trim());
  // walked row by row over the set of places the sent text can be at, never a regex: one built from
  // the rows backtracks exponentially over a box of blank rows
  const text = sent.replace(/\u00a0/g, " ").trim();
  let at = new Set([0]);
  rows.forEach((row, index) => {
    const next = new Set<number>();
    for (const from of at) {
      // a wrap between words leaves one space or line break before the next row; within a word, none
      const starts = index === 0 ? [from] : /\s/.test(text[from] ?? "") ? [from, from + 1] : [from];
      for (const start of starts) if (text.startsWith(row, start)) next.add(start + row.length);
    }
    at = next;
  });
  return at.has(text.length) ? sent : null;
}

/**
 * Whether a colored viewport read shows the live screen, so claudeInputDraft may take its colors:
 * the viewport at the bottom of the pane's history before and after the colored read, or, only when
 * herdr reports no scroll for either read, the viewport's whole text equal to the live screen; and
 * the live screen the same before and after it. A scroll known for one read and not the other is
 * no proof.
 */
export function viewportShowsLive(scrollBefore: { offset_from_bottom: number } | null, scrollAfter: { offset_from_bottom: number } | null,
  colors: string, before: string, live: string): boolean {
  const lines = (text: string): string => text.replace(ANSI_RE, "").replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .split(/\r?\n/).map((line) => line.trimEnd()).join("\n").trimEnd();
  const atBottom = scrollBefore !== null && scrollAfter !== null
    ? scrollBefore.offset_from_bottom === 0 && scrollAfter.offset_from_bottom === 0
    : scrollBefore === null && scrollAfter === null && lines(colors) === lines(live);
  return atBottom && live === before;
}

/** Whether a card is the one for a message Claude Code holds back (parseClaudeHeld). */
export function isClaudeHeld(prompt: InteractivePrompt): boolean {
  return parsedByPublicPrompt.get(prompt)?.responder === "claude-held";
}

/**
 * Whether a held-message card was read off Claude's own grey text. Claude's hint outlasts the
 * message for a moment (sent or cleared in the terminal), over a box that is empty again and shows
 * its tip or a suggested prompt: Enter there sends Claude's suggestion and Ctrl+C asks to leave
 * Claude. A read that fails or shows no box says nothing, and the card stays.
 * herdr gives colors for the viewport alone (an ANSI read of "detection", the live screen the card
 * is read from, carries no escapes: measured on 0.9.3), and a viewport scrolled into the history
 * can show an older box. So the grey text counts only when it is the very text the card took for
 * the message.
 */
export async function claudeHeldIsGrey(paneId: string, prompt: InteractivePrompt): Promise<boolean> {
  if (!isClaudeHeld(prompt)) return false;
  const same = (text: string | null): boolean => text !== null && normalizeText(text) === normalizeText(prompt.body ?? "");
  return paneRead({ paneId, source: "visible", format: "ansi", timeoutMs: SUGGESTION_READ_MS })
    .then((read) => same(claudeGreyInput(read.text)), () => false);
}

async function readPrompt(paneId: string, codexHome?: string, openCodeStateDir?: string, openCodeState = defaultOpenCodeState, signal?: AbortSignal): Promise<{ agent: string; status: string; prompt: InteractivePrompt | null; pane: HerdrPane; panes: HerdrPane[]; screen?: string; stale?: boolean }> {
  const before = openCodeState.checkpoint();
  const { panes } = await openCodeState.snapshot();
  // a closed pane's wait has ended too
  for (const logged of fallbackLogged) if (!panes.some((candidate) => candidate.pane_id === logged)) fallbackLogged.delete(logged);
  for (const known of askings.keys()) if (!panes.some((candidate) => candidate.pane_id === known)) askings.delete(known);
  for (const known of answerTurns.keys()) if (!panes.some((candidate) => candidate.pane_id === known)) answerTurns.delete(known);
  for (const known of heldCandidates.keys()) if (!panes.some((candidate) => candidate.pane_id === known)) heldCandidates.delete(known);
  for (const known of chatSent.keys()) if (!panes.some((candidate) => candidate.pane_id === known)) chatSent.delete(known);
  openCodeState.reconcile(panes, before);
  const pane = panes.find((candidate) => candidate.pane_id === paneId);
  if (!pane) throw new HerdrError("pane_not_found", `pane ${paneId} not found`);
  const agent = pane.agent ?? "";
  const status = pane.agent_status;
  // counted right before the screen is read, after the snapshot: what matters is whether an
  // answer ran while the screen was being read
  const turns = answerTurns.get(paneId) ?? 0;
  const known = await readKnownPrompt(paneId, pane, agent, codexHome, panes, openCodeStateDir, openCodeState, signal);
  if (known.stale) return { agent, status, prompt: null, pane, panes, stale: true };
  // an omo form just answered has closed, while herdr still reports the wait for a moment: that
  // is no screen to answer, and its fallback card would flash up after the form's last answer
  const settling = Date.now() - (formsAnswered.get(paneId) ?? 0) < FORM_SETTLE_MS;
  if (known.prompt !== null || status !== "blocked" || !agent || settling) {
    fallbackLogged.delete(paneId);
    return { agent, status, prompt: asked(paneId, known.prompt, turns), pane, panes, screen: known.screen };
  }
  // herdr says the agent waits on the user and no reader knows the screen: the fallback card
  const screen = known.screen ?? await liveScreen(paneId);
  // Codex's collapsed question queue reads blocked while its main prompt takes a message; a
  // model list of Claude Code's or Codex's that no reader could read is left to the terminal
  // (claudeModelListWaits, codexModelListWaits)
  if ((agent === "codex" && (codexQuestionsCollapsed(screen) || codexModelListWaits(screen))) || claudeModelListWaits(screen) || claudeModelListWaits(screen, CLAUDE_EFFORT_GUARD_RE)) {
    fallbackLogged.delete(paneId);
    return { agent, status, prompt: asked(paneId, null, turns), pane, panes, screen };
  }
  const prompt = asked(paneId, parseFallbackPrompt(agent, screen), turns)!;
  if (!fallbackLogged.has(paneId) && fallbackLogged.size < FALLBACK_LOGGED_MAX) {
    fallbackLogged.add(paneId);
    console.warn(`prompt: ${agent} pane ${paneId} is blocked on a screen no reader knows; fallback card (${prompt.options.length} options)`);
  }
  return { agent, status, prompt, pane, panes, screen };
}

/** Only the live loader near the input, never a quoted mention in older output. */
// The tail is 24 lines: codex parks its todo block, input box and status rows between the
// loader and the bottom, and a 12-line slice cut the loader off (2026-10-13 report).
export function paneIsCompacting(screen: string): boolean {
  return screen.split("\n").slice(-24).some((line) => /^\s*[─━]*\s*[\u2800-\u28ff◐◓◑◒]?\s*(?:Auto[- ]compacting|Compacting(?: context| before next prompt)?|Context overflow detected, compacting)(?:\.{3}|…)(?:\s*\((?:esc|escape|ctrl\+c)(?: to cancel\)[^\n]*|[^)\n]*(?:…|\.{3})))?\s*[─━]*\s*$/i.test(line));
}

/**
 * The pane's live screen as text: herdr's bottom buffer, whatever part of the history the pane's
 * viewport shows. A pane scrolled up (a drag or the wheel in a terminal) stays scrolled while the
 * agent draws its next menu at the bottom, out of that viewport.
 */
async function liveScreen(paneId: string): Promise<string> {
  // an explicit window: the default detection view can end below the loader line (codex's todo
  // block and status rows), which paneIsCompacting's tail scan must still see
  return (await paneRead({ paneId, source: "detection", format: "text", lines: 40 })).text;
}

/** omo's form or widget hint: a narrow pane wraps it, including between "just" and "type". */
const OMO_FORM_RE = /\b1-9\s+select\b|enter\s+save\s+and\s+next|\btab\s+next\s+question\b|\bor\s+just\s+type\s+your\s+reply\b/;
const omoAskReader = new OmoAskReader();

/** Resolve the live process tree every time: a cached session can outlive its agent. */
async function omoAsksFor(paneId: string, cwd: string, panes: HerdrPane[]): Promise<OmoAsk[]> {
  const path = await omoTranscriptForPane(paneId, cwd, panes).catch(() => null);
  if (!path) return [];
  try { return omoAskReader.read(path).flatMap((call) => omoAskOf({ ...call, id: `${path}\0${call.id}` }) ?? []).reverse(); }
  catch { return []; }
}

async function readKnownPrompt(
  paneId: string,
  pane: { cwd?: string | null; agent_status?: string; agent_session?: HerdrPane["agent_session"] },
  agent: string,
  codexHome?: string,
  panes: HerdrPane[] = [],
  openCodeStateDir?: string,
  openCodeState = defaultOpenCodeState,
  signal?: AbortSignal,
): Promise<{ prompt: InteractivePrompt | null; screen?: string; stale?: boolean }> {
  if (agent === "opencode") {
    const sessionID = opencodeSessionId(pane);
    if (!sessionID) return { prompt: null };
    const state = openCodeState.begin(paneId, sessionID);
    const config = readOpenCodeService(openCodeStateDir);
    const revision = state.revision;
    const issued = ++state.issued;
    const forms = config ? await listPendingQuestionForms(config, sessionID, signal) : null;
    if (signal?.aborted || openCodeState.entries.get(paneId) !== state) return { prompt: null, stale: true };
    if (state.revision === revision && issued >= state.applied) {
      state.applied = issued;
      state.available = forms !== null;
      // Failure is not evidence of settlement. Keep the last native card and its identity.
      if (forms !== null) {
        state.listed = forms[0] ?? null;
        if (state.listed === null && state.form !== null) {
          state.draft = undefined;
          state.form = null;
          state.revision++;
        }
      }
    }
    // A late read renders the newer applied form and draft, never a synthetic empty card.
    const form = state.listed;
    if (!form) return { prompt: null };
    if (form.fields.length === 0) return { prompt: null };

    // Schema changes under a reused form id are a replacement too.
    const identity = JSON.stringify({
      id: form.id, title: form.title,
      fields: form.fields.map(({ key, type, title, description, required, custom, options }) => ({
        key, type, title, description, required, custom,
        options: options?.map(({ value, label, description }) => ({ value, label, description })),
      })),
    });
    if (state.form !== identity) {
      state.draft = undefined;
      state.form = identity;
      state.revision++;
      state.updatedAt = openCodeState.now();
    }
    const draft = state.draft;
    let stepIndex = 0;
    if (draft && draft.formId === form.id) {
      stepIndex = Math.min(draft.stepIndex, form.fields.length - 1);
    }

    const field = form.fields[stepIndex]!;
    const multiSelect = field.type === "multiselect";
    const rawOptions = field.options ?? [];
    const customAllowed = field.custom === true || rawOptions.length === 0;

    let options: InteractivePromptOption[];
    let customOptionIndex: number | null = null;

    if (rawOptions.length === 0) {
      options = [{ label: "Type your answer", description: null }];
      customOptionIndex = 0;
    } else {
      options = rawOptions.map((opt) => ({
        label: opt.label || opt.value,
        description: opt.description ?? null,
      }));
      if (customAllowed) {
        options.push({ label: "Type your own answer", description: null });
        customOptionIndex = options.length - 1;
      }
    }

    const title = field.title && field.title !== field.description ? field.title : (form.title || "Question");
    const question = field.description || field.title || form.title || "";
    const steps = form.fields.length > 1
      ? form.fields.map((f, i) => ({
          label: f.title || `Question ${i + 1}`,
          answered: i < stepIndex,
          current: i === stepIndex,
        }))
      : undefined;

    let defaultOptionIndex: number | null = null;
    let defaultOptionIndices: number[] | undefined;
    let defaultCustomText: string | undefined;

    const savedAnswer = draft?.answers[field.key];
    if (savedAnswer !== undefined) {
      if (Array.isArray(savedAnswer)) {
        defaultOptionIndices = savedAnswer
          .map((val) => rawOptions.findIndex((opt) => opt.value === val))
          .filter((idx) => idx >= 0);
        if (customAllowed) defaultCustomText = savedAnswer.filter((value) => !rawOptions.some((option) => option.value === value)).join("\n") || undefined;
      } else if (typeof savedAnswer === "string") {
        const optIdx = rawOptions.findIndex((opt) => opt.value === savedAnswer);
        if (optIdx >= 0) {
          defaultOptionIndex = optIdx;
        } else if (customAllowed) {
          defaultCustomText = savedAnswer;
        }
      }
    }

    const parsed = finishPrompt(
      "opencode",
      {
        kind: "question",
        title,
        question,
        body: null,
        options,
        multi_select: multiSelect,
        ...(field.required === false ? { optional: true as const } : {}),
        custom_option_index: customOptionIndex,
        steps,
        can_step_back: stepIndex > 0,
        default_option_index: defaultOptionIndex,
        default_option_indices: defaultOptionIndices,
        default_custom_text: defaultCustomText,
      },
      {
        responder: "opencode-question",
        menuLabels: [],
        selectedIndex: 0,
        checkedOptionIndices: [],
        customMenuIndex: customOptionIndex,
        rejectWithEscapeIndex: null,
        openCodeForm: {
          formId: form.id,
          fieldKey: field.key,
          stepIndex,
          totalSteps: form.fields.length,
          options: rawOptions,
          sessionID,
          state,
          revision: state.revision,
          available: state.available,
        },
      },
      { call: `${sessionID}:${identity}:${field.key}:${stepIndex}` },
    );

    return { prompt: publicPrompt(parsed) };
  }

  if (!["claude", "omp", "codex", "omo", "pi", "gjc", "hermes", "cmd", ""].includes(agent)) return { prompt: null };
  const screen = await liveScreen(paneId);
  // omo's form reads its text from the session's call, the screen showing where the form stands
  const omoAsks = ["omo", "pi", "claude", ""].includes(agent) && pane.cwd && OMO_FORM_RE.test(screen)
    ? await omoAsksFor(paneId, pane.cwd, panes) : [];
  // a pane herdr names claude, or not at all, is omo's only on evidence: herdr reports it waiting
  // on the user, or the session's pending call is the form on screen
  const omoTrusted = (agent !== "claude" && agent !== "") || pane.agent_status === "blocked";
  const prompt = parseInteractivePrompt(agent, screen, omoAsks[0] ?? null, omoTrusted, omoAsks, agent === "claude" ? heldCandidate(paneId) : null, pane.agent_status === "working");
  if (prompt && await claudeHeldIsGrey(paneId, prompt)) return { prompt: null, screen };
  if (!prompt && agent === "gjc") {
    const fallback = parseFallbackPrompt(agent, screen);
    if (parsedByPublicPrompt.get(fallback)?.responder === "fallback-gjc-menu") return { prompt: fallback, screen };
  }
  const count = agent === "codex" && prompt === null ? queuedQuestionCount(screen) : 0;
  if (count === 0 || !pane.cwd) return { prompt, screen };
  let rollout = queueRollouts.get(paneId);
  if (!rollout || Date.now() - rollout.at > QUEUE_ROLLOUT_MS) {
    rollout = { path: await codexTranscriptPath(paneId, pane.cwd, await paneCodexHome(paneId, codexHome)), at: Date.now() };
    queueRollouts.set(paneId, rollout);
    if (queueRollouts.size > 64) queueRollouts.delete(queueRollouts.keys().next().value!);
  }
  try {
    // a question remembered from another rollout (a new session) means nothing here
    const front = queueFronts.get(paneId);
    if (front && front.rollout !== rollout.path) queueFronts.delete(paneId);
    return {
      prompt: rollout.path ? codexQueuedPrompt(screen, await unansweredCodexQuestions(rollout.path), front?.rollout === rollout.path ? front : null) : null,
      screen,
    };
  } catch {
    return { prompt: null, screen }; // the rollout went away
  }
}

/**
 * After an answer from the chat: if Codex opened its next question, close the queue, so
 * the main prompt has the input back. Only once another question shows (`answered` is the
 * id of the one just answered, which can still be on screen for a moment). alt+↓ elsewhere,
 * on the main prompt or an approval, changes nothing (checked on Codex 0.156.1).
 */
async function closeQueue(paneId: string, answered: string): Promise<void> {
  const since = Date.now();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await Bun.sleep(100);
    const screen = await liveScreen(paneId);
    const shown = parsePrompt("codex", screen);
    if (shown?.responder === "codex-async-question") {
      // the question just answered, a moment ago; still there after 600ms, it is its twin
      // (Codex takes the Enter at once, and questions may repeat a title and options)
      if (shown.id === answered && Date.now() - since < 600) continue;
      await paneSendKeys(paneId, [KEY.closeQueue]);
      return;
    }
    if (queuedQuestionCount(screen) > 0 || shown === null) return;
  }
}

/**
 * Opens Codex's collapsed queue on its first question and returns that question, only
 * if it is the one the card showed (title and options). Another one stays open, so the
 * chat's next read shows the question actually waiting (a skip can leave the rollout's
 * guess behind); a queue that does not open is left alone.
 */
async function openQueuedQuestion(paneId: string, queued: ParsedPrompt, givenUp: () => boolean = () => false, opens: (open: boolean) => void = () => undefined): Promise<InteractivePrompt | null> {
  // the key only once the screen still shows the questions' count, nothing of the user's queued,
  // and while somebody still waits for the answer (asked after the read, which takes its time)
  if (queuedQuestionCount(await liveScreen(paneId)) === 0 || givenUp()) return null;
  // told before the key goes: it may be pressed and its reply still be lost
  opens(true);
  await paneSendKeys(paneId, [KEY.openQueue]);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await Bun.sleep(100);
    const opened = parsePrompt("codex", await liveScreen(paneId));
    if (opened?.responder !== "codex-async-question") continue;
    if (sameText(opened.question, queued.question) && opened.options.length === queued.options.length
      && opened.options.every((option, index) => sameText(option.label, queued.options[index]!.label))) return publicPrompt(opened);
    const rollout = queueRollouts.get(paneId)?.path;
    if (rollout) queueFronts.set(paneId, { question: opened.question, options: opened.options.map((option) => option.label), rollout });
    if (queueFronts.size > 64) queueFronts.delete(queueFronts.keys().next().value!);
    break;
  }
  // not the card's question (a skip can leave the rollout's guess behind), or nothing opened:
  // never leave the queue open, where it would hold the input a message goes to. The one
  // close of this request's opening, told before it is tried: if its reply is lost, nobody
  // closes a second time what another client may have opened since
  opens(false);
  await closeOpenQuestion(paneId);
  return null;
}

/** Closes Codex's queue if a question shows open in it. */
async function closeOpenQuestion(paneId: string): Promise<void> {
  const screen = await liveScreen(paneId);
  if (parsePrompt("codex", screen)?.responder === "codex-async-question") await paneSendKeys(paneId, [KEY.closeQueue]);
}

/** How long an answer waits for the menu to show the cursor on its row, before it is refused. */
const SETTLE_MS = 1_500;

/**
 * After an answer to a form of several questions (omo) or to a model list (Claude Code, Codex):
 * back once the pane shows its next step (the next question, the review, a model's levels, or
 * nothing when it was submitted or closed), so the card's read right after the answer gets that
 * step and never the one just answered. A screen that does not move within a second leaves it to
 * the card's next poll.
 */
async function formMovedOn(paneId: string, answered: string, codexHome?: string, openCodeStateDir?: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await Bun.sleep(50);
    const prompt = await readPrompt(paneId, codexHome, openCodeStateDir).then((read) => read.prompt, () => null);
    // by what it says: the answer ended that asking, so the same step still on screen has a new id
    if (contentId(prompt) !== answered) return;
  }
}

function promptChanged(): Response {
  return jsonResponse({ error: { code: "prompt_changed", message: "The interactive prompt changed; reopen it and try again." } }, 409);
}

export interface PromptRequestOptions {
  /** runs a pane's answer after the input already queued for it (a composer message in flight) */
  serialize?: <T>(paneId: string, task: () => Promise<T>) => Promise<T>;
  /** Native Codex store, for the rollout behind a collapsed queue; defaults to CODEX_HOME */
  codexHome?: string;
  /** a Claude pane's transcript, for the plan file behind a plan card */
  claudeTranscript?: (paneId: string) => string | null;
  /** the requester can only watch: it gets the screen's card, never the plan file's text or path */
  readOnly?: boolean;
  /** OpenCode state dir where service.json lives; tests use an isolated directory */
  openCodeStateDir?: string;
  /** Each server owns its drafts and clears them when stopped. */
  openCodeState?: OpenCodePromptState;
}

/**
 * A Claude plan card with the whole plan from Claude's plan file, as the screen shows only what fits
 * the pane. The plan's revision is part of the id, so an answer to a card read before the file
 * changed is refused.
 */
async function withPlanFile(prompt: InteractivePrompt | null, transcript: string | null | undefined): Promise<InteractivePrompt | null> {
  if (!prompt || !transcript || parsedByPublicPrompt.get(prompt)?.responder !== "claude-plan") return prompt;
  const plan = await claudePlanFile(transcript);
  if (!plan) return prompt;
  const revision = createHash("sha256").update(plan.text).digest("hex").slice(0, 8);
  return { ...prompt, id: `${prompt.id}.${revision}`, body: plan.text.slice(0, 12_000), plan_file: plan.path };
}

export async function handlePromptRequest(request: Request, url: URL, options: PromptRequestOptions = {}): Promise<Response | null> {
  if (url.pathname !== "/api/pane/prompt" && url.pathname !== "/api/pane/prompt/answer") return null;
  // the answer being handled, once its body was read: what the log line says even when the handling throws
  let answerLog: { paneId: string; matched: boolean } | null = null;
  try {
    if (url.pathname === "/api/pane/prompt") {
      if (request.method !== "GET") return badRequest("method_not_allowed", "GET is required.");
      const paneId = url.searchParams.get("pane_id")?.trim();
      if (!paneId) return badRequest("missing_pane_id", "pane_id is required.");
      const readSendId = chatSent.get(paneId)?.commands.at(-1)?.id;
      const read = await readPrompt(paneId, options.codexHome, options.openCodeStateDir, options.openCodeState, request.signal);
      if (read.stale) return promptChanged();
      const { agent, status, screen } = read;
      // `plan=0` is how a connection server asks for a watching device through its PC proxy, which
      // reaches this PC with its own credential: it only ever narrows the answer
      const watching = options.readOnly || url.searchParams.get("plan") === "0";
      const prompt = watching ? read.prompt : await withPlanFile(read.prompt, options.claudeTranscript?.(paneId));
      // no menu up: what Claude suggests typing next, for the composer's placeholder, and the chat's
      // own last message where Claude put it back into the box on a cancel. Only a nicety: it is read
      // only while Claude waits for the next prompt (a working agent shows none), and a failed or
      // slow read of it (a herdr without ansi reads, a busy one) leaves the prompt answer as it is,
      // on time.
      const box = prompt === null && agent === "claude" && (status === "idle" || status === "done")
        ? await paneRead({ paneId, source: "visible", format: "ansi", timeoutMs: SUGGESTION_READ_MS })
          .then((read) => read.text, () => null)
        : null;
      const outcomes = await commandOutcomes(paneId, read.pane, read.prompt, read.screen, readSendId, options.codexHome);
      return jsonResponse({
        prompt,
        suggestion: box === null ? null : parseClaudeSuggestion(box),
        restored: box === null ? null : await restoredOnLiveScreen(paneId, box).catch(() => null),
        ...(screen && paneIsCompacting(screen) ? { compacting: true } : {}),
        ...(outcomes.length ? { outcomes: watching ? outcomes.map(({ preview: _preview, result_text: _resultText, ...outcome }) => outcome) : outcomes } : {}),
      } satisfies PanePromptResponse);
    }

    if (request.method !== "POST") return badRequest("method_not_allowed", "POST is required.");
    let body: PromptAnswer;
    try {
      body = await request.json() as PromptAnswer;
    } catch {
      return badRequest("invalid_json", "The request body must be valid JSON.");
    }
    if (!body || typeof body !== "object") return badRequest("invalid_answer", "The answer body is required.");
    if (typeof body.pane_id !== "string" || !body.pane_id.trim()) return badRequest("missing_pane_id", "pane_id is required.");
    if (typeof body.prompt_id !== "string" || !body.prompt_id) return badRequest("invalid_answer", "prompt_id is required.");

    // read, checked and answered in the pane's turn: a message still in flight goes first, and
    // one sent meanwhile waits until the queue is opened, answered and closed again
    const serialize = options.serialize ?? (<T>(_paneId: string, task: () => Promise<T>) => task());
    const form: { answered?: string } = {};
    const log = { paneId: body.pane_id, matched: false };
    answerLog = log;
    const response = await serialize(body.pane_id, async () => {
      // given up while it waited its turn: nothing is read, opened or sent for it
      if (request.signal.aborted) return promptChanged();
      const deadlineAt = Date.now() + 4_000;
      const deadline = AbortSignal.any([request.signal, AbortSignal.timeout(4_000)]);
      const openCodeState = options.openCodeState ?? defaultOpenCodeState;
      const { prompt, agent, pane, panes } = await readPrompt(body.pane_id, options.codexHome, options.openCodeStateDir, openCodeState, deadline);
      // a plan card's id carries its plan file's revision: the file as it is now must match too
      if (!prompt || (await withPlanFile(prompt, options.claudeTranscript?.(body.pane_id)))!.id !== body.prompt_id) return promptChanged();
      log.matched = true;

      const parsedPrompt = parsedByPublicPrompt.get(prompt);
      if (parsedPrompt?.responder === "opencode-question" && parsedPrompt.openCodeForm) {
        const openCodeForm = parsedPrompt.openCodeForm;
        if (!openCodeForm.available) return jsonResponse({ error: { code: "service_unavailable", message: "OpenCode service is not available. Your answer has not been sent." } }, 502);
        const state = openCodeForm.state;
        const asking = askings.get(body.pane_id);
        const current = (): boolean => !deadline.aborted
          && openCodeState.entries.get(body.pane_id) === state && state.revision === openCodeForm.revision
          && askings.get(body.pane_id) === asking && asking?.content === parsedPrompt.id;
        // The lookup above awaited HTTP. Neither its pane nor its form is a live binding now.
        const stillBound = async (): Promise<boolean> => {
          if (!current()) return false;
          const before = openCodeState.checkpoint();
          const snapshot = await openCodeState.snapshot(Math.max(1, deadlineAt - Date.now())).catch(() => null);
          if (!snapshot) return false;
          openCodeState.reconcile(snapshot.panes, before);
          const live = snapshot.panes.find((candidate) => candidate.pane_id === body.pane_id);
          return !!live && live.agent === "opencode" && opencodeSessionId(live) === openCodeForm.sessionID && current();
        };
        if (!(await stillBound())) return promptChanged();
        const navigating = body.step_back === true || body.step_index !== undefined;
        const supplied = [
          body.option_index !== undefined,
          body.option_indices !== undefined,
          body.custom_text !== undefined,
        ].filter(Boolean).length;
        const combined = parsedPrompt.multi_select && body.option_indices !== undefined && body.custom_text !== undefined && body.option_index === undefined;
        if (supplied !== 1 && !navigating && !combined) return badRequest("invalid_answer", "Exactly one answer is required.");
        if ((supplied > 1 && !combined) || (navigating && supplied !== 0) || (body.step_back === true && body.step_index !== undefined)
          || (!navigating && body.draft !== undefined)) return badRequest("invalid_answer", "Exactly one answer is required.");

        if (navigating) {
          let targetStep = openCodeForm.stepIndex - 1;
          if (body.step_index !== undefined) {
            if (!Number.isInteger(body.step_index) || body.step_index < 0 || body.step_index >= openCodeForm.stepIndex) {
              return badRequest("invalid_answer", "Invalid step index to step back to.");
            }
            targetStep = body.step_index;
          }
          if (targetStep < 0) {
            return badRequest("invalid_answer", "Cannot step back from the first step.");
          }

          const draft = state.draft ? { ...state.draft, answers: { ...state.draft.answers } } : {
            formId: openCodeForm.formId,
            stepIndex: targetStep,
            answers: {},
            updatedAt: openCodeState.now(),
          };
          // Navigation carries the current step's unsent edits, including an explicit clear.
          if (body.draft !== undefined) {
            if (typeof body.draft !== "object" || body.draft === null
              || !Array.isArray(body.draft.option_indices) || typeof body.draft.custom_text !== "string"
              || body.draft.custom_text.length > 12_000
              || body.draft.option_indices.some((index) => !Number.isInteger(index) || index < 0 || index >= openCodeForm.options.length)
              || (!parsedPrompt.multi_select && body.draft.option_indices.length > 1)
              || (parsedPrompt.custom_option_index === null && body.draft.custom_text !== "")) return badRequest("invalid_answer", "Invalid draft.");
            const selected = body.draft.option_indices.map((index) => openCodeForm.options[index]!.value);
            const custom = body.draft.custom_text;
            draft.answers[openCodeForm.fieldKey] = parsedPrompt.multi_select ? [...selected, ...(custom ? [custom] : [])] : custom || selected[0] || "";
          }
          if (JSON.stringify(draft.answers).length > 65_536) return badRequest("invalid_answer", "The form answers are too large.");
          draft.stepIndex = targetStep;
          draft.updatedAt = openCodeState.now();
          state.draft = draft;
          state.updatedAt = draft.updatedAt;
          state.revision++;
          askingEnded(body.pane_id);
          return jsonResponse({ ok: true });
        }

        let answerValue: string | string[];
        if (body.custom_text !== undefined && body.option_indices === undefined) {
          if (typeof body.custom_text !== "string") return badRequest("invalid_answer", "Custom text must be a string.");
          const text = body.custom_text.trim();
          if ((!text && !parsedPrompt.optional) || text.length > 12_000 || (text && parsedPrompt.custom_option_index === null)) return badRequest("invalid_answer", "This prompt does not accept a custom answer.");
          answerValue = parsedPrompt.multi_select ? (text ? [text] : []) : text;
        } else if (body.option_indices !== undefined) {
          if (!Array.isArray(body.option_indices)) return badRequest("invalid_answer", "Option indices must be an array.");
          if (!parsedPrompt.multi_select || (body.option_indices.length === 0 && !combined && !parsedPrompt.optional)) return badRequest("invalid_answer", "This prompt requires one or more selections.");
          const choices = [...new Set(body.option_indices)];
          if (choices.some((c) => !Number.isInteger(c) || c < 0 || c >= openCodeForm.options.length)) {
            return badRequest("invalid_answer", "An option index is outside the displayed range.");
          }
          answerValue = choices.map((i) => openCodeForm.options[i]!.value);
          if (body.custom_text !== undefined) {
            if (typeof body.custom_text !== "string" || !body.custom_text.trim() || body.custom_text.length > 12_000 || parsedPrompt.custom_option_index === null) return badRequest("invalid_answer", "This prompt does not accept a custom answer.");
            answerValue.push(body.custom_text.trim());
          }
        } else {
          const index = body.option_index;
          if (!Number.isInteger(index) || index! < 0 || index! >= openCodeForm.options.length || index === parsedPrompt.custom_option_index || parsedPrompt.multi_select) {
            return badRequest("invalid_answer", "A valid option index is required.");
          }
          answerValue = openCodeForm.options[index!]!.value;
        }

        const draft = state.draft ? { ...state.draft, answers: { ...state.draft.answers } } : {
          formId: openCodeForm.formId,
          stepIndex: openCodeForm.stepIndex,
          answers: {},
          updatedAt: openCodeState.now(),
        };
        draft.answers[openCodeForm.fieldKey] = answerValue;
        if (JSON.stringify(draft.answers).length > 65_536) return badRequest("invalid_answer", "The form answers are too large.");
        draft.updatedAt = openCodeState.now();
        state.updatedAt = draft.updatedAt;

        const isLastStep = openCodeForm.stepIndex >= openCodeForm.totalSteps - 1;
        if (!isLastStep) {
          draft.stepIndex += 1;
          state.draft = draft;
          state.revision++;
          askingEnded(body.pane_id);
          return jsonResponse({ ok: true });
        }

        const config = readOpenCodeService(options.openCodeStateDir);
        if (!config) {
          return jsonResponse({ error: { code: "service_unavailable", message: "OpenCode service is not available." } }, 502);
        }

        if (!(await stillBound())) return promptChanged();
        const replyResult = await replyOpenCodeForm(config, openCodeForm.sessionID, openCodeForm.formId, draft.answers, deadline);
        if (replyResult.ok) {
          // An upstream acknowledgement is authoritative, even after a poll or status change.
          // Only clean up this asking: another form/session may already have replaced it.
          if (openCodeState.entries.get(body.pane_id) === state && state.revision === openCodeForm.revision) {
            state.draft = undefined;
            state.form = null;
            state.listed = null;
            state.revision++;
            formsAnswered.set(body.pane_id, Date.now());
            if (formsAnswered.size > 64) formsAnswered.delete(formsAnswered.keys().next().value!);
            if (askings.get(body.pane_id) === asking) askingEnded(body.pane_id);
          }
          return jsonResponse({ ok: true });
        }
        if (replyResult.status === 0) return jsonResponse({ error: { code: "reply_unconfirmed", message: "OpenCode may have received your answer, but its reply did not arrive. Check the question before sending again." } }, 504);
        if (!current()) return promptChanged();
        if (replyResult.status === 409) {
          state.draft = undefined;
          state.form = null;
          state.listed = null;
          state.revision++;
          return jsonResponse({ error: { code: "prompt_changed", message: "The form has already been settled." } }, 409);
        }
        return jsonResponse({ error: { code: "reply_failed", message: `Failed to reply to OpenCode form (HTTP ${replyResult.status}).` } }, 502);
      }

      // checked against the card before anything is sent: an invalid answer never opens the queue
      let steps: AnswerStep[];
      try {
        steps = answerKeys(prompt, body);
      } catch (error) {
        if (error instanceof InvalidAnswer) return badRequest("invalid_answer", error.message);
        throw error;
      }
      // The asking this answer is for, held to its last key: once anything says it ended (the
      // agent back at work), no key of this answer goes out any more, whatever the screen shows.
      const asking = askings.get(body.pane_id)!;
      const asks = (): boolean => askings.get(body.pane_id) === asking && asking.content !== null;
      let target = prompt;
      /** what the card said at the answer's last look: a list drawn as another window by then is another text */
      let lastSeen: string | undefined;
      const opensQueue = parsedByPublicPrompt.get(prompt)?.responder === "codex-queued-question";
      const opensOmo = parsedByPublicPrompt.get(prompt)?.responder === "omo-pending";
      let answered = false;
      let committed = false;
      // whether this request's alt+↑ may have left the queue open
      let queueOpened = false;
      answersUnderWay.add(body.pane_id);
      answerTurns.set(body.pane_id, (answerTurns.get(body.pane_id) ?? 0) + 1);
      try {
        if (request.signal.aborted) return promptChanged();
        if (opensQueue) {
          // the card came from the rollout: answer it in the open queue, once it shows this question
          const opened = await openQueuedQuestion(body.pane_id, parsedByPublicPrompt.get(prompt)!, () => request.signal.aborted, (open) => { queueOpened = open; });
          // a queue it could not answer in it has closed again itself, or never opened: a
          // queue another client opened meanwhile is that client's to close
          if (!opened) return promptChanged();
          if (!asks()) return promptChanged();
          target = opened;
        }
        if (opensOmo) {
          // Alt+Up opens the form even with whitespace in the composer; no draft is submitted.
          // A remapped shortcut or a different question fails closed before any answer text.
          await paneSendKeys(body.pane_id, [KEY.openQueue]);
          const deadline = Date.now() + SETTLE_MS;
          let opened: InteractivePrompt | null = null;
          while (Date.now() < deadline) {
            if (!asks() || request.signal.aborted) return promptChanged();
            const left = deadline - Date.now();
            const read = await Promise.race([readKnownPrompt(body.pane_id, pane, agent, options.codexHome, panes, options.openCodeStateDir), Bun.sleep(left).then(() => null)]);
            if (!read || Date.now() > deadline) return promptChanged();
            const parsed = read.prompt && parsedByPublicPrompt.get(read.prompt);
            if (parsed?.responder === "omo-question") {
              // Opening a form changes its drawing, but not the call or question it answers.
              const pending = parsedByPublicPrompt.get(prompt)!;
              if (!pending.omoQuestion || parsed.omoQuestion?.call !== pending.omoQuestion.call
                || parsed.omoQuestion.index !== pending.omoQuestion.index
                || parsed.question !== pending.question || parsed.multi_select !== pending.multi_select
                || JSON.stringify(parsed.options) !== JSON.stringify(pending.options)) return promptChanged();
              opened = read.prompt;
              break;
            }
            await Bun.sleep(Math.min(50, Math.max(0, deadline - Date.now())));
          }
          if (!opened || !asks()) return promptChanged();
          target = opened;
        }
        // the keys for the question as it shows in the open queue
        if (target !== prompt) steps = answerKeys(target, body);
        const parsed = parsedByPublicPrompt.get(target)!;
        const responder = parsed.responder;
        const reader = registry.readerFor(responder);
        const interaction = reader?.interaction?.(parsed);
        // where the moves sent so far leave the cursor (↑ stops at the first row: omoWalk)
        let cursor = parsed.selectedIndex;
        // Claude's unnumbered rows and pi's models are read with no number to aim at: looked at
        // again before the Enter even when it needs no move. So is Claude's model list, picked
        // with a letter: typed after the list has gone, it would stand in the agent's own prompt
        let moved = reader !== undefined && reader.reread !== "none";
        // Claude's and Codex's model lists: a window on a list, picked with a letter; Claude's effort
        // slider the same way, its levels side by side
        const list = reader !== undefined && reader.list !== "none";
        // ←/→ move the slider; anywhere else they are a menu's own keys (Claude's question tabs)
        const sideways = reader?.list === "slider";
        /** the menu as the last look before a key showed it */
        let seen: ParsedPrompt | null = null;
        const looked = (shown: ParsedPrompt | null): void => { seen = shown; lastSeen = shown?.id; };
        /** Whether the screen is the card's own menu, with the cursor on the row the moves were for. */
        const aimed = (shown: ParsedPrompt | null, screen: string): boolean => {
          if (interaction) return shown?.responder === responder && interaction.matches(screen);
          // a dialog of pi's has a card only with its cursor on the first row (parsePiDialog),
          // which the answer's own moves have just left: read off the screen itself
          if ((responder === "pi-question" || responder === "pi-confirm") && cursor !== 0) {
            const dialog = parsePiDialog(screen, true);
            return dialog?.id === parsed.id && dialog.selectedIndex === cursor && promptTailIsActive(dialog, screen);
          }
          return shown?.id === parsed.id && shown.selectedIndex === cursor;
        };
        /**
         * Waits for the screen to show the card's own menu with the cursor where the moves sent
         * so far leave it. False: the asking ended, nobody waits for the answer, or the menu did
         * not show so within SETTLE_MS.
         */
        let matchedScreen: string | null = null;
        const onRow = async (): Promise<boolean> => {
          const deadline = Date.now() + SETTLE_MS;
          for (;;) {
            // nobody waits for this answer any more: nothing that cannot be undone is started
            if (!asks() || request.signal.aborted) return false;
            const left = deadline - Date.now();
            if (left <= 0) return false;
            // a read that outlasts the wait is no read
            const reading = readKnownPrompt(body.pane_id, pane, agent, options.codexHome, panes, options.openCodeStateDir);
            reading.catch(() => undefined);
            const read = await Promise.race([reading, Bun.sleep(left).then(() => null)]);
            if (!read || Date.now() > deadline) return false;
            const shown = read.prompt ? parsedByPublicPrompt.get(read.prompt) ?? null : null;
            if (asks() && aimed(shown, read.screen ?? "")) { looked(shown); matchedScreen = read.screen ?? ""; return true; }
            await Bun.sleep(50);
          }
        };
        const sendStep = async (step: AnswerStep, move: boolean, more: boolean): Promise<void> => {
          const first = !move && !committed;
          if (!move) committed = true;
          try {
            if (step.keys) await paneSendKeys(body.pane_id, step.keys);
            else if (step.text !== undefined) await paneSendText(body.pane_id, step.text);
          } catch (error) {
            // herdr was never reached, so nothing was pressed: the card is still to be answered
            if (first && error instanceof HerdrError && error.code === "connect_failed") committed = false;
            throw error;
          }
          if (more) await Bun.sleep(30);
        };
        if (interaction) {
          const result = await executeInteractionPlan(interaction, body.option_index!, {
            rereadMoves: list || reader?.reread === "each-move",
            active: asks,
            cancelled: () => request.signal.aborted,
            read: async () => await onRow() ? matchedScreen : null,
            send: (step, commit) => sendStep(step, !commit, !commit),
          });
          if (result === "prompt_changed") return promptChanged();
        } else {
          // whether a move of this answer has gone out
          let walked = false;
          for (let index = 0; index < steps.length; index += 1) {
            const step = steps[index]!;
            const move = step.keys?.every((key) => key === KEY.up || key === KEY.down || (sideways && (key === KEY.left || key === KEY.right))) ?? false;
            // the asking ended under the answer: no further key, whatever the screen shows
            if (!asks()) return promptChanged();
            // GJC's selector can close under the answer: its composer must not take the moves.
            if (move && walked && (list || responder === "fallback-gjc-menu") && !(await onRow())) return promptChanged();
            if (!move && !committed) {
              // The first irreversible step goes only once the menu shows the expected cursor.
              // Later keys follow as before: the menu itself changes under them.
              if (moved && !(await onRow())) return promptChanged();
              if (request.signal.aborted) return promptChanged();
            }
            // herdr may press the key and lose its reply; a possibly pressed key ends the asking.
            const key: AnswerStep | null = step.pick ? (seen as ParsedPrompt | null)?.rowKey ?? null : step;
            if (key === null) return promptChanged();
            await sendStep(key, move, index < steps.length - 1);
            if (move) {
              moved = true;
              walked = true;
              for (const key of step.keys!) cursor = key === KEY.down || key === KEY.right ? cursor + 1 : Math.max(0, cursor - 1);
            }
          }
        }
        answered = true;
        const sent = chatSent.get(body.pane_id)?.commands.at(-1);
        // An incidental question only unblocks the command; only its named dialog can complete it.
        // The card's Esc row (a cancel or refusal: omp's handoff Cancel, Codex's No) is not a result.
        if (committed && sent?.dialogId === prompt.id && sent.form?.dialog === parsed.responder
          && body.option_index !== parsed.rejectWithEscapeIndex) noteCommandEvidence(body.pane_id, sent.id, { kind: "dialog", at: Date.now() });
      } catch (error) {
        if (error instanceof InvalidAnswer) return badRequest("invalid_answer", error.message);
        throw error;
      } finally {
        answersUnderWay.delete(body.pane_id);
        answerTurns.set(body.pane_id, (answerTurns.get(body.pane_id) ?? 0) + 1);
        // the queue this request opened never stays open, whatever failed on the way
        if (queueOpened && !answered) await closeOpenQuestion(body.pane_id).catch(() => undefined);
        // answered, or as good as: the same prompt on the screen after this is asked anew
        if (committed) askingEnded(body.pane_id);
        // sent or dropped from its card: the same words in the box after this are a new message
        if (committed && parsedByPublicPrompt.get(target)?.responder === "claude-held") heldCandidates.delete(body.pane_id);
      }
      // answered from the chat, the queue closes again: the next question waits collapsed, and
      // the main prompt (where a message typed in the chat goes) has the input back
      if (parsedByPublicPrompt.get(target)?.responder === "codex-async-question") {
        queueFronts.delete(body.pane_id);
        // by what it says, as closeQueue reads it off the screen
        await closeQueue(body.pane_id, contentId(target)!);
      }
      const responder = parsedByPublicPrompt.get(target)?.responder;
      if (responder === "omo-question" || responder === "omo-review" || responder === "omo-typing" || responder === "omo-pending") {
        formsAnswered.set(body.pane_id, Date.now());
        if (formsAnswered.size > 64) formsAnswered.delete(formsAnswered.keys().next().value!);
      }
      // A model list closes, or opens its next list, a moment after its key: the same wait, so
      // the card's read right after the answer does not get the list just answered once more
      if (target.steps) form.answered = contentId(target);
      else if (responder === "claude-model" || responder === "claude-effort" || responder === "codex-model") form.answered = lastSeen ?? contentId(target);
      return jsonResponse({ ok: true });
    });
    // the wait for the form's next step only reads the pane: after the pane's turn, so a message
    // queued for it meanwhile is not held up behind the polls
    if (form.answered !== undefined) await formMovedOn(body.pane_id, form.answered, options.codexHome, options.openCodeStateDir);
    await logAnswer(log, response);
    return response;
  } catch (error) {
    // a read or a send that threw (a herdr timeout, 502) is an outcome too
    const response = errorResponse(error);
    if (answerLog !== null) await logAnswer(answerLog, response);
    return response;
  }
}

/** One line per answer that got as far as the pane: the pane, whether the card's prompt still stood, and the
 * refusal's own code (prompt_changed, invalid_answer, agent_blocked, a herdr error...). Never the answer. The pane
 * id is the client's until the snapshot has checked it, so it is logged as a JSON string: one field, whatever it holds. */
async function logAnswer(log: { paneId: string; matched: boolean }, response: Response): Promise<void> {
  const outcome = response.ok ? "ok" : ((await response.clone().json().catch(() => null)) as { error?: { code?: string } } | null)?.error?.code ?? `status_${response.status}`;
  // quoted as JSON: a space or a newline in the client's id cannot pass for a field of the line
  const pane = JSON.stringify(log.paneId.slice(0, 80));
  console.log(`[prompt/answer] pane=${pane} prompt_matched=${log.matched} outcome=${outcome}`);
}
