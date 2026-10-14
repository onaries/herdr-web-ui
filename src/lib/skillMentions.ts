import type { SlashCommand } from "../../shared/protocol.ts";

/** One skill name as an answer spells it: `/name`, or `$name` for a Codex skill. */
export interface SkillMention {
  /** the exact text in the answer, trigger included: what a copy yields */
  raw: string;
  name: string;
}

export type SkillSplit = string | SkillMention;

/** Splits plain answer text around the skill names in it; null when the pane lists no skill. */
export type SkillMatcher = (text: string) => SkillSplit[];

/** A name does not start inside a word, a path or an address. */
const BEFORE = /[\w/.:~$@#\\-]/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Matches only skills the pane's command list names, whole, in the form they are typed (`/name`;
 * `$name` for a Codex skill). A bare word never matches, nor does a longer name that merely starts
 * with a skill's (`/review-all` for `review`), a path (`/review/x`, `a/review`) or a file (`/review.md`).
 */
export function createSkillMatcher(commands: readonly SlashCommand[]): SkillMatcher | null {
  const names = new Map<string, string>();
  for (const command of commands) {
    if (command.source !== "skill" || command.name === "") continue;
    const trigger = command.trigger ?? "/";
    names.set(trigger + command.name, command.name);
  }
  if (names.size === 0) return null;
  // longest first, so `/review-pr` is not cut at a skill named `review`
  const alternatives = [...names.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|");
  const pattern = new RegExp(`(?:${alternatives})(?![\\w:/-]|\\.\\w)`, "g");
  return (text) => {
    const out: SkillSplit[] = [];
    let cursor = 0;
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
      const start = match.index;
      if (start > 0 && BEFORE.test(text[start - 1] ?? "")) continue;
      const raw = match[0];
      if (start > cursor) out.push(text.slice(cursor, start));
      out.push({ raw, name: names.get(raw) ?? raw.slice(1) });
      cursor = start + raw.length;
    }
    if (cursor === 0) return [text];
    if (cursor < text.length) out.push(text.slice(cursor));
    return out;
  };
}
