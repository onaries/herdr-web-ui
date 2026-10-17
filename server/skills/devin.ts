import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import type { SlashCommand } from "../../shared/protocol.ts";
import type { AgentCommandSource } from "./index.ts";
import { customCommands, environValue, plainObject, readFrontmatter, stripJsonc, walkSkills } from "./walk.ts";

/**
 * Devin 3000.11.92: config imports default on. Native roots are one level deep; imported
 * Claude/Copilot skills recurse. Invocation names are directory names, not display `name`.
 * The recorded palette excludes MCP prompts (server-dependent), cloud-only skills and commands,
 * and model/resume/config/hooks/mcp/theme whose recorded screens have no chat prompt.
 */
const descriptions = {
  usage: "Show session usage of credits / ACUs", context: "Show context window usage",
  mode: "Show or switch mode", bug: "Report a bug to the Devin CLI developers",
  handoff: "Hand off between local and Devin cloud", "accept-edits": "Switch to accept edits mode",
  autonomous: "Switch to autonomous mode", billing: "Choose whether a provider plan pays for its models",
  btw: "Ask a quick side question without disrupting the conversation", bypass: "Switch to bypass mode",
  clear: "Clear conversation history", cloud: "Switch this session to run in Devin cloud",
  continue: "Resume the most recent session or a given session", copy: "Copy the last response to clipboard",
  dangerous: "Switch to bypass mode", exit: "Exit the application", feedback: "Rate the last response",
  fork: "Fork the current session", fusion: "Choose a Fusion model", help: "Show available commands",
  "list-sessions": "List recent sessions", login: "Re-authenticate with Devin in this session",
  "login-status": "Show login and authentication status", logout: "Clear stored credentials and exit",
  normal: "Switch to normal mode", org: "Select your Devin organization", quit: "Exit the application",
  "rename-session": "Rename the current session", revert: "Revert back to a previous step",
  "rm-session": "Delete a session", "session-stats": "Show session statistics",
  shortcuts: "Show keyboard shortcuts", smart: "Switch to smart mode", steps: "List conversation steps",
  title: "Rename the current session", update: "Check for and install updates",
  upgrade: "Upgrade your subscription plan", yolo: "Switch to bypass mode",
  status: "Check authentication status", workspace: "List workspace directories",
  "add-dir": "Add an additional workspace directory", "undo-add-dir": "Remove a workspace directory",
  "remove-dir": "Remove a workspace directory", ask: "Switch to Ask mode",
  plan: "Switch to Plan mode or plan with a prompt", code: "Switch to Code mode or run a prompt",
  compact: "Force conversation compaction", fast: "Switch to the fastest available model",
  loop: "Run a prompt then auto-review the diff in a loop",
  goal: "Set a goal the agent keeps working on until it is done", recap: "Recap the session",
  share: "Share this conversation with your team on Devin",
} as const;

function config(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const json = stripJsonc(readFileSync(path, "utf8"));
    return plainObject(JSON.parse(json));
  } catch { return {}; /* optional malformed configuration */ }
}

export const source: AgentCommandSource = {
  builtins: Object.keys(descriptions),
  descriptions,
  discover({ home, cwd, repoRoot, env }) {
    const configHome = environValue(env, "XDG_CONFIG_HOME") ?? join(home, ".config");
    const dataHome = environValue(env, "XDG_DATA_HOME") ?? join(home, ".local", "share");
    const project = repoRoot ?? cwd;
    const imports = {
      ...plainObject(config(join(configHome, "devin", "config.json")).read_config_from),
      ...plainObject(project ? config(join(project, ".devin", "config.json")).read_config_from : null),
    };
    const found: { namespace: string; command: SlashCommand }[] = [];
    const add = (root: string, namespace: string, origin: SlashCommand["origin"], recursive = false, plugin = false): void => {
      for (const skill of walkSkills(root, { depth: recursive ? "recursive" : "one", looseMarkdown: "none", ignoreFiles: false, requireDescription: false })) {
        if (Array.isArray(skill.fields.triggers) && !skill.fields.triggers.includes("user")) continue;
        const name = basename(dirname(skill.path));
        found.push({ namespace, command: { name: plugin ? `${namespace}:${name}` : name, description: skill.description, source: "skill", origin } });
      }
    };
    // Native source roots share a precedence tier: first directory wins within each scope.
    for (const [base, origin] of [[home, "user"], [project, "project"]] as const) {
      if (!base) continue;
      const start = found.length;
      add(origin === "user" ? join(configHome, "devin", "skills") : join(base, ".devin", "skills"), "devin", origin);
      add(origin === "user" ? join(configHome, "cognition", "skills") : join(base, ".cognition", "skills"), "cognition", origin);
      add(join(base, ".agents", "skills"), "agents", origin);
      const seen = new Set<string>();
      for (let index = start; index < found.length;) {
        const item = found[index];
        if (!item) break;
        if (seen.has(item.command.name)) found.splice(index, 1);
        else { seen.add(item.command.name); index++; }
      }
      if (imports.windsurf !== false) add(origin === "user" ? join(home, ".codeium", "windsurf", "skills") : join(base, ".windsurf", "skills"), "windsurf", origin);
      if (imports.claude !== false) {
        add(join(base, ".claude", "skills"), "claude", origin, true);
        if (origin === "project") {
          const root = join(base, ".claude", "commands");
          for (const command of customCommands(root, "skill")) {
            const fields = readFrontmatter(join(root, ...command.name.split(":")) + ".md");
            if (Array.isArray(fields?.triggers) && !fields.triggers.includes("user")) continue;
            found.push({ namespace: "claude", command: { ...command, origin } });
          }
        }
      }
      if (imports.copilot !== false) add(origin === "user" ? join(environValue(env, "COPILOT_HOME") ?? join(home, ".copilot"), "skills") : join(base, ".github", "skills"), "copilot", origin, true);
    }
    const pluginRoot = join(dataHome, "devin", "cli", "plugins");
    const visited = new Set<string>();
    const plugins = (directory: string): void => {
      if (!existsSync(directory)) return;
      const canonical = realpathSync(directory);
      if (visited.has(canonical)) return;
      visited.add(canonical);
      const manifestPath = [".devin-plugin/plugin.json", ".claude-plugin/plugin.json", "plugin.json"].map((path) => join(directory, path)).find(existsSync);
      if (manifestPath) {
        const manifest = config(manifestPath);
        if (typeof manifest.name !== "string") return;
        const roots = manifest.skills === undefined ? ["skills"] : typeof manifest.skills === "string" ? [manifest.skills] : Array.isArray(manifest.skills) ? manifest.skills : [];
        for (const root of roots) if (typeof root === "string") {
          const path = join(directory, root);
          if (!relative(directory, path).split(sep).includes("..")) add(path, manifest.name, "plugin", false, true);
        }
        return;
      }
      for (const entry of readdirSync(directory)) {
        const path = join(directory, entry);
        try { if (statSync(path).isDirectory()) plugins(path); }
        catch { continue; /* broken plugin link */ }
      }
    };
    plugins(pluginRoot);
    const namespaces = new Map<string, Set<string>>();
    for (const { namespace, command } of found) {
      const sources = namespaces.get(command.name) ?? new Set<string>();
      sources.add(namespace);
      namespaces.set(command.name, sources);
    }
    const result = new Map<string, SlashCommand>();
    for (const { namespace, command } of found) {
      const name = (namespaces.get(command.name)?.size ?? 0) > 1 ? `${namespace}:${command.name}` : command.name;
      // Project overrides user only within the same source namespace.
      result.set(name, { ...command, name });
    }
    return [...result.values()];
  },
};
