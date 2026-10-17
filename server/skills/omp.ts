import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { SlashCommand } from "../../shared/protocol.ts";
import type { AgentCommandContext, AgentCommandSource } from "./index.ts";
import { SkillIgnore } from "../skill-ignore.ts";
import { description, environRecord, plainObject, readFrontmatter, readSkillText, walkSkills } from "./walk.ts";

/**
 * omp 18.8.7: discovery/{builtin,omp-plugins,claude,agent-plugins,claude-plugins,
 * agents,codex,opencode,github}.ts and extensibility/skills.ts. Skills use the
 * provider's unqualified name, including plugin skills. No Python `$` menu.
 * Invocation-only extension/plugin roots cannot be recovered from file settings.
 */
const BUILTINS = [
  "login", "logout", "review", "goal", "session", "usage", "security", "setup", "plan",
  "plan-review", "vibe", "guided-goal", "loop", "queue", "switch", "fast", "slow", "extended-context", "computer", "prewalk",
  "advisor", "export", "trace", "dump", "share", "collab", "join", "leave", "browser",
  "copy", "open", "todo", "jobs", "stats", "changelog", "hotkeys", "tools", "context",
  "extensions", "git", "hub", "branch", "fork", "ssh", "new", "fresh", "clear",
  "delete", "compact", "shake", "handoff", "pin", "btw", "tan", "omfg", "cleanse",
  "retry", "debug", "memory", "rename", "move", "wt", "add-dir", "remove-dir", "dirs",
  "exit", "restart", "marketplace", "reload-plugins", "force", "live", "record",
  "pause", "quit", "autoresearch", "green", "init",
] as const;
// Palette minus the recorded unrepresentable model/resume/settings/agents/mcp/
// plugins/skills/effort screens and terminal-only tree. `skill:` is a group, not a command.

const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
function config(path: string): Record<string, unknown> {
  try { return plainObject(path.endsWith(".json") ? JSON.parse(readFileSync(path, "utf8")) : Bun.YAML.parse(readFileSync(path, "utf8"))); }
  catch { return {}; /* optional config, including malformed YAML, does not gate discovery */ }
}
function files(directory: string, recursive = false): string[] {
  const ignore = new SkillIgnore();
  const ancestors: string[] = [];
  for (let dir = directory; ; dir = dirname(dir)) {
    ancestors.unshift(dir);
    if (existsSync(join(dir, ".git")) || dirname(dir) === dir) break;
  }
  for (const dir of ancestors) {
    try { ignore.add(readFileSync(join(dir, ".gitignore"), "utf8"), relative(ancestors[0] ?? directory, dir).split(sep).filter(Boolean).join("/") + (dir === ancestors[0] ? "" : "/")); }
    catch { /* optional gitignore */ }
  }
  try {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name.startsWith(".")) return [];
      const path = join(directory, entry.name);
      if (ignore.ignores(relative(ancestors[0] ?? directory, path).split(sep).join("/") + (entry.isDirectory() ? "/" : ""))) return [];
      if (recursive && entry.isDirectory()) return files(path, true);
      if (!entry.name.endsWith(".md")) return [];
      if (entry.isFile()) return [path];
      try { return entry.isSymbolicLink() && statSync(path).isFile() ? [path] : []; }
      catch { return []; /* dangling link */ }
    });
  } catch { return []; /* absent or unreadable provider */ }
}
type Level = "user" | "project";
interface Root {
  readonly path: string;
  readonly level: Level;
  readonly provider: string;
  readonly origin?: "plugin";
  readonly plugin?: string;
}

function discover(ctx: AgentCommandContext): SlashCommand[] {
  const { home } = ctx;
  const cwd = ctx.cwd ?? home;
  const env = environRecord(ctx.env);
  const expand = (path: string): string => resolve(cwd, path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path);
  const configRoot = join(home, env.PI_CONFIG_DIR || ".omp");
  const baseConfig = config(join(configRoot, "agent", "config.yml"));
  const profile = env.OMP_PROFILE ?? env.PI_PROFILE ?? (typeof baseConfig.profile === "string" ? baseConfig.profile : "");
  const named = profile && profile !== "default" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(profile) && profile !== "." && profile !== "..";
  const agentDir = ctx.roots.agentDir || (named ? join(configRoot, "profiles", profile, "agent") : env.PI_CODING_AGENT_DIR ? expand(env.PI_CODING_AGENT_DIR) : join(configRoot, "agent"));
  // Settings belong to the active profile; cwd config overrides user config.
  const settings = config(join(agentDir, "config.yml"));
  const projectSettings = config(join(cwd, ".omp", "config.yml"));
  const skillsSettings = { ...plainObject(settings.skills), ...plainObject(projectSettings.skills) };
  const commandSettings = { ...plainObject(settings.commands), ...plainObject(projectSettings.commands) };
  const ancestors: string[] = [];
  for (let dir = cwd; ; dir = dirname(dir)) {
    ancestors.push(dir);
    if (existsSync(join(dir, ".git")) || dir === home || dirname(dir) === dir) break;
  }
  const root = (path: string, level: Level, provider: string): Root => ({ path, level, provider });
  const project = (dir: string, provider: string): Root[] =>
    ancestors.filter((path) => path !== home).map((path) => root(join(path, dir), "project", provider));
  const nativeUser = root(agentDir, "user", "native");
  const nativeProject = root(join(cwd, ".omp"), "project", "native");
  const native = [nativeProject, nativeUser];
  const nativeSkills = [...ancestors.map((dir) => root(join(dir, ".omp"), "project", "native")), nativeUser];
  const claudeDir = env.CLAUDE_CONFIG_DIR ? expand(env.CLAUDE_CONFIG_DIR) : join(home, ".claude");
  const claude = [root(claudeDir, "user", "claude"), ...project(".claude", "claude")];
  const agents = [...ancestors.filter((dir) => dir !== home).flatMap((dir) => [".agent", ".agents"].map((name) => root(join(dir, name), "project", "agents"))),
    ...[".agent", ".agents"].map((name) => root(join(home, name), "user", "agents"))];
  const codex = [root(join(home, ".codex"), "user", "codex"), root(join(cwd, ".codex"), "project", "codex")];
  const opencode = [root(join(home, ".config", "opencode"), "user", "opencode"), root(join(cwd, ".opencode"), "project", "opencode")];
  const github = root(join(cwd, ".github"), "project", "github");

  const extensions: Root[] = [];
  for (const scope of native) {
    const settings = config(join(scope.path, "settings.json"));
    for (const path of strings(settings.extensions)) extensions.push({ ...scope, path: expand(path), provider: "omp-plugins", origin: "plugin" });
  }
  const pluginRoot = join(configRoot, "plugins");
  const pluginScopes = [root(pluginRoot, "user", "omp-plugins"),
    root(join(ancestors.find((dir) => existsSync(join(dir, ".omp")) || existsSync(join(dir, ".git"))) ?? cwd, ".omp", "plugins"), "project", "omp-plugins")];
  const overrides = config(join(cwd, ".omp", "plugin-overrides.json"));
  const installed = new Map<string, Root>();
  for (const scope of pluginScopes) {
    const runtime = plainObject(config(join(scope.path, "omp-plugins.lock.json")).plugins);
    const dependencies = plainObject(config(join(scope.path, "package.json")).dependencies);
    for (const name of new Set([...Object.keys(dependencies), ...Object.keys(runtime)])) {
      const path = join(scope.path, "node_modules", name);
      const pkg = config(join(path, "package.json"));
      if ((!pkg.omp && !pkg.pi) || plainObject(runtime[name]).enabled === false || strings(overrides.disabled).includes(name)) continue;
      installed.set(name, { ...scope, path, origin: "plugin" });
    }
  }
  extensions.push(...installed.values());
  // Installed registries, not arbitrary cache versions, determine active marketplace plugins.
  const marketplaces = new Map<string, Root[]>();
  const enabledPlugins = Object.assign({}, plainObject(config(join(claudeDir, "settings.json")).enabledPlugins),
    ...[...ancestors].reverse().flatMap((dir) => ["settings.json", "settings.local.json"].map((name) => plainObject(config(join(dir, ".claude", name)).enabledPlugins))));
  for (const scope of [root(join(claudeDir, "plugins"), "user", "claude-plugins"), ...pluginScopes]) {
    for (const [id, entries] of Object.entries(plainObject(config(join(scope.path, "installed_plugins.json")).plugins))) {
      const roots: Root[] = [];
      for (const entry of Array.isArray(entries) ? entries : []) {
        const record = plainObject(entry);
        if (record.enabled === false || typeof record.installPath !== "string") continue;
        const level = record.scope === "project" || record.scope === "local" || scope.level === "project" ? "project" : "user";
        if (scope.provider === "claude-plugins" && (enabledPlugins[id] === false || (level === "project" && enabledPlugins[id] !== true && record.projectPath !== (ancestors.find((dir) => existsSync(join(dir, ".git"))) ?? cwd)))) continue;
        roots.push({ path: record.installPath, level, provider: "claude-plugins", origin: "plugin", plugin: id.split("@")[0] });
      }
      marketplaces.set(id, roots);
    }
  }
  const marketplaceRoots = [...marketplaces.values()].flat();
  const pluginDirectories = (scope: Root, kind: "skills" | "commands"): string[] => {
    const manifest = config(join(scope.path, ".claude-plugin", "plugin.json"));
    const declared = manifest[kind] ?? (kind === "commands" ? manifest["slash-commands"] : undefined);
    const configured = typeof declared === "string" ? [declared] : strings(declared);
    const dirs = (kind === "skills" || configured.length === 0 ? [join(scope.path, kind)] : []).concat(configured.map((path) => resolve(scope.path, path)));
    return [...new Set(dirs)].filter((path) => !relative(scope.path, path).startsWith(".."));
  };
  const targetsPortable = (scope: Root): boolean => {
    const schema = config(join(scope.path, "plugin.json")).$schema;
    return typeof schema === "string" && schema.startsWith("https://agent-plugins.org/schemas/");
  };
  const portable = [...marketplaceRoots, ...extensions].filter((scope) => {
    const manifest = config(join(scope.path, "plugin.json"));
    if (manifest.$schema !== "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json" ||
        typeof manifest.name !== "string" || manifest.name.length > 64 ||
        !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(manifest.name) || /--|\.\./.test(manifest.name)) return false;
    if (["version", "description", "homepage", "repository", "license"].some((key) => manifest[key] !== undefined && typeof manifest[key] !== "string")) return false;
    if (manifest.keywords !== undefined && (!Array.isArray(manifest.keywords) || manifest.keywords.some((item) => typeof item !== "string"))) return false;
    if (manifest.author !== undefined && (typeof manifest.author !== "object" || manifest.author === null || Array.isArray(manifest.author) ||
        Object.entries(plainObject(manifest.author)).some(([key, value]) => !["name", "email", "url"].includes(key) || typeof value !== "string"))) return false;
    return true;
  });
  const legacyExtensions = extensions.filter((scope) => !targetsPortable(scope));
  const legacyMarketplaces = marketplaceRoots.filter((scope) => !targetsPortable(scope));
  const skillRoots = [...nativeSkills, ...legacyExtensions, ...claude, ...portable,
    ...legacyMarketplaces, ...agents, ...codex, ...opencode, github];
  const thirdParty = ["enableCodexUser", "enableClaudeUser", "enableClaudeProject", "enablePiUser", "enablePiProject"].some((key) => skillsSettings[key] !== false);
  const enabled = (scope: Root): boolean => {
    const toggle = scope.provider === "native" ? `enablePi${scope.level === "user" ? "User" : "Project"}`
      : scope.provider === "agents" ? `enableAgents${scope.level === "user" ? "User" : "Project"}`
      : scope.provider === "claude" ? `enableClaude${scope.level === "user" ? "User" : "Project"}`
      : scope.provider === "codex" && scope.level === "user" ? "enableCodexUser" : null;
    return toggle ? skillsSettings[toggle] !== false : thirdParty;
  };
  const commands: SlashCommand[] = [];
  const names = new Set<string>(BUILTINS);
  const seenPaths = new Set<string>();
  const ignored = strings(skillsSettings.ignoredSkills).map((pattern) => new Bun.Glob(pattern));
  const included = strings(skillsSettings.includeSkills).map((pattern) => new Bun.Glob(pattern));
  const disabled = strings(settings.disabledExtensions).concat(strings(projectSettings.disabledExtensions));
  const addSkills = (scope: Root, directories = [join(scope.path, "skills")]): void => {
    for (const directory of directories) for (const skill of walkSkills(directory, { depth: "one", looseMarkdown: "none", ignoreFiles: false, requireDescription: true })) {
      const name = skill.name.trim();
      if (!name || name.startsWith(".") || skill.fields.enabled === false || disabled.includes(`skill:${name}`) ||
          ignored.some((glob) => glob.match(name)) || (included.length > 0 && !included.some((glob) => glob.match(name)))) continue;
      const canonical = realpathSync(skill.path);
      if (portable.some((item) => item.path === scope.path)) {
        // Portable packages require spec names and contained skills, unlike legacy providers.
        const declared = skill.fields.name;
        const allowed = ["name", "description", "license", "allowed-tools", "metadata", "compatibility"];
        if (typeof declared !== "string" || declared !== basename(dirname(skill.path)) ||
            declared.length > 64 || declared !== declared.toLowerCase() || !/^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(declared) ||
            skill.description.length > 1024 || Object.keys(skill.fields).some((key) => !allowed.includes(key)) ||
            ["license", "allowed-tools", "compatibility"].some((key) => skill.fields[key] !== undefined && typeof skill.fields[key] !== "string") ||
            (typeof skill.fields.compatibility === "string" && skill.fields.compatibility.length > 500) ||
            (skill.fields.metadata !== undefined && (typeof skill.fields.metadata !== "object" || skill.fields.metadata === null || Array.isArray(skill.fields.metadata) || Object.values(plainObject(skill.fields.metadata)).some((value) => typeof value !== "string"))) ||
            relative(realpathSync(scope.path), canonical).startsWith("..")) continue;
      }
      if (names.has(`skill:${name}`) || seenPaths.has(canonical)) continue;
      names.add(`skill:${name}`); seenPaths.add(canonical);
      commands.push({ name: `skill:${name}`, description: skill.description, source: "skill", origin: scope.origin ?? scope.level });
    }
  };
  if (skillsSettings.enabled !== false && skillsSettings.enableSkillCommands !== false) {
    // Explicit custom roots override defaults; same-source custom duplicates keep first wins.
    for (const directory of strings(skillsSettings.customDirectories)) addSkills(root(expand(directory), "user", "custom"), [expand(directory)]);
    for (const scope of skillRoots.filter(enabled)) addSkills(scope, scope.plugin && !portable.includes(scope) ? pluginDirectories(scope, "skills") : undefined);
    addSkills(root(agentDir, "user", "managed"), [join(agentDir, "managed-skills")]);
  }
  const allBuiltinNames = new Set<string>([...names, "model", "resume", "settings", "agents", "mcp", "plugins", "skills", "effort", "tree", "force:", "q", "providers", "models", "status"]);
  const addCommand = (command: SlashCommand): void => {
    if (allBuiltinNames.has(command.name)) return;
    allBuiltinNames.add(command.name); commands.push(command);
  };
  // File capabilities are provider-prioritized independently of the skill toggles.
  const claudeCommands = [root(claudeDir, "user", "claude"), root(join(cwd, ".claude"), "project", "claude")];
  for (const scope of [...native, ...legacyExtensions, ...claudeCommands, ...legacyMarketplaces, ...agents, ...codex, ...opencode]) {
    if (["claude", "opencode"].includes(scope.provider) && commandSettings[`enable${scope.provider === "claude" ? "Claude" : "Opencode"}${scope.level === "user" ? "User" : "Project"}`] === false) continue;
    const directories = scope.plugin ? pluginDirectories(scope, "commands") : [join(scope.path, "commands")];
    for (const directory of directories) for (const path of files(directory, scope.provider === "claude")) {
      const fields = readFrontmatter(path);
      const name = (scope.provider === "codex" || scope.provider === "opencode") && typeof fields?.name === "string" ? fields.name : basename(path, ".md");
      let text: string;
      try { text = readSkillText(path); } catch { continue; /* unreadable command file */ }
      const fallback = description(text);
      const desc = typeof fields?.description === "string" ? fields.description.trim() : fallback.length > 60 ? `${fallback.slice(0, 60)}...` : fallback;
      const command = { name: scope.plugin ? `${scope.plugin}:${name}` : name, description: desc, source: scope.level };
      addCommand(command);
      if (scope.provider === "claude" && relative(directory, path).includes(sep)) addCommand({ ...command, name: relative(directory, path).slice(0, -3).split(sep).join(":") });
    }
  }
  // Native templates are recursive and user-first, with the runtime's source suffix.
  for (const scope of [nativeUser, nativeProject, ...legacyExtensions, ...agents, ...codex, github]) {
    const directory = join(scope.path, "prompts");
    for (const path of files(directory, scope.provider === "native")) {
      if (scope.provider === "github" && !path.endsWith(".prompt.md")) continue;
      const subdir = dirname(relative(directory, path)).split(sep).join(":");
      const suffix = `(${scope.level}${subdir === "." ? "" : `:${subdir}`})`;
      const fields = readFrontmatter(path);
      let markdown: string;
      try { markdown = readSkillText(path); } catch { continue; /* unreadable prompt file */ }
      const fallback = description(markdown);
      const desc = typeof fields?.description === "string" ? fields.description : fallback.length > 60 ? `${fallback.slice(0, 60)}...` : fallback;
      const name = (scope.provider === "github" || scope.provider === "codex") && typeof fields?.name === "string" ? fields.name : basename(path, scope.provider === "github" ? ".prompt.md" : ".md");
      addCommand({ name, description: desc ? `${desc} ${suffix}` : suffix, source: scope.level });
    }
  }
  return commands;
}

// What each command does, as omp 18.8.7's own command definitions say it (src/slash-commands/*.ts
// `description`). The palette shows a toggle's current state in that place ("Context: 1% ..."), which
// is one session's state, not a description, so it is not copied here; a command whose definition
// lives outside those files keeps the palette's wording when it describes the command.
const DESCRIPTIONS: Readonly<Record<string, string>> = {
  "login": "Login with OAuth provider",
  "logout": "Logout from OAuth provider",
  "review": "Launch interactive code review (bundled)",
  "goal": "Toggle goal mode (persistent autonomous objective for this session)",
  "session": "Session management commands",
  "usage": "Show provider usage and limits",
  "security": "Plan, run, inspect, import, and compare OMP-native security scans",
  "setup": "Open provider setup",
  "plan": "Toggle plan mode (agent plans before executing)",
  "plan-review": "Re-open the plan review for the latest plan (plan mode only)",
  "vibe": "Toggle vibe mode (direct persistent fast/good worker sessions; read-only toolset)",
  "guided-goal": "Have the agent interview you in chat, then set up goal mode",
  "loop": "Toggle loop mode. While enabled, the next prompt you send re-submits after every yield. Esc cancels the current iteration; /loop again to disable.",
  "queue": "Queue a message for after the agent yields",
  "switch": "Switch model for this session (same as alt+p)",
  "fast": "Toggle priority service tier (OpenAI service_tier=priority, Anthropic speed=fast)",
  "slow": "",
  "extended-context": "Toggle premium long-context windows",
  "computer": "Toggle the native computer-use tool for this session",
  "prewalk": "Switch to a fast/cheap model at the next action (works even without --prewalk)",
  "advisor": "Toggle the advisor (a second model that reviews each turn and injects notes)",
  "export": "Export session to HTML file",
  "trace": "Open this session's trace in the stats dashboard",
  "dump": "Copy session transcript to clipboard (and write LLM request JSON to tmp)",
  "share": "Share session via an encrypted link (share server or secret gist)",
  "collab": "Share this session live via a relay",
  "join": "Join a shared collab session",
  "leave": "Leave the collab session",
  "browser": "Toggle browser headless vs visible mode",
  "copy": "Pick text or code from the conversation to copy",
  "open": "Open the last link from the conversation in your browser (or pick one with /copy)",
  "todo": "View or modify the agent's todo list",
  "jobs": "Show async background jobs status",
  "stats": "Launch the local stats dashboard",
  "changelog": "Show changelog entries",
  "hotkeys": "Show all keyboard shortcuts",
  "tools": "Show tools currently visible to the agent",
  "context": "Show estimated context usage breakdown",
  "extensions": "Open Extension Control Center dashboard",
  "git": "Open the git UI (split diff viewer, staging, commit composer)",
  "hub": "Open the live Agent Hub",
  "branch": "Create a new branch from a previous message",
  "fork": "Create a new fork from a previous message",
  "ssh": "Manage SSH hosts (add, list, remove)",
  "new": "Start a new session",
  "fresh": "Reset provider stream state without changing the local transcript",
  "clear": "Clear the conversation context in place, keeping the session",
  "delete": "Delete the current session and start a new one",
  "compact": "Manually compact the session context",
  "shake": "Drop heavy content from context (tool results, large blocks)",
  "handoff": "Hand off session context to a new session",
  "pin": "Pin or unpin a session at the top of the resume list",
  "btw": "Ask an ephemeral side question using the current session context",
  "tan": "Run a full background agent on tangential work",
  "omfg": "Forge a TTSR rule from a complaint to stop a recurring behavior",
  "cleanse": "Detect and fix project diagnostics with weighted parallel subagents",
  "retry": "Retry the last failed agent turn",
  "debug": "Open debug tools selector",
  "memory": "Inspect and operate memory maintenance",
  "rename": "Rename the current session",
  "move": "Move the current session to a different directory",
  "wt": "Move this session into a new worktree, changes included",
  "add-dir": "Add a workspace directory to this session (multi-root)",
  "remove-dir": "Remove a workspace directory from this session",
  "dirs": "List this session's workspace directories",
  "exit": "Exit the application",
  "restart": "Restart omp with the same launch flags, resuming this session",
  "marketplace": "Manage marketplace plugin sources and installed plugins",
  "reload-plugins": "Reload all plugins (skills, commands, hooks, tools, agents, MCP)",
  "force": "Force next turn to use a specific tool",
  "live": "Start Codex-backed realtime voice mode",
  "record": "Start or stop recording this screen to a replayable file (omp play)",
  "pause": "Freeze all agents (main, subagents, advisor) until resumed",
  "quit": "Quit the application",
  "autoresearch": "Toggle builtin autoresearch mode, or pass off / clear, or a goal message.",
  "green": "Generate a prompt to iterate on CI failures until the branch is green (bundled)",
  "init": "Generate AGENTS.md for current codebase",
};

export const source: AgentCommandSource = { builtins: BUILTINS, descriptions: DESCRIPTIONS, discover };
