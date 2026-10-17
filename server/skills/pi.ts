import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { AgentCommandContext, AgentCommandSource } from "./index.ts";
import { ancestorsToRepoRoot, environValue, piTemplates, plainObject, readFrontmatter, walkSkills } from "./walk.ts";
import type { SlashCommand } from "../../shared/protocol.ts";

// Docs-based, pi 0.87.1: upstream pi is not installed here, so what pi loads is built from its
// docs (skills.md, prompt-templates.md, settings.md, security.md), not read off a running pi.
// Skills are found recursively (a directory holding SKILL.md ends the descent; loose .md files
// count only directly in a root) and need a description. The agent directory and ~/.agents load
// always; the settings.json `skills` list adds paths; a project's .pi/skills, .agents/skills and
// .pi/prompts load only where project trust says so.

/** pi states what each command opens or does, in its own words, read off its palette. */
const PI_DESCRIPTIONS: Record<string, string> = {
  settings: "Open settings menu", model: "<provider/model> — Select model", thinking: "<level> — Set thinking level",
  "scoped-models": "Enable/disable models for Ctrl+P cycling", login: "<provider> — Configure provider authentication",
  logout: "Remove provider authentication", llama: "[t] Manage llama.cpp router models", new: "Start a new session",
  resume: "Resume a different session", name: "Set session display name", session: "Show session info and stats",
  fork: "Create a new fork from a previous user message",
  clone: "Duplicate the current session at the current position", compact: "Manually compact the session context",
  import: "Import and resume a session from a JSONL file", copy: "Copy last agent message to clipboard",
  export: "Export session (HTML default, or specify path: .html/.jsonl)", share: "Share session as a secret GitHub gist",
  bug: "<description> — Report a bug to the Pi developers", trust: "Save project trust decision for future sessions",
  reload: "Reload keybindings, extensions, skills, prompts, themes, and context files", hotkeys: "Show all keyboard shortcuts",
  changelog: "Show changelog entries", quit: "Quit pi",
};


const readJson = (path: string): unknown => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; /* absent or not JSON */ } };
const canonical = (path: string): string => { try { return realpathSync(path); } catch { return resolve(path); } };

/** PI_CODING_AGENT_DIR from the pane's own environ first, then the server's, else ~/.pi/agent. */
function agentDirectory(home: string, env: readonly string[] | null): string {
  const own = environValue(env, "PI_CODING_AGENT_DIR");
  const dir = own || process.env["PI_CODING_AGENT_DIR"];
  if (!dir) return join(home, ".pi", "agent");
  return dir === "~" || dir.startsWith("~/") ? join(home, dir.slice(2)) : dir;
}

/** Saved decisions in trust.json: an absolute path mapped to true/false, or a list of trusted paths. */
function savedDecisions(value: unknown, into = new Map<string, boolean>()): Map<string, boolean> {
  if (Array.isArray(value)) {
    for (const entry of value) if (typeof entry === "string" && isAbsolute(entry)) into.set(canonical(entry), true);
    return into;
  }
  for (const [key, entry] of Object.entries(plainObject(value))) {
    const fields = plainObject(entry);
    const verdict = typeof entry === "boolean" ? entry : typeof fields["trusted"] === "boolean" ? fields["trusted"] : typeof fields["trust"] === "boolean" ? fields["trust"] : null;
    if (isAbsolute(key) && verdict !== null) into.set(canonical(key), verdict);
    else if (!isAbsolute(key) && typeof entry === "object" && entry !== null) savedDecisions(entry, into);
  }
  return into;
}

/** pi's order without an interactive prompt: the closest saved decision, else defaultProjectTrust. */
function projectTrusted(agentDir: string, settings: Record<string, unknown>, cwd: string): boolean {
  const decisions = savedDecisions(readJson(join(agentDir, "trust.json")));
  for (let directory = canonical(cwd); ; directory = dirname(directory)) {
    const decision = decisions.get(directory);
    if (decision !== undefined) return decision;
    if (directory === dirname(directory)) break;
  }
  return settings["defaultProjectTrust"] === "always";
}

const asCommands = (found: ReturnType<typeof walkSkills>, origin: NonNullable<SlashCommand["origin"]>): SlashCommand[] =>
  found.map(({ name, description }) => ({ name: `skill:${name}`, description, source: "skill", origin }));
const recursive = (root: string): ReturnType<typeof walkSkills> => walkSkills(root, { depth: "recursive", looseMarkdown: "root", ignoreFiles: false, requireDescription: true });

/** One settings entry's skills: a directory is walked, a .md file is one skill. */
function entrySkills(path: string): ReturnType<typeof walkSkills> {
  let target;
  try { target = statSync(path); } catch { return []; }
  if (target.isDirectory()) return recursive(path);
  if (!target.isFile() || !path.endsWith(".md")) return [];
  const fields = readFrontmatter(path);
  if (typeof fields?.["description"] !== "string" || !fields["description"].trim()) return [];
  const name = typeof fields["name"] === "string" && fields["name"] ? fields["name"] : basename(path) === "SKILL.md" ? basename(dirname(path)) : basename(path, ".md");
  return [{ name, description: fields["description"], path, fields }];
}

/** The settings `skills` array: plain paths add, `+path` forces in, `-path` and `!glob` exclude. */
function settingsSkills(home: string, agentDir: string, settings: Record<string, unknown>): { added: ReturnType<typeof walkSkills>; forced: ReturnType<typeof walkSkills>; excluded: (path: string) => boolean } {
  const entries = Array.isArray(settings["skills"]) ? settings["skills"].filter((entry): entry is string => typeof entry === "string") : [];
  const location = (entry: string): string => resolve(agentDir, entry === "~" || entry.startsWith("~/") ? join(home, entry.slice(2)) : entry);
  const expand = (entry: string): string[] => {
    if (!/[*?[{]/.test(entry)) return [location(entry)];
    try { return [...new Bun.Glob(entry).scanSync({ cwd: agentDir, absolute: true, onlyFiles: false })]; } catch { return []; }
  };
  const added: ReturnType<typeof walkSkills> = [];
  const forced: ReturnType<typeof walkSkills> = [];
  const globs: Bun.Glob[] = [];
  const paths: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith("!")) globs.push(new Bun.Glob(entry.slice(1)));
    else if (entry.startsWith("-")) paths.push(location(entry.slice(1)));
    else if (entry.startsWith("+")) for (const path of expand(entry.slice(1))) forced.push(...entrySkills(path));
    else for (const path of expand(entry)) added.push(...entrySkills(path));
  }
  const excluded = (path: string): boolean => {
    const directory = dirname(path);
    return paths.some((entry) => path === entry || directory === entry || path.startsWith(entry + sep))
      || globs.some((glob) => [path, directory, path.slice(agentDir.length + 1), directory.slice(agentDir.length + 1)].some((candidate) => glob.match(candidate)));
  };
  return { added, forced, excluded };
}

function discoverSkills({ home, cwd, env }: AgentCommandContext): SlashCommand[] {
  const agentDir = agentDirectory(home, env);
  const settings = plainObject(readJson(join(agentDir, "settings.json")));
  const listed = settingsSkills(home, agentDir, settings);
  const user = [...recursive(join(agentDir, "skills")), ...recursive(join(home, ".agents", "skills")), ...listed.added].filter((skill) => !listed.excluded(skill.path));
  const result = asCommands([...user, ...listed.forced], "user");
  if (cwd && projectTrusted(agentDir, settings, cwd)) {
    for (const directory of ancestorsToRepoRoot(cwd)) {
      result.push(...asCommands(recursive(join(directory, ".pi", "skills")), "project"), ...asCommands(recursive(join(directory, ".agents", "skills")), "project"));
    }
  }
  return result;
}

export const source: AgentCommandSource = {
  // pi 0.87.1, as its own palette lists them, less /tree — the way omp's list curates its own
  // commands. The chat reads pi's tree browser as nothing at all: no card, and the pane still looks
  // idle while the terminal waits for arrow keys. Offering the one command that opens it from the
  // chat would walk a reader into a state only the terminal lens can leave. Navigating stays in the
  // terminal; the chat's place is the abandoned-turns marker, which says where a /tree left off
  builtins: ["settings", "model", "thinking", "scoped-models", "login", "logout", "llama", "new", "resume", "name", "session", "fork", "clone", "compact", "import", "copy", "export", "share", "bug", "trust", "reload", "hotkeys", "changelog", "quit"],
  descriptions: PI_DESCRIPTIONS,
  discover(ctx) {
    // pi's packages and extension commands stay out: no file scan can know them, and they are in
    // the terminal's own `/` menu either way
    const { home, cwd } = ctx;
    const agentDir = agentDirectory(home, ctx.env);
    const trusted = cwd !== null && cwd !== undefined && projectTrusted(agentDir, plainObject(readJson(join(agentDir, "settings.json"))), cwd);
    return [
      ...piTemplates(join(agentDir, "prompts"), "user"),
      ...(trusted && existsSync(join(cwd, ".pi", "prompts")) ? piTemplates(join(cwd, ".pi", "prompts"), "project") : []),
      ...discoverSkills(ctx),
    ];
  },
};
