import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paneCommands } from "../commands.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "codex-skills-"));
  roots.push(root);
  return { root, home: join(root, "home"), repo: join(root, "repo"), store: join(root, "profile") };
}
function put(path: string, text = ""): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}
function skill(root: string, name: string): string {
  const path = join(root, name, "SKILL.md");
  put(path, `---\nname: ${name}\ndescription: First sentence. Second sentence.\n---\nBody\n`);
  return path;
}

describe("Codex skill discovery", () => {
  it("loads ancestor, shared, legacy, system and linked skills with their origins", () => {
    const { root, home, repo } = fixture();
    const cwd = join(repo, "packages", "app");
    mkdirSync(cwd, { recursive: true });
    put(join(repo, ".git"));
    skill(join(root, ".agents", "skills"), "outside");
    for (const directory of [repo, join(repo, "packages"), cwd]) skill(join(directory, ".agents", "skills"), "same");
    skill(join(home, ".agents", "skills"), "shared");
    skill(join(home, ".codex", "skills"), "legacy");
    skill(join(home, ".codex", "skills", ".system"), "creator");
    skill(join(cwd, ".codex", "skills"), "unsupported");
    const linked = skill(join(root, "links"), "target");
    symlinkSync(join(linked, ".."), join(home, ".agents", "skills", "link"), "dir");
    skill(join(home, ".agents", "skills", "group"), "nested");
    put(join(home, ".agents", "skills", "missing-description", "SKILL.md"), "---\nname: missing-description\n---\nBody");
    put(join(home, ".agents", "skills", "missing-name", "SKILL.md"), "---\ndescription: Not a skill\n---\n");
    put(join(home, ".agents", "skills", ".ignore"), "shared/\n");
    const commands = paneCommands("codex", cwd, home).filter((command) => command.source === "skill");
    expect(commands.map(({ name, origin, trigger }) => [name, origin, trigger])).toEqual([
      ["creator", "bundled", "$"], ["legacy", "user", "$"],
      ["same", "project", "$"], ["same", "project", "$"], ["same", "project", "$"],
      ["shared", "user", "$"], ["target", "user", "$"],
    ]);
    expect(commands.every((command) => command.description === "First sentence. Second sentence.")).toBe(true);
  });

  it("uses the pane CODEX_HOME and only direct Markdown prompts", () => {
    const { home, store } = fixture();
    skill(join(home, ".codex", "skills"), "wrong-store");
    skill(join(store, "skills"), "profile");
    put(join(store, "prompts", "review.md"), "---\ndescription: Review staged files\n---\nReview");
    put(join(store, "prompts", "nested", "hidden.md"), "Hidden");
    put(join(store, "prompts", "ignored.txt"), "Ignored");
    const commands = paneCommands("codex", null, home, { environ: [`CODEX_HOME=${store}`] }).filter((command) => command.source !== "builtin");
    expect(commands.map(({ name, source, trigger }) => [name, source, trigger])).toEqual([
      ["profile", "skill", "$"], ["prompts:review", "user", undefined],
    ]);
  });

  it("excludes disabled canonical paths including symlink aliases", () => {
    const { home, store } = fixture();
    const disabled = skill(join(store, "skills"), "disabled");
    skill(join(store, "skills"), "enabled");
    mkdirSync(join(home, ".agents", "skills"), { recursive: true });
    symlinkSync(join(disabled, ".."), join(home, ".agents", "skills", "alias"), "dir");
    put(join(store, "config.toml"), `[[skills.config]]\npath = ${JSON.stringify(disabled)}\nenabled = false\n`);
    expect(paneCommands("codex", null, home, { environ: [`CODEX_HOME=${store}`] }).filter((command) => command.source === "skill").map((command) => command.name)).toEqual(["enabled"]);
  });

  it("keeps skills discoverable when TOML is malformed", () => {
    const { home } = fixture();
    skill(join(home, ".codex", "skills"), "available");
    put(join(home, ".codex", "config.toml"), "[[skills.config]\nenabled = false");
    expect(paneCommands("codex", null, home).some((command) => command.name === "available")).toBe(true);
  });

  it("loads enabled marketplace plugins and omits disabled or unconfigured ones", () => {
    const { home } = fixture();
    const store = join(home, ".codex");
    skill(join(store, "plugins", "cache", "market", "enabled", "1.0", "skills"), "plugin-skill");
    skill(join(store, "plugins", "cache", "market", "disabled", "1.0", "skills"), "disabled-skill");
    skill(join(store, "plugins", "cache", "other-market", "enabled", "1.0", "skills"), "other-market-skill");
    skill(join(store, "plugins", "cache", "unconfigured", "1.0", "skills"), "unconfigured-skill");
    put(join(store, "config.toml"), '[plugins."enabled@market"]\nenabled = true\n[plugins."disabled@market"]\nenabled = false\n');
    expect(paneCommands("codex", null, home).filter((command) => command.origin === "plugin")).toEqual([
      { name: "plugin-skill", description: "First sentence. Second sentence.", source: "skill", trigger: "$", origin: "plugin" },
    ]);
  });

  it("includes every cached plugin without a plugin table and bounds cache cycles", () => {
    const { home } = fixture();
    const cache = join(home, ".codex", "plugins", "cache");
    skill(join(cache, "simple-plugin", "v1", "skills"), "simple");
    skill(join(cache, "market", "plugin", "v1", "skills"), "marketplace");
    symlinkSync(cache, join(cache, "cycle"), "dir");
    expect(paneCommands("codex", null, home).filter((command) => command.origin === "plugin").map((command) => command.name)).toEqual(["marketplace", "simple"]);
  });

  it("skips a stale plugin link without hiding the plugins beside it", () => {
    const { home } = fixture();
    const market = join(home, ".codex", "plugins", "cache", "market");
    // Plugins and stale links alternate, so whichever way the directory is read a stale link comes first.
    for (const index of [1, 2, 3]) {
      skill(join(market, `plugin-${index}`, "1.0", "skills"), `kept-${index}`);
      if (index < 3) symlinkSync(join(market, "gone"), join(market, `stale-${index}`), "dir");
    }
    expect(paneCommands("codex", null, home).filter((command) => command.origin === "plugin").map((command) => command.name)).toEqual(["kept-1", "kept-2", "kept-3"]);
  });

  it("loads a plugin version and its latest link once", () => {
    const { home } = fixture();
    const plugin = join(home, ".codex", "plugins", "cache", "market", "chrome");
    skill(join(plugin, "1.0", "skills"), "control-chrome");
    symlinkSync(join(plugin, "1.0"), join(plugin, "latest"), "dir");
    expect(paneCommands("codex", null, home).filter((command) => command.origin === "plugin").map((command) => command.name)).toEqual(["control-chrome"]);
  });

  it("keeps the representable model picker and unchecked palette commands", () => {
    const { home } = fixture();
    const builtins = paneCommands("codex", null, home).filter((command) => command.source === "builtin").map((command) => command.name);
    expect(builtins).toHaveLength(44);
    expect(builtins).toContain("model");
    expect(builtins).toContain("keymap");
    expect(builtins).toContain("subagents");
    for (const name of ["resume", "permissions", "agents", "hooks", "mcp", "plugins", "skills", "voice", "theme", "help", "quit"]) expect(builtins).not.toContain(name);
  });
});
