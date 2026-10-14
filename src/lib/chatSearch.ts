export interface ChatSearchRow {
  readonly key: string;
  /** The source text whose offsets a consumer will highlight. */
  readonly text: string;
}

export interface ChatSearchMatch {
  readonly rowKey: string;
  /** UTF-16 offset in the matching row's source text, inclusive. */
  readonly start: number;
  /** UTF-16 offset in the matching row's source text, exclusive. */
  readonly end: number;
}

export interface ChatSearchResult {
  readonly matches: readonly ChatSearchMatch[];
  readonly count: number;
}

/**
 * Finds non-overlapping literal matches across every supplied logical row.
 * It deliberately does not inspect DOM nodes or fetch unloaded history.
 */
export function searchLoadedChatRows(rows: readonly ChatSearchRow[], query: string, matchCase = false): ChatSearchResult {
  if (query.length === 0) return { matches: [], count: 0 };

  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), matchCase ? "gu" : "giu");
  const matches: ChatSearchMatch[] = [];
  for (const row of rows) {
    for (const match of row.text.matchAll(pattern)) matches.push({ rowKey: row.key, start: match.index, end: match.index + match[0].length });
  }
  return { matches, count: matches.length };
}
import type { ConversationTurn } from "../../shared/protocol.ts";


/** Searches only source the conversation response actually supplied, including folded work. */
export function chatSearchText(turn: ConversationTurn, wholeOutputs?: ReadonlyMap<string, string>): string {
  return turn.parts.map((part) => {
    switch (part.kind) {
      case "text": case "thinking": case "compact": case "notice": return part.text;
      case "tool": return [part.name, part.summary, part.input, part.output_ref === undefined ? part.output : wholeOutputs?.get(part.output_ref) ?? part.output].join("\n");
      case "skill": return [part.skill.name, part.skill.path ?? ""].join("\n");
      case "task_result": return part.tasks.map((task) => `${task.title}\n${task.result}`).join("\n");
      case "image": return "";
    }
  }).filter(Boolean).join("\n\n");
}
