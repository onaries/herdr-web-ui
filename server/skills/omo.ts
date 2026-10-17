import { join } from "node:path";
import type { AgentCommandSource } from "./index.ts";
import { walkSkills } from "./walk.ts";
import type { SlashCommand } from "../../shared/protocol.ts";

/** senpi 2026.10.16's palette, with omo's application name. */
const OMO_DESCRIPTIONS: Record<string, string> = {
  settings: "Open settings menu", model: "Select model (opens selector UI)", thinking: "Set thinking level",
  "scoped-models": "Enable/disable models for Ctrl+P cycling", "favorite-models": "Manage favorite models for Ctrl+P cycling",
  export: "Export session (HTML default, or specify path: .html/.jsonl)", import: "Import and resume a session from a JSONL file",
  share: "Share session as a secret GitHub gist", copy: "Copy last agent message to clipboard",
  rename: "Rename the current session", name: "Alias of /rename (set session display name)", session: "Show session info and stats",
  changelog: "Show changelog entries", hotkeys: "Show all keyboard shortcuts", fork: "Create a new fork from a previous user message",
  clone: "Duplicate the current session at the current position", trust: "Save project trust decision for future sessions",
  login: "Configure provider authentication", logout: "Remove provider authentication", new: "Start a new session",
  compact: "Manually compact the session context", resume: "Resume a different session",
  sessions: "Alias of /resume (browse and resume past sessions)",
  reload: "Reload keybindings, extensions, skills, prompts, themes, and context files", quit: "Quit omo", exit: "Quit omo",
};

function omoSkills(root: string, mode: "pi" | "agents", origin: NonNullable<SlashCommand["origin"]>): SlashCommand[] {
  return walkSkills(root, { depth: "recursive", looseMarkdown: mode === "pi" ? "root" : "nested", ignoreFiles: true, requireDescription: true }).map(({ name, description }) => ({ name: `skill:${name}`, description, source: "skill", origin }));
}

export const source: AgentCommandSource = {
  builtins: ["settings", "model", "thinking", "scoped-models", "favorite-models", "export", "import", "share", "copy", "rename", "name", "session", "changelog", "hotkeys", "fork", "clone", "trust", "login", "logout", "new", "compact", "resume", "sessions", "reload", "quit", "exit"],
  descriptions: OMO_DESCRIPTIONS,
  discover({ home, roots }) {
    return [
      ...omoSkills(join(roots.agentDir ?? join(home, ".omo", "agent"), "skills"), "pi", "user"),
      ...omoSkills(join(home, ".agents", "skills"), "agents", "user"),
      ...(roots.pluginDir ? omoSkills(join(roots.pluginDir, "skills"), "pi", "bundled") : []),
    ];
  },
};
