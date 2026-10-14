import { closeSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

import type { RepoDiffFile, RepoDiffFileList, RepoDiffFilePatch, RepoDiffRepository, RepoDiffScope, RepoDiffStatus } from "../shared/protocol.ts";
import { errorResponse, jsonResponse } from "./http.ts";

/**
 * What changed in the repository a pane (or a named folder) sits in, read with git and never
 * written: the list of changed files, and one file's patch at a time. The two are separate reads
 * so a repository with one enormous change does not cost every other file its diff.
 *
 * Every git call is an argv array (no shell), with external diff drivers, textconv filters, the
 * fsmonitor hook, optional locks and pathspec magic switched off, a byte cap on what is read and
 * a deadline after which the process is killed. A patch is sent whole or not at all: one that
 * passes its cap is reported as unavailable, never cut in the middle of a hunk.
 *
 * It reads what this server's user can read in that repository, which is no more than the
 * terminal the same browser can already type `git diff` into.
 */

/** A list holds at most this many files; `truncated` and `total` say when there were more. */
export const REPO_DIFF_MAX_FILES = 2_000;
/** What one listing command may print before it is stopped (names, statuses, line counts). */
export const REPO_DIFF_MAX_LIST_BYTES = 2 * 1024 * 1024;
/** One file's patch; a larger one is answered as `too_large` with no patch text. */
export const REPO_DIFF_MAX_PATCH_BYTES = 1024 * 1024;
/** Unchanged lines around each change, as `git diff` prints by default. */
export const REPO_DIFF_CONTEXT_LINES = 3;
/** How long one git process may run. */
export const REPO_DIFF_DEADLINE_MS = 10_000;
const MAX_PATH_BYTES = 4_096;
const SNIFF_BYTES = 8_192;

export interface RepoDiffOptions {
  /** the git to run (a stand-in, in tests) */
  git?: string;
  deadlineMs?: number;
  maxFiles?: number;
  maxListBytes?: number;
  maxPatchBytes?: number;
}

/** A refusal in the API's own words: it never carries git's stderr. */
export class RepoDiffError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message); }
}

interface GitRun { code: number | null; stdout: string; overflow: boolean }

interface Context {
  git: string;
  deadlineMs: number;
  maxFiles: number;
  maxListBytes: number;
  maxPatchBytes: number;
}

function contextOf(options: RepoDiffOptions): Context {
  return {
    git: options.git ?? "git",
    deadlineMs: options.deadlineMs ?? REPO_DIFF_DEADLINE_MS,
    maxFiles: options.maxFiles ?? REPO_DIFF_MAX_FILES,
    maxListBytes: options.maxListBytes ?? REPO_DIFF_MAX_LIST_BYTES,
    maxPatchBytes: options.maxPatchBytes ?? REPO_DIFF_MAX_PATCH_BYTES,
  };
}

function gitEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    // a repository the server itself was started inside (a hook, a test runner) is not the one asked about
    if (value === undefined || name === "GIT_DIR" || name === "GIT_WORK_TREE" || name === "GIT_INDEX_FILE" || name === "GIT_EXTERNAL_DIFF" || name === "GIT_PAGER") continue;
    env[name] = value;
  }
  return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };
}

/** One git process in `cwd`: stdout up to `maxBytes`, killed at the deadline or once it prints more. */
async function runGit(context: Context, cwd: string, args: string[], maxBytes: number): Promise<GitRun> {
  const argv = [context.git, "--no-pager", "--no-optional-locks", "--literal-pathspecs", "-c", "core.quotePath=false", "-c", "core.fsmonitor=false", "-c", "color.ui=never", "-C", cwd, ...args];
  let proc: Bun.Subprocess<"ignore", "pipe", "ignore">;
  try {
    proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: gitEnvironment() });
  } catch {
    throw new RepoDiffError("git_unavailable", "git could not be started on this PC", 503);
  }
  const reader = proc.stdout.getReader();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
    void reader.cancel().catch(() => undefined);
  }, context.deadlineMs);
  const chunks: Uint8Array[] = [];
  let size = 0;
  let overflow = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        overflow = true;
        const keep = value.byteLength - (size - maxBytes);
        if (keep > 0) chunks.push(value.subarray(0, keep));
        proc.kill("SIGKILL");
        void reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(value);
    }
    const code = await proc.exited;
    if (timedOut) throw new RepoDiffError("git_timeout", "git did not answer in time", 504);
    return { code: overflow ? null : code, stdout: Buffer.concat(chunks).toString("utf8"), overflow };
  } finally {
    clearTimeout(timer);
  }
}

async function repositoryOf(context: Context, cwd: string): Promise<RepoDiffRepository> {
  const top = await runGit(context, cwd, ["rev-parse", "--show-toplevel"], 16 * 1024);
  const root = top.stdout.replace(/\r?\n$/, "");
  if (top.code !== 0 || root === "") throw new RepoDiffError("not_a_repository", "that folder is not inside a git working tree", 409);
  const [branch, head] = await Promise.all([
    runGit(context, root, ["symbolic-ref", "--quiet", "--short", "HEAD"], 16 * 1024),
    runGit(context, root, ["rev-parse", "--quiet", "--verify", "HEAD^{commit}"], 1024),
  ]);
  const oid = head.code === 0 ? head.stdout.trim() : "";
  const name = branch.code === 0 ? branch.stdout.replace(/\r?\n$/, "") : "";
  return { root, branch: name === "" ? null : name, head: oid === "" ? null : oid, detached: name === "" && oid !== "", unborn: oid === "" };
}

const REVISION = /^[A-Za-z0-9][A-Za-z0-9._/~^@{}-]{0,199}$/;

async function resolveRevision(context: Context, root: string, name: string, value: string): Promise<string> {
  if (!REVISION.test(value) || value.includes("..")) throw new RepoDiffError("invalid_revision", `${name} must name one commit: a hash, a branch, a tag or an expression such as HEAD~1`, 400);
  const parsed = await runGit(context, root, ["rev-parse", "--quiet", "--verify", "--end-of-options", `${value}^{commit}`], 1024);
  const oid = parsed.stdout.trim();
  if (parsed.code !== 0 || !/^[0-9a-f]{40,64}$/.test(oid)) throw new RepoDiffError("revision_not_found", `${name} names no commit in this repository`, 404);
  return oid;
}

function scopeOf(value: string | null): RepoDiffScope {
  if (value === null || value === "" || value === "workspace") return "workspace";
  if (value === "staged" || value === "commit") return value;
  throw new RepoDiffError("invalid_scope", "scope must be workspace, staged or commit", 400);
}

/** A path inside the repository, as git names it: relative, forward slashes, no `..`. */
function repositoryPath(name: string, value: string): string {
  const segments = value.split("/");
  if (value === "" || value.includes("\0") || value.startsWith("/") || Buffer.byteLength(value) > MAX_PATH_BYTES || segments.some((segment) => segment === ".." || segment === "." || segment === "")) {
    throw new RepoDiffError("invalid_path", `${name} must be a file path relative to the repository root`, 400);
  }
  return value;
}

interface Comparison { scope: RepoDiffScope; base: string | null; head: string | null; args: string[] }

async function comparisonOf(context: Context, root: string, params: URLSearchParams): Promise<Comparison> {
  const scope = scopeOf(params.get("scope"));
  const base = params.get("base");
  const head = params.get("head");
  if (scope !== "commit") {
    if (base !== null || head !== null) throw new RepoDiffError("invalid_revision", "base and head apply to scope=commit only", 400);
    return { scope, base: null, head: null, args: scope === "staged" ? ["--cached"] : [] };
  }
  if (base === null) throw new RepoDiffError("invalid_revision", "scope=commit needs a base revision", 400);
  const [from, to] = await Promise.all([resolveRevision(context, root, "base", base), resolveRevision(context, root, "head", head ?? "HEAD")]);
  return { scope, base: from, head: to, args: [from, to] };
}

const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "--find-renames", "--ignore-submodules=dirty", "--src-prefix=a/", "--dst-prefix=b/"];

const STATUS: Record<string, RepoDiffStatus> = { A: "added", D: "deleted", M: "modified", R: "renamed", C: "copied", T: "type_changed", U: "unmerged" };

/** The whole NUL-terminated fields of `-z` output: what follows the last NUL was cut short. */
function fields(output: string): string[] {
  const end = output.lastIndexOf("\0");
  return end < 0 ? [] : output.slice(0, end).split("\0");
}

interface Listing { files: RepoDiffFile[]; complete: boolean }

async function changedFiles(context: Context, root: string, comparison: Comparison, pathspec: string[]): Promise<Listing> {
  const tail = [...comparison.args, "--", ...pathspec];
  const [names, counts, others] = await Promise.all([
    runGit(context, root, ["diff", ...DIFF_FLAGS, "--name-status", "-z", ...tail], context.maxListBytes),
    runGit(context, root, ["diff", ...DIFF_FLAGS, "--numstat", "-z", ...tail], context.maxListBytes),
    comparison.scope === "workspace"
      ? runGit(context, root, ["ls-files", "-z", "--others", "--exclude-standard", "--", ...pathspec], context.maxListBytes)
      : Promise.resolve<GitRun>({ code: 0, stdout: "", overflow: false }),
  ]);
  for (const run of [names, counts, others]) {
    if (!run.overflow && run.code !== 0) throw new RepoDiffError("git_failed", "git could not compare this repository", 500);
  }
  const stats = new Map<string, { additions: number | null; deletions: number | null; binary: boolean }>();
  const numbers = fields(counts.stdout);
  for (let index = 0; index < numbers.length; index += 1) {
    const [added, deleted, ...rest] = numbers[index]!.split("\t");
    if (added === undefined || deleted === undefined) break;
    let path = rest.join("\t");
    // a rename: the counts stand alone, then the old and the new name
    if (path === "") { path = numbers[index + 2] ?? ""; index += 2; }
    if (path === "") break;
    const binary = added === "-" || deleted === "-";
    stats.set(path, { additions: binary ? null : Number(added), deletions: binary ? null : Number(deleted), binary });
  }
  const found = new Map<string, RepoDiffFile>();
  const named = fields(names.stdout);
  for (let index = 0; index < named.length;) {
    const letter = named[index]![0] ?? "";
    const status = STATUS[letter];
    const paired = letter === "R" || letter === "C";
    const path = named[index + (paired ? 2 : 1)];
    if (status === undefined || path === undefined) break;
    // a conflict's counts are those of a combined diff, which no one is shown
    const stat = status === "unmerged" ? undefined : stats.get(path);
    const file: RepoDiffFile = { path, old_path: paired ? named[index + 1]! : null, status, additions: stat?.additions ?? null, deletions: stat?.deletions ?? null, binary: stat?.binary ?? null };
    // a conflicted file can be named twice; the conflict is what there is to say about it
    if (found.get(path)?.status !== "unmerged") found.set(path, file);
    index += paired ? 3 : 2;
  }
  for (const path of fields(others.stdout)) {
    if (!found.has(path)) found.set(path, { path, old_path: null, status: "untracked", additions: null, deletions: null, binary: null });
  }
  const files = [...found.values()].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { files, complete: !names.overflow && !others.overflow };
}

/** GET /api/workspace/diff/files */
export async function repoDiffFiles(cwd: string, params: URLSearchParams, options: RepoDiffOptions = {}): Promise<RepoDiffFileList> {
  const context = contextOf(options);
  const repository = await repositoryOf(context, cwd);
  const comparison = await comparisonOf(context, repository.root, params);
  const listing = await changedFiles(context, repository.root, comparison, []);
  return {
    repository,
    scope: comparison.scope,
    base: comparison.base,
    head: comparison.head,
    files: listing.files.slice(0, context.maxFiles),
    total: listing.complete ? listing.files.length : null,
    truncated: !listing.complete || listing.files.length > context.maxFiles,
    limits: { max_files: context.maxFiles, max_list_bytes: context.maxListBytes },
  };
}

/** What an untracked path is on disk, without following a link out of the repository. */
function untrackedKind(path: string, maxBytes: number): "text" | "binary" | "too_large" | "unsupported" {
  let fd: number | null = null;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return "unsupported";
    if (stat.size > maxBytes) return "too_large";
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(SNIFF_BYTES);
    return buffer.subarray(0, readSync(fd, buffer, 0, SNIFF_BYTES, 0)).includes(0) ? "binary" : "text";
  } catch {
    return "unsupported";
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** GET /api/workspace/diff/file */
export async function repoDiffFile(cwd: string, params: URLSearchParams, options: RepoDiffOptions = {}): Promise<RepoDiffFilePatch> {
  const context = contextOf(options);
  const path = repositoryPath("path", params.get("path") ?? "");
  const oldParam = params.get("old_path");
  const oldPath = oldParam === null || oldParam === "" ? null : repositoryPath("old_path", oldParam);
  const repository = await repositoryOf(context, cwd);
  const comparison = await comparisonOf(context, repository.root, params);
  const pathspec = oldPath !== null && oldPath !== path ? [oldPath, path] : [path];
  const listing = await changedFiles(context, repository.root, comparison, pathspec);
  const file = listing.files.find((candidate) => candidate.path === path);
  if (file === undefined) throw new RepoDiffError("not_found", "nothing changed at that path in this comparison", 404);
  if (oldPath !== null && file.old_path !== oldPath) throw new RepoDiffError("invalid_path", "old_path no longer belongs to this file's change; refresh the list", 400);

  const answer = (patch: string | null, unavailable: RepoDiffFilePatch["unavailable"], described: RepoDiffFile = file): RepoDiffFilePatch => ({
    repository,
    scope: comparison.scope,
    base: comparison.base,
    head: comparison.head,
    file: described,
    patch,
    unavailable,
    truncated: unavailable === "too_large",
    limits: { max_patch_bytes: context.maxPatchBytes, context_lines: REPO_DIFF_CONTEXT_LINES },
  });

  if (file.status === "unmerged") return answer(null, "unmerged");
  if (file.binary === true) return answer(null, "binary");

  let run: GitRun;
  if (file.status === "untracked") {
    const kind = untrackedKind(join(repository.root, path), context.maxPatchBytes);
    if (kind === "binary") return answer(null, "binary", { ...file, binary: true });
    if (kind !== "text") return answer(null, kind);
    // an untracked file has no index entry to compare with: it is shown as a new file, whole
    run = await runGit(context, repository.root, ["diff", "--no-index", ...DIFF_FLAGS, `-U${REPO_DIFF_CONTEXT_LINES}`, "--", "/dev/null", path], context.maxPatchBytes);
    if (!run.overflow && run.code !== 1 && run.code !== 0) throw new RepoDiffError("git_failed", "git could not read that file", 500);
  } else {
    run = await runGit(context, repository.root, ["diff", ...DIFF_FLAGS, `-U${REPO_DIFF_CONTEXT_LINES}`, ...comparison.args, "--", ...pathspec], context.maxPatchBytes);
    if (!run.overflow && run.code !== 0) throw new RepoDiffError("git_failed", "git could not compare that file", 500);
  }
  if (run.overflow) return answer(null, "too_large");
  // the file changed between the listing and this read, or git printed a form no patch reader takes
  if (run.stdout === "") throw new RepoDiffError("not_found", "nothing changed at that path in this comparison", 404);
  if (!run.stdout.startsWith("diff --git ")) return answer(null, "unsupported");
  return answer(run.stdout, null, file.status === "untracked" ? { ...file, binary: false } : file);
}

/** The HTTP answer of either route, with every refusal in the `{ error: { code, message } }` envelope. */
export async function repoDiffResponse(kind: "files" | "file", cwd: string, params: URLSearchParams, options: RepoDiffOptions = {}): Promise<Response> {
  try {
    const body = kind === "files" ? await repoDiffFiles(cwd, params, options) : await repoDiffFile(cwd, params, options);
    return jsonResponse(body, 200, { "cache-control": "private, no-store" });
  } catch (error) {
    if (error instanceof RepoDiffError) return jsonResponse({ error: { code: error.code, message: error.message } }, error.status);
    return errorResponse(error);
  }
}
