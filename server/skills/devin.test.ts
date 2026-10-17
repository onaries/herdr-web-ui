import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { paneCommands } from "../commands.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "devin-skills-"));
  directories.push(root);
  const home = join(root, "home");
  const cwd = join(root, "project");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  const put = (path: string, content = "---\ndescription: Test skill. More information.\n---\nBody") => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };
  const commands = (environ: readonly string[] = []) => paneCommands("devin", cwd, home, { environ });
  const skills = (environ: readonly string[] = []) => commands(environ).filter((command) => command.source === "skill");
  return { root, home, cwd, put, commands, skills };
}

test("loads native user and project roots with directory names and origin", () => {
  const f = fixture();
  for (const [base, paths] of [
    [f.home, [".config/devin/skills/user", ".config/cognition/skills/cognition", ".agents/skills/agents"]],
    [f.cwd, [".devin/skills/project", ".cognition/skills/project-cognition", ".agents/skills/project-agents"]],
  ] as const) for (const path of paths) f.put(join(base, path, "SKILL.md"), "---\nname: display-only\ndescription: Test description.\n---");
  f.put(join(f.cwd, ".devin/skills/nested/child/SKILL.md"));
  const result = f.skills();
  expect(result.map((command) => [command.name, command.origin])).toEqual([
    ["agents", "user"], ["cognition", "user"], ["project", "project"],
    ["project-agents", "project"], ["project-cognition", "project"], ["user", "user"],
  ]);
});

test("pins recorded source collision and native root precedence", () => {
  const f = fixture();
  for (const root of [".devin/skills", ".cognition/skills", ".agents/skills", ".claude/skills"]) f.put(join(f.cwd, root, "collision/SKILL.md"));
  f.put(join(f.home, ".agents/skills/herdr/SKILL.md"));
  f.put(join(f.cwd, ".devin/skills/herdr/SKILL.md"));
  expect(f.skills().map((command) => [command.name, command.origin])).toEqual([
    ["agents:herdr", "user"], ["claude:collision", "project"],
    ["devin:collision", "project"], ["devin:herdr", "project"],
  ]);
});

test("project replaces user within one namespace without duplicate rows", () => {
  const f = fixture();
  f.put(join(f.home, ".config/devin/skills/shared/SKILL.md"));
  f.put(join(f.cwd, ".devin/skills/shared/SKILL.md"));
  expect(f.skills()).toEqual([{ name: "shared", description: "Test skill. More information.", source: "skill", origin: "project" }]);
});

test("hides model-only and empty trigger lists without hiding default or user triggers", () => {
  const f = fixture();
  f.put(join(f.cwd, ".devin/skills/default/SKILL.md"));
  for (const [name, triggers] of [["hidden", "[model]"], ["empty", "[]"], ["visible", "[user]"]] as const) {
    f.put(join(f.cwd, ".devin/skills", name, "SKILL.md"), `---\ntriggers: ${triggers}\n---`);
  }
  expect(f.skills().map((command) => command.name)).toEqual(["default", "visible"]);
});

test("imports recursive Claude and Copilot skills and Claude commands by default", () => {
  const f = fixture();
  f.put(join(f.cwd, ".claude/skills/group/claude/SKILL.md"));
  f.put(join(f.home, ".claude/skills/personal/SKILL.md"));
  f.put(join(f.cwd, ".claude/commands/docs/release.md"));
  f.put(join(f.cwd, ".github/skills/group/copilot/SKILL.md"));
  f.put(join(f.home, ".copilot/skills/group/global/SKILL.md"));
  f.put(join(f.cwd, ".windsurf/skills/windsurf/SKILL.md"));
  f.put(join(f.home, ".codeium/windsurf/skills/global-windsurf/SKILL.md"));
  expect(f.skills().map((command) => command.name)).toEqual(["claude", "copilot", "docs:release", "global", "global-windsurf", "personal", "windsurf"]);
});

test("JSONC disabled imports hide user and project imports while native roots remain", () => {
  const f = fixture();
  f.put(join(f.home, ".config/devin/config.json"), `{
    // Imports are disabled; strings containing URLs and trailing-comma text stay intact.
    "example": "https://example.com/a,}",
    "read_config_from": {"claude": false, "windsurf": false, "copilot": false,},
  }`);
  for (const base of [f.home, f.cwd]) {
    f.put(join(base, ".claude/skills/claude/SKILL.md"));
    f.put(join(base, ".agents/skills/native/SKILL.md"));
  }
  f.put(join(f.cwd, ".claude/commands/hidden.md"));
  f.put(join(f.cwd, ".github/skills/copilot/SKILL.md"));
  f.put(join(f.cwd, ".windsurf/skills/windsurf/SKILL.md"));
  expect(f.skills().map((command) => command.name)).toEqual(["native"]);
});

test("honors process XDG and Copilot directories and project import overrides", () => {
  const f = fixture();
  const config = join(f.root, "config");
  const copilot = join(f.root, "copilot");
  f.put(join(config, "devin/config.json"), '{"read_config_from":{"claude":false}}');
  f.put(join(config, "devin/skills/xdg/SKILL.md"));
  f.put(join(f.home, ".config/devin/skills/wrong/SKILL.md"));
  f.put(join(copilot, "skills/custom/SKILL.md"));
  f.put(join(f.cwd, ".devin/config.json"), '{"read_config_from":{"claude":true}}');
  f.put(join(f.cwd, ".claude/skills/enabled/SKILL.md"));
  expect(f.skills([`XDG_CONFIG_HOME=${config}`, `COPILOT_HOME=${copilot}`]).map((command) => command.name)).toEqual(["custom", "enabled", "xdg"]);
});

test("loads plugin manifests, relocated skills and disabled skill roots without following cycles", () => {
  const f = fixture();
  const data = join(f.root, "data");
  const plugins = join(data, "devin/cli/plugins");
  f.put(join(plugins, "cache/active/.devin-plugin/plugin.json"), '{"name":"tools","skills":["custom"]}');
  f.put(join(plugins, "cache/active/custom/review/SKILL.md"));
  f.put(join(plugins, "cache/active/skills/wrong/SKILL.md"));
  f.put(join(plugins, "disabled/.claude-plugin/plugin.json"), '{"name":"off","skills":[]}');
  f.put(join(plugins, "disabled/skills/hidden/SKILL.md"));
  symlinkSync(plugins, join(plugins, "cycle"));
  expect(f.skills([`XDG_DATA_HOME=${data}`])).toEqual([
    { name: "tools:review", description: "Test skill. More information.", source: "skill", origin: "plugin" },
  ]);
});

test("keeps local palette commands and excludes recorded terminal screens and cloud-only skills", () => {
  const f = fixture();
  const names = f.commands().map((command) => command.name);
  for (const name of ["login", "goal", "code", "fusion", "share", "cloud", "handoff"]) expect(names).toContain(name);
  for (const name of ["model", "resume", "config", "hooks", "mcp", "theme", "declarative-repo-setup", "upload-secrets", "repo", "platform", "ssh", "rename"]) expect(names).not.toContain(name);
});
