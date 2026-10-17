import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paneCommands } from "../commands.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "grok-skills-"));
  dirs.push(dir);
  return dir;
}
function skill(root: string, name: string, description: string | null = `Does ${name}`, fieldName: string | null = name): void {
  const lines = ["---", ...(fieldName ? [`name: ${fieldName}`] : []), ...(description ? [`description: ${description}`] : []), "---", "Body"];
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, "SKILL.md"), lines.join("\n"));
}
const skillsOf = (commands: ReturnType<typeof paneCommands>) => commands.filter((command) => command.source === "skill").map(({ name, origin, description }) => ({ name, origin, description }));

describe("grok skills", () => {
  it("offers the README's slash table as written, aliases included", () => {
    const names = paneCommands("grok", null, temp()).filter((command) => command.source === "builtin").map((command) => command.name).sort();
    expect(names).toEqual(["always-approve", "compact", "exit", "feedback", "flush", "hooks-add", "hooks-list", "hooks-trust", "load", "m", "memory", "ml", "model", "multiline", "new", "plugin", "plugins", "quit", "resume", "rewind", "skills", "yolo"]);
  });

  it("reads project, user, Claude and plugin roots with their origins", () => {
    const home = temp();
    const repo = temp();
    mkdirSync(join(repo, ".git"));
    const cwd = join(repo, "packages", "app");
    mkdirSync(cwd, { recursive: true });
    skill(join(cwd, ".grok", "skills"), "local-one");
    skill(join(repo, ".grok", "skills"), "repo-one");
    skill(join(repo, ".claude", "skills"), "claude-project");
    skill(join(home, ".grok", "skills"), "mine");
    skill(join(home, ".claude", "skills"), "claude-user");
    skill(join(home, ".grok", "plugins", "team", "skills"), "from-plugin");
    const installed = join(home, "cache", "tools");
    skill(join(installed, "skills"), "claude-plugin");
    mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
    writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "tools@market": [{ installPath: installed }] } }));
    const found = Object.fromEntries(skillsOf(paneCommands("grok", cwd, home)).map(({ name, origin }) => [name, origin]));
    expect(found).toEqual({ "local-one": "project", "repo-one": "project", "claude-project": "project", mine: "user", "claude-user": "user", "from-plugin": "plugin", "claude-plugin": "plugin" });
  });

  it("lets the higher priority win a duplicate name", () => {
    const home = temp();
    const repo = temp();
    mkdirSync(join(repo, ".git"));
    skill(join(repo, ".grok", "skills"), "commit", "Project commit");
    skill(join(home, ".grok", "skills"), "commit", "User commit");
    expect(skillsOf(paneCommands("grok", repo, home))).toEqual([{ name: "commit", origin: "project", description: "Project commit" }]);
  });

  it("requires both name and description", () => {
    const home = temp();
    skill(join(home, ".grok", "skills"), "complete");
    skill(join(home, ".grok", "skills"), "no-description", null);
    skill(join(home, ".grok", "skills"), "no-name", "Present", null);
    expect(skillsOf(paneCommands("grok", null, home)).map((command) => command.name)).toEqual(["complete"]);
  });

  it("drops a repository skill that .gitignore ignores and keeps the person's own", () => {
    const home = temp();
    const repo = temp();
    mkdirSync(join(repo, ".git"));
    writeFileSync(join(repo, ".gitignore"), "ignored-skill/\n");
    skill(join(repo, ".grok", "skills"), "ignored-skill");
    skill(join(repo, ".grok", "skills"), "tracked-skill");
    skill(join(home, ".grok", "skills"), "ignored-skill", "Mine");
    expect(skillsOf(paneCommands("grok", repo, home)).map(({ name, origin }) => [name, origin])).toEqual([["ignored-skill", "user"], ["tracked-skill", "project"]]);
    writeFileSync(join(repo, ".gitignore"), ".grok/\n");
    expect(skillsOf(paneCommands("grok", repo, home)).map((command) => command.name)).toEqual(["ignored-skill"]);
  });

  it("honors GROK_HOME from the pane process and the [skills] table of its config.toml", () => {
    const home = temp();
    const moved = temp();
    const extra = temp();
    const wip = join(extra, "wip");
    skill(join(home, ".grok", "skills"), "default-home");
    skill(join(moved, "skills"), "moved-home");
    skill(extra, "extra-one");
    skill(extra, "wip", "Work in progress");
    writeFileSync(join(moved, "config.toml"), `[skills]\npaths = ["${extra}", "relative/dir"]\nignore = ["${wip}"]\n`);
    const found = skillsOf(paneCommands("grok", null, home, { environ: [`GROK_HOME=${moved}`] })).map((command) => command.name);
    expect(found).toEqual(["extra-one", "moved-home"]);
  });

  it("lists nothing from a missing home and never throws on a broken config.toml", () => {
    const home = temp();
    mkdirSync(join(home, ".grok"), { recursive: true });
    writeFileSync(join(home, ".grok", "config.toml"), "[skills\npaths = ");
    expect(skillsOf(paneCommands("grok", null, home))).toEqual([]);
    expect(skillsOf(paneCommands("grok", null, join(home, "absent")))).toEqual([]);
  });
});
