/** Lexical paths only: the browser cannot resolve a remote PC's symlinks or filesystem case. */
function directoryPath(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const path = /^[A-Za-z]:[\\/]|^\\\\/u.test(cwd) ? cwd.replace(/\\/g, "/") : cwd;
  if (/^[A-Za-z]:\/+$/u.test(path)) return `${path.slice(0, 2)}/`;
  return path.replace(/\/+$/, "") || "/";
}

/**
 * A folder that is no project to start a workspace in: a worktree checkout (herdr makes its own
 * under ~/.herdr/worktrees; `worktrees` names the linked ones a PC has open) or a temporary
 * directory. Recent folders leave these out.
 */
export function passingFolder(path: string, worktrees: readonly string[] = []): boolean {
  const lexical = directoryPath(path) ?? path;
  if (/\/\.herdr\/worktrees(?:\/|$)/u.test(lexical)) return true;
  if (/^(?:\/private)?\/tmp(?:\/|$)|^\/var\/tmp(?:\/|$)|^(?:\/private)?\/var\/folders\//u.test(lexical)) return true;
  if (/\/AppData\/Local\/Temp(?:\/|$)/iu.test(lexical)) return true;
  // roots as the candidate: a Windows root keeps its backslashes until here
  return worktrees.some((raw) => { const root = directoryPath(raw) ?? raw; return lexical === root || lexical.startsWith(`${root}/`); });
}

type DirectoryStorage = Pick<Storage, "getItem" | "setItem">;

/** Store canonical absolute paths from snapshots; ~/ input is captured after the PC resolves it. */
function absoluteDirectories(values: readonly unknown[]): string[] {
  const paths = values.flatMap((value) => {
    if (typeof value !== "string" || !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(value)) return [];
    const path = directoryPath(value);
    return path === null ? [] : [path];
  });
  return [...new Set(paths)];
}

/**
 * Folder history belongs to a PC, not its live panes. Missing panes never delete history.
 * A folder a workspace was started in goes to the front (`promote`); one only seen in a pane
 * goes behind what is kept. A pane's folder follows every `cd` of its shell, so a folder seen
 * there is somewhere a shell has been, not a project that was opened.
 */
export class RecentDirectoryStore {
  private readonly memory = new Map<string, string[]>();
  private readonly unsaved = new Set<string>();
  constructor(private readonly storage: () => DirectoryStorage = () => window.localStorage) {}

  read(machineId: string): string[] {
    if (this.unsaved.has(machineId)) return this.memory.get(machineId) ?? [];
    try {
      const raw = this.storage().getItem(`herdr-web-ui:recent-directories:${machineId}`);
      if (raw !== null) {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          const paths = absoluteDirectories(parsed);
          this.memory.set(machineId, paths);
          return paths;
        }
      }
    } catch { /* Unavailable or malformed browser storage retains this page's history. */ }
    return this.memory.get(machineId) ?? [];
  }

  remember(machineId: string, paths: readonly (string | null | undefined)[], promote = false): string[] {
    const previous = this.read(machineId);
    const incoming = absoluteDirectories(paths).filter((path) => promote || !previous.includes(path));
    if (!incoming.length) return previous;
    const next = promote ? [...incoming, ...previous.filter((path) => !incoming.includes(path))] : [...previous, ...incoming];
    if (next.length === previous.length && next.every((path, index) => path === previous[index])) return previous;
    this.memory.set(machineId, next);
    try {
      this.storage().setItem(`herdr-web-ui:recent-directories:${machineId}`, JSON.stringify(next));
      this.unsaved.delete(machineId);
    } catch {
      // A read may still work after a quota/write failure; do not replace unsaved history with it.
      this.unsaved.add(machineId);
    }
    return next;
  }
}

export const recentDirectories = new RecentDirectoryStore();
