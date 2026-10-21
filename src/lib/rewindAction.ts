/**
 * What a user message in Chat offers to go back to it, by the pane's agent. Claude Code's /rewind is
 * walked by the bridge and answered from a card ("card"). grok and agy keep a rewind the chat already
 * follows (server/grok.ts, server/agy.ts), but nothing reads their input box, so nothing may be typed
 * there: the action only opens the terminal for the user to run it ("terminal"). Others: no action.
 */
export type RewindAction = "card" | "terminal" | null;

export function rewindAction(agent: string | null): RewindAction {
  if (agent === "claude") return "card";
  return agent === "grok" || agent === "agy" ? "terminal" : null;
}

/** What the chat knows when it draws a user message: the pane, this connection and what is on its way. */
export interface RewindContext {
  agent: string | null;
  /** this connection may type into the pane (a watching device may not) */
  interactive: boolean;
  connected: boolean;
  ended: boolean;
  /** the chat is read from the agent's own transcript, not drawn from the screen */
  conversation: boolean;
  agentStatus?: string | null;
  /** a card is up */
  promptUp: boolean;
  /** the chat's message box */
  draft: string;
  sending: boolean;
  /** a rewind asked from this chat is on its way */
  pending: boolean;
}

/**
 * The action a user message shows. Claude Code's card only while the agent waits with nothing up, the
 * message box is empty (a draft would be lost under the restore) and no send or rewind is on its way;
 * grok's and agy's terminal whatever their state, since nothing is typed for them.
 */
export function rewindOffer(context: RewindContext): RewindAction {
  if (!context.interactive || !context.connected || context.ended || !context.conversation) return null;
  const action = rewindAction(context.agent);
  if (action !== "card") return action;
  const waiting = context.agentStatus === "idle" || context.agentStatus === "done";
  return waiting && !context.promptUp && context.draft.trim() === "" && !context.sending && !context.pending ? "card" : null;
}
