/**
 * A comparison's changed files as folders (components/RepoChanges.tsx), so a large change set
 * reads by folder. The listing's order is kept: a folder sits where its first file was listed and
 * holds its entries in their listed order, so the file rows read top to bottom as the flat list
 * did. A folder holding one folder and nothing else is drawn with it as one row
 * (`src/components/diffs`), as code hosts draw their trees, so a deep path does not cost a row
 * per segment. Every folder starts open; the component keeps what the reader folds, by path.
 */

export interface ChangeTreeFolder {
  kind: "folder";
  /** the folder's path, no trailing slash: what a fold is kept under */
  path: string;
  /** what the row says: the last segment, or the joined segments of a folder drawn with the one folder in it */
  name: string;
  /** rows in from the root, which is 0 */
  depth: number;
  entries: ChangeTreeEntry[];
  /** files under it, however deep */
  files: number;
}

export interface ChangeTreeFile {
  kind: "file";
  path: string;
  /** the file's own name, what the row shows; the folder above says the rest */
  name: string;
  depth: number;
  /** where the file is in the listing */
  index: number;
}

export type ChangeTreeEntry = ChangeTreeFolder | ChangeTreeFile;

interface Node {
  path: string;
  name: string;
  /** in first-seen order: a file's index in the listing, or a folder */
  entries: Array<Node | number>;
  folders: Map<string, Node>;
}

/** The tree of `paths` (repository-relative, forward slashes), in their order. */
export function changeTree(paths: readonly string[]): ChangeTreeEntry[] {
  const root: Node = { path: "", name: "", entries: [], folders: new Map() };
  paths.forEach((path, index) => {
    const segments = path.split("/");
    let folder = root;
    for (const segment of segments.slice(0, -1)) {
      let next = folder.folders.get(segment);
      if (next === undefined) {
        next = { path: folder.path === "" ? segment : `${folder.path}/${segment}`, name: segment, entries: [], folders: new Map() };
        folder.folders.set(segment, next);
        folder.entries.push(next);
      }
      folder = next;
    }
    folder.entries.push(index);
  });
  return finish(root.entries, 0, paths);
}

function finish(entries: readonly (Node | number)[], depth: number, paths: readonly string[]): ChangeTreeEntry[] {
  return entries.map((entry): ChangeTreeEntry => {
    if (typeof entry === "number") {
      const path = paths[entry]!;
      return { kind: "file", path, name: path.slice(path.lastIndexOf("/") + 1), depth, index: entry };
    }
    // a folder holding one folder and nothing else is drawn with it
    let folder = entry;
    let name = folder.name;
    while (folder.entries.length === 1 && typeof folder.entries[0] !== "number") {
      folder = folder.entries[0]!;
      name = `${name}/${folder.name}`;
    }
    const children = finish(folder.entries, depth + 1, paths);
    return { kind: "folder", path: folder.path, name, depth, entries: children, files: countFiles(children) };
  });
}

function countFiles(entries: readonly ChangeTreeEntry[]): number {
  return entries.reduce((sum, entry) => sum + (entry.kind === "file" ? 1 : entry.files), 0);
}

/** Every folder's path, a parent before what is in it: what Collapse all folds. */
export function changeTreeFolders(entries: readonly ChangeTreeEntry[]): string[] {
  return entries.flatMap((entry) => (entry.kind === "folder" ? [entry.path, ...changeTreeFolders(entry.entries)] : []));
}
