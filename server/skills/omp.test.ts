import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { paneCommands } from "../commands.ts";

const fixtures: string[] = [];
afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});
function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "omp-skills-"));
  fixtures.push(home);
  const repo = join(home, "repo"), cwd = join(repo, "packages", "app");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const agent = join(home, ".omp", "agent");
  const skill = (root: string, name: string, extra = "", desc = "A skill. More detail.") =>
    put(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}\n${extra}---\nInstructions.\n`);
  const commands = (env: string[] = []) => paneCommands("omp", cwd, home, { environ: env });
  return { home, repo, cwd, agent, skill, commands };
}

describe("omp command discovery", () => {
  it("skips dangling and directory .md links instead of failing the menu", () => {
    const f = fixture();
    put(join(f.agent, "commands/real.md"), "Real command");
    symlinkSync(join(f.home, "gone.md"), join(f.agent, "commands/dangling.md"));
    symlinkSync(join(f.agent, "commands"), join(f.agent, "commands/folder.md"), "dir");
    symlinkSync(join(f.home, "gone.md"), join(f.agent, "prompts-dangling.md"));
    mkdirSync(join(f.agent, "prompts"), { recursive: true });
    symlinkSync(join(f.home, "gone.md"), join(f.agent, "prompts/dangling.md"));
    const names = f.commands().filter((row) => row.source !== "builtin").map((row) => row.name);
    expect(names).toContain("real");
    expect(names.some((name) => name === "dangling" || name === "folder")).toBeFalse();
  });

  it("uses provider priority, ancestor boundaries and first names with realpath deduplication", () => {
    const f = fixture();
    f.skill(join(f.cwd, ".omp/skills"), "collision");
    f.skill(join(f.repo, ".omp/skills"), "ancestor");
    f.skill(join(f.agent, "skills"), "collision");
    f.skill(join(f.home, ".claude/skills"), "collision");
    f.skill(join(f.home, ".claude/skills"), "claude-user");
    f.skill(join(f.repo, ".agents/skills"), "agents-project");
    f.skill(join(f.home, ".agent/skills"), "agents-user");
    f.skill(join(f.home, ".codex/skills"), "codex-user");
    f.skill(join(f.cwd, ".opencode/skills"), "opencode-project");
    f.skill(join(f.home, ".config/opencode/skills"), "opencode-user");
    f.skill(join(f.cwd, ".github/skills"), "github-project");
    f.skill(join(f.agent, "managed-skills"), "managed");
    f.skill(join(f.home, ".omp/skills"), "outside-repo");
    f.skill(join(f.agent, "skills"), ".hidden");
    f.skill(join(f.agent, "skills"), "disabled", "enabled: false\n");
    f.skill(join(f.agent, "skills"), "missing", "", '""');
    f.skill(join(f.agent, "skills/group/deep"), "nested");
    put(join(f.agent, "skills/loose.md"), "---\ndescription: Loose\n---\n");
    symlinkSync(join(f.cwd, ".omp/skills/collision"), join(f.agent, "skills/linked"));
    const skills = f.commands().filter((row) => row.source === "skill");
    expect(skills.map((row) => row.name).sort()).toEqual([
      "agents-project", "agents-user", "ancestor", "claude-user", "codex-user", "collision",
      "github-project", "managed", "opencode-project", "opencode-user",
    ].map((name) => `skill:${name}`).sort());
    expect(skills.find((row) => row.name === "skill:collision")?.origin).toBe("project");
    expect(skills.find((row) => row.name === "skill:claude-user")?.origin).toBe("user");
  });

  it("honors skill source toggles, include and ignore globs, and custom overrides", () => {
    const f = fixture();
    f.skill(join(f.agent, "skills"), "native");
    f.skill(join(f.home, ".claude/skills"), "shared");
    f.skill(join(f.home, ".agents/skills"), "agent-user");
    f.skill(join(f.repo, ".agents/skills"), "agent-project");
    f.skill(join(f.agent, "managed-skills"), "managed");
    f.skill(join(f.home, "custom"), "shared", "", "Custom wins.");
    f.skill(join(f.home, "custom"), "ignored-one");
    put(join(f.agent, "config.yml"), "skills:\n  enablePiUser: false\n  enableAgentsUser: false\n  includeSkills: ['shared', 'managed', 'agent-*']\n  ignoredSkills: ['*-project', 'ignored-*']\n  customDirectories: ['~/custom']\n");
    const rows = f.commands().filter((row) => row.source === "skill");
    expect(rows.map((row) => row.name).sort()).toEqual(["skill:managed", "skill:shared"]);
    expect(rows.find((row) => row.name === "skill:shared")?.description).toBe("Custom wins.");
  });

  it.each(["enabled", "enableSkillCommands"])("does not register skill commands when %s is false", (key) => {
    const f = fixture();
    f.skill(join(f.agent, "skills"), "probe");
    put(join(f.agent, "config.yml"), `skills:\n  ${key}: false\n`);
    put(join(f.agent, "commands/deploy.md"), "Deploy the app");
    const commands = f.commands();
    expect(commands.some((row) => row.source === "skill")).toBeFalse();
    expect(commands.some((row) => row.name === "deploy")).toBeTrue();
  });

  it("keeps managed skills when every third-party toggle is disabled", () => {
    const f = fixture();
    f.skill(join(f.agent, "managed-skills"), "managed");
    f.skill(join(f.cwd, ".github/skills"), "third-party");
    put(join(f.agent, "config.yml"), "skills:\n  enableCodexUser: false\n  enableClaudeUser: false\n  enableClaudeProject: false\n  enablePiUser: false\n  enablePiProject: false\n");
    expect(f.commands().filter((row) => row.source === "skill").map((row) => row.name)).toEqual(["skill:managed"]);
  });

  it("uses the pane environment for profiles and relocated agent and Claude roots", () => {
    const f = fixture();
    f.skill(join(f.agent, "skills"), "default");
    f.skill(join(f.home, ".omp/profiles/work/agent/skills"), "profile");
    f.skill(join(f.home, "moved/skills"), "moved");
    f.skill(join(f.home, "claude/skills"), "claude");
    expect(f.commands(["OMP_PROFILE=work"]).filter((row) => row.source === "skill").map((row) => row.name)).toEqual(["skill:profile"]);
    expect(f.commands(["PI_PROFILE=work"]).filter((row) => row.source === "skill").map((row) => row.name)).toEqual(["skill:profile"]);
    expect(f.commands([`PI_CODING_AGENT_DIR=${f.home}/moved`, `CLAUDE_CONFIG_DIR=${f.home}/claude`]).filter((row) => row.source === "skill").map((row) => row.name).sort()).toEqual(["skill:claude", "skill:moved"]);
  });

  it("falls back on malformed settings and applies the configured profile", () => {
    const f = fixture();
    f.skill(join(f.agent, "skills"), "default");
    put(join(f.agent, "config.yml"), "skills: [broken");
    expect(f.commands().some((row) => row.name === "skill:default")).toBeTrue();
    put(join(f.agent, "config.yml"), "profile: work\n");
    f.skill(join(f.home, ".omp/profiles/work/agent/skills"), "profile");
    expect(f.commands().filter((row) => row.source === "skill").map((row) => row.name)).toEqual(["skill:profile"]);
  });

  it("loads configured and installed plugins, with active registry versions and origins", () => {
    const f = fixture();
    const extension = join(f.home, "extension");
    put(join(f.agent, "settings.json"), JSON.stringify({ extensions: [extension] }));
    f.skill(join(extension, "skills"), "extension");
    put(join(extension, "commands/plugin-command.md"), "Plugin command");
    const cache = join(f.home, ".claude/plugins/cache/market/pkg/1");
    f.skill(join(cache, "skills"), "market-skill");
    put(join(cache, "commands/check.md"), "Check changes");
    const disabled = join(f.home, "disabled-plugin");
    f.skill(join(disabled, "skills"), "disabled-plugin");
    put(join(f.home, ".claude/plugins/installed_plugins.json"), JSON.stringify({ version: 2, plugins: {
      "pkg@market": [{ installPath: cache, scope: "user" }],
      "disabled@market": [{ installPath: disabled, enabled: false }],
    } }));
    const installed = join(f.home, ".omp/plugins/node_modules/installed");
    put(join(f.home, ".omp/plugins/omp-plugins.lock.json"), JSON.stringify({ plugins: { installed: { enabled: true } } }));
    put(join(installed, "package.json"), JSON.stringify({ omp: {} }));
    f.skill(join(installed, "skills"), "installed");
    const rows = f.commands();
    expect(rows.filter((row) => row.origin === "plugin").map((row) => row.name).sort()).toEqual(["skill:extension", "skill:installed", "skill:market-skill"]);
    expect(rows.find((row) => row.name === "pkg:check")?.source).toBe("user");
    expect(rows.some((row) => row.name === "plugin-command")).toBeTrue();
  });

  it("lists file commands and templates, reserves builtins and aliases, and preserves descriptions", () => {
    const f = fixture();
    put(join(f.cwd, ".omp/commands/deploy.md"), "---\ndescription: Deploy the app. Then check its health.\n---\nBody");
    put(join(f.agent, "prompts/review-docs.md"), "---\ndescription: Review documentation. Explain the changes.\n---\nBody");
    put(join(f.agent, "prompts/deploy.md"), "Hidden by the file command");
    put(join(f.agent, "prompts/model.md"), "Hidden even though the model screen is excluded");
    put(join(f.agent, "prompts/force:.md"), "Hidden alias");
    put(join(f.agent, "prompts/providers.md"), "Hidden setup alias");
    put(join(f.agent, "prompts/review.md"), "Hidden by the installed review builtin");
    put(join(f.agent, "prompts/nested/deep.md"), "Deep prompt");
    put(join(f.home, ".agents/commands/team.md"), "Team command");
    put(join(f.home, ".codex/prompts/codex.md"), "---\nname: renamed\n---\nCodex prompt");
    put(join(f.cwd, ".github/prompts/github.prompt.md"), "GitHub prompt");
    const rows = f.commands();
    expect(rows.filter((row) => row.name === "deploy")).toEqual([{ name: "deploy", description: "Deploy the app. Then check its health.", source: "project" }]);
    expect(rows.find((row) => row.name === "review-docs")?.description).toBe("Review documentation. Explain the changes. (user)");
    expect(rows.find((row) => row.name === "deep")?.description).toBe("Deep prompt (user:nested)");
    expect(rows.some((row) => row.name === "team")).toBeTrue();
    expect(rows.some((row) => row.name === "renamed")).toBeTrue();
    expect(rows.some((row) => row.name === "github")).toBeTrue();
    expect(rows.some((row) => ["help", "sessions", "model", "resume", "settings", "agents", "mcp", "plugins", "skills", "effort", "tree", "force:"].includes(row.name))).toBeFalse();
    expect(rows.filter((row) => row.source === "builtin").length).toBe(77);
    expect(rows.find((row) => row.name === "review")?.source).toBe("builtin");
    expect(rows.some((row) => row.name === "providers")).toBeFalse();
  });

  it("validates portable plugin skills and rejects invalid or escaping components", () => {
    const f = fixture();
    const plugin = join(f.home, "portable");
    put(join(f.agent, "settings.json"), JSON.stringify({ extensions: [plugin] }));
    put(join(plugin, "plugin.json"), JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "portable" }));
    f.skill(join(plugin, "skills"), "portable-skill");
    f.skill(join(plugin, "skills"), "invalid", "extra: true\n");
    f.skill(join(f.home, "outside"), "escaping");
    symlinkSync(join(f.home, "outside/escaping"), join(plugin, "skills/escaping"));
    const commands = f.commands();
    expect(commands.filter((row) => row.source === "skill").map((row) => row.name)).toEqual(["skill:portable-skill"]);
    expect(commands.find((row) => row.name === "skill:portable-skill")?.origin).toBe("plugin");
  });

  it("honors command provider toggles, nested Claude aliases and gitignored files", () => {
    const f = fixture();
    put(join(f.home, ".claude/commands/team/check.md"), "Check changes");
    put(join(f.cwd, ".opencode/commands/hidden.md"), "Disabled command");
    put(join(f.cwd, ".omp/commands/ignored.md"), "Ignored command");
    put(join(f.repo, ".gitignore"), "ignored.md\n");
    put(join(f.agent, "config.yml"), "commands:\n  enableOpencodeProject: false\n");
    const names = f.commands().filter((row) => row.source !== "builtin").map((row) => row.name);
    expect(names).toEqual(["check", "team:check"]);
  });
});
