import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paneCommands } from "../commands.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const put = (path: string, text: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); };
const skill = (path: string, name: unknown, description: unknown = "First sentence. Second sentence.", extra = "") =>
  put(join(path, "SKILL.md"), `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n${extra}---\nBody\n`);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "opencode-menu-"));
  roots.push(root);
  const home = join(root, "home");
  const repo = join(root, "repo");
  const cwd = join(repo, "packages", "app");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(repo, ".git"));
  return { root, home, repo, cwd, config: join(home, ".config", "opencode") };
}

describe("OpenCode's menu", () => {
  it("loads recursive native and external roots up to the repository boundary with origins", () => {
    const { root, home, repo, cwd, config } = fixture();
    skill(join(config, "skill", "nested", "native"), "native");
    skill(join(config, "skills", "plural"), "plural", "Description", "metadata:\n  opencode/slash: false\n");
    skill(join(home, ".claude", "skills", "claude"), "claude");
    skill(join(home, ".agents", "skills", "agents"), "agents");
    skill(join(repo, ".opencode", "skills", "project"), "project");
    skill(join(cwd, ".opencode", "skill", "local"), "local");
    skill(join(repo, ".claude", "skills", "external-project"), "external-project");
    skill(join(cwd, ".agents", "skills", "local-agents"), "local-agents");
    skill(join(root, ".opencode", "skills", "outside"), "outside");
    symlinkSync(join(config, "skills"), join(config, "skills", "loop"), "dir");
    const commands = paneCommands("opencode", cwd, home);
    expect(commands.filter((row) => row.source === "skill").map(({ name, origin }) => [name, origin])).toEqual([
      ["agents", "user"], ["claude", "user"], ["customize-opencode", "bundled"], ["external-project", "project"],
      ["local", "project"], ["local-agents", "project"], ["native", "user"], ["plural", "user"], ["project", "project"],
    ]);
  });

  for (const flag of ["OPENCODE_DISABLE_EXTERNAL_SKILLS", "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS", "OPENCODE_DISABLE_CLAUDE_CODE"]) {
    it(`omits external roots when the pane sets ${flag}`, () => {
      const { home, cwd, config } = fixture();
      skill(join(config, "skills", "native"), "native");
      for (const directory of [home, cwd]) {
        for (const kind of [".claude", ".agents"]) skill(join(directory, kind, "skills", "external"), "external");
      }
      const commands = paneCommands("opencode", cwd, home, { environ: [`${flag}=1`] });
      expect(commands.filter((row) => row.source === "skill").map((row) => row.name)).toEqual(["customize-opencode", "native"]);
    });
  }

  it("honors the pane config directory rather than the server environment", () => {
    const { root, home, config } = fixture();
    skill(join(config, "skills", "default"), "default");
    const custom = join(root, "custom");
    skill(join(custom, "skill", "custom"), "custom");
    put(join(custom, "commands", "check.md"), "---\ndescription: Check\n---\nRun checks");
    const commands = paneCommands("opencode", null, home, { environ: [`OPENCODE_CONFIG_DIR=${custom}`] });
    expect(commands.filter((row) => row.source !== "builtin").map((row) => row.name)).toEqual(["check", "custom", "customize-opencode"]);
  });

  it("rejects invalid metadata without falling back to directory names", () => {
    const { home, config } = fixture();
    for (const [directory, name, desc] of [
      ["mismatch", "different", "Description"], ["missing", null, "Description"],
      ["Upper", "Upper", "Description"], ["bad--name", "bad--name", "Description"],
      ["long-description", "long-description", "x".repeat(1025)], ["blank", "blank", "   "],
      ["not-string", "not-string", 7], ["a".repeat(65), "a".repeat(65), "Description"],
    ] as const) skill(join(config, "skills", directory), name, desc);
    skill(join(config, "skills", "a".repeat(64)), "a".repeat(64), "x".repeat(1024));
    const commands = paneCommands("opencode", null, home);
    expect(commands.filter((row) => row.source === "skill").map((row) => row.name)).toEqual(["a".repeat(64), "customize-opencode"]);
  });

  it("merges JSONC and markdown commands and lets commands win over skills", () => {
    const { home, repo, cwd, config } = fixture();
    put(join(config, "opencode.json"), JSON.stringify({ command: { user: { template: "x", description: "User" }, collision: { template: "x" }, invalid: { description: "No template" } } }));
    put(join(repo, "opencode.jsonc"), `{
      // a URL and comment-like text inside a string remain intact
      "command": { "json-command": { "template": "https://example.com/*x*/,", "description": "JSON", }, },
    }`);
    put(join(repo, ".opencode", "commands", "collision.md"), "---\ndescription: Project command\n---\nBody");
    put(join(config, "commands", "markdown.md"), "---\ndescription: >-\n  First sentence.\n  More detail.\n---\nBody");
    put(join(config, "opencode.jsonc"), "malformed");
    for (const name of ["collision", "init"]) skill(join(config, "skills", name), name);
    const commands = paneCommands("opencode", cwd, home);
    expect(commands.filter((row) => row.source === "user" || row.source === "project").map(({ name, source }) => [name, source])).toEqual([
      ["collision", "project"], ["json-command", "project"], ["markdown", "user"], ["user", "user"],
    ]);
    expect(commands.filter((row) => row.name === "collision")).toHaveLength(1);
    expect(commands.find((row) => row.name === "markdown")?.description).toBe("First sentence. More detail.");
    expect(commands.find((row) => row.name === "init")?.source).toBe("builtin");
  });

  it("keeps unchecked palette commands and omits the six recorded unrepresentable screens", () => {
    const { home } = fixture();
    const commands = paneCommands("opencode", null, home);
    expect(commands.filter((row) => row.source === "builtin").map((row) => row.name)).toEqual([
      "debug", "diff", "exit", "help", "init", "mcps", "models", "move", "new", "review", "status", "variants",
    ]);
  });
});
