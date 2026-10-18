import { describe, expect, test } from "bun:test";
import { movedTabOrder } from "./tabOrder.ts";
import { placeBlock, workspaceMoves, worktreeGroups } from "./workspaceOrder.ts";

const start = ["X", "A", "a1", "a2", "a3", "B", "b1", "C"];

/** herdr's answer to each move, as live-recorded on 0.9.3: boundaries before removal, one workspace at a time */
function replay(order: readonly string[], next: readonly string[]): string[] {
  return workspaceMoves(order, next).reduce<string[]>((current, move) => movedTabOrder(current, move.workspaceId, move.insertIndex) ?? current, [...order]);
}

function space(id: string, repoKey?: string, linked = false) {
  return { workspace_id: id, worktree: repoKey === undefined ? null : { is_linked_worktree: linked, repo_key: repoKey } };
}

function shape(ordered: ReturnType<typeof space>[]): [string, string[]][] {
  return worktreeGroups(ordered).map(({ workspace, children }) => [workspace.workspace_id, children.map((child) => child.workspace_id)]);
}

describe("worktreeGroups", () => {
  test("a worktree hangs under its repository's workspace", () => {
    expect(shape([space("A", "a"), space("B", "b"), space("a1", "a", true)])).toEqual([["A", ["a1"]], ["B", []]]);
  });

  test("with the main checkout open twice, a worktree takes the nearest one before it", () => {
    const ordered = [space("A", "a"), space("a1", "a", true), space("T", "t"), space("plain"), space("A2", "a"), space("a2", "a", true), space("a3", "a", true)];
    expect(shape(ordered)).toEqual([["A", ["a1"]], ["T", []], ["plain", []], ["A2", ["a2", "a3"]]]);
  });

  test("a worktree before every workspace of its repository takes the first one", () => {
    expect(shape([space("a1", "a", true), space("A", "a"), space("A2", "a")])).toEqual([["A", ["a1"]], ["A2", []]]);
  });

  test("a worktree whose repository is not open stays at the top level", () => {
    expect(shape([space("x1", "x", true), space("B", "b")])).toEqual([["x1", []], ["B", []]]);
  });
});

describe("workspaceMoves", () => {
  test("a worktree moved down one place lands past its sibling", () => {
    const next = placeBlock(start, ["a1"], ["a2"], "after");
    expect(next).toEqual(["X", "A", "a2", "a1", "a3", "B", "b1", "C"]);
    expect(workspaceMoves(start, next)).toEqual([{ workspaceId: "a1", insertIndex: 4 }]);
  });

  test("a worktree moved up one place lands before its sibling", () => {
    const next = placeBlock(start, ["a3"], ["a2"], "before");
    expect(next).toEqual(["X", "A", "a1", "a3", "a2", "B", "b1", "C"]);
    expect(workspaceMoves(start, next)).toHaveLength(1);
    expect(replay(start, next)).toEqual(next);
  });

  test("a repository's group moves with its worktrees", () => {
    const down = placeBlock(start, ["A", "a1", "a2", "a3"], ["B", "b1"], "after");
    expect(down).toEqual(["X", "B", "b1", "A", "a1", "a2", "a3", "C"]);
    expect(replay(start, down)).toEqual(down);
    expect(workspaceMoves(start, down)).toHaveLength(2);
    const up = placeBlock(start, ["A", "a1", "a2", "a3"], ["X"], "before");
    expect(workspaceMoves(start, up)).toEqual([{ workspaceId: "X", insertIndex: 5 }]);
    expect(replay(start, up)).toEqual(up);
  });

  test("the last place is the boundary after every workspace", () => {
    const next = placeBlock(start, ["X"], ["C"], "after");
    expect(workspaceMoves(start, next)).toEqual([{ workspaceId: "X", insertIndex: 8 }]);
  });

  test("an unchanged order needs no move", () => {
    expect(workspaceMoves(start, start)).toEqual([]);
  });
});
