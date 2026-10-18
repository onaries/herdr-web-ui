/**
 * The mode a new Claude Code or Codex agent starts in (Settings > Chat > New agents), as the
 * arguments herdr's `agent start` passes after `--`. "default" adds none, so the agent follows
 * its own configuration; an older agent that lacks a mode refuses to start and says why.
 */

/** Claude Code's `--permission-mode` choices; "default" leaves the flag out */
export const CLAUDE_LAUNCH_MODES = ["default", "acceptEdits", "auto", "plan", "dontAsk", "bypassPermissions"] as const;
export type ClaudeLaunchMode = (typeof CLAUDE_LAUNCH_MODES)[number];

/** Codex's `/approvals` presets, each a sandbox and an approval policy; "default" leaves both out */
export const CODEX_LAUNCH_MODES = ["default", "readOnly", "auto", "fullAccess"] as const;
export type CodexLaunchMode = (typeof CODEX_LAUNCH_MODES)[number];

const CODEX_ARGS: Record<Exclude<CodexLaunchMode, "default">, string[]> = {
  readOnly: ["--sandbox", "read-only", "--ask-for-approval", "on-request"],
  auto: ["--sandbox", "workspace-write", "--ask-for-approval", "on-request"],
  fullAccess: ["--sandbox", "danger-full-access", "--ask-for-approval", "never"],
};

/** The arguments a new agent of `kind` starts with; undefined when there are none to add. */
export function launchArgs(kind: string, modes: { claudeLaunchMode: ClaudeLaunchMode; codexLaunchMode: CodexLaunchMode }): string[] | undefined {
  if (kind === "claude" && modes.claudeLaunchMode !== "default") return ["--permission-mode", modes.claudeLaunchMode];
  if (kind === "codex" && modes.codexLaunchMode !== "default") return [...CODEX_ARGS[modes.codexLaunchMode]];
  return undefined;
}

/** The `agent` of a create request: the kind and the arguments its mode adds; null for a plain shell. */
export function launchAgent(kind: string, modes: { claudeLaunchMode: ClaudeLaunchMode; codexLaunchMode: CodexLaunchMode }): { kind: string; args?: string[] } | null {
  if (!kind) return null;
  const args = launchArgs(kind, modes);
  return args === undefined ? { kind } : { kind, args };
}
