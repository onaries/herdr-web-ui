import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { SlashCommand } from "../../shared/protocol.ts";
import type { AgentCommandSource } from "./index.ts";
import { ancestorsToRepoRoot, readFrontmatter, walkSkills } from "./walk.ts";

// agy 1.2.16's embedded migration guide, checked with
// strings ~/.local/bin/agy | rg 'gemini/config/skills', names ~/.gemini/config/skills.
// ~/.gemini/antigravity-cli/skills is not in that binary and is deliberately not scanned.
// The 1.4.0 recorded palette is retained except the screens proven unrepresentable in
// agy-screens.txt (including their aliases). Bundled skills are discovered, not invented.
const descriptions = {
  "add-dir": "Add a directory to the workspace", artifact: "View and review artifacts",
  "agy-customizations": "Guide to the Antigravity Customization System",
  "antigravity-guide": "Guide and reference for Google Antigravity",
  btw: "Ask a side question without interrupting the current task",
  fork: "Branch the current conversation", branch: "Branch the current conversation",
  browser: "Invoke a browser agent for web tasks", boost: "Invoke the Boost multi-agent orchestrator",
  feedback: "Submit feedback about the agent", changelog: "Show release notes and changes",
  clear: "Clear conversation and start a new one", new: "Clear conversation and start a new one",
  codesearch: "Search code in the workspace", cs: "Search code in the workspace", search: "Search code in the workspace",
  context: "Visualize current context usage", diff: "View uncommitted changes and per-turn diffs",
  rewind: "Rewind conversation to a previous message", undo: "Rewind conversation to a previous message",
  exit: "Exit the CLI", quit: "Exit the CLI", help: "Show commands and keybindings",
  open: "Open a file or view opened and edited files", goal: "Run until the specified goal is finished",
  "grill-me": "Interview me to align on a plan", usage: "View model quota usage", quota: "View model quota usage",
  schedule: "Run an instruction on a schedule or as a one-time timer",
  title: "Toggle the terminal window title", tasks: "View background tasks", logout: "Log out",
  learn: "Capture reusable skills or rules from recent work", plan: "Plan before executing a task",
  rename: "Rename the current conversation", copy: "Copy a planner response to the clipboard",
  "teamwork-preview": "Invoke a team of agents for a large project",
  "remote-control": "Turn remote control on or off", statusline: "Toggle the statusline",
} as const;
const rules = { depth: "one", looseMarkdown: "none", ignoreFiles: false, requireDescription: true } as const;
// agy's palette lists a bundled skill that is also a builtin (agy-customizations) once, as the
// builtin. A bundled skill named like an unrepresentable command is what that command's screen
// opens (plugin/SKILL.md: "Also triggered by the /plugin slash command"), so it is left out too.
const unrepresentable: ReadonlySet<string> = new Set(["model", "resume", "config", "permissions", "agents", "hooks", "mcp", "plugin", "skills", "voice", "effort", "keybindings"]);

export const source: AgentCommandSource = {
  builtins: Object.keys(descriptions),
  descriptions,
  discover({ home, cwd, repoRoot }) {
    const found = new Map<string, SlashCommand>();
    const add = (name: string, description: string, fields: Readonly<Record<string, unknown>>, origin: SlashCommand["origin"]): void => {
      if (fields["disable-slash-command"] === true || found.has(name) || (origin === "bundled" && (unrepresentable.has(name) || Object.hasOwn(descriptions, name)))) return;
      found.set(name, { name, description, source: "skill", origin });
    };
    const scan = (root: string, origin: SlashCommand["origin"]): void => {
      for (const skill of walkSkills(root, rules)) add(skill.name, skill.description, skill.fields, origin);
    };
    const declared = (directory: string, origin: SlashCommand["origin"]): void => {
      const path = join(directory, "skills.json");
      if (!existsSync(path)) return;
      let config: unknown;
      try { config = JSON.parse(readFileSync(path, "utf8")); }
      catch { return; /* invalid optional registration file */ }
      if (!config || typeof config !== "object" || !("entries" in config) || !Array.isArray(config.entries)) return;
      for (const entry of config.entries) {
        if (!entry || typeof entry !== "object" || typeof entry.path !== "string") continue;
        const root = entry.path.startsWith("~/") ? join(home, entry.path.slice(2)) : resolve(repoRoot ?? directory, entry.path);
        const excluded: unknown[] = Array.isArray(entry.exclude) ? entry.exclude : [];
        if (Array.isArray(entry.include_only)) {
          for (const name of entry.include_only) {
            if (typeof name !== "string" || excluded.includes(name)) continue;
            const fields = readFrontmatter(join(root, name, "SKILL.md"));
            if (typeof fields?.description !== "string" || !fields.description.trim()) continue;
            add(typeof fields.name === "string" && fields.name ? fields.name : basename(name), fields.description, fields, origin);
          }
        } else {
          for (const skill of walkSkills(root, rules)) {
            if (!excluded.includes(basename(dirname(skill.path)))) add(skill.name, skill.description, skill.fields, origin);
          }
        }
      }
    };
    const project = cwd ? ancestorsToRepoRoot(cwd) : [];
    for (const directory of project) {
      for (const prefix of [".agents", ".agent", "_agents", "_agent"]) scan(join(directory, prefix, "skills"), "project");
    }
    for (const directory of project) {
      for (const prefix of [".agents", ".agent", "_agents", "_agent"]) declared(join(directory, prefix), "project");
    }
    const config = join(home, ".gemini", "config");
    scan(join(config, "skills"), "user");
    const plugins = join(config, "plugins");
    if (existsSync(plugins)) {
      for (const plugin of readdirSync(plugins)) scan(join(plugins, plugin, "skills"), "plugin");
    }
    scan(join(home, ".gemini", "antigravity-cli", "builtin", "skills"), "bundled");
    declared(config, "user");
    return [...found.values()];
  },
};
