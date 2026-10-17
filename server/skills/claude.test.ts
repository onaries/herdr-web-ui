import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paneCommands } from "../commands.ts";
import { source } from "./claude.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "claude-menu-"));
  roots.push(home);
  const repo = join(home, "repo");
  const cwd = join(repo, "app");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(cwd);
  return { home, repo, cwd };
}
function put(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}
function skill(root: string, name: string, fields = "", body = "Probe skill"): void {
  put(join(root, name, "SKILL.md"), `---\n${fields}\n---\n${body}\n`);
}

describe("Claude discovery", () => {
  it("loads personal and nearest ancestor skills before commands, without descendants", () => {
    const { home, repo, cwd } = fixture();
    skill(join(home, ".claude/skills"), "shared", "description: Personal");
    skill(join(repo, ".claude/skills"), "shared", "description: Project");
    skill(join(repo, ".claude/skills"), "parent");
    skill(join(cwd, ".claude/skills"), "local", "name: renamed");
    skill(join(cwd, ".claude/skills"), "hidden", "user-invocable: false");
    skill(join(cwd, "sub/.claude/skills"), "deep");
    put(join(home, ".claude/commands/shared.md"), "Legacy command");
    put(join(repo, ".claude/commands/team/check.md"), "Check");
    const commands = paneCommands("claude", cwd, home).filter(({ source }) => source !== "builtin");
    expect(commands).toEqual([
      { name: "parent", description: "Probe skill", source: "skill", origin: "project" },
      { name: "renamed", description: "Probe skill", source: "skill", origin: "project" },
      { name: "shared", description: "Personal", source: "skill", origin: "user" },
      { name: "team:check", description: "Check", source: "project" },
    ]);
  });

  it("honors the process config directory for synced skills, plugins and commands", () => {
    const { home, cwd } = fixture();
    const config = join(home, "custom");
    const plugin = join(home, "plugin");
    skill(join(home, ".claude/skills"), "wrong-home");
    skill(join(config, "skills/synced"), "probe-skill");
    skill(join(plugin, "skills"), "folder", "name: named");
    skill(join(plugin, "skills"), "hidden", "user-invocable: false");
    put(join(plugin, "commands/check.md"), "Check");
    put(join(config, "commands/local.md"), "Local");
    put(join(config, "settings.json"), JSON.stringify({ enabledPlugins: { "tools@market": true, "off@market": false } }));
    put(join(config, "plugins/installed_plugins.json"), JSON.stringify({ plugins: { "tools@market": [{ installPath: plugin }], "off@market": [{ installPath: plugin }] } }));
    const commands = paneCommands("claude", cwd, home, { environ: [`CLAUDE_CONFIG_DIR=${config}`] }).filter(({ source }) => source !== "builtin");
    expect(commands).toEqual([
      { name: "anthropic-skills:probe-skill", description: "Probe skill", source: "skill", origin: "user" },
      { name: "local", description: "Local", source: "user" },
      { name: "tools:check", description: "Check", source: "plugin" },
      { name: "tools:named", description: "Probe skill", source: "skill", origin: "plugin" },
    ]);
  });

  it("falls back only to the main checkout when a linked worktree has no skill roots", () => {
    const { home, repo } = fixture();
    const worktree = join(home, "linked");
    const sibling = join(home, "sibling");
    const gitdir = join(repo, ".git/worktrees/linked");
    put(join(worktree, ".git"), `gitdir: ${gitdir}\n`);
    put(join(gitdir, "commondir"), "../..\n");
    skill(join(repo, ".claude/skills"), "main");
    skill(join(sibling, ".claude/skills"), "untracked-sibling");
    mkdirSync(join(worktree, ".claude/skills"), { recursive: true });
    expect(paneCommands("claude", worktree, home).filter(({ source }) => source === "skill").map(({ name }) => name)).toEqual(["main"]);
    skill(join(worktree, ".claude/skills"), "own");
    expect(paneCommands("claude", worktree, home).filter(({ source }) => source === "skill").map(({ name }) => name)).toEqual(["own"]);
  });

  it("uses the recorded native palette without binary skills or unrepresentable screens", () => {
    expect(source.builtins).toEqual([
      "add-dir", "advisor", "artifacts", "auto-mode-setup", "autocompact", "autofix-pr",
      "background", "branch", "btw", "bug", "cd", "chrome", "clear", "color", "compact",
      "context", "copy", "design-login", "diff", "doctor", "effort", "exit", "export", "fast",
      "feedback", "focus", "fork", "goal", "help", "ide", "import", "init", "insights", "install-github-app",
      "install-slack-app", "keybindings", "list-agents", "login", "logout", "mcp", "memory",
      "mobile", "model", "output-style", "passes", "plan", "powerup", "privacy-settings",
      "radio", "rate-limit-options", "recap", "release-notes", "reload-plugins", "reload-skills",
      "remote-control", "remote-env", "rename", "rewind", "sandbox", "security-review", "skill-doctor",
      "status", "statusline", "stickers", "subtask", "tasks", "team-onboarding", "teleport",
      "terminal-setup", "tui", "ultrareview", "upgrade", "usage", "usage-credits", "voice", "web-setup", "workflows",
    ]);
  });
});
