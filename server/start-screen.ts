import type { ConversationMetadata, ConversationResponse } from "../shared/protocol.ts";

/**
 * The model and reasoning effort an agent's own screen states before its first message, when no
 * transcript records them yet. Only a line in the agent's own layout is read, and a model is
 * given the id its transcript will record only where the screen's name maps to it by the
 * vendor's regular rule (src/lib/modelName.ts); anything else stays unknown rather than guessed.
 * Captured live 2026-10-14: Claude Code 2.1.296, Codex 0.162.1, gjc 0.17.7.
 */
type Screen = Pick<ConversationMetadata, "model" | "reasoning_effort">;
const NOTHING: Screen = { model: null, reasoning_effort: null };

const CLAUDE_FAMILY = "opus|sonnet|haiku|fable|mythos";
const VERSION = "[1-9]\\d?";
const EFFORT = "none|minimal|low|medium|high|xhigh|max";

function lastMatch(lines: string[], pattern: RegExp): RegExpExecArray | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = pattern.exec(lines[index]!);
    if (match) return match;
  }
  return null;
}

/** `▝▜██████▀  Haiku 5.5 · Claude Max`, the line under `Claude Code v…`. */
function claudeScreen(lines: string[]): Screen {
  const title = lastMatch(lines, /Claude Code v\d/u);
  if (!title) return NOTHING;
  const named = new RegExp(`(?:^|\\s)(${CLAUDE_FAMILY}) (${VERSION})(?:\\.(0|${VERSION}))? · `, "iu").exec(lines[lines.indexOf(title.input) + 1] ?? "");
  if (!named) return NOTHING;
  return { model: `claude-${named[1]!.toLowerCase()}-${named[2]}${named[3] === undefined ? "" : `-${named[3]}`}`, reasoning_effort: null };
}

/** `  GPT-6-Luna medium fast · /folder`, the status line under the composer. */
function codexScreen(lines: string[]): Screen {
  if (!lines.some((line) => line.includes("OpenAI Codex (v"))) return NOTHING;
  const found = lastMatch(lines, new RegExp(`^\\s*(GPT-[\\w.-]+) (${EFFORT})(?: \\w+)? · `, "u"));
  return found ? { model: found[1]!.toLowerCase(), reasoning_effort: found[2]! } : NOTHING;
}

/** ` ⬢ opus-5.5 · ◉ xhigh · 1.5% / …`, the status line over the composer. */
function gjcScreen(lines: string[]): Screen {
  const found = lastMatch(lines, new RegExp(`⬢ (\\S+) · ◉ (${EFFORT})(?: |$)`, "u"));
  if (!found) return NOTHING;
  const claude = new RegExp(`^(${CLAUDE_FAMILY})-(${VERSION})(?:\\.(0|${VERSION}))?$`, "u").exec(found[1]!);
  const model = claude ? `claude-${claude[1]}-${claude[2]}${claude[3] === undefined ? "" : `-${claude[3]}`}` : found[1]!;
  return { model, reasoning_effort: found[2]! };
}

const SCREENS: Partial<Record<ConversationResponse["source"], (lines: string[]) => Screen>> = {
  "claude-transcript": claudeScreen,
  "codex-transcript": codexScreen,
  "gjc-transcript": gjcScreen,
};

export function readsStartScreen(source: ConversationResponse["source"]): boolean {
  return SCREENS[source] !== undefined;
}

export function startScreenMetadata(source: ConversationResponse["source"], screen: string): Screen {
  return SCREENS[source]?.(screen.split("\n")) ?? NOTHING;
}
