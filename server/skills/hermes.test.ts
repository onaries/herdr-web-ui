import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { paneCommands } from "../commands.ts";

const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});
function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hermes-menu-"));
  temporary.push(root);
  const home = join(root, "home");
  const profile = join(home, "profile");
  const repo = join(home, "repo");
  const cwd = join(repo, "src", "nested");
  mkdirSync(cwd, { recursive: true });
  put(join(repo, ".git"), "gitdir: /unused/worktree\n");
  const config = (skills: Record<string, unknown> = {}, quick_commands: Record<string, unknown> = {}) =>
    put(join(profile, "config.yaml"), Bun.YAML.stringify({ skills, quick_commands }));
  const skill = (root: string, directory: string, fields: Record<string, unknown> = {}, body = "Probe body.") =>
    put(join(root, directory, "SKILL.md"), `---\n${Bun.YAML.stringify(fields)}\n---\n${body}\n`);
  const commands = (extra: string[] = []) => paneCommands("hermes", cwd, home, { environ: [`HERMES_HOME=${profile}`, ...extra] });
  const discovered = () => commands().filter((command) => command.source !== "builtin");
  return { root, home, profile, repo, cwd, config, skill, commands, discovered };
}

describe("Hermes commands", () => {
  it("keeps CLI CommandDefs and palette aliases, excluding gateway and unrepresentable screens", () => {
    const f = fixture();
    const rows = f.commands();
    const names = new Set(rows.map((command) => command.name));
    expect(rows).toHaveLength(110);
    expect(rows.every((command) => command.source === "builtin")).toBeTrue();
    for (const name of ["new", "status", "clear", "reset", "prompt", "compose", "voice", "login", "tasks", "reload_skills"]) expect(names.has(name)).toBeTrue();
    for (const name of ["start", "topic", "pause", "approve", "deny", "sethome", "set-home", "commands", "restart", "platform"]) expect(names.has(name)).toBeFalse();
    for (const name of ["model", "resume", "sessions", "config", "agents", "plugins", "skills", "skin"]) expect(names.has(name)).toBeFalse();
    expect(rows.find((command) => command.name === "reset")?.description).toBe(rows.find((command) => command.name === "new")?.description);
  });

  it("honors HERMES_HOME and separates local, bundled and trusted project skills", () => {
    const f = fixture();
    f.config({ trusted_project_dirs: [f.repo] });
    f.skill(join(f.home, ".hermes", "skills"), "wrong-home");
    f.skill(join(f.profile, "skills"), "category/my_skill", { description: "Personal." });
    f.skill(join(f.profile, "skills"), "category/stock", { name: "Stock Skill", description: "Installed stock." });
    f.skill(join(f.home, ".hermes", "hermes-agent", "skills"), "other/stock", { name: "Stock Skill" });
    f.skill(join(f.repo, ".hermes", "skills"), "project", { description: "Project." });
    f.skill(join(f.repo, ".agents", "skills"), "agent-project");
    f.skill(join(f.cwd, ".hermes", "skills"), "not-root");
    expect(f.discovered()).toEqual([
      { name: "agent-project", description: "Probe body.", source: "skill", origin: "project" },
      { name: "my-skill", description: "Personal.", source: "skill", origin: "user" },
      { name: "project", description: "Project.", source: "skill", origin: "project" },
      { name: "stock-skill", description: "Installed stock.", source: "skill", origin: "bundled" },
    ]);
  });

  it("never offers untrusted projects, disabled discovery, non-repositories or a home repository", () => {
    const f = fixture();
    f.skill(join(f.repo, ".hermes", "skills"), "private-project");
    f.config();
    expect(f.discovered()).toEqual([]);
    f.config({ trusted_project_dirs: [f.repo], project_discovery: false });
    expect(f.discovered()).toEqual([]);
    f.config({ trusted_project_dirs: [f.cwd] });
    expect(f.discovered()).toEqual([]);
    put(join(f.home, ".git"), "");
    f.skill(join(f.home, ".agents", "skills"), "home-project");
    f.config({ trusted_project_dirs: [f.home] });
    expect(paneCommands("hermes", f.home, f.home, { environ: [`HERMES_HOME=${f.profile}`] }).filter((command) => command.source === "skill")).toEqual([]);
    const outside = join(f.root, "outside");
    mkdirSync(outside);
    f.skill(join(outside, ".hermes", "skills"), "not-a-repo");
    f.config({ trusted_project_dirs: [outside] });
    expect(paneCommands("hermes", outside, f.home, { environ: [`HERMES_HOME=${f.profile}`] }).filter((command) => command.source === "skill")).toEqual([]);
  });

  it("expands create and external roots, dedupes roots and applies tier precedence", () => {
    const f = fixture();
    f.config({ trusted_project_dirs: [f.repo], create_dir: "created", external_dirs: ["${EXTRA}", "~/shared", "skills", "created"] });
    const local = join(f.profile, "skills");
    const created = join(f.profile, "created");
    const external = join(f.profile, "external");
    for (const root of [join(f.repo, ".hermes", "skills"), local, created, external]) f.skill(root, "winner", { description: root });
    for (const root of [local, created, external]) f.skill(root, "local-wins", { description: root });
    for (const root of [created, external]) f.skill(root, "create-wins", { description: root });
    f.skill(external, "external-only");
    f.skill(join(f.home, "shared"), "tilde-only");
    const rows = f.commands(["EXTRA=external"]).filter((command) => command.source === "skill");
    expect(rows.map((command) => command.name)).toEqual(["create-wins", "external-only", "local-wins", "tilde-only", "winner"]);
    expect(rows.find((command) => command.name === "winner")).toMatchObject({ description: join(f.repo, ".hermes", "skills"), origin: "project" });
    expect(rows.find((command) => command.name === "local-wins")?.description).toBe(local);
    expect(rows.find((command) => command.name === "create-wins")?.description).toBe(created);
  });

  it("normalizes names, filters disabled and core collisions, and retains full descriptions", () => {
    const f = fixture();
    f.config({ disabled: '["off", "hermes-agent"]' });
    const root = join(f.profile, "skills");
    for (const name of ["off", "hermes-agent", "new", "reset", "model", "start", "set-home"]) f.skill(root, name);
    f.skill(root, "normal", { name: "Foo__ Bar++", description: "x".repeat(220) });
    f.skill(root, "unicode", { name: "文書" });
    f.skill(root, "invalid", { name: "+++" });
    f.skill(root, "no-header", {}, "# Heading\n\nA body description.\nSecond line.");
    f.skill(root, "no-body", {}, "# Heading");
    f.skill(root, "wrong-platform", { platforms: ["not-an-os"] });
    expect(f.discovered().map((command) => command.name)).toEqual(["foo-bar", "hermes-agent", "no-body", "no-header", "文書"]);
    expect(f.discovered().find((command) => command.name === "foo-bar")?.description).toHaveLength(220);
    expect(f.discovered().find((command) => command.name === "no-header")?.description).toBe("A body description.");
    expect(f.discovered().find((command) => command.name === "no-body")?.description).toBe("Invoke the no-body skill");
  });

  it("omits same-tier ambiguous names and keeps identical shallow copies and first slug wins", () => {
    const f = fixture();
    f.config();
    const root = join(f.profile, "skills");
    f.skill(root, "a/one", { name: "ambiguous" }, "One.");
    f.skill(root, "b/two", { name: "ambiguous" }, "Two.");
    f.skill(root, "shallow", { name: "same", description: "Identical." });
    f.skill(root, "category/deep", { name: "same", description: "Identical." });
    f.skill(root, "a/slug", { name: "git_helper", description: "First." });
    f.skill(root, "b/slug", { name: "git-helper", description: "Second." });
    symlinkSync(root, join(root, "cycle"), "dir");
    f.skill(root, "scripts/support", { name: "root-support" });
    f.skill(root, "parent", { name: "parent" });
    f.skill(root, "parent/scripts/support", { name: "support" });
    f.skill(root, "parent/child", { name: "child" });
    put(join(root, "loose.md"), "Not a skill.");
    expect(f.discovered()).toEqual([
      { name: "child", description: "Probe body.", source: "skill", origin: "user" },
      { name: "git-helper", description: "First.", source: "skill", origin: "user" },
      { name: "parent", description: "Probe body.", source: "skill", origin: "user" },
      { name: "root-support", description: "Probe body.", source: "skill", origin: "user" },
      { name: "same", description: "Identical.", source: "skill", origin: "user" },
    ]);
  });

  it("loads YAML bundles and quick commands in dispatch precedence without duplicate rows", () => {
    const f = fixture();
    f.config({}, {
      fastcheck: { type: "exec", command: "git status", description: "Quick check." },
      release: { type: "alias", command: "/status", description: "Quick release." },
      new: { type: "alias", command: "/status" },
    });
    const root = join(f.profile, "skills");
    f.skill(root, "release");
    f.skill(root, "bundle-only");
    put(join(f.profile, "skill-bundles", "a.yaml"), Bun.YAML.stringify({ name: "release", skills: ["release"] }));
    put(join(f.profile, "skill-bundles", "b.yml"), Bun.YAML.stringify({ name: "bundle_only", skills: ["release", "bundle-only"], description: "Bundle description." }));
    put(join(f.profile, "skill-bundles", "c.yml"), Bun.YAML.stringify({ name: "bundle_only", skills: ["other"], description: "Duplicate." }));
    put(join(f.profile, "skill-bundles", "fallback.yml"), "skills: [release]\n");
    put(join(f.profile, "skill-bundles", "bad.yaml"), "skills: [\n");
    put(join(f.profile, "skill-bundles", "empty.yaml"), "skills: []\n");
    put(join(f.profile, "skill-bundles", "scalar.yaml"), "skills: release\n");
    expect(f.discovered()).toEqual([
      { name: "bundle-only", description: "Bundle description.", source: "skill", origin: "user" },
      { name: "fallback", description: "Load 1 skills as a bundle", source: "skill", origin: "user" },
      { name: "fastcheck", description: "Quick check.", source: "user" },
      { name: "release", description: "Quick release.", source: "user" },
    ]);
  });

  it("uses default home and malformed configuration without scanning plugin or global agent skills", () => {
    const f = fixture();
    const root = join(f.home, ".hermes", "skills");
    f.skill(root, "probe-skill");
    f.skill(join(f.home, ".agents", "skills"), "not-external");
    f.skill(join(f.home, ".hermes", "plugins", "enabled", "skills"), "plugin");
    put(join(f.home, ".hermes", "config.yaml"), "skills: [\n");
    expect(paneCommands("hermes", f.cwd, f.home).filter((command) => command.source === "skill")).toEqual([
      { name: "probe-skill", description: "Probe body.", source: "skill", origin: "user" },
    ]);
  });
});
