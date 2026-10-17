import { afterEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paneCommands } from "../commands.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function temp(): string {
  const root = mkdtempSync(join(tmpdir(), "agy-skills-"));
  roots.push(root);
  return root;
}
function put(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}
function skill(path: string, fields = ""): void {
  put(join(path, "SKILL.md"), `---\ndescription: Probe skill. More detail.\n${fields}---\nProbe body\n`);
}

it("discovers each agy root with nearest-project precedence and no undocumented global root", () => {
  const home = temp(), repo = join(home, "repo"), cwd = join(repo, "sub");
  put(join(repo, ".git"), "gitdir: fixture");
  for (const prefix of [".agents", ".agent", "_agents", "_agent"]) skill(join(repo, prefix, "skills", prefix.slice(1)));
  skill(join(repo, ".agents", "skills", "collision"));
  skill(join(cwd, ".agents", "skills", "collision"));
  skill(join(home, ".gemini", "config", "skills", "personal"));
  skill(join(home, ".gemini", "config", "skills", "collision"));
  skill(join(home, ".gemini", "config", "plugins", "sample", "skills", "plugin-skill"));
  skill(join(home, ".gemini", "antigravity-cli", "builtin", "skills", "bundled-skill"));
  skill(join(home, ".gemini", "antigravity-cli", "skills", "wrong-global"));
  skill(join(home, ".agents", "skills", "outside-repo"));
  const commands = paneCommands("agy", cwd, home).filter(({ source }) => source === "skill");
  expect(commands.map(({ name, origin }) => [name, origin])).toEqual([
    ["agent", "project"], ["agents", "project"], ["bundled-skill", "bundled"], ["collision", "project"],
    ["personal", "user"], ["plugin-skill", "plugin"],
  ]);
});

it("requires descriptions, skips disabled skills, and scans only one level by default", () => {
  const home = temp(), root = join(home, ".gemini", "config", "skills");
  skill(join(root, "enabled"), "name: renamed\n");
  skill(join(root, "disabled"), "disable-slash-command: true\n");
  skill(join(root, "group", "nested"));
  put(join(root, "missing", "SKILL.md"), "---\nname: missing\n---\nBody\n");
  put(join(root, "blank", "SKILL.md"), '---\ndescription: " "\n---\n');
  const commands = paneCommands("agy", null, home).filter(({ source }) => source === "skill");
  expect(commands.map(({ name }) => name)).toEqual(["renamed"]);
});

it("loads nested include_only registrations with path resolution and excludes", () => {
  const home = temp(), repo = join(home, "repo"), cwd = join(repo, "sub");
  put(join(repo, ".git"), "gitdir: fixture");
  mkdirSync(cwd, { recursive: true });
  skill(join(repo, "shared", "category", "nested"));
  skill(join(repo, "shared", "category", "excluded"));
  skill(join(home, "extra", "home-skill"));
  skill(join(home, "absolute", "absolute-skill"));
  put(join(repo, ".agents", "skills.json"), JSON.stringify({ entries: [
    { path: "shared", include_only: ["category/nested", "category/excluded"], exclude: ["category/excluded"] },
    { path: "~/extra" }, { path: join(home, "absolute") },
  ] }));
  const commands = paneCommands("agy", cwd, home).filter(({ source }) => source === "skill");
  expect(commands.map(({ name, origin }) => [name, origin])).toEqual([
    ["absolute-skill", "project"], ["home-skill", "project"], ["nested", "project"],
  ]);
});

it("offers a bundled skill once when it is a builtin, and never as an unrepresentable command", () => {
  const home = temp(), bundled = join(home, ".gemini", "antigravity-cli", "builtin", "skills");
  for (const name of ["agy-customizations", "plugin", "kept"]) skill(join(bundled, name));
  const commands = paneCommands("agy", null, home);
  expect(commands.filter(({ name }) => name === "agy-customizations").map(({ source }) => source)).toEqual(["builtin"]);
  expect(commands.some(({ name }) => name === "plugin")).toBeFalse();
  expect(commands.filter(({ source }) => source === "skill").map(({ name }) => name)).toEqual(["kept"]);
});

it("retains the recorded palette and aliases except unrepresentable screens", () => {
  const commands = paneCommands("agy", null, temp());
  expect(commands.map(({ name }) => name).sort()).toEqual([
    "add-dir", "agy-customizations", "antigravity-guide", "artifact", "boost", "branch", "browser",
    "btw", "changelog", "clear", "codesearch", "context", "copy", "cs", "diff", "exit", "feedback",
    "fork", "goal", "grill-me", "help", "learn", "logout", "new", "open", "plan", "quit", "quota",
    "remote-control", "rename", "rewind", "schedule", "search", "statusline", "tasks",
    "teamwork-preview", "title", "undo", "usage",
  ].sort());
  expect(commands.every(({ source }) => source === "builtin")).toBeTrue();
});
