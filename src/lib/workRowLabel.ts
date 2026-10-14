import { isToolNarration, toolVerb } from "./toolVerbs.ts";

/** Narration owns the visible label; the verb still determines the existing detail layout. */
export function workRowLabel(part: { name: string; input: string }, summary: string): { narration: boolean; verb: string | null } {
  return { narration: isToolNarration(part, summary), verb: toolVerb(part, summary) };
}
