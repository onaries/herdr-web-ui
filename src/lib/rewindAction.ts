/** Supported agents hand rewind to their own terminal; this action sends no input. */
export type RewindAction = "terminal" | null;

export function rewindAction(agent: string | null): RewindAction {
  return agent === "claude" || agent === "grok" || agent === "agy" ? "terminal" : null;
}

/** The pane and connection must still be available, with a native conversation. */
export interface RewindContext {
  agent: string | null;
  interactive: boolean;
  connected: boolean;
  ended: boolean;
  conversation: boolean;
}

export function rewindOffer(context: RewindContext): RewindAction {
  if (!context.interactive || !context.connected || context.ended || !context.conversation) return null;
  return rewindAction(context.agent);
}
