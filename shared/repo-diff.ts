/** Which two states of a repository are compared. */
export type RepoDiffScope = "workspace" | "staged" | "commit";

export interface RepoDiffRepositories {
  roots: string[];
  /** The bounded search stopped early or could not read a folder. */
  truncated: boolean;
}

/** How one file changed. `untracked` exists only in the `workspace` scope. */
export type RepoDiffStatus = "added" | "deleted" | "modified" | "renamed" | "copied" | "type_changed" | "unmerged" | "untracked";

/** The repository a comparison was read from, on the PC that owns it. */
export interface RepoDiffRepository {
  /** the working tree's top folder, absolute */
  root: string;
  /** the checked-out branch; null on a detached HEAD */
  branch: string | null;
  /** HEAD's commit hash; null before the first commit */
  head: string | null;
  detached: boolean;
  /** no commit yet: `staged` then lists everything added so far */
  unborn: boolean;
}

export interface RepoDiffFile {
  /** relative to the repository root, forward slashes, as git names it (never quoted) */
  path: string;
  /** where a renamed or copied file came from; null otherwise */
  old_path: string | null;
  status: RepoDiffStatus;
  /** lines added and removed; null for a binary file, an untracked one, and past the list's byte cap */
  additions: number | null;
  deletions: number | null;
  /** null when not determined: an untracked file in a list is not opened to find out */
  binary: boolean | null;
}

/** GET /api/workspace/diff/files */
export interface RepoDiffFileList {
  repository: RepoDiffRepository;
  scope: RepoDiffScope;
  /** the commits compared, as full hashes, in the `commit` scope; null in the others */
  base: string | null;
  head: string | null;
  /** sorted by path, at most `limits.max_files` */
  files: RepoDiffFile[];
  /** how many files changed in all; null when git printed more than `limits.max_list_bytes` */
  total: number | null;
  /** `files` is not the whole list */
  truncated: boolean;
  limits: { max_files: number; max_list_bytes: number };
}

/**
 * GET /api/workspace/diff/file. `patch` is git's own output for that one file, from its
 * `diff --git` line on, and is either complete or null.
 */
export interface RepoDiffFilePatch {
  repository: RepoDiffRepository;
  scope: RepoDiffScope;
  base: string | null;
  head: string | null;
  file: RepoDiffFile;
  patch: string | null;
  /**
   * Why there is no patch: `binary` (no text to show), `too_large` (past `limits.max_patch_bytes`),
   * `unmerged` (a conflict: git prints a combined diff, which is not a unified patch) or
   * `unsupported` (an untracked path that is not a regular file). Null when `patch` is set.
   */
  unavailable: "binary" | "too_large" | "unmerged" | "unsupported" | null;
  /** the patch exists and was left out for its size */
  truncated: boolean;
  limits: { max_patch_bytes: number; context_lines: number };
}
