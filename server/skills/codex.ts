import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { SlashCommand } from "../../shared/protocol.ts";
import type { AgentCommandSource } from "./index.ts";
import { ancestorsToRepoRoot, environValue, piTemplates, plainObject, walkSkills } from "./walk.ts";

/**
 * Codex 0.162.1: todo 3 recorded .agents/skills loading, not project .codex/skills.
 * The latter is undocumented and unconfirmed, so it is deliberately not offered.
 * https://developers.openai.com/plugins/build/plugins documents
 * [plugins."plugin-name@marketplace-name"].enabled. The installed binary contains
 * plugins/cache and plugins_for_config; its cache is marketplace/plugin/version.
 * Neither the docs nor the binary's isolated "qualified name" string confirms
 * $plugin:skill syntax, so plugin skills retain their bare frontmatter names.
 * Builtins are the recorded palette minus the nine unrepresentable screen checks.
 */
function canonical(path: string): string {
  try { return realpathSync(path); }
  catch { return resolve(path); /* disabled paths may no longer exist */ }
}

export const source: AgentCommandSource = {
  builtins: ["model", "fast", "ide", "keymap", "vim", "experimental", "approve", "memories", "import",
    "review", "rename", "new", "archive", "delete", "fork", "worktree", "init", "compact", "recap", "plan",
    "goal", "side", "copy", "export", "raw", "tui", "diff", "mention", "status", "daemon", "warnings",
    "cd", "pwd", "usage", "title", "statusline", "pets", "logout", "exit", "feedback", "ps", "stop",
    "clear", "subagents"],
  descriptions: {
    model: "Choose what model and reasoning effort to use", fast: "1.5x speed",
    ide: "Include current selection, open files, and other context from your IDE",
    keymap: "Remap TUI shortcuts", vim: "Toggle Vim mode for the composer",
    experimental: "Toggle experimental features", approve: "Approve one retry of a recent auto-review denial",
    memories: "Configure memory use and generation", import: "Import setup, this project, and recent chats from Claude Code",
    review: "Review my current changes and find issues", rename: "Rename the current thread",
    new: "Start a new chat during a conversation", archive: "Archive this session",
    delete: "Permanently delete this session", fork: "Fork the current chat",
    worktree: "Start or continue a conversation in a new worktree", init: "Create an AGENTS.md file with instructions for Codex",
    compact: "Summarize conversation to prevent hitting the context limit", recap: "Summarize the current conversation now",
    plan: "Switch to Plan mode", goal: "Set or view the goal for a long-running task",
    side: "Start a side conversation in an ephemeral fork", copy: "Copy the last response or part of it",
    export: "Export the conversation as markdown", raw: "Toggle raw scrollback mode for copy-friendly terminal selection",
    tui: "Choose the TUI mode for the next launch", diff: "Show git diff (including untracked files)",
    mention: "Mention a file", status: "Show current session configuration and token usage",
    daemon: "Manage the local background server", warnings: "View retained warnings and diagnostic details",
    cd: "Change the current working directory", pwd: "Show the current working directory",
    usage: "View account usage or use a usage limit reset", title: "Configure which items appear in the terminal title",
    statusline: "Configure which items appear in the status line", pets: "Choose or hide the terminal pet",
    logout: "Log out of Codex", exit: "Exit Codex", feedback: "Send logs to maintainers",
    ps: "List background terminals", stop: "Stop all background terminals",
    clear: "Clear the terminal and start a new chat", subagents: "Switch between this session's subagents",
  },
  discover({ home, cwd, env }) {
    const codexHome = environValue(env, "CODEX_HOME") || join(home, ".codex");
    let config: Record<string, unknown> = {};
    try { config = plainObject(Bun.TOML.parse(readFileSync(join(codexHome, "config.toml"), "utf8"))); }
    catch { /* missing or malformed TOML leaves discovery ungated */ }
    const configured = plainObject(config.skills).config;
    const disabled = new Set((Array.isArray(configured) ? configured : []).flatMap((entry: unknown) => {
      const setting = plainObject(entry);
      return setting.enabled === false && typeof setting.path === "string" ? [canonical(setting.path)] : [];
    }));
    const result: SlashCommand[] = piTemplates(join(codexHome, "prompts"), "user").map((command) => ({ ...command, name: `prompts:${command.name}` }));
    const load = (root: string, origin: SlashCommand["origin"]): void => {
      for (const skill of walkSkills(root, { depth: "one", looseMarkdown: "none", ignoreFiles: false, requireDescription: true })) {
        if (typeof skill.fields.name !== "string" || !skill.fields.name.trim() || disabled.has(canonical(skill.path))) continue;
        result.push({ name: skill.name, description: skill.description, source: "skill", trigger: "$", origin });
      }
    };
    for (const directory of cwd ? ancestorsToRepoRoot(cwd) : []) load(join(directory, ".agents", "skills"), "project");
    load(join(home, ".agents", "skills"), "user");
    load(join(codexHome, "skills"), "user");
    load(join(codexHome, "skills", ".system"), "bundled");
    load("/etc/codex/skills", "bundled");

    const cache = join(codexHome, "plugins", "cache");
    const plugins = config.plugins === undefined ? null : plainObject(config.plugins);
    const ancestors = new Set<string>();
    // A version's `latest` link and the version itself are one plugin install, loaded once.
    const loaded = new Set<string>();
    const visit = (directory: string): void => {
      let path: string;
      try { path = realpathSync(directory); } catch { return; /* optional cache */ }
      if (ancestors.has(path)) return;
      ancestors.add(path);
      try {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const child = join(directory, entry.name);
          try { if (!statSync(child).isDirectory()) continue; }
          catch { continue; /* a stale link hides only itself */ }
          if (entry.name === "skills") {
            if (loaded.has(canonical(child))) continue;
            loaded.add(canonical(child));
            const parts = relative(cache, directory).split(sep);
            const enabled = plugins === null || Object.entries(plugins).some(([key, value]) => {
              const [plugin, marketplace] = key.split("@");
              return plainObject(value).enabled === true && (parts[0] === key || parts[0] === plugin
                || (parts[0] === marketplace && parts[1] === plugin));
            });
            if (enabled) load(child, "plugin");
          } else if (!entry.name.startsWith(".")) visit(child);
        }
      } catch { /* unreadable or broken cache entry */ }
      finally { ancestors.delete(path); }
    };
    visit(cache);
    return result;
  },
};
