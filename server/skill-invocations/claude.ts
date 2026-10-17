import type { SkillActivity } from "../../shared/protocol.ts";
import { source, unrepresentable } from "../skills/claude.ts";

/** The recorded Claude command echo, not arbitrary XML embedded in a user's prose. */
export function claudeCommandEcho(text: string): { text: string; skill: SkillActivity } | null {
  const match = /^<command-message>([\p{L}\p{N}_:-]+)<\/command-message>\s*<command-name>\/([\p{L}\p{N}_:-]+)<\/command-name>\s*<command-args>([\s\S]*)<\/command-args>$/u.exec(text.trim());
  if (!match || match[1] !== match[2]) return null;
  const name = match[1];
  if (!name || source.builtins.includes(name) || unrepresentable.some((builtin) => builtin === name)) return null;
  const args = match[3]?.trim();
  return { text: `/${name}${args ? ` ${args}` : ""}`, skill: { name, evidence: "invocation", status: "requested" } };
}
