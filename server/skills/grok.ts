import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { AgentCommandSource } from "./index.ts";
import { SkillIgnore } from "../skill-ignore.ts";
import { environValue, walkSkills } from "./walk.ts";
import type { SlashCommand } from "../../shared/protocol.ts";

/**
 * Grok (xAI's `grok` CLI), built from its documentation only: DOCS-BASED, NOT VERIFIED AGAINST A
 * LIVE GROK. grok is not installed on this machine, so there is no screen capture, no transcript
 * and no palette to check against.
 *
 * Source: https://github.com/xai-org/grok-build, commit 2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8
 * (2026-09-29), crates/codegen/xai-grok-shell/README.md: "Slash Commands" for the builtins,
 * "Skills" and "File Locations" for the roots, "Claude Code Compatibility" for the plugins.
 *
 * Builtins are the README's slash table as written, every row kept, each alias listed as a command
 * of its own. Nothing is left out as terminal-only: no screen of grok was seen, so no command is
 * known to be unrepresentable, and grok has no TERMINAL_ONLY_COMMANDS entry.
 *
 * Skills: a directory per skill with a SKILL.md whose frontmatter has `name` and `description`
 * (both required, so a skill missing either is not offered). Where the same name is found twice
 * the higher priority wins: ./.grok/skills, the repository root's, then the person's own
 * (~/.grok/skills, ~/.claude/skills), the `[skills] paths` of config.toml and last the plugins.
 * `.claude/skills` counts as `.grok/skills` of the same scope. Local and repository skills drop
 * out when .gitignore ignores them; the person's own are never filtered. `[skills] ignore`
 * excludes a path wherever it was found. `$GROK_HOME` (read from the pane process's environment)
 * replaces ~/.grok.
 *
 * Deliberately not here (IS-2 exclusions, also named in the changelog fragment):
 * - skills compiled into the grok binary (`create-skill`, `feedback`, ...): they have no directory
 *   to read, and a hard-coded list would drift from the binary;
 * - relative `[skills] paths` and a project's own `.grok/config.toml`: the README does not say
 *   what a relative path is relative to, nor whether a project may add skill directories;
 * - plugin names as a prefix: the README says nothing of how grok names a plugin's skills, so
 *   they are listed under their own names.
 */
const GROK_DESCRIPTIONS: Record<string, string> = {
  model: "<name> — Switch to a different model", m: "Alias of /model",
  new: "Start a new session (clears context)",
  load: "[workspace] [session] — Load a previous session", resume: "Alias of /load",
  rewind: "<prompt> — Rewind to a previous prompt (restores files)",
  compact: "Compact conversation history",
  "always-approve": "[on|off] — Toggle auto-approve mode", yolo: "Alias of /always-approve",
  multiline: "Toggle multiline input mode", ml: "Alias of /multiline",
  memory: "[workspace|global] <text> — Append text to a memory file (requires memory enabled)",
  flush: "Save current session knowledge to memory now",
  skills: "[name] — List skills or inject a skill into context",
  plugins: "[list|reload|trust] — Manage plugins (list, reload, trust)", plugin: "Alias of /plugins",
  "hooks-list": "Show hooks loaded in this session",
  "hooks-trust": "Trust this folder for hooks (writes folder trust)",
  "hooks-add": "<path> — Add a custom hook file or directory",
  feedback: "[message] — Report an issue or send feedback",
  exit: "Exit the TUI", quit: "Alias of /exit",
};

/** `~` and `~/x` as the person's home, an absolute path as itself; anything else is not a path grok resolves here */
function absolute(path: unknown, home: string): string | null {
  if (typeof path !== "string") return null;
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path.startsWith("/") ? resolve(path) : null;
}

/** `[skills] paths` and `ignore` from the user's config.toml */
function skillsTable(configDir: string, home: string): { paths: string[]; ignore: string[] } {
  try {
    const table = (Bun.TOML.parse(readFileSync(join(configDir, "config.toml"), "utf8")) as { skills?: { paths?: unknown; ignore?: unknown } }).skills;
    const list = (value: unknown): string[] => (Array.isArray(value) ? value : []).flatMap((entry) => absolute(entry, home) ?? []);
    return { paths: list(table?.paths), ignore: list(table?.ignore) };
  } catch { return { paths: [], ignore: [] }; /* no config, or one that is not TOML */ }
}

/** The `skills/` directory of every plugin under `root`, and of every installed Claude plugin */
function pluginSkillRoots(root: string, installed: boolean): string[] {
  const roots: string[] = [];
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const plugin = join(root, entry.name);
      if (statSync(plugin).isDirectory()) roots.push(join(plugin, "skills"));
    }
  } catch { /* no plugins directory */ }
  if (installed) {
    try {
      const plugins = (JSON.parse(readFileSync(join(root, "installed_plugins.json"), "utf8")) as { plugins?: Record<string, Array<{ installPath?: unknown }>> }).plugins ?? {};
      for (const versions of Object.values(plugins)) for (const version of versions) if (typeof version.installPath === "string") roots.push(join(version.installPath, "skills"));
    } catch { /* no installed plugin list */ }
  }
  return roots;
}

export const source: AgentCommandSource = {
  builtins: Object.keys(GROK_DESCRIPTIONS),
  descriptions: GROK_DESCRIPTIONS,
  discover({ home, cwd, repoRoot, env }) {
    const grokHome = absolute(environValue(env, "GROK_HOME"), home) ?? join(home, ".grok");
    const { paths, ignore } = skillsTable(grokHome, home);
    // repository-scoped skills are dropped when .gitignore ignores them, judged from the repository root
    const gitignore = new SkillIgnore();
    const base = repoRoot ?? cwd ?? null;
    if (base) {
      try { gitignore.add(readFileSync(join(base, ".gitignore"), "utf8")); } catch { /* no .gitignore */ }
      if (cwd && resolve(cwd) !== resolve(base)) {
        try { gitignore.add(readFileSync(join(cwd, ".gitignore"), "utf8"), `${relative(base, cwd).split(sep).join("/")}/`); } catch { /* none */ }
      }
    }
    const roots: Array<{ root: string; origin: NonNullable<SlashCommand["origin"]>; project: boolean }> = [];
    for (const directory of new Set([cwd, repoRoot].flatMap((path) => (path ? [resolve(path)] : [])))) {
      roots.push({ root: join(directory, ".grok", "skills"), origin: "project", project: true }, { root: join(directory, ".claude", "skills"), origin: "project", project: true });
    }
    roots.push({ root: join(grokHome, "skills"), origin: "user", project: false }, { root: join(home, ".claude", "skills"), origin: "user", project: false });
    for (const path of paths) roots.push({ root: path, origin: "user", project: false });
    for (const directory of new Set([cwd, repoRoot].flatMap((path) => (path ? [resolve(path)] : [])))) {
      for (const root of [...pluginSkillRoots(join(directory, ".grok", "plugins"), false), ...pluginSkillRoots(join(directory, ".claude", "plugins"), false)]) roots.push({ root, origin: "plugin", project: true });
    }
    for (const root of [...pluginSkillRoots(join(grokHome, "plugins"), false), ...pluginSkillRoots(join(home, ".claude", "plugins"), true)]) roots.push({ root, origin: "plugin", project: false });

    const seen = new Set<string>();
    const found: SlashCommand[] = [];
    for (const { root, origin, project } of roots) {
      if (!existsSync(root)) continue;
      for (const skill of walkSkills(root, { depth: "one", looseMarkdown: "none", ignoreFiles: false, requireDescription: true })) {
        if (typeof skill.fields.name !== "string" || !skill.fields.name.trim() || seen.has(skill.name)) continue;
        const directory = dirname(skill.path);
        if (ignore.some((path) => directory === path || directory.startsWith(path + sep))) continue;
        if (project && base) {
          const inside = relative(base, directory);
          if (!inside.startsWith("..") && gitignore.ignores(`${inside.split(sep).join("/")}/`)) continue;
        }
        seen.add(skill.name);
        found.push({ name: skill.name, description: skill.description, source: "skill", origin });
      }
    }
    return found;
  },
};
