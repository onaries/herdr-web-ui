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

const GIT_LS_FILES = ["ls-files", "-z", "-co", "--exclude-standard"];

async function gitFiles(cwd: string): Promise<string[] | null> {
  const proc = Bun.spawn(["git", "-C", cwd, ...GIT_LS_FILES], { stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => proc.kill(), 3_000);
  try {
    const [output, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (exitCode !== 0) return null;
    return [...new Set(output.split("\0").filter(Boolean))].slice(0, MAX_GIT_ENTRIES);
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

/** `gitFiles` for a lookup that answers at once, uncapped: a name is matched against every path. */
function gitFilesNow(cwd: string): string[] | null {
  const proc = Bun.spawnSync(["git", "-C", cwd, ...GIT_LS_FILES], { stdout: "pipe", stderr: "ignore", timeout: 3_000 });
  if (proc.exitCode !== 0) return null;
  return proc.stdout.toString().split("\0").filter(Boolean);
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
