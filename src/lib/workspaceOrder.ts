import { movedTabOrder } from "./tabOrder.ts";

/**
 * One herdr `workspace.move`. Like `tab.move`, its `insert_index` counts insertion boundaries
 * before the workspace is taken out, and it moves only the workspace it names: a repository's
 * worktree workspaces stay where they were (live-verified, herdr 0.9.3).
 */
export interface WorkspaceMove {
  workspaceId: string;
  insertIndex: number;
}

/**
 * The moves, in order, that turn herdr's `current` order into `next` (the same workspaces). The
 * longest run of `next` already in order stays put; every other workspace goes right after the
 * one before it in `next`, so a group moved past a single workspace costs one move, not one per member.
 */
export function workspaceMoves(current: readonly string[], next: readonly string[]): WorkspaceMove[] {
  const position = new Map(current.map((id, index) => [id, index]));
  const ranks = next.map((id) => position.get(id) ?? -1);
  const runLength = ranks.map(() => 1);
  const before = ranks.map(() => -1);
  let end = -1;
  for (let i = 0; i < ranks.length; i++) {
    for (let j = 0; j < i; j++) {
      if (ranks[j]! < ranks[i]! && runLength[j]! + 1 > runLength[i]!) { runLength[i] = runLength[j]! + 1; before[i] = j; }
    }
    if (end < 0 || runLength[i]! > runLength[end]!) end = i;
  }
  const kept = new Set<string>();
  for (let i = end; i >= 0; i = before[i]!) kept.add(next[i]!);
  let order = [...current];
  const moves: WorkspaceMove[] = [];
  next.forEach((id, index) => {
    if (kept.has(id)) return;
    const insertIndex = index === 0 ? 0 : order.indexOf(next[index - 1]!) + 1;
    const moved = movedTabOrder(order, id, insertIndex);
    if (!moved) return;
    moves.push({ workspaceId: id, insertIndex });
    order = moved;
  });
  return moves;
}

/** `order` with `block` (one workspace, or a repository's workspace and its worktrees) put back before or after the workspaces of `around`. */
export function placeBlock(order: readonly string[], block: readonly string[], around: readonly string[], side: "before" | "after"): string[] {
  const rest = order.filter((id) => !block.includes(id));
  const at = around.map((id) => rest.indexOf(id)).filter((index) => index >= 0);
  if (at.length === 0) return [...order];
  const edge = side === "before" ? Math.min(...at) : Math.max(...at) + 1;
  return [...rest.slice(0, edge), ...block, ...rest.slice(edge)];
}
