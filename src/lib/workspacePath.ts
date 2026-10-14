/**
 * Paths in the file browser read from the folder it was opened on (the pane's directory), as
 * "root/sub/dir", instead of from home. Adapted from t3code's formatWorkspaceRelativePath.
 */

/** The absolute folder the browser was opened on: `start` typed as `~`, `~/…` or an absolute path. */
export function resolveWorkspaceRoot(start: string, home: string): string | null {
  let root: string;
  if (start === "~") root = home;
  else if (start.startsWith("~/")) root = `${home.replace(/\/+$/, "")}/${start.slice(2)}`;
  else if (start.startsWith("/")) root = start;
  else return null;
  root = root.replace(/\/+$/, "");
  return root === "" ? null : root;
}

/**
 * `path` as "<root name>/<rest>" when it is the root or inside it, else `fallback` (the
 * home-relative form). Nothing is shown relative to a root that is not an ancestor.
 */
export function workspaceRelativePath(path: string, root: string | null, fallback: string): string {
  if (root === null) return fallback;
  const label = root.slice(root.lastIndexOf("/") + 1);
  if (path === root) return label;
  return path.startsWith(`${root}/`) ? `${label}/${path.slice(root.length + 1)}` : fallback;
}
