import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const CACHE_MS = 5_000;
const MAX_ENTRIES = 5_000;
/** git lists paths cheaply, so a tracked data set of thousands of files does not hide the rest */
const MAX_GIT_ENTRIES = 100_000;
/** one folder's share of files, so a folder of thousands leaves room for its siblings; its subfolders are always walked */
const MAX_FOLDER_ENTRIES = 1_000;
const MAX_DEPTH = 6;
const SKIP: Record<string, true> = { ".git": true, node_modules: true, dist: true, target: true, ".venv": true };
const cache = new Map<string, { expires: number; files: string[] }>();

/** What one git listing may print; past it the listing is not used and the walk answers instead. */
export const GIT_LIST_MAX_BYTES = 16 * 1024 * 1024;
/** How long one git listing may run, including a process it left holding its output. */
export const GIT_LIST_DEADLINE_MS = 3_000;

interface GitListOptions {
  /** the git to run (a stand-in, in tests) */
  git: string;
  deadlineMs: number;
  maxBytes: number;
}

const GIT_LIST_DEFAULTS: GitListOptions = { git: "git", deadlineMs: GIT_LIST_DEADLINE_MS, maxBytes: GIT_LIST_MAX_BYTES };
let gitList = GIT_LIST_DEFAULTS;

/** For tests: a stand-in git, a shorter deadline or a smaller cap. No argument restores the defaults. */
export function setGitListOptions(options: Partial<GitListOptions> = {}): void {
  gitList = { ...GIT_LIST_DEFAULTS, ...options };
}

/** The same policy as `repo-diff.ts`: only read the repository, run no hook or helper, never prompt. */
function gitEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    // a repository the server itself was started inside (a hook, a test runner) is not the one asked about
    if (value === undefined || name === "GIT_DIR" || name === "GIT_WORK_TREE" || name === "GIT_INDEX_FILE" || name === "GIT_COMMON_DIR" || name === "GIT_EXTERNAL_DIFF" || name === "GIT_PAGER") continue;
    env[name] = value;
  }
  return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };
}

function gitListArgv(cwd: string): string[] {
  // an empty core.fsmonitor turns the hook off in every git: before 2.36, `false` names a program to run
  return [gitList.git, "--no-pager", "--no-optional-locks", "--literal-pathspecs", "-c", "core.fsmonitor=", "-C", cwd, "ls-files", "-z", "-co", "--exclude-standard"];
}

/** Split only a listing read whole: one whose last name lacks its NUL was cut short, so none of it is used. */
function listedNames(output: Uint8Array): string[] | null {
  if (output.byteLength > 0 && output[output.byteLength - 1] !== 0) return null;
  return Buffer.from(output.buffer, output.byteOffset, output.byteLength).toString("utf8").split("\0").filter(Boolean);
}

async function gitFiles(cwd: string): Promise<string[] | null> {
  const { deadlineMs, maxBytes } = gitList;
  let proc: Bun.Subprocess<"ignore", "pipe", "ignore">;
  try {
    proc = Bun.spawn(gitListArgv(cwd), { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: gitEnvironment() });
  } catch {
    return null;
  }
  const reader = proc.stdout.getReader();
  let stopped = false;
  const stop = () => {
    stopped = true;
    proc.kill("SIGKILL");
    // a process git left behind may still hold stdout after git itself exits
    void reader.cancel().catch(() => undefined);
  };
  const timer = setTimeout(stop, deadlineMs);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        stop();
        break;
      }
      chunks.push(value);
    }
    const exitCode = await proc.exited;
    if (stopped || exitCode !== 0) return null;
    const names = listedNames(Buffer.concat(chunks));
    return names && [...new Set(names)].slice(0, MAX_GIT_ENTRIES);
  } finally {
    clearTimeout(timer);
  }
}

/** Breadth first, each folder taking at most its share, so one huge folder cannot use up the walk. */
function walkFiles(cwd: string): string[] {
  const files: string[] = [];
  let visited = 0;
  let level = [cwd];
  for (let depth = 0; depth <= MAX_DEPTH && level.length > 0 && visited < MAX_ENTRIES; depth += 1) {
    const next: string[] = [];
    for (const directory of level) {
      if (visited >= MAX_ENTRIES) break;
      let entries;
      try {
        entries = readdirSync(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((left, right) => Number(left.isDirectory()) - Number(right.isDirectory()) || left.name.localeCompare(right.name));
      let taken = 0;
      for (const entry of entries) {
        if (visited >= MAX_ENTRIES) break;
        if (SKIP[entry.name]) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          visited += 1;
          next.push(path);
        } else if (entry.isFile() && taken < MAX_FOLDER_ENTRIES) {
          visited += 1;
          taken += 1;
          files.push(relative(cwd, path).split(sep).join("/"));
        }
      }
    }
    level = next;
  }
  return files;
}

async function inventory(cwd: string): Promise<string[]> {
  const hit = cache.get(cwd);
  if (hit && hit.expires > Date.now()) return hit.files;
  const files = (await gitFiles(cwd)) ?? walkFiles(cwd);
  files.sort();
  cache.set(cwd, { expires: Date.now() + CACHE_MS, files });
  return files;
}

function subsequence(path: string, query: string): boolean {
  let index = 0;
  for (const character of path) if (character === query[index]) index += 1;
  return index === query.length;
}

function score(path: string, query: string): number {
  if (!query) return 1;
  const lower = path.toLowerCase();
  const original = scoreLower(lower, query);
  if (original >= 0 || !(/[^\x00-\x7f]/.test(path) || /[^\x00-\x7f]/.test(query))) return original;
  return scoreLower(path.normalize("NFC").toLowerCase(), query.normalize("NFC"));
}

function scoreLower(lower: string, query: string): number {
  const name = lower.slice(lower.lastIndexOf("/") + 1);
  const at = lower.indexOf(query);
  if (at >= 0) return 300 - at + (name.includes(query) ? 30 : 0);
  if (subsequence(name, query)) return 200 - name.length;
  if (subsequence(lower, query)) return 100 - lower.length / 1000;
  return -1;
}

export async function paneFiles(cwd: string, query = "", limit = 20): Promise<string[]> {
  const normalized = query.trim().toLowerCase();
  const boundedLimit = Math.min(100, Math.max(1, Math.trunc(limit) || 20));
  return (await inventory(cwd))
    .map((path) => ({ path, score: score(path, normalized) }))
    .filter((item) => item.score >= 0)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, boundedLimit)
    .map((item) => item.path);
}

const walked = new Map<string, { expires: number; files: string[] }>();

/** `gitFiles` for a lookup that answers at once, not cut to MAX_GIT_ENTRIES: a name is matched against every path. */
function gitFilesNow(cwd: string): string[] | null {
  const { deadlineMs, maxBytes } = gitList;
  let proc;
  try {
    proc = Bun.spawnSync(gitListArgv(cwd), {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      env: gitEnvironment(),
      timeout: deadlineMs,
      maxBuffer: maxBytes,
      killSignal: "SIGKILL",
    });
  } catch {
    return null;
  }
  // a listing past its cap or deadline may end in half a name, even when git exited 0
  if (proc.exitCode !== 0 || proc.exitedDueToTimeout || proc.exitedDueToMaxBuffer || proc.stdout.byteLength > maxBytes) return null;
  return listedNames(proc.stdout);
}

/**
 * The files under `cwd` whose path ends in `name` (a bare `demo.mp4`, or `screenshots/demo.mp4`),
 * for a path an agent wrote without its folders. The git inventory comes first, whole, so a
 * folder of thousands of files cannot hide the one named; the bounded walk follows, since that
 * inventory leaves out ignored files (build output, recordings).
 */
export function filesNamed(cwd: string, name: string, limit = 10, anyForm = false): string[] {
  const suffix = anyForm ? name.replace(/^\.\//, "").normalize("NFC") : name.replace(/^\.\//, "");
  let hit = walked.get(cwd);
  if (!hit || hit.expires <= Date.now()) {
    hit = { expires: Date.now() + CACHE_MS, files: [...new Set([...gitFilesNow(cwd) ?? [], ...walkFiles(cwd)])] };
    walked.set(cwd, hit);
    if (walked.size > 16) walked.delete(walked.keys().next().value!);
  }
  return hit.files.filter((path) => {
    const compared = anyForm ? path.normalize("NFC") : path;
    return compared === suffix || compared.endsWith(`/${suffix}`);
  }).sort().slice(0, limit);
}

export function clearFileCache(): void {
  cache.clear();
  walked.clear();
}
