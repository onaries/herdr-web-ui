import { useSyncExternalStore } from "react";
import type { WorkspaceBranch } from "./worktreeBranches.ts";

/**
 * The branch of each workspace's checkout, as the sidebar's roster read it (useWorktreeBranches),
 * for the strip under a pane's composer. The roster stays the one reader of the git inventory:
 * a second reader per pane would ask every repository twice. A PC whose roster is folded away
 * publishes nothing, and its panes name their folder alone.
 */
export const DETACHED = "\0detached";

const published = new Map<string, ReadonlyMap<string, string>>();
const listeners = new Set<() => void>();

/** What the strip says of each workspace: its branch, or DETACHED where the checkout has none. */
export function branchWords(branches: ReadonlyMap<string, WorkspaceBranch>): Map<string, string> {
  const words = new Map<string, string>();
  for (const [workspaceId, branch] of branches) {
    if (branch.branch !== null && branch.branch.trim() !== "") words.set(workspaceId, branch.branch);
    else if (branch.isDetached) words.set(workspaceId, DETACHED);
  }
  return words;
}

/** `branches` null: the PC's roster left the screen. Tells its readers only when a word changed. */
export function publishBranches(machineId: string, branches: ReadonlyMap<string, WorkspaceBranch> | null): void {
  const next = branches === null ? new Map<string, string>() : branchWords(branches);
  const before = published.get(machineId) ?? new Map<string, string>();
  if (before.size === next.size && [...next].every(([workspaceId, word]) => before.get(workspaceId) === word)) return;
  if (next.size === 0) published.delete(machineId);
  else published.set(machineId, next);
  for (const listener of [...listeners]) listener();
}

export function publishedBranch(machineId: string, workspaceId: string | null): string | null {
  return workspaceId === null ? null : published.get(machineId)?.get(workspaceId) ?? null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function usePaneBranch(machineId: string, workspaceId: string | null): string | null {
  return useSyncExternalStore(subscribe, () => publishedBranch(machineId, workspaceId));
}
