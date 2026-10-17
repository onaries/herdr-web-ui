import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { paneCommands } from "../commands.ts";
import { source } from "./gjc.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "gjc-skills-"));
  roots.push(home);
  const cwd = join(home, "repo", "nested");
  const agentDir = join(home, "relocated");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(home, "repo", ".git"));
  const put = (path: string, content: string): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };
  const skill = (root: string, directory: string, name = directory): void => {
    put(join(root, directory, "SKILL.md"), `---\n${name ? `name: ${name}\n` : ""}description: First sentence. More detail for the tooltip.\n---\nBody\n`);
  };
  const config = (yaml: string): void => put(join(agentDir, "config.yml"), yaml);
  const commands = (env = [`GJC_CODING_AGENT_DIR=${agentDir}`]) => paneCommands("gjc", cwd, home, { environ: env });
  return { home, cwd, agentDir, put, skill, config, commands };
}

describe("gjc discovery", () => {
  it("reads the pane's relocated skills, commands and YAML settings", () => {
    const f = fixture();
    f.skill(join(f.agentDir, "skills"), "chosen");
    f.skill(join(f.home, ".gjc", "agent", "skills"), "wrong-home");
    f.skill(join(f.home, "repo", ".gjc", "skills"), "untrusted");
    f.put(join(f.agentDir, "commands", "omg:setup.md"), "---\ndescription: Inspect installation\n---\nRun\n");
    f.config("skills:\n  trustProjectSkills: false\n");
    const commands = f.commands();
    expect(commands).toContainEqual({ name: "skill:chosen", description: "First sentence. More detail for the tooltip.", source: "skill", origin: "user" });
    expect(commands).toContainEqual({ name: "omg:setup", description: "Inspect installation", source: "user" });
    expect(commands.map((command) => command.name)).not.toContain("skill:wrong-home");
    expect(commands.map((command) => command.name)).not.toContain("skill:untrusted");
  });

  it("keeps nearest project skills ahead of user and distant duplicates", () => {
    const f = fixture();
    f.skill(join(f.cwd, ".gjc", "skills"), "near", "duplicate");
    f.skill(join(f.home, "repo", ".gjc", "skills"), "far", "duplicate");
    f.skill(join(f.agentDir, "skills"), "user", "duplicate");
    f.skill(join(f.home, ".gjc", "skills"), "outside");
    f.skill(join(f.home, "repo", ".gjc", "skills"), "root-only");
    f.put(join(f.cwd, ".gjc", "commands", "review.md"), "---\ndescription: Near\n---\n");
    f.put(join(f.agentDir, "commands", "review.md"), "---\ndescription: User\n---\n");
    const commands = f.commands();
    expect(commands.filter((command) => command.name === "skill:duplicate")).toEqual([
      { name: "skill:duplicate", description: "First sentence. More detail for the tooltip.", source: "skill", origin: "project" },
    ]);
    expect(commands.find((command) => command.name === "review")).toMatchObject({ description: "Near", source: "project" });
    expect(commands.find((command) => command.name === "skill:root-only")?.origin).toBe("project");
  });

  it.each(["trustProjectSkills", "enablePiProject"])("hides project skills when %s is false", (setting) => {
    const f = fixture();
    f.skill(join(f.cwd, ".gjc", "skills"), "project");
    f.skill(join(f.agentDir, "skills"), "user");
    f.config(`skills:\n  ${setting}: false\n`);
    const skills = f.commands().filter((command) => command.source === "skill");
    expect(skills.some((command) => command.origin === "project")).toBe(false);
    expect(skills.some((command) => command.name === "skill:user")).toBe(true);
  });

  it("hides all user roots when enablePiUser is false", () => {
    const f = fixture();
    for (const root of [join(f.agentDir, "skills"), join(f.home, ".gjc", "skills"), join(f.home, "custom")]) f.skill(root, "user");
    f.skill(join(f.cwd, ".gjc", "skills"), "project");
    f.config("skills:\n  enablePiUser: false\n  customDirectories: ['~/custom']\n");
    const skills = f.commands().filter((command) => command.source === "skill");
    expect(skills.some((command) => command.origin === "user")).toBe(false);
    expect(skills.some((command) => command.name === "skill:project")).toBe(true);
    expect(skills.filter((command) => command.origin === "bundled")).toHaveLength(4);
  });

  it("disables filesystem and bundled skills without disabling commands", () => {
    const f = fixture();
    f.skill(join(f.agentDir, "skills"), "user");
    f.put(join(f.agentDir, "commands", "review.md"), "Review\n");
    f.config("skills:\n  enabled: false\n");
    const commands = f.commands();
    expect(commands.some((command) => command.source === "skill")).toBe(false);
    expect(commands.some((command) => command.name === "review")).toBe(true);
  });

  it("ignores HUD YAML and defaults when agent YAML is invalid", () => {
    const f = fixture();
    f.skill(join(f.agentDir, "skills"), "user");
    f.skill(join(f.cwd, ".gjc", "skills"), "project");
    f.put(join(f.home, ".gjc", "config.yml"), "skills:\n  enabled: false\n");
    f.config("skills: [invalid");
    const names = f.commands().map((command) => command.name);
    expect(names).toContain("skill:user");
    expect(names).toContain("skill:project");
  });

  it("honors PI fallbacks, GJC config precedence, legacy and custom directories", () => {
    const f = fixture();
    f.skill(join(f.agentDir, "skills"), "canonical");
    f.skill(join(f.home, ".custom-gjc", "skills"), "legacy");
    f.skill(join(f.home, ".custom-pi", "skills"), "pi-legacy");
    f.skill(join(f.home, ".gjc", "skills"), "old");
    f.skill(join(f.home, "extra"), "extra");
    f.config("skills:\n  customDirectories: ['~/extra']\n");
    const env = [`PI_CODING_AGENT_DIR=${f.agentDir}`, "GJC_CONFIG_DIR=.custom-gjc", "PI_CONFIG_DIR=.custom-pi"];
    const names = f.commands(env).map((command) => command.name);
    for (const name of ["canonical", "legacy", "old", "extra"]) expect(names).toContain(`skill:${name}`);
    expect(names).not.toContain("skill:pi-legacy");
    expect(f.commands([`PI_CODING_AGENT_DIR=${f.agentDir}`, "PI_CONFIG_DIR=.custom-pi"]).map((command) => command.name)).toContain("skill:pi-legacy");
  });

  it("uses GJC before PI and defaults to the gjc agent directory", () => {
    const f = fixture();
    f.skill(join(f.agentDir, "skills"), "gjc");
    f.skill(join(f.home, "pi", "skills"), "pi");
    f.skill(join(f.home, ".gjc", "agent", "skills"), "default");
    const names = f.commands([`GJC_CODING_AGENT_DIR=${f.agentDir}`, `PI_CODING_AGENT_DIR=${join(f.home, "pi")}`]).map((command) => command.name);
    expect(names).toContain("skill:gjc");
    expect(names).not.toContain("skill:pi");
    expect(f.commands([]).map((command) => command.name)).toContain("skill:default");
  });

  it("requires descriptions, scans one level, follows links and reserves bundled names", () => {
    const f = fixture();
    const root = join(f.agentDir, "skills");
    f.skill(root, "directory", "named");
    f.skill(root, "fallback", "");
    f.skill(root, "deep/nested");
    f.skill(root, "deep-interview");
    f.put(join(root, "missing", "SKILL.md"), "---\nname: missing\n---\nBody\n");
    f.skill(join(f.home, "linked"), "target", "linked");
    symlinkSync(join(f.home, "linked", "target"), join(root, "link"));
    const skills = f.commands().filter((command) => command.source === "skill");
    const names = skills.map((command) => command.name);
    expect(names).toContain("skill:named");
    expect(names).toContain("skill:fallback");
    expect(names).toContain("skill:linked");
    expect(names).not.toContain("skill:nested");
    expect(names).not.toContain("skill:missing");
    expect(skills.filter((command) => command.name === "skill:deep-interview")).toHaveLength(1);
    expect(skills.find((command) => command.name === "skill:deep-interview")?.origin).toBe("bundled");
  });

  it("keeps the recorded palette except custom commands and unrepresentable screens", () => {
    // gjc.txt, 62 rows; gjc-screens.txt excludes these eight screens. The five omg
    // rows are installed markdown commands, not builtins, and are discovered per pane.
    const palette = "help tutorial clear new resume star unstar sessions session goal compact handoff retry copy dump export language settings aside notify import-session theme pet model effort fast routing jobs transcript context progress usage credential changelog hotkeys tools mcp extensions monitors tree fork provider login logout ssh drop contribute-pr btw background debug memory rename move exit dir-entry-ext extension:notify omg omg:gpt-image omg:insane-review omg:no-english omg:setup init".split(" ");
    const excluded = new Set(["model", "resume", "sessions", "settings", "mcp", "effort", "theme", "tree", "omg", "omg:gpt-image", "omg:insane-review", "omg:no-english", "omg:setup"]);
    expect([...source.builtins].sort()).toEqual(palette.filter((name) => !excluded.has(name)).sort());
  });

  it("offers builtins and exactly the bundled skills over an empty home", () => {
    const f = fixture();
    const commands = f.commands();
    expect(commands.filter((command) => command.source === "builtin").map((command) => command.name).sort()).toEqual([...source.builtins].sort());
    expect(commands.filter((command) => command.source !== "builtin").map(({ name, source, origin }) => ({ name, source, origin }))).toEqual([
      { name: "skill:autoresearch", source: "skill", origin: "bundled" },
      { name: "skill:deep-interview", source: "skill", origin: "bundled" },
      { name: "skill:ralplan", source: "skill", origin: "bundled" },
      { name: "skill:ultragoal", source: "skill", origin: "bundled" },
    ]);
  });
});
