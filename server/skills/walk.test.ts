import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paneCommands } from "../commands.ts";
import { ancestorsToRepoRoot, readFrontmatter, walkSkills } from "./walk.ts";
import type { WalkRules } from "./walk.ts";

const roots: string[] = [];
const previousHome = process.env.HOME;
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
});
function temp(): string {
  const root = mkdtempSync(join(tmpdir(), "skill-walk-"));
  roots.push(root);
  return root;
}
function put(path: string, content = ""): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}
const recursive: WalkRules = { depth: "recursive", looseMarkdown: "root", ignoreFiles: true, requireDescription: true };
const one: WalkRules = { depth: "one", looseMarkdown: "none", ignoreFiles: false, requireDescription: false };

describe("shared skill walk", () => {
  it("keeps one-level names, whole descriptions, and body fallbacks", () => {
    const root = temp();
    put(join(root, "named", "SKILL.md"), `---\nname: valid:name\ndescription: ${"x".repeat(150)}\n---\n`);
    put(join(root, "fallback", "SKILL.md"), "---\nname: invalid name\n---\nBody fallback\n");
    put(join(root, "group", "deep", "SKILL.md"), "---\ndescription: Deep\n---\n");
    put(join(root, "loose.md"), "---\ndescription: Loose\n---\n");
    expect(walkSkills(root, one).map(({ name, description }) => [name, description])).toEqual([
      ["fallback", "Body fallback"], ["valid:name", "x".repeat(150)],
    ]);
  });

  it("distinguishes root and nested loose markdown and stops at declared skills", () => {
    const root = temp();
    put(join(root, "root.md"), "---\nname: root\ndescription: Root\n---\n");
    put(join(root, "group", "inner.md"), "---\nname: nested\ndescription: Nested\n---\n");
    put(join(root, "declared", "SKILL.md"), "---\nname: declared\ndescription: Declared\n---\n");
    put(join(root, "declared", "hidden", "SKILL.md"), "---\nname: hidden\ndescription: Hidden\n---\n");
    expect(walkSkills(root, recursive).map(({ name }) => name).sort()).toEqual(["declared", "root"]);
    expect(walkSkills(root, { ...recursive, looseMarkdown: "nested" }).map(({ name }) => name).sort()).toEqual(["declared", "nested"]);
    expect(walkSkills(root, { ...recursive, looseMarkdown: "none" }).map(({ name }) => name)).toEqual(["declared"]);
  });

  it("honors ignores, skip names, symlinks, and the description requirement", () => {
    const root = temp();
    for (const name of ["keep", "ignored", "skipped", ".hidden", "node_modules"]) {
      put(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: Present\n---\n`);
    }
    put(join(root, "blank", "SKILL.md"), '---\ndescription: " "\n---\n');
    put(join(root, "missing", "SKILL.md"), "---\nname: missing\n---\nBody\n");
    put(join(root, ".ignore"), "ignored/\n");
    symlinkSync(".", join(root, "cycle"), "dir");
    symlinkSync("absent", join(root, "broken"), "dir");
    expect(walkSkills(root, { ...recursive, skipNames: (name) => name === "skipped" }).map(({ name }) => name)).toEqual(["keep"]);
    expect(walkSkills(root, { ...one, skipNames: (name) => name === "skipped" }).some(({ name }) => name === "ignored")).toBeTrue();
  });

  it("reads complete UTF-8 YAML metadata and rejects malformed frontmatter", () => {
    const root = temp();
    const path = join(root, "SKILL.md");
    const description = "한".repeat(3000);
    put(path, `\uFEFF---\r\nname: full\r\ndescription: ${description}\r\nuser-invocable: false\r\n---\r\nBody\n`);
    expect(readFrontmatter(path)).toEqual({ name: "full", description, "user-invocable": false });
    put(join(root, "bad.md"), "---\ndescription: [\n---\n");
    expect(readFrontmatter(join(root, "bad.md"))).toBeNull();
    expect(readFrontmatter(join(root, "absent.md"))).toBeNull();
  });

  it("reads a bounded prefix of regular files only, so a huge or device skill cannot stall discovery", () => {
    const root = temp();
    put(join(root, "huge", "SKILL.md"), `---\ndescription: huge\n${"x: y\n".repeat(100_000)}---\nbody`);
    put(join(root, "small", "SKILL.md"), "---\ndescription: small\n---\nbody");
    if (process.platform !== "win32") {
      mkdirSync(join(root, "device"));
      symlinkSync("/dev/zero", join(root, "device", "SKILL.md"));
      expect(readFrontmatter(join(root, "device", "SKILL.md"))).toBeNull();
    }
    expect(readFrontmatter(join(root, "huge", "SKILL.md"))).toBeNull();
    expect(walkSkills(root, { ...one, requireDescription: true }).map((skill) => skill.name)).toEqual(["small"]);
    expect(walkSkills(root, one).map((skill) => skill.name).sort()).toEqual(["huge", "small"]);
  });

  it("leaves empty homes at builtins and unimplemented sources empty", () => {
    const home = temp();
    for (const agent of ["omo", "claude", "codex", "pi", "omp", "grok", "agy", "devin", "hermes"]) {
      expect(paneCommands(agent, home, home).every(({ source }) => source === "builtin")).toBeTrue();
    }
    const opencode = paneCommands("opencode", home, home);
    expect(opencode.filter(({ source }) => source === "builtin").map(({ name }) => name)).toEqual([
      "debug", "diff", "exit", "help", "init", "mcps", "models", "move", "new", "review", "status", "variants",
    ]);
    expect(opencode.filter(({ source }) => source !== "builtin").map(({ name, source, origin }) => ({ name, source, origin }))).toEqual([
      { name: "customize-opencode", source: "skill", origin: "bundled" },
    ]);
  });
});

describe("repository ancestors", () => {
  for (const kind of ["file", "directory"]) {
    it(`stops at the nearest .git ${kind}`, () => {
      const home = temp();
      process.env.HOME = home;
      const repo = join(home, "repo");
      const cwd = join(repo, "sub", "deep");
      mkdirSync(cwd, { recursive: true });
      if (kind === "file") put(join(repo, ".git"), "gitdir: /fixture");
      else mkdirSync(join(repo, ".git"));
      expect(ancestorsToRepoRoot(cwd)).toEqual([cwd, join(repo, "sub"), repo]);
    });
  }
  it("never includes home or its repository and falls back to cwd without a boundary", () => {
    const home = temp();
    process.env.HOME = home;
    const cwd = join(home, "sub", "deep");
    mkdirSync(cwd, { recursive: true });
    put(join(home, ".git"), "gitdir: /fixture");
    expect(ancestorsToRepoRoot(cwd)).toEqual([cwd]);
    expect(ancestorsToRepoRoot(home)).toEqual([]);
    expect(ancestorsToRepoRoot(join(home, ".."))).toEqual([]);
  });
});
