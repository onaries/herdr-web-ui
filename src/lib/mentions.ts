export type ActiveTrigger = {
  kind: "slash" | "file";
  /** `$`: a skill named the way Codex takes it (`$name`), anywhere a word starts; absent for `/` */
  prefix?: "$";
  query: string;
  /** Inclusive index of the trigger character. */
  start: number;
  /** Exclusive end of the token being completed. */
  end: number;
};

const SLASH_QUERY = /^[\p{L}\p{N}_-]*$/u;
const FILE_QUERY = /^\S+$/u;

// A skill token stops at the first character a skill name cannot hold, so `/del,` keeps its comma.
function tokenEnd(text: string, from: number, part: RegExp = /\S/u): number {
  let end = from;
  while (end < text.length && part.test(text[end] ?? "")) end += 1;
  return end;
}
const SKILL_CHAR = /[\p{L}\p{N}_-]/u;

/**
 * Finds the completion token at the caret. `/` begins a word; the caller limits later tokens
 * to skills its agent honours there. With `skills`, `$skill` also completes (Codex's syntax).
 */
export function activeTrigger(text: string, caret: number, options: { skills?: boolean } = {}): ActiveTrigger | null {
  if (!Number.isInteger(caret) || caret < 0 || caret > text.length) return null;

  const lineStart = text.lastIndexOf("\n", Math.max(0, caret - 1)) + 1;
  if (options.skills) {
    const dollar = text.lastIndexOf("$", Math.max(0, caret - 1));
    const query = dollar >= lineStart ? text.slice(dollar + 1, caret) : "";
    if (dollar >= lineStart && (dollar === 0 || /\s/u.test(text[dollar - 1] ?? "")) && SLASH_QUERY.test(query)) {
      return { kind: "slash", prefix: "$", query, start: dollar, end: tokenEnd(text, caret, SKILL_CHAR) };
    }
  }
  const slash = text.lastIndexOf("/", Math.max(0, caret - 1));
  if (slash >= lineStart && (slash === 0 || /\s/u.test(text[slash - 1] ?? ""))) {
    const query = text.slice(slash + 1, caret);
    if (SLASH_QUERY.test(query)) {
      return { kind: "slash", query, start: slash, end: tokenEnd(text, caret, SKILL_CHAR) };
    }
  }

  const at = text.lastIndexOf("@", Math.max(0, caret - 1));
  if (at < lineStart) return null;
  const query = text.slice(at + 1, caret);
  if (query.length === 0 || !FILE_QUERY.test(query)) return null;
  return { kind: "file", query, start: at, end: tokenEnd(text, caret) };
}

/** Replaces exactly the active token and returns the caret position after the inserted completion.
 * A completion's trailing space reuses the space already after the token instead of doubling it,
 * and gives way to punctuation that follows it, leaving the caret before that punctuation. */
export function applyCompletion(
  text: string,
  trigger: ActiveTrigger,
  replacement: string,
): { text: string; caret: number } {
  const after = text.slice(trigger.end);
  const punctuated = replacement.endsWith(" ") && /^\p{P}/u.test(after);
  const inserted = replacement.endsWith(" ") && (after.startsWith(" ") || punctuated) ? replacement.slice(0, -1) : replacement;
  return { text: text.slice(0, trigger.start) + inserted + after, caret: trigger.start + (punctuated ? inserted : replacement).length };
}
