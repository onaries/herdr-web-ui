import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paneCommands } from "../commands.ts";
import { typedTerminalCommand } from "../../src/lib/compose.ts";
import { source } from "./cmd.ts";

// Copied from Command Code 1.84.0, dist/bundled/command-code-knowledge/reference/custom-slash-commands.md:
// Canonical names and descriptions are checked against the pinned reference; the wire catalog has no alias field.
// `/clear` (`/new`): Start a new session with empty context; previous stays on disk, resumable with `/resume`
// `/resume` (`/sessions`): Resume a past conversation
// `/exit` (`/quit`): Exit Command Code
// `/feedback [title]` (alias `/issue`): Report a bug or share feedback; opens a prefilled GitHub issue
// Copied from product-help.md: `/learn (courses): Open the Command Code learn hub in your browser`
const PINNED_SLASH_COMMANDS = [
  "init", "import", "goal", "memory", "resume", "fork", "worktree", "clone", "rename", "name", "rewind",
  "tree", "clear", "theme", "language", "share", "unshare", "taste", "learn-taste", "skills", "agents",
  "design", "mcp", "model", "effort", "connect", "compact", "compact-mode", "config", "context", "ide",
  "terminal-setup", "login", "logout", "learn", "feedback", "trace", "session-file", "copy", "export",
  "changelog", "hotkeys", "todos", "loop", "rc", "plan", "mode", "mode:default", "mode:accept-edits",
  "mode:plan", "plans", "plan-review", "review", "pr-comments", "add-dir", "status", "statusline", "usage",
  "upgrade", "extra", "update", "reload", "mods", "help", "exit",
];
// Separate alias rows preserve typed names: /new, /sessions, /quit, /issue, /courses.

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function temp(): string {
  const root = mkdtempSync(join(tmpdir(), "cmd-skills-"));
  roots.push(root);
  return root;
}
function put(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}
function skill(root: string, name: string, description = `${name} skill`): string {
  const path = join(root, name, "SKILL.md");
  put(path, `---\nname: ${name}\ndescription: ${description}\n---\nBody\n`);
  return path;
}
function context(home: string, cwd: string | null = null) {
  return { home, cwd, repoRoot: null, env: null, roots: {} };
}

describe("Command Code command catalog", () => {
  it("matches the pinned canonical builtins", () => {
    expect(new Set(source.builtins)).toEqual(new Set([...PINNED_SLASH_COMMANDS, "new", "sessions", "quit", "issue", "courses"]));
    expect(new Set(source.builtins)).toHaveLength(70);
    expect(source.pin).toBe("1.84.0");
  });

  it("lists a skill by its primary slash name", () => {
    const home = temp();
    skill(join(home, ".commandcode", "skills"), "x");
    expect(source.discover(context(home)).map(({ name }) => name)).toContain("x");
    expect(source.discover(context(home)).map(({ name }) => name)).toContain("agent-browser");
    expect(paneCommands("cmd", null, home).some(({ name }) => name === "x")).toBe(true);
  });

  it("uses skill: only when its name shadows a builtin", () => {
    const home = temp();
    skill(join(home, ".commandcode", "skills"), "compact");
    skill(join(home, ".commandcode", "skills"), "x");
    const skills = source.discover(context(home)).filter(({ source }) => source === "skill");
    expect(skills.map(({ name }) => name)).toContain("skill:compact");
    expect(skills.map(({ name }) => name)).toContain("x");
    expect(skills.map(({ name }) => name)).toContain("skill:loop");
    expect(source.skillsOverrideBuiltins).not.toBe(true);
  });

  it("loads nested custom commands with their parent label", () => {
    const home = temp();
    put(join(home, ".commandcode", "commands", "frontend", "component.md"), "Build a component");
    expect(source.discover(context(home))).toContainEqual(expect.objectContaining({
      name: "component",
      description: "frontend · Build a component",
    }));
  });

  it("deduplicates a symlinked skill by canonical path", () => {
    const home = temp();
    const root = join(home, ".commandcode", "skills");
    const target = skill(root, "x");
    mkdirSync(join(home, ".agents", "skills"), { recursive: true });
    symlinkSync(join(target, ".."), join(home, ".agents", "skills", "linked"), "dir");
    const rows = source.discover(context(home)).filter(({ name }) => name === "x");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(realpathSync(target));
  });

  it("carries canonical IDs through the pane catalog and has the model builtin", () => {
    const home = temp();
    skill(join(home, ".commandcode", "skills"), "x");
    const rows = paneCommands("cmd", null, home);
    expect(rows.some(({ name, source }) => name === "model" && source === "builtin")).toBe(true);
    expect(rows.find(({ name }) => name === "x")?.id).toBe(realpathSync(join(home, ".commandcode", "skills", "x", "SKILL.md")));
  });

  it("pins each distinct command form class and uses per-form terminal behavior", () => {
    expect(source.forms?.["compact"]).toEqual([{ match: "bare", interaction: "none" }]);
    expect(source.forms?.["goal"]?.find(({ match }) => match === "bare")?.interaction).toBe("unknown");
    expect(source.forms?.["model"]).toEqual([
      { match: "bare", interaction: "terminal" },
      { match: "other", interaction: "none" },
    ]);
    expect(source.forms?.["config"]).toEqual([
      { match: "bare", interaction: "terminal" },
      { match: "other", interaction: "terminal" },
    ]);
    expect(source.forms?.["mode"]).toEqual([
      { match: "bare", interaction: "terminal" },
      { match: "other", interaction: "none" },
    ]);
    expect(source.forms?.["rc"]?.find(({ match }) => match === "bare")?.interaction).toBe("terminal");
    expect(source.forms?.["plans"]).toContainEqual({ match: "other", interaction: "terminal" });
    expect(source.forms?.["worktree"]).toContainEqual({ match: { sub: "list" }, interaction: "terminal" });
    expect(source.forms?.["rc"]).toContainEqual({ match: { sub: "status" }, interaction: "terminal" });
    expect(source.forms?.["memory"]).toEqual([{ match: "bare", interaction: "terminal" }]);
    expect(source.forms?.["design"]?.find(({ match }) => match === "bare")?.interaction).toBe("terminal");
    expect(paneCommands("cmd", null, temp()).find(({ name }) => name === "model")?.visibility).not.toBe("terminal");
    const model = paneCommands("cmd", null, temp()).find(({ name }) => name === "model")!;
    expect(typedTerminalCommand([model], "/model")).toBe(model);
    expect(typedTerminalCommand([model], "/model gpt-5")).toBeNull();
  });

  it("keeps only well-formed subcommand and other match rules", () => {
    expect(source.forms?.["model"]?.some((form) => typeof form.match === "object" && form.match.sub === "*")).toBe(false);
    expect(source.forms?.["model"]?.some((form) => form.match === "other")).toBe(true);
  });

  it("hides non-invocable skills and skills disabled in user or project settings", () => {
    const home = temp();
    const repo = join(temp(), "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const cwd = join(repo, "app");
    mkdirSync(cwd, { recursive: true });
    skill(join(home, ".commandcode", "skills"), "hidden");
    put(join(home, ".commandcode", "skills", "hidden", "SKILL.md"), "---\nname: hidden\ndescription: hidden\nuser-invocable: false\n---\n");
    skill(join(home, ".commandcode", "skills"), "user-disabled");
    put(join(home, ".commandcode", "settings.json"), JSON.stringify({ disabledSkills: ["user-disabled"] }));
    skill(join(repo, ".commandcode", "skills"), "project-disabled");
    put(join(repo, ".commandcode", "settings.json"), JSON.stringify({ disabledSkills: ["project-disabled"] }));
    expect(source.discover(context(home, cwd)).map(({ name }) => name)).not.toContain("hidden");
    expect(source.discover(context(home, cwd)).map(({ name }) => name)).not.toContain("user-disabled");
    expect(source.discover(context(home, cwd)).map(({ name }) => name)).not.toContain("project-disabled");
  });

  it("resolves relative user and project skill roots from the project root", () => {
    const home = temp();
    const repo = join(temp(), "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const cwd = join(repo, "src");
    mkdirSync(cwd, { recursive: true });
    skill(join(repo, "vendor", "skills"), "project-extra");
    skill(join(repo, "team", "skills"), "user-extra");
    put(join(home, ".commandcode", "settings.json"), JSON.stringify({ skills: ["./team/skills"] }));
    expect(source.discover(context(home, cwd)).map(({ name }) => name)).toContain("user-extra");
    expect(source.discover(context(home, cwd)).find(({ name }) => name === "user-extra")?.origin).toBe("user");
    put(join(repo, ".commandcode", "settings.json"), JSON.stringify({ skills: ["./vendor/skills"] }));
    const names = source.discover(context(home, cwd)).map(({ name }) => name);
    expect(names).toContain("project-extra");
    expect(names).not.toContain("user-extra");
  });

  it("reads a custom command's description from its first 64 KiB only", () => {
    const home = temp();
    put(join(home, ".commandcode", "commands", "huge.md"), "x".repeat(2 * 1024 * 1024));
    const huge = source.discover(context(home)).find(({ name }) => name === "huge");
    expect(huge?.description.length).toBeLessThanOrEqual(64 * 1024);
  });

  it("keeps the catalog when a configured skill path is a file", () => {
    const home = temp();
    const repo = join(temp(), "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    put(join(repo, "loose.md"), "---\nname: loose\ndescription: Loose\n---\n");
    put(join(repo, ".commandcode", "settings.json"), JSON.stringify({ skills: ["./loose.md"] }));
    const names = source.discover(context(home, repo)).map(({ name }) => name);
    expect(names).toContain("agent-browser");
  });

  it("lets settings.local.json replace project skill locations at highest priority", () => {
    const home = temp();
    const repo = join(temp(), "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const cwd = join(repo, "src");
    mkdirSync(cwd, { recursive: true });
    skill(join(repo, "vendor", "base-skills"), "base-extra");
    skill(join(repo, "vendor", "local-skills"), "local-extra");
    put(join(repo, ".commandcode", "settings.json"), JSON.stringify({ skills: ["./vendor/base-skills"] }));
    put(join(repo, ".commandcode", "settings.local.json"), JSON.stringify({ skills: ["./vendor/local-skills"] }));
    const names = source.discover(context(home, cwd)).map(({ name }) => name);
    expect(names).toContain("local-extra");
    expect(names).not.toContain("base-extra");
    put(join(repo, ".commandcode", "settings.local.json"), JSON.stringify({ skills: [] }));
    const overridden = source.discover(context(home, cwd)).map(({ name }) => name);
    expect(overridden).not.toContain("local-extra");
    expect(overridden).not.toContain("base-extra");
  });

  it("qualifies skills colliding with builtin aliases and custom commands", () => {
    const home = temp();
    const commandRoot = join(home, ".commandcode", "commands");
    put(join(commandRoot, "help.md"), "Custom help");
    skill(join(home, ".commandcode", "skills"), "new");
    skill(join(home, ".commandcode", "skills"), "help");
    const rows = source.discover(context(home));
    expect(rows.map(({ name }) => name)).toContain("skill:new");
    expect(rows.map(({ name }) => name)).toContain("skill:help");
    expect(rows.find(({ name }) => name === "help")?.source).toBe("user");
  });

  it("matches custom command collisions without regard to case", () => {
    const home = temp();
    put(join(home, ".commandcode", "commands", "Deploy.md"), "Deploy this project");
    skill(join(home, ".commandcode", "skills"), "deploy");
    const rows = source.discover(context(home));
    expect(rows.map(({ name }) => name)).toContain("Deploy");
    expect(rows.map(({ name }) => name)).toContain("skill:deploy");
    expect(rows.filter(({ name }) => name.toLowerCase() === "deploy")).toHaveLength(1);
  });
});
