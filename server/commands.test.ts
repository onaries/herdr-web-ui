import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { paneCommands } from "./commands.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe("omo's loaded commands", () => {
  const put = (path: string, text: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); };
  const skill = (root: string, name: string) => put(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: From ${root}\n---\n`);
  const fixture = () => {
    const home = temp("omo-commands-");
    const agentDir = join(home, "custom-agent");
    const pluginDir = join(home, "plugin");
    return { home, agentDir, pluginDir, skillRoots: [join(agentDir, "skills"), join(home, ".agents", "skills"), join(pluginDir, "skills")] };
  };

  it("lists omo builtins and all three roots, with first-root precedence", () => {
    const { home, agentDir, pluginDir, skillRoots } = fixture();
    skillRoots.forEach((root, index) => { skill(root, `root-${index}`); skill(root, "shared"); });
    const commands = paneCommands("omo", null, home, { agentDir, pluginDir });
    const builtins = commands.filter((command) => command.source === "builtin").map((command) => command.name);
    expect(builtins).toEqual(["changelog", "clone", "compact", "copy", "exit", "export", "favorite-models", "fork", "hotkeys", "import", "login", "logout", "model", "name", "new", "quit", "reload", "rename", "resume", "scoped-models", "session", "sessions", "settings", "share", "thinking", "trust"]);
    expect(commands.filter((command) => command.source === "skill").map((command) => command.name)).toEqual(["skill:root-0", "skill:root-1", "skill:root-2", "skill:shared"]);
    expect(commands.find((command) => command.name === "skill:shared")?.description).toBe(`From ${join(agentDir, "skills")}`);
    // the person's own roots, then omo's bundled one; a name both hold is the person's
    expect(commands.filter((command) => command.source === "skill").map((command) => [command.name, command.origin])).toEqual([["skill:root-0", "user"], ["skill:root-1", "user"], ["skill:root-2", "bundled"], ["skill:shared", "user"]]);
    expect(paneCommands("claude", null, home).some((command) => command.origin !== undefined)).toBe(false);
  });

  it("uses default roots without a plugin and excludes untrusted project skills", () => {
    const home = temp("omo-default-");
    const cwd = temp("omo-project-");
    skill(join(home, ".omo", "agent", "skills"), "personal");
    skill(join(home, ".agents", "skills"), "global");
    skill(join(cwd, ".omo", "skills"), "project");
    skill(join(cwd, ".agents", "skills"), "ancestor");
    const commands = paneCommands("omo", cwd, home);
    expect(commands.filter((command) => command.source === "skill").map((command) => command.name)).toEqual(["skill:global", "skill:personal"]);
    expect(paneCommands("omo", cwd, temp("omo-empty-")).every((command) => command.source === "builtin")).toBe(true);
    expect(paneCommands("pi", cwd, home).some((command) => command.name === "favorite-models")).toBe(false);
  });

  it("recurses in every root but stops at a declared skill", () => {
    const { home, agentDir, pluginDir, skillRoots } = fixture();
    skillRoots.forEach((root, index) => {
      skill(join(root, "group"), `inner-${index}`);
      skill(root, `outer-${index}`);
      skill(join(root, `outer-${index}`), `hidden-${index}`);
    });
    const commands = paneCommands("omo", null, home, { agentDir, pluginDir });
    expect(commands.filter((command) => command.source === "skill").map((command) => command.name)).toEqual(["skill:inner-0", "skill:inner-1", "skill:inner-2", "skill:outer-0", "skill:outer-1", "skill:outer-2"]);
  });

  it("applies pi and agents loose-markdown modes with parent-directory names", () => {
    const { home, agentDir, pluginDir, skillRoots } = fixture();
    for (const root of skillRoots) {
      put(join(root, "solo.md"), "---\ndescription: Root markdown\n---\n");
      put(join(root, "group", "inner.md"), "---\ndescription: Nested markdown\n---\n");
    }
    const commands = paneCommands("omo", null, home, { agentDir, pluginDir });
    expect(commands.filter((command) => command.source === "skill")).toEqual([
      { name: "skill:group", description: "Nested markdown", source: "skill", origin: "user" },
      { name: "skill:skills", description: "Root markdown", source: "skill", origin: "user" },
    ]);
  });

  it("rejects absent and blank descriptions, including loose markdown", () => {
    const { home, agentDir } = fixture();
    for (const filename of ["missing/SKILL.md", "blank/SKILL.md", "missing.md", "blank.md"]) {
      put(join(agentDir, "skills", filename), `---\nname: invalid\n${filename.startsWith("blank") ? 'description: "   "\\n' : ""}---\nBody is not a description.\n`);
    }
    expect(paneCommands("omo", null, home, { agentDir }).filter((command) => command.source === "skill")).toEqual([]);
  });

  it("reads long UTF-8 frontmatter without interpreting the skill body", () => {
    const { home, agentDir } = fixture();
    const description = "한".repeat(3000);
    put(join(agentDir, "skills", "long", "SKILL.md"), `---\ndescription: ${description}\n---\nname: body-is-not-metadata\n`);
    expect(paneCommands("omo", null, home, { agentDir }).filter((command) => command.source === "skill")).toEqual([
      { name: "skill:long", description, source: "skill", origin: "user" },
    ]);
  });

  it("honours root and nested ignores without hiding sibling paths", () => {
    const { home, agentDir } = fixture();
    const root = join(agentDir, "skills");
    skill(root, "hidden");
    skill(join(root, "group"), "secret");
    skill(join(root, "other"), "secret");
    put(join(root, ".gitignore"), "hidden/\n");
    put(join(root, "group", ".gitignore"), "secret/\n");
    const commands = paneCommands("omo", null, home, { agentDir });
    expect(commands.filter((command) => command.source === "skill").map((command) => command.name)).toEqual(["skill:secret"]);
    expect(commands.find((command) => command.name === "skill:secret")?.description).toBe(`From ${join(root, "other")}`);
  });

  it("re-includes an allowed directory and its contents after a wildcard ignore", () => {
    const { home, agentDir } = fixture();
    const root = join(agentDir, "skills");
    skill(root, "keep");
    skill(root, "hidden");
    put(join(root, ".ignore"), "*\n!keep/\n!keep/**\n");
    expect(paneCommands("omo", null, home, { agentDir }).filter((command) => command.source === "skill").map((command) => command.name)).toEqual(["skill:keep"]);
  });

  it("follows skill links and skips broken links, cycles, hidden directories and node_modules", () => {
    const { home, agentDir } = fixture();
    const root = join(agentDir, "skills");
    const shared = temp("omo-linked-");
    skill(shared, "linked");
    mkdirSync(root, { recursive: true });
    symlinkSync(join(shared, "linked"), join(root, "alias"), "dir");
    symlinkSync(join(shared, "absent"), join(root, "broken"), "dir");
    symlinkSync(".", join(root, "cycle"), "dir");
    skill(join(root, ".hidden"), "hidden");
    skill(join(root, "node_modules"), "dependency");
    skill(root, "fd-hidden");
    put(join(root, ".fdignore"), "fd-hidden/\n");
    expect(paneCommands("omo", null, home, { agentDir }).filter((command) => command.source === "skill").map((command) => command.name)).toEqual(["skill:linked"]);
  });
});

describe("paneCommands", () => {
  it("returns sorted built-ins for supported agents and none for unknown agents", () => {
    const claude = paneCommands("claude", null, temp("commands-home-"));
    expect(claude.some((command) => command.name === "clear" && command.source === "builtin")).toBeTrue();
    expect(claude.map((command) => command.name)).toEqual([...claude.map((command) => command.name)].sort());
    expect(paneCommands("unknown", "/tmp")).toEqual([]);
    expect(paneCommands(null, "/tmp")).toEqual([]);
  });

  it("offers Claude's /goal with the argument it takes", () => {
    const goal = paneCommands("claude", null, temp("commands-home-")).find((command) => command.name === "goal");
    expect(goal?.source).toBe("builtin");
    expect(goal?.description.startsWith("[condition|clear] — ")).toBeTrue();
    expect(paneCommands("codex", null, temp("commands-home-")).some((command) => command.name === "goal")).toBeTrue();
  });

  it("loads user and nested project Claude commands with descriptions", () => {
    const home = temp("commands-home-");
    const cwd = temp("commands-project-");
    mkdirSync(join(home, ".claude", "commands"), { recursive: true });
    mkdirSync(join(cwd, ".claude", "commands", "team"), { recursive: true });
    writeFileSync(join(home, ".claude", "commands", "deploy.md"), "---\ndescription: Deploy safely\n---\nignored body\n");
    writeFileSync(join(cwd, ".claude", "commands", "team", "review.md"), "\nReview this project thoroughly\nMore detail");

    const commands = paneCommands("claude", cwd, home);
    expect(commands).toContainEqual({ name: "deploy", description: "Deploy safely", source: "user" });
    expect(commands).toContainEqual({ name: "team:review", description: "Review this project thoroughly", source: "project" });
  });
});

describe("skills and plugins", () => {
  const write = (path: string, text: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); };

  it("offers linked skills and commands while skipping broken links and cycles", () => {
    const home = temp("linked-home-");
    const cwd = temp("linked-project-");
    const shared = temp("linked-resources-");
    write(join(shared, "skill", "SKILL.md"), "---\ndescription: Shared skill\n---\n");
    write(join(shared, "review.md"), "Shared review\n");
    write(join(shared, "team", "check.md"), "Shared check\n");
    symlinkSync(".", join(shared, "team", "cycle"), "dir");
    const plugin = join(home, "plugin");
    for (const root of [join(home, ".claude"), join(cwd, ".claude"), join(home, ".codex"), join(cwd, ".codex"), join(home, ".agents"), join(home, ".pi", "agent"), plugin]) {
      const skills = join(root, "skills");
      mkdirSync(skills, { recursive: true });
      symlinkSync(join(shared, "skill"), join(skills, "linked"), "dir");
      symlinkSync(join(shared, "missing"), join(skills, "broken"), "dir");
      symlinkSync("cycle", join(skills, "cycle"), "dir");
    }
    for (const commands of [join(home, ".claude", "commands"), join(cwd, ".claude", "commands"), join(home, ".codex", "prompts"), join(plugin, "commands")]) {
      mkdirSync(commands, { recursive: true });
      symlinkSync(join(shared, "review.md"), join(commands, "review.md"));
      symlinkSync(join(shared, "missing.md"), join(commands, "broken.md"));
      symlinkSync("cycle.md", join(commands, "cycle.md"));
      symlinkSync(join(shared, "team"), join(commands, "team"), "dir");
      symlinkSync(join(shared, "team"), join(commands, "alias"), "dir");
      symlinkSync(".", join(commands, "cycle"), "dir");
    }
    write(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "tools@market": [{ installPath: plugin }] } }));
    write(join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "tools@market": true } }));

    expect(paneCommands("claude", cwd, home).filter((command) => command.source !== "builtin")).toEqual([
      { name: "alias:check", description: "Shared check", source: "user" },
      { name: "linked", description: "Shared skill", source: "skill", origin: "user" },
      { name: "review", description: "Shared review", source: "user" },
      { name: "team:check", description: "Shared check", source: "user" },
      { name: "tools:alias:check", description: "Shared check", source: "plugin" },
      { name: "tools:linked", description: "Shared skill", source: "skill", origin: "plugin" },
      { name: "tools:review", description: "Shared review", source: "plugin" },
      { name: "tools:team:check", description: "Shared check", source: "plugin" },
    ]);
    expect(paneCommands("codex", cwd, home).filter((command) => command.source !== "builtin")).toEqual([
      { name: "prompts:review", description: "Shared review", source: "user" },
    ]);
    const previousPiAgentDir = process.env["PI_CODING_AGENT_DIR"];
    process.env["PI_CODING_AGENT_DIR"] = join(home, ".pi", "agent");
    try {
      expect(paneCommands("pi", null, home).filter((command) => command.source !== "builtin")).toEqual([
        { name: "skill:linked", description: "Shared skill", source: "skill", origin: "user" },
        { name: "skill:linked", description: "Shared skill", source: "skill", origin: "user" },
      ]);
    } finally {
      if (previousPiAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
      else process.env["PI_CODING_AGENT_DIR"] = previousPiAgentDir;
    }
  });

  it("offers Claude's skills, user and project, and the enabled plugins' skills and commands", () => {
    const home = temp("skills-home-");
    const cwd = temp("skills-cwd-");
    write(join(home, ".claude", "skills", "patina", "SKILL.md"), "---\nname: patina\ndescription: Rewrite AI prose\n---\n");
    write(join(home, ".claude", "skills", "notes", "README.md"), "no SKILL.md: not a skill");
    write(join(cwd, ".claude", "skills", "deploy", "SKILL.md"), "---\ndescription: Ship it\n---\n");
    const plugin = join(home, ".claude", "plugins", "cache", "market", "hud", "1.0.0");
    write(join(plugin, "skills", "setup", "SKILL.md"), "---\nname: setup\ndescription: Configure the HUD\n---\n");
    write(join(plugin, "commands", "configure.md"), "---\ndescription: Configure options\n---\n");
    const off = join(home, ".claude", "plugins", "cache", "market", "off", "1.0.0");
    write(join(off, "skills", "hidden", "SKILL.md"), "---\nname: hidden\n---\n");
    write(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "hud@market": [{ installPath: plugin }], "off@market": [{ installPath: off }] } }));
    write(join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "hud@market": true, "off@market": false } }));
    const extra = paneCommands("claude", cwd, home).filter((command) => command.source === "skill" || command.source === "plugin");
    expect(extra).toEqual([
      { name: "deploy", description: "Ship it", source: "skill", origin: "project" },
      { name: "hud:configure", description: "Configure options", source: "plugin" },
      { name: "hud:setup", description: "Configure the HUD", source: "skill", origin: "plugin" },
      { name: "patina", description: "Rewrite AI prose", source: "skill", origin: "user" },
    ]);
  });

  it("passes a long or multi-line description on whole: the menu shortens it, the tooltip shows it", () => {
    const home = temp("whole-home-");
    const long = "Builds the docs site, deploys it to a throwaway preview host and posts the address on the pull request it was asked from, then tears the host down once that pull request closes, however long that takes.";
    expect(long.length).toBeGreaterThanOrEqual(200);
    write(join(home, ".claude", "commands", "preview.md"), `---\ndescription: ${long}\n---\nbody\n`);
    write(join(home, ".claude", "skills", "patina", "SKILL.md"), "---\nname: patina\ndescription: >-\n  Rewrites AI prose in the house style.\n  Use when asked to deslop; never on code.\n---\n");
    write(join(home, ".claude", "skills", "literal", "SKILL.md"), "---\ndescription: |\n  Line one.\n  Line two.\n---\n");
    write(join(home, ".pi", "agent", "prompts", "review.md"), "---\ndescription: >-\n  Review the staged changes\n  one file at a time.\n---\nbody\n");
    const claude = paneCommands("claude", null, home);
    expect(claude.find((command) => command.name === "preview")?.description).toBe(long);
    expect(claude.find((command) => command.name === "patina")?.description).toBe("Rewrites AI prose in the house style. Use when asked to deslop; never on code.");
    expect(claude.find((command) => command.name === "literal")?.description).toBe("Line one.\nLine two.");
    expect(paneCommands("pi", null, home).find((command) => command.name === "review")?.description).toBe("Review the staged changes one file at a time.");
  });

  it("keeps the description line of a header that is not strict YAML", () => {
    const home = temp("loose-home-");
    const commands = join(home, ".claude", "commands");
    write(join(commands, "hint.md"), "---\nargument-hint: [system] [--source <path>]\ndescription: With hint\n---\nYou are the front door\n");
    write(join(commands, "colon.md"), "---\ndescription: Use when: the user asks\n---\n# Heading\n");
    write(join(commands, "sibling.md"), "---\nname: [broken\ndescription: \"Still here\"\n---\nBody line\n");
    write(join(commands, "none.md"), "---\nname: [broken\n---\nBody line\n");
    write(join(commands, "hash.md"), "---\ndescription: Close issue #102 and its PR\n---\nbody\n");
    write(join(commands, "escaped.md"), "---\ndescription: \"Say \\\"hi\\\" first\"\n---\nbody\n");
    const claude = paneCommands("claude", null, home);
    const said = (name: string) => claude.find((command) => command.name === name)?.description;
    expect(said("hint")).toBe("With hint");
    expect(said("colon")).toBe("Use when: the user asks");
    expect(said("sibling")).toBe("Still here");
    // no description line at all: the body's first line, as before
    expect(said("none")).toBe("Body line");
    // a ` #` in a plain value is part of the text, not a YAML comment; a quoted value is YAML's
    expect(said("hash")).toBe("Close issue #102 and its PR");
    expect(said("escaped")).toBe('Say "hi" first');
  });

  it("offers Codex's saved prompts as /prompts:<name> and its skills with $", () => {
    const home = temp("codex-home-");
    write(join(home, ".codex", "prompts", "review.md"), "Review the diff\n");
    write(join(home, ".codex", "skills", "deepinit", "SKILL.md"), "---\nname: deepinit\ndescription: Deep codebase initialization\n---\n");
    const extra = paneCommands("codex", null, home).filter((command) => command.source !== "builtin");
    expect(extra).toEqual([
      { name: "deepinit", description: "Deep codebase initialization", source: "skill", trigger: "$", origin: "user" },
      { name: "prompts:review", description: "Review the diff", source: "user" },
    ]);
  });
});

// Measured against pi 0.87.1: its `/` palette (the built-ins and their wording), and what a
// headless `get_commands` reports for resources planted in each folder pi reads.
describe("pi's slash commands", () => {
  const put = (path: string, text: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); };
  const skill = (root: string, name: string, description: string) => put(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`);

  it("offers pi's own built-ins, in pi's words", () => {
    const commands = paneCommands("pi", null, temp("pi-empty-home-"));
    expect(commands.map((command) => command.name)).toContain("compact");
    // /tree is offered by pi itself but not by the chat, the way omp's list omits it: the command
    // opens pi's tree browser, which the chat reads as nothing at all — no card, pane looks idle —
    // so offering it invites a reader into a state only the terminal lens can leave
    expect(commands.map((command) => command.name)).not.toContain("tree");
    // its own verbs, not the omp/codex wording shared by the rest
    expect(commands).toContainEqual({ name: "quit", description: "Quit pi", source: "builtin" });
    expect(commands.map((command) => command.name)).not.toContain("sessions");
    expect(commands.every((command) => command.source === "builtin")).toBeTrue();
  });

  it("offers the templates and skills pi loads from the person's own folders", () => {
    const home = temp("pi-home-");
    put(join(home, ".pi", "agent", "prompts", "review.md"), "---\ndescription: Review staged git changes\n---\nbody\n");
    put(join(home, ".pi", "agent", "prompts", "plain.md"), "First line wins when there is no frontmatter\n");
    skill(join(home, ".pi", "agent", "skills"), "pdf-tools", "Extract text from PDFs");
    skill(join(home, ".agents", "skills"), "from-agents", "Found under ~/.agents");

    const extra = paneCommands("pi", null, home).filter((command) => command.source !== "builtin");
    expect(extra).toEqual([
      { name: "plain", description: "First line wins when there is no frontmatter", source: "user" },
      { name: "review", description: "Review staged git changes", source: "user" },
      // a skill is a command under skill:, which is how pi names it and how it must be typed
      { name: "skill:from-agents", description: "Found under ~/.agents", source: "skill", origin: "user" },
      { name: "skill:pdf-tools", description: "Extract text from PDFs", source: "skill", origin: "user" },
    ]);
  });

  it("offers a template reached through a symbolic link", () => {
    // pi reads a prompt directory with readdir + stat, so a link to a .md file is a file to it and
    // the command is loaded. `entry.isFile()` on the directory entry asks the link itself, which
    // answers false, and the chat silently hid a command the agent would run — the common way to
    // keep one review prompt shared between a dotfiles repo and an agent dir
    const home = temp("pi-home-");
    const elsewhere = temp("pi-shared-");
    put(join(elsewhere, "review.md"), "---\ndescription: Review staged git changes\n---\nbody\n");
    mkdirSync(join(home, ".pi", "agent", "prompts"), { recursive: true });
    symlinkSync(join(elsewhere, "review.md"), join(home, ".pi", "agent", "prompts", "review.md"));
    const commands = paneCommands("pi", null, home).filter((command) => command.source === "user");
    expect(commands).toEqual([{ name: "review", description: "Review staged git changes", source: "user" }]);
  });

  it("skips a prompt link that resolves to nothing or to a folder", () => {
    // a broken link is skipped by pi too (its stat throws), and a folder is not a template: a
    // conventional prompt directory loads its direct .md children and nothing below one, so
    // following a link to a folder would offer commands pi never loads
    const home = temp("pi-home-");
    const elsewhere = temp("pi-shared-");
    put(join(elsewhere, "deep.md"), "---\ndescription: nested under a linked folder\n---\n");
    mkdirSync(join(home, ".pi", "agent", "prompts"), { recursive: true });
    symlinkSync(join(elsewhere, "gone.md"), join(home, ".pi", "agent", "prompts", "broken.md"));
    // named .md so the name test alone cannot pass it: only the stat knows it is a folder
    symlinkSync(elsewhere, join(home, ".pi", "agent", "prompts", "folder.md"));
    symlinkSync(join(elsewhere, "deep.md"), join(home, ".pi", "agent", "prompts", "ok.md"));
    const names = paneCommands("pi", null, home).filter((command) => command.source === "user").map((command) => command.name);
    expect(names).toEqual(["ok"]);
  });

  it("reads no deeper than pi does in a prompt directory", () => {
    const home = temp("pi-home-");
    put(join(home, ".pi", "agent", "prompts", "top.md"), "---\ndescription: a direct child\n---\n");
    // pi loads direct .md children of a conventional prompt directory and nothing below one
    put(join(home, ".pi", "agent", "prompts", "sub", "deep.md"), "---\ndescription: a nested one\n---\n");
    const names = paneCommands("pi", null, home).filter((command) => command.source === "user").map((command) => command.name);
    expect(names).toEqual(["top"]);
  });

  it("holds a project's own commands back, since pi gates them behind trust", () => {
    const home = temp("pi-home-");
    const cwd = temp("pi-project-");
    put(join(cwd, ".pi", "prompts", "proj-template.md"), "---\ndescription: a project template\n---\n");
    skill(join(cwd, ".pi", "skills"), "proj-skill", "A project skill");
    // offered only where pi would run them, and which folder pi calls the project is its own
    // decision behind ~/.pi/agent/trust.json: a listed command the agent refuses is worse than
    // one missing from the menu, so a project's resources stay in the terminal's menu
    const commands = paneCommands("pi", cwd, home);
    expect(commands.some((command) => command.source === "project")).toBeFalse();
    expect(commands.map((command) => command.name)).not.toContain("proj-template");
    expect(commands.map((command) => command.name)).not.toContain("skill:proj-skill");
  });

  it("leaves a folder with no pi resources at its built-ins", () => {
    expect(paneCommands("pi", temp("pi-cwd-"), temp("pi-home-")).every((command) => command.source === "builtin")).toBeTrue();
  });
});
