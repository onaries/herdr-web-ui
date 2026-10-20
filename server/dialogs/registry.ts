import { readers } from "./index.ts";
import { claudeModelListWaits, CLAUDE_EFFORT_GUARD_RE } from "./claude.ts";
import { codexModelListWaits } from "./codex.ts";
import type { DialogReader, OmoAsk } from "./shared.ts";
export type { DialogReader } from "./shared.ts";

export interface ReaderContext {
  agent: string;
  omoAsk: OmoAsk | null;
  omoTrusted: boolean;
  omoOpen: OmoAsk[];
  sent: string | null;
  working: boolean;
  /** Fallback cards are read only after the caller knows the pane is blocked. */
  fallback?: boolean;
}

export function readersFor(agent: string): readonly DialogReader[] {
  return readers.filter((reader) => reader.agents.includes(agent) || reader.agents.includes("*")).sort((a, b) => a.priority - b.priority);
}

export const registry = {
  readersFor,
  readerFor(responder: string): DialogReader | undefined {
    return readers.find((reader) => reader.id === responder);
  },
  waits(agent: string, screen: string): boolean {
    return claudeModelListWaits(screen) || claudeModelListWaits(screen, CLAUDE_EFFORT_GUARD_RE) || (agent === "codex" && codexModelListWaits(screen));
  },
};
