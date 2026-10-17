import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paneCommands } from "../commands.ts";

const roots: string[] = [];
const previousHome = process.env.HOME;
const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
  else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
});
function temp(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-skills-"));
  roots.push(root);
  return root;
}
function put(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}
const skill = (root: string, name: string, description = `${name} skill`) => put(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`);
const extra = (home: string, cwd: string | null) => paneCommands("pi", cwd, home).filter((command) => command.source !== "builtin");
const names = (home: string, cwd: string | null) => extra(home, cwd).map((command) => command.name);

/** a home, and a project that is a repository with a pane working in a subfolder of it */
function setup(): { home: string; repo: string; cwd: string; agentDir: string } {
  const home = temp();
  process.env.HOME = home;
  const repo = join(temp(), "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const cwd = join(repo, "packages", "app");
  mkdirSync(cwd, { recursive: true });
  return { home, repo, cwd, agentDir: join(home, ".pi", "agent") };
}

describe("pi's builtins", () => {
  it("keeps every 0.87.1 name except tree", () => {
    const commands = paneCommands("pi", null, temp()).map((command) => command.name);
    expect(commands.sort()).toEqual(["settings", "model", "thinking", "scoped-models", "login", "logout", "llama", "new", "resume", "name", "session", "fork", "clone", "compact", "import", "copy", "export", "share", "bug", "trust", "reload", "hotkeys", "changelog", "quit"].sort());
    expect(commands).not.toContain("tree");
  });
});

describe("pi's user skills", () => {
  it("lists a nested skill from the agent dir and ~/.agents, as the person's own", () => {
    const { home, agentDir } = setup();
    skill(join(agentDir, "skills", "group", "inner"), "deep-one");
    skill(join(home, ".agents", "skills"), "shared");
    put(join(agentDir, "skills", "loose.md"), "---\nname: loose\ndescription: A loose root file\n---\n");
    put(join(agentDir, "skills", "group", "ignored.md"), "---\nname: nested-loose\ndescription: Not at the root\n---\n");
    expect(extra(home, null)).toEqual([
      { name: "skill:deep-one", description: "deep-one skill", source: "skill", origin: "user" },
      { name: "skill:loose", description: "A loose root file", source: "skill", origin: "user" },
      { name: "skill:shared", description: "shared skill", source: "skill", origin: "user" },
    ]);
  });

  it("skips a skill with no description, which pi does not load", () => {
    const { home, agentDir } = setup();
    put(join(agentDir, "skills", "bare", "SKILL.md"), "---\nname: bare\n---\nbody\n");
    expect(names(home, null)).toEqual([]);
  });

  it("takes the agent dir from the pane's environ", () => {
    const { home } = setup();
    const other = temp();
    skill(join(other, "skills"), "elsewhere");
    const commands = paneCommands("pi", null, home, { environ: [`PI_CODING_AGENT_DIR=${other}`] });
    expect(commands.filter((command) => command.source !== "builtin").map((command) => command.name)).toEqual(["skill:elsewhere"]);
  });
});

describe("pi's settings skills", () => {
  it("adds paths from the agent dir, and honours -path, !glob and +path", () => {
    const { home, agentDir } = setup();
    skill(join(agentDir, "skills"), "off-by-path");
    skill(join(agentDir, "skills"), "off-by-glob");
    skill(join(agentDir, "skills"), "stays");
    skill(join(agentDir, "extra", "pack"), "listed");
    skill(join(agentDir, "extra", "pack"), "dropped");
    skill(join(agentDir, "forced"), "forced-in");
    put(join(agentDir, "single.md"), "---\ndescription: One file\n---\n");
    put(join(agentDir, "settings.json"), JSON.stringify({ skills: ["extra/pack", "single.md", "-skills/off-by-path", "!skills/off-by-glob/**", "!extra/pack/dropped/*", "+forced"] }));
    expect(names(home, null).sort()).toEqual(["skill:forced-in", "skill:listed", "skill:single", "skill:stays"]);
  });
});

describe("pi's project skills and prompts", () => {
  function plant(repo: string, cwd: string): void {
    skill(join(repo, ".pi", "skills"), "repo-skill");
    skill(join(repo, "packages", ".agents", "skills"), "agents-skill");
    put(join(cwd, ".pi", "prompts", "ship.md"), "---\ndescription: Ship it\n---\n");
  }

  it("lists none without a trust decision", () => {
    const { home, repo, cwd } = setup();
    plant(repo, cwd);
    expect(names(home, cwd)).toEqual([]);
  });

  it("lists them, from every ancestor to the repo root, once trust.json lists the repo", () => {
    const { home, repo, cwd, agentDir } = setup();
    plant(repo, cwd);
    put(join(agentDir, "trust.json"), JSON.stringify({ [repo]: true }));
    expect(extra(home, cwd)).toEqual([
      { name: "ship", description: "Ship it", source: "project" },
      { name: "skill:agents-skill", description: "agents-skill skill", source: "skill", origin: "project" },
      { name: "skill:repo-skill", description: "repo-skill skill", source: "skill", origin: "project" },
    ]);
  });

  it("lists them under defaultProjectTrust always, and a closer refusal wins over it", () => {
    const { home, repo, cwd, agentDir } = setup();
    plant(repo, cwd);
    put(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
    expect(names(home, cwd)).toEqual(["ship", "skill:agents-skill", "skill:repo-skill"]);
    put(join(agentDir, "trust.json"), JSON.stringify({ [repo]: false }));
    expect(names(home, cwd)).toEqual([]);
  });
});
