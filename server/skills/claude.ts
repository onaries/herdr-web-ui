import { dirname, join, resolve } from "node:path";
import type { AgentCommandSource } from "./index.ts";
import { readFileSync } from "node:fs";
import { ancestorsToRepoRoot, customCommands, environValue, walkSkills } from "./walk.ts";
import type { SlashCommand } from "../../shared/protocol.ts";

/**
 * Claude Code 2.1.301. --add-dir and lazily activated descendant .claude/skills
 * are not observable here. Binary-compiled skills have no discoverable bundled group; the
 * palette's doctor, init, insights, security-review, statusline and team-onboarding run when
 * typed, so they are offered as builtins.
 * The recorded screen check excludes config, hooks, permissions, plugin, resume,
 * skills and theme: their screens returned no representable prompt.
 */
export const unrepresentable = ["config", "hooks", "permissions", "plugin", "resume", "skills", "theme"] as const;

function claudeSkills(root: string, origin: SlashCommand["origin"], prefix?: string): SlashCommand[] {
  return walkSkills(root, { depth: "one", looseMarkdown: "none", ignoreFiles: false, requireDescription: false })
    .filter(({ fields }) => fields["user-invocable"] !== false)
    .map(({ name, description }) => ({ name: prefix ? `${prefix}:${name}` : name, description, source: "skill", origin }));
}

/** A linked worktree points into <main>/.git/worktrees/<name>, never a sibling checkout. */
function mainCheckout(repo: string): string | null {
  try {
    const gitdir = readFileSync(join(repo, ".git"), "utf8").match(/^gitdir:\s*(.+)\s*$/)?.[1];
    if (!gitdir) return null;
    const directory = resolve(repo, gitdir.trim());
    const common = readFileSync(join(directory, "commondir"), "utf8").trim();
    return common ? dirname(resolve(directory, common)) : null;
  } catch { return null; /* not a linked worktree */ }
}

function managedSettingsDir(): string {
  if (process.platform === "darwin") return "/Library/Application Support/ClaudeCode";
  if (process.platform === "win32") return join(process.env.ProgramFiles ?? "C:\\Program Files", "ClaudeCode");
  return "/etc/claude-code";
}

/**
 * The skills and commands of the Claude plugins turned on in settings.json, as Claude
 * offers them: `/<plugin>:<name>`.
 */
function pluginCommands(config: string): SlashCommand[] {
  const read = (path: string): unknown => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } };
  const enabled = (read(join(config, "settings.json")) as { enabledPlugins?: Record<string, unknown> } | null)?.enabledPlugins ?? {};
  const installed = (read(join(config, "plugins", "installed_plugins.json")) as { plugins?: Record<string, Array<{ installPath?: unknown }>> } | null)?.plugins ?? {};
  const result: SlashCommand[] = [];
  for (const [id, on] of Object.entries(enabled)) {
    if (on !== true) continue;
    const installPath = installed[id]?.[0]?.installPath;
    if (typeof installPath !== "string") continue;
    const plugin = id.split("@")[0]!;
    result.push(...claudeSkills(join(installPath, "skills"), "plugin", plugin));
    result.push(...customCommands(join(installPath, "commands"), "plugin").map((command) => ({ ...command, name: `${plugin}:${command.name}` })));
  }
  return result;
}


export const source: AgentCommandSource = {
  builtins: [
    "add-dir", "advisor", "artifacts", "auto-mode-setup", "autocompact", "autofix-pr",
    "background", "branch", "btw", "bug", "cd", "chrome", "clear", "color", "compact",
    "context", "copy", "design-login", "diff", "doctor", "effort", "exit", "export", "fast",
    "feedback", "focus", "fork", "goal", "help", "ide", "import", "init", "insights", "install-github-app",
    "install-slack-app", "keybindings", "list-agents", "login", "logout", "mcp", "memory",
    "mobile", "model", "output-style", "passes", "plan", "powerup", "privacy-settings",
    "radio", "rate-limit-options", "recap", "release-notes", "reload-plugins", "reload-skills",
    "remote-control", "remote-env", "rename", "rewind", "sandbox", "security-review", "skill-doctor",
    "status", "statusline", "stickers", "subtask", "tasks", "team-onboarding", "teleport",
    "terminal-setup", "tui", "ultrareview",
    "upgrade", "usage", "usage-credits", "voice", "web-setup", "workflows",
  ],
  descriptions: {
    "add-dir": "Add a new working directory", advisor: "Let Claude consult a stronger model",
    artifacts: "Browse published and shared artifacts", "auto-mode-setup": "Teach auto mode about your environment",
    autocompact: "Set how full context gets before summarizing", "autofix-pr": "Monitor and autofix issues with the current pull request",
    background: "Send this session to the background", branch: "Branch the current conversation",
    btw: "Ask a side question without interrupting the current work", bug: "Report a bug or share your conversation",
    cd: "Move this session to a new working directory", chrome: "Open Claude in Chrome settings",
    color: "Set the prompt bar color", context: "Show current context usage",
    doctor: "Health-check your Claude Code setup and fix issues", init: "Initialize a new CLAUDE.md file with codebase documentation",
    insights: "Generate a report analyzing your Claude Code sessions", "security-review": "Complete a security review of the pending changes",
    statusline: "Set up Claude Code's status line UI", "team-onboarding": "Help teammates ramp on Claude Code with a guide from your usage",
    copy: "Copy a response to the clipboard", "design-login": "Authorize design-system access",
    export: "Export the conversation to a file or clipboard", fast: "Toggle fast mode",
    feedback: "Send feedback or report a bug", focus: "Toggle the focused conversation view",
    fork: "Copy this conversation into a background session", ide: "Manage IDE integrations",
    import: "Import configuration from another coding agent", "install-github-app": "Set up Claude GitHub Actions",
    "install-slack-app": "Install the Claude Slack app", keybindings: "Open keyboard shortcuts",
    "list-agents": "List subagents, teammates and other sessions", mcp: "Manage MCP servers",
    mobile: "Show a QR code for the mobile app", "output-style": "List or switch output styles",
    passes: "Share a free week of Claude Code", plan: "Enable plan mode or view the session plan",
    powerup: "Discover Claude Code features through interactive lessons", "privacy-settings": "View and update privacy settings",
    radio: "Listen to Claude FM radio", "rate-limit-options": "Manage usage limits and upgrade options",
    recap: "Generate a one-line session recap", "reload-plugins": "Activate pending plugin changes",
    "reload-skills": "Reload skills added or changed on disk", "remote-control": "Control this session from your phone or browser",
    "remote-env": "Choose the default cloud environment", rename: "Rename the current conversation",
    rewind: "Restore code or conversation to an earlier point", sandbox: "Configure sandboxing",
    "skill-doctor": "Show unused skills that cost context", stickers: "Order Claude Code stickers",
    subtask: "Send a subagent off with the full context", tasks: "View and manage background work",
    teleport: "Send this session to the cloud or resume a cloud session", tui: "Set the terminal UI renderer",
    ultrareview: "Start a cloud agent that finds and verifies bugs", upgrade: "Upgrade your plan",
    usage: "Show session cost, plan usage and activity", "usage-credits": "Configure or request usage credits",
    voice: "Toggle voice mode", "web-setup": "Set up cloud sessions with GitHub", workflows: "Browse workflows",
  },
  discover({ home, cwd, env }) {
    const config = environValue(env, "CLAUDE_CONFIG_DIR") || join(home, ".claude");
    const ancestors = cwd ? ancestorsToRepoRoot(cwd) : [];
    const projectSkills = ancestors.flatMap((directory) => claudeSkills(join(directory, ".claude", "skills"), "project"));
    const repo = ancestors.at(-1);
    if (repo && projectSkills.length === 0) {
      const main = mainCheckout(repo);
      if (main) projectSkills.push(...claudeSkills(join(main, ".claude", "skills"), "project"));
    }
    // Skills beat legacy command files; within each kind enterprise > personal > nearest project.
    const candidates = [
      ...claudeSkills(join(managedSettingsDir(), ".claude", "skills"), "user"),
      ...claudeSkills(join(config, "skills"), "user"),
      ...claudeSkills(join(config, "skills", "synced"), "user", "anthropic-skills"),
      ...projectSkills,
      ...customCommands(join(config, "commands"), "user"),
      ...ancestors.flatMap((directory) => customCommands(join(directory, ".claude", "commands"), "project")),
      ...pluginCommands(config),
    ];
    const seen = new Set<string>();
    return candidates.filter(({ name }) => {
      if (seen.has(name)) return false;
      seen.add(name);
      return true;
    });
  },
};
