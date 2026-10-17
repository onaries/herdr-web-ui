/**
 * OpenCode 1.17.15 exposes every valid skill as /name: it has no opencode/slash metadata key.
 * Palette exclusions are the recorded unrepresentable screens: agents, connect, editor,
 * sessions, skills and themes. Unchecked commands remain available.
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { SlashCommand } from "../../shared/protocol.ts";
import type { AgentCommandSource } from "./index.ts";
import { ancestorsToRepoRoot, description, environRecord, stripJsonc, walkSkills } from "./walk.ts";

const BUNDLED_DESCRIPTION = "Use ONLY when the user is editing or creating opencode's own configuration: opencode.json, opencode.jsonc, files under .opencode/, or files under ~/.config/opencode/. Also use when creating or fixing opencode agents, subagents, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring opencode itself.";
const DESCRIPTIONS = {
  debug: "View debug info", diff: "Open diff viewer", exit: "Exit the app", help: "Help",
  init: "guided AGENTS.md setup", mcps: "Toggle MCPs", models: "Switch model",
  move: "Move to another project dir", new: "New session",
  review: "review changes [commit|branch|pr], defaults to uncommitted",
  status: "View status", variants: "Switch model variant",
} as const;

function configCommands(path: string, source: "user" | "project"): SlashCommand[] {
  try {
    const json = stripJsonc(readFileSync(path, "utf8"));
    const config: unknown = JSON.parse(json);
    if (typeof config !== "object" || config === null || !("command" in config)) return [];
    const commands = config.command;
    if (typeof commands !== "object" || commands === null || Array.isArray(commands)) return [];
    return Object.entries(commands).flatMap(([name, value]): SlashCommand[] => {
      if (typeof value !== "object" || value === null || !("template" in value) || typeof value.template !== "string") return [];
      return [{ name, description: "description" in value && typeof value.description === "string" ? value.description : "", source }];
    });
  } catch { return []; /* missing, unreadable or malformed optional config */ }
}

export const source: AgentCommandSource = {
  builtins: Object.keys(DESCRIPTIONS),
  descriptions: DESCRIPTIONS,
  discover(ctx) {
    const env = environRecord(ctx.env);
    const config = env.OPENCODE_CONFIG_DIR || join(ctx.home, ".config", "opencode");
    const projects = ctx.cwd ? ancestorsToRepoRoot(ctx.cwd).reverse() : [];
    const commands = new Map<string, SlashCommand>();
    const directories: readonly (readonly [string, "user" | "project"])[] = [
      [config, "user"],
      ...projects.flatMap((directory): [string, "project"][] => [[directory, "project"], [join(directory, ".opencode"), "project"]]),
    ];
    for (const [directory, source] of directories) {
      // File commands override config commands at the same root.
      for (const filename of ["opencode.json", "opencode.jsonc"]) {
        for (const command of configCommands(join(directory, filename), source)) commands.set(command.name, command);
      }
      if (source === "project" && basename(directory) !== ".opencode") continue;
      try {
        for (const entry of readdirSync(join(directory, "commands"), { withFileTypes: true })) {
          if (!entry.name.endsWith(".md") || entry.isDirectory()) continue;
          const name = entry.name.slice(0, -3);
          commands.set(name, { name, description: description(readFileSync(join(directory, "commands", entry.name), "utf8")), source });
        }
      } catch { /* optional command directory */ }
    }
    const skills = new Map<string, SlashCommand>([["customize-opencode", {
      name: "customize-opencode", description: BUNDLED_DESCRIPTION, source: "skill", origin: "bundled",
    }]]);
    const external = !["OPENCODE_DISABLE_EXTERNAL_SKILLS", "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS", "OPENCODE_DISABLE_CLAUDE_CODE"]
      .some((key) => env[key] === "1" || env[key] === "true");
    const roots: { path: string; origin: "user" | "project" }[] = [];
    if (external) {
      for (const directory of [ctx.home, ...projects]) {
        for (const kind of [".claude", ".agents"]) roots.push({ path: join(directory, kind, "skills"), origin: directory === ctx.home ? "user" : "project" });
      }
    }
    for (const directory of [config, ...projects.map((directory) => join(directory, ".opencode"))]) {
      for (const kind of ["skill", "skills"]) roots.push({ path: join(directory, kind), origin: directory === config ? "user" : "project" });
    }
    for (const { path, origin } of roots) {
      for (const skill of walkSkills(path, { depth: "recursive", looseMarkdown: "none", ignoreFiles: false, requireDescription: true })) {
        if (typeof skill.fields.name !== "string" || skill.name !== basename(dirname(skill.path)) ||
          skill.name.length > 64 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(skill.name) || skill.description.length > 1024) continue;
        skills.set(skill.name, { name: skill.name, description: skill.description, source: "skill", origin });
      }
    }
    // Commands win over skills, including builtins; custom builtin overrides keep just one row.
    const builtinNames = new Set<string>(source.builtins);
    return [
      ...[...commands.values()].filter((command) => !builtinNames.has(command.name)),
      ...[...skills.values()].filter((skill) => !commands.has(skill.name) && !builtinNames.has(skill.name)),
    ];
  },
};
