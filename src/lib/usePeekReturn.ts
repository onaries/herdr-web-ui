import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import type { AgentStatus } from "../../shared/protocol.ts";
import type { InputRowState, FrameGate } from "./inputRow.ts";
import { modalOpen } from "./focus.ts";
import { returnBlocked, watchReturn, type PeekRequest, type TerminalPeek } from "./terminalPeek.ts";
import type { Translate } from "./i18n.ts";
import type { StillOpen } from "./paneTerminalShared.ts";

export interface PeekReturnDeps {
  activeRef: RefObject<boolean>;
  agent: string | null;
  agentRef: RefObject<string | null>;
  agentStatus: AgentStatus | undefined;
  chatMounted: boolean;
  coarseRef: RefObject<boolean>;
  compositionCommitPendingRef: RefObject<boolean>;
  composingRef: RefObject<boolean>;
  draftHeldForRef: RefObject<string | null>;
  ended: boolean;
  findOpenRef: RefObject<boolean>;
  frameGateRef: RefObject<FrameGate>;
  inputRowNow: () => InputRowState | null;
  lineComposingRef: RefObject<boolean>;
  onEndPeekRef: RefObject<((peek: TerminalPeek) => void) | undefined>;
  onOpenTerminal: (() => void) | undefined;
  onPeekRef: RefObject<((request: PeekRequest) => void) | undefined>;
  paneId: string | null;
  paneRef: RefObject<string | null>;
  peek: TerminalPeek | null;
  peekRef: RefObject<TerminalPeek | null>;
  presented: boolean;
  receiptRowRef: RefObject<{ pane: string; text: string; state: InputRowState } | null>;
  stackRef: RefObject<HTMLDivElement | null>;
  termRef: RefObject<Terminal | null>;
  terminalId: string | null;
  t: Translate;
  heldRef: RefObject<boolean>;
  unsupportedRef: RefObject<boolean>;
}

export function usePeekReturn(deps: PeekReturnDeps) {
  const { activeRef, agent, agentRef, agentStatus, chatMounted, coarseRef, compositionCommitPendingRef, composingRef, draftHeldForRef, ended, findOpenRef, frameGateRef, inputRowNow, lineComposingRef, onEndPeekRef, onOpenTerminal, onPeekRef, paneId, paneRef, peek, peekRef, presented, receiptRowRef, stackRef, termRef, terminalId, t, heldRef, unsupportedRef } = deps;
  // a peek whose screen closed while held input, the find bar or a composition (in the grid, or in
  // the input line the return would unmount) was in the way: it is left to the reader, and the head
  // stops saying the chat may come back
  const [manualPeek, setManualPeek] = useState<TerminalPeek | null>(null);
  const autoPeek = peek !== null && peek.auto && manualPeek !== peek ? peek : null;
  // the peek that came back by itself (the agent's record, or its screen): no screen is left open
  const autoEndedRef = useRef<TerminalPeek | null>(null);
  const onCommandScreenClosed = useCallback((closed: TerminalPeek) => {
    if (peekRef.current !== closed) return;
    const pane = paneRef.current;
    if (returnBlocked({ heldDraft: pane !== null && draftHeldForRef.current === pane, findOpen: findOpenRef.current,
      composing: composingRef.current || compositionCommitPendingRef.current || lineComposingRef.current })) { setManualPeek(closed); return; }
    autoEndedRef.current = closed;
    onEndPeekRef.current?.(closed);
  }, []);
  // The agent ended or the tab was put away: the chat is back for when it shows again.
  useEffect(() => { if (peek !== null && (ended || !presented)) onEndPeekRef.current?.(peek); }, [peek, ended, presented]);
  // A watched peek (lib/terminalPeek.ts watchReturn): armed by a frame whose input row an open screen
  // hid or covered, back on the first frame that draws the row again, empty. Read off whole frames
  // only (onInputRowFrame), never on a timer, and nothing is typed. A draft after it arms, another
  // agent in the pane, or a blocker (held input, the find bar, a composition) leaves it to the reader.
  const watchRef = useRef<{ peek: TerminalPeek; agent: string; armed: boolean } | null>(null);
  // the last peek's watch, kept past its end: whether its screen was seen open before the reader left
  const lastWatchRef = useRef<{ peek: TerminalPeek; agent: string; armed: boolean } | null>(null);
  const watchFrame = useCallback((state: InputRowState) => {
    const watch = watchRef.current;
    if (watch === null) return;
    if (peekRef.current !== watch.peek) { watchRef.current = null; return; }
    // another agent in the pane: its screen is not the one watched, and the head stops promising
    if (agentRef.current !== watch.agent) { watchRef.current = null; setManualPeek(watch.peek); return; }
    const next = watchReturn(watch.agent, watch.armed, state);
    if (next.step === "wait") { watch.armed = next.armed; return; }
    watchRef.current = null;
    if (next.step === "manual") setManualPeek(watch.peek);
    else onCommandScreenClosed(watch.peek);
  }, [onCommandScreenClosed]);
  // the watch starts with the peek, from the screen as it stands (the command's screen may have
  // opened before its receipt came), and goes with it
  useLayoutEffect(() => {
    if (peek === null || peek.watch === null || manualPeek === peek) { watchRef.current = null; return; }
    if (watchRef.current?.peek === peek) return;
    watchRef.current = { peek, agent: peek.watch, armed: false };
    lastWatchRef.current = watchRef.current;
    const atReceipt = receiptRowRef.current;
    receiptRowRef.current = null;
    if (atReceipt !== null && atReceipt.pane === peek.paneId && atReceipt.text === peek.text) watchFrame(atReceipt.state);
    const state = frameGateRef.current.reflowing ? null : inputRowNow();
    if (state !== null && watchRef.current?.peek === peek) watchFrame(state);
  }, [peek, manualPeek, inputRowNow, watchFrame]);
  // A peek ended by hand while the command's screen is still open in the terminal (Claude's /btw
  // answer, a picker left up): the next message would be typed into that screen and do nothing, so
  // the composer says so, holds Send behind Send anyway, and offers the terminal again. Only where
  // the agent's recognizer read the empty row as the peek began; it goes on the first whole frame
  // showing the row back, and with another pane, agent, terminal or session. Nothing is typed to
  // close anything. `named`: the screen is the sent command's (a peek opened by hand names none:
  // the reader may have opened another there); `command` also heads the peek Show terminal opens.
  const [stillOpen, setStillOpenState] = useState<StillOpen | null>(null);
  const stillOpenRef = useRef(stillOpen);
  const setStillOpen = useCallback((next: StillOpen | null) => { stillOpenRef.current = next; setStillOpenState(next); }, []);
  // A watched command whose screen had not opened when its peek was ended by hand (gjc's /sessions
  // keeps its empty box for seconds while it loads): no notice yet, and the first frame that shows
  // its screen (the agent's arm set) turns it into one. It goes with another peek, pane, agent,
  // terminal or session, and once the agent works on a turn.
  const pendingOpenRef = useRef<StillOpen | null>(null);
  // A peek ended by hand while the screen read nothing (a cut frame, or a blank one): the next whole
  // frame decides, the row back clearing it and anything else making the notice; no frame, no notice
  const undecidedOpenRef = useRef<StillOpen | null>(null);
  // the history the pane's chat read last: a new one (/new, /resume, a clear) is another session
  const chatHistoryRef = useRef<{ pane: string; history: string | undefined } | null>(null);
  // the still-open note the composer shows, whose Send anyway is one send past the guard (composerSend)
  const stillOpenNotedRef = useRef(false);
  // a whole frame of the pane's stream was parsed (the write callback): the watch and the guard read it
  const onInputRowFrame = useCallback(() => {
    const pending = pendingOpenRef.current;
    const undecided = undecidedOpenRef.current;
    if (watchRef.current === null && stillOpenRef.current === null && pending === null && undecided === null) return;
    // herdr's first frame for the pane's new size may be its old screen reflowed: no screen opened or closed
    if (frameGateRef.current.reflowing) return;
    const state = inputRowNow();
    if (state === null || state === "unknown") return;
    if (undecided !== null) {
      undecidedOpenRef.current = null;
      if (state !== "ready" && undecided.pane === paneRef.current && undecided.agent === agentRef.current) setStillOpen(undecided);
    }
    if (state === "ready" && stillOpenRef.current !== null) setStillOpen(null);
    // the command's screen opened after its peek ended: now it would take the next message
    if (pending !== null) {
      const step = pending.pane === paneRef.current && pending.agent === agentRef.current ? watchReturn(pending.agent, false, state) : null;
      if (step === null) pendingOpenRef.current = null;
      else if (step.step === "wait" && step.armed) { pendingOpenRef.current = null; setStillOpen(pending); }
    }
    watchFrame(state);
  }, [inputRowNow, watchFrame, setStillOpen]);
  const onInputRowFrameRef = useRef(onInputRowFrame); onInputRowFrameRef.current = onInputRowFrame;
  useLayoutEffect(() => { setStillOpen(null); pendingOpenRef.current = null; undecidedOpenRef.current = null; stillOpenNotedRef.current = false; }, [paneId, terminalId, setStillOpen]);
  useEffect(() => {
    if (stillOpenRef.current !== null && stillOpenRef.current.agent !== agent) setStillOpen(null);
    if (pendingOpenRef.current !== null && pendingOpenRef.current.agent !== agent) pendingOpenRef.current = null;
    if (undecidedOpenRef.current !== null && undecidedOpenRef.current.agent !== agent) undecidedOpenRef.current = null;
  }, [agent, setStillOpen]);
  // a turn began: whatever the command was loading, the agent has moved on
  useEffect(() => { if (agentStatus === "working") { pendingOpenRef.current = null; undecidedOpenRef.current = null; } }, [agentStatus]);
  // what the composer and the queue say when the screen would take a send
  const stillOpenNote = useCallback((open: StillOpen): string => open.named
    ? t("Not sent: {command} is still open in the terminal.", { command: open.command })
    : t("Not sent: a screen is still open in the terminal."), [t]);
  // the terminal again, for the screen still open there: a peek the reader ends by hand
  const showStillOpen = useCallback(() => {
    const open = stillOpenRef.current;
    const show = onPeekRef.current;
    if (open === null) return;
    if (show === undefined || heldRef.current || unsupportedRef.current) { onOpenTerminal?.(); return; }
    show({ command: open.command, text: null, knownOutcomeIds: null, auto: false, watch: null, inputRowSeen: true });
  }, [onOpenTerminal]);
  // Every end of a peek back to the chat: the hidden grid lets go of the keyboard (it has no Chat
  // guard of its own, and keys typed after the return would reach the pane), and a desktop's typing
  // goes back to the message box of the same pane (another pane's composer focuses itself, or not,
  // as a pane switch decides). A phone's keyboard stays down. Keep Terminal (or the header's
  // Terminal) keeps the grid, and gives it the keyboard its button took.
  const shownPeekRef = useRef<TerminalPeek | null>(null);
  useLayoutEffect(() => {
    const was = shownPeekRef.current;
    shownPeekRef.current = peek;
    // another peek: what the last one left pending is its own again
    if (peek !== null) { pendingOpenRef.current = null; undecidedOpenRef.current = null; }
    if (was === null || peek !== null) return;
    if (!chatMounted) {
      if (activeRef.current && was.paneId === paneRef.current && !coarseRef.current && !modalOpen() && !findOpenRef.current) termRef.current?.focus();
      return;
    }
    // ended by hand on the same pane, over a screen its recognizer knows: is the screen still open?
    if (was !== autoEndedRef.current && was.inputRowSeen && was.paneId === paneRef.current && agentRef.current !== null) {
      const state = inputRowNow();
      const history = chatHistoryRef.current?.pane === was.paneId ? chatHistoryRef.current.history : undefined;
      // a peek opened by hand names no command, unless it showed a screen the guard still names (no row seen back since)
      const kept = stillOpenRef.current?.pane === was.paneId ? stillOpenRef.current : null;
      const open: StillOpen = { pane: was.paneId, agent: agentRef.current, command: was.text === null && kept !== null ? kept.command : was.command,
        named: was.text !== null || kept?.named === true, history };
      const watched = lastWatchRef.current?.peek === was ? lastWatchRef.current : null;
      if (state === "ready") {
        setStillOpen(null);
        if (watched !== null && !watched.armed && watched.agent === agentRef.current) pendingOpenRef.current = open;
      } else if (state === "unknown") undecidedOpenRef.current = open;
      else if (state !== null) setStillOpen(open);
    }
    termRef.current?.blur();
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && stackRef.current?.contains(focused)) focused.blur();
    if (activeRef.current && was.paneId === paneRef.current && !coarseRef.current && !modalOpen()) {
      stackRef.current?.querySelector<HTMLTextAreaElement>(".composer-text")?.focus({ preventScroll: true });
    }
  }, [peek, chatMounted]); // eslint-disable-line react-hooks/exhaustive-deps -- read at the end only
  return { autoPeek, onCommandScreenClosed, stillOpen, stillOpenRef, setStillOpen, pendingOpenRef, undecidedOpenRef, chatHistoryRef, stillOpenNotedRef, onInputRowFrameRef, stillOpenNote, showStillOpen };
}
