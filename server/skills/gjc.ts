import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { AgentCommandSource } from "./index.ts";
import type { SlashCommand } from "../../shared/protocol.ts";
import { ancestorsToRepoRoot, customCommands, environRecord, walkSkills } from "./walk.ts";

// gjc 0.18.9's recorded palette, less the screens proved unrepresentable in
// gjc-screens.txt. Installed omg commands are discovered from files, not builtins.
const DESCRIPTIONS = {
  help: "Learn commands and beginner workflows",
  tutorial: "Open frictionless onboarding",
  clear: "Clear context while preserving this session ID",
  new: "Start a new session",
  star: "Star the current session for easier discovery",
  unstar: "Remove the star from the current session",
  session: "Show session info or delete the current session transcript/artifacts",
  goal: "Plan and track an autonomous goal",
  compact: "Compact context and continue this session",
  handoff: "Generate a handoff and continue in a new session",
  retry: "Retry or continue the last interrupted turn",
  copy: "Copy the last response for review or sharing",
  dump: "Dump the full transcript for review or sharing",
  export: "Export this session to an HTML file",
  language: "Change the interactive UI language, or show the current one",
  aside: "Run the Aside CLI from the composer",
  notify: "Notification status, health, test, recovery, and session on/off",
  "import-session": "Import a Codex or Claude transcript into native GJC history",
  pet: "Gajae pet living beside the composer",
  fast: "Toggle priority service tier (OpenAI service_tier=priority, Anthropic speed=fast)",
  routing: "Show or set up sub-agent model autorouting",
  jobs: "Show async background jobs status",
  transcript: "Browse the current session transcript",
  context: "Show active context token usage breakdown",
  progress: "Show a read-only project progress overview from durable goal, todo, workflow, agent, and verification artifacts",
  usage: "Show provider usage and limits",
  credential: "Switch this session's active stored account, or list accounts",
  changelog: "Show release notes and changelog entries",
  hotkeys: "Show all keyboard shortcuts",
  tools: "Show tools currently visible to the agent",
  extensions: "Configure skills, hooks, and MCPs.",
  monitors: "Open the monitor/cron jobs overlay",
  fork: "Choose an earlier prompt to continue in a new session",
  provider: "Set up API-compatible providers or login providers",
  login: "Login with OAuth provider",
  logout: "Logout from OAuth provider",
  ssh: "Manage SSH hosts (add, list, remove)",
  drop: "Delete the current session and start a new one",
  "contribute-pr": "Dump redacted session context and write a worker prompt for a separate terminal",
  btw: "Start an ephemeral multi-turn side chat using the current session context",
  background: "Detach UI and continue running in background",
  debug: "Open debug tools selector",
  memory: "Inspect and operate memory maintenance",
  rename: "Rename the current session, or regenerate the title from the conversation",
  move: "Move session to a different working directory",
  exit: "Exit the application",
  "dir-entry-ext": "(hook command)",
  "extension:notify": "Control notifications for this session (on, off, status).",
  init: "Generate AGENTS.md for current codebase",
} as const;

// Descriptions read from the installed binary's embedded SKILL.md frontmatter.
const BUNDLED = {
  autoresearch: "Goal-directed research missions that interleave web research with data experimentation and end on a structured best-effort verdict",
  "deep-interview": "Socratic deep interview with mathematical ambiguity gating before explicit execution approval",
  ralplan: "Consensus planning entrypoint that auto-gates vague ultragoal requests before execution",
  ultragoal: "Create and execute durable repo-native multi-goal plans over GJC goal mode artifacts.",
} as const;

function settings(agentDir: string): Readonly<Record<string, unknown>> {
  try {
    const config: unknown = Bun.YAML.parse(readFileSync(join(agentDir, "config.yml"), "utf8"));
    if (typeof config !== "object" || config === null || !("skills" in config)) return {};
    const skills = config.skills;
    return typeof skills === "object" && skills !== null && !Array.isArray(skills) ? Object.fromEntries(Object.entries(skills)) : {};
  } catch { return {}; /* missing or invalid YAML uses gjc's defaults */ }
}

export const source: AgentCommandSource = {
  builtins: Object.keys(DESCRIPTIONS),
  descriptions: DESCRIPTIONS,
  discover({ home, cwd, env }) {
    const environ = environRecord(env);
    const expand = (path: string): string => path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
    const agentDir = expand(environ.GJC_CODING_AGENT_DIR || environ.PI_CODING_AGENT_DIR || join(home, ".gjc", "agent"));
    const configDir = environ.GJC_CONFIG_DIR || environ.PI_CONFIG_DIR || ".gjc";
    const config = settings(agentDir);
    const ancestors = cwd ? ancestorsToRepoRoot(cwd) : [];
    const commands = new Map<string, SlashCommand>();
    const addCommands = (root: string, origin: "user" | "project"): void => {
      for (const command of customCommands(root, origin)) {
        if (!commands.has(command.name)) commands.set(command.name, command);
      }
    };
    for (const ancestor of ancestors) addCommands(join(ancestor, ".gjc", "commands"), "project");
    addCommands(join(agentDir, "commands"), "user");
    if (config.enabled === false) return [...commands.values()];
    const skills = new Map<string, SlashCommand>(Object.entries(BUNDLED).map(([name, description]) => [
      name, { name: `skill:${name}`, description, source: "skill", origin: "bundled" },
    ]));
    const addSkills = (root: string, origin: "user" | "project"): void => {
      for (const skill of walkSkills(root, { depth: "one", looseMarkdown: "none", ignoreFiles: false, requireDescription: true })) {
        // A missing frontmatter name falls back to the directory (unverified in gjc's docs).
        if (!skills.has(skill.name)) skills.set(skill.name, { name: `skill:${skill.name}`, description: skill.description, source: "skill", origin });
      }
    };
    if (config.enablePiProject !== false && config.trustProjectSkills !== false) {
      for (const ancestor of ancestors) addSkills(join(ancestor, ".gjc", "skills"), "project");
    }
    if (config.enablePiUser !== false) {
      for (const root of [join(agentDir, "skills"), join(home, configDir, "skills"), join(home, ".gjc", "skills")]) addSkills(root, "user");
      if (Array.isArray(config.customDirectories)) {
        for (const directory of config.customDirectories) {
          if (typeof directory !== "string") continue;
          const expanded = expand(directory);
          addSkills(isAbsolute(expanded) ? expanded : join(cwd ?? home, expanded), "user");
        }
      }
    }
    return [...commands.values(), ...skills.values()];
  },
};
