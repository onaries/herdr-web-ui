import { useCallback, useEffect, useMemo, useState } from "react";
import type { SessionSnapshot, WorktreeOpened } from "../../shared/protocol.ts";
import { useMachineApi, useMachineId } from "./machineContext.tsx";
import { publishBranches } from "./paneBranch.ts";
import { usePageVisible } from "./visibility.ts";
import { WorkspaceBranchCache, worktreeRepositories, worktreeWorkspaceSignature, type WorkspaceBranch } from "./worktreeBranches.ts";

const BRANCH_POLL_MS = 30_000;

/** Use the existing worktree API; pane status updates never trigger a git inventory poll. */
/** `roster`: this reader is the PC's roster, whose branches the panes' composers name too (lib/paneBranch.ts). */
export function useWorktreeBranches(snapshot: SessionSnapshot | null, online: boolean, roster = false): {
  branches: ReadonlyMap<string, WorkspaceBranch>;
  rememberOpened(opened: WorktreeOpened): void;
} {
  const machineId = useMachineId();
  const { listWorktrees } = useMachineApi();
  const visible = usePageVisible();
  const owner = useMemo(() => ({ cache: new WorkspaceBranchCache(), pending: null as Promise<void> | null }), [machineId]);
  const [, publish] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const workspaces = snapshot?.workspaces ?? [];
  const signature = worktreeWorkspaceSignature(workspaces);

  useEffect(() => {
    owner.cache.reconcile(workspaces);
    const repositories = worktreeRepositories(workspaces);
    if (!online || !visible || repositories.length === 0) {
      owner.cache.invalidate();
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll(): Promise<void> {
      // A create or structural change may restart this effect while its previous RPC awaits.
      // Wait for that same-PC cycle to finish before opening another inventory connection.
      if (owner.pending) await owner.pending;
      if (stopped) return;
      const generation = owner.cache.generation;
      const cycle = (async () => {
        let changed = false;
        for (const repository of repositories) {
          if (stopped || generation !== owner.cache.generation) break;
          try {
            const listing = await listWorktrees(repository.workspaceId);
            if (!stopped) changed = owner.cache.applyListing(repository.repoKey, listing, generation) || changed;
          } catch { /* Retain a last known branch only while its exact checkout still exists. */ }
        }
        if (!stopped && changed) publish((value) => value + 1);
      })();
      owner.pending = cycle;
      await cycle;
      if (owner.pending === cycle) owner.pending = null;
      if (!stopped) timer = setTimeout(() => void poll(), BRANCH_POLL_MS);
    }

    void poll();
    return () => {
      stopped = true;
      owner.cache.invalidate();
      clearTimeout(timer);
    };
  }, [owner, listWorktrees, signature, online, visible, refresh]);

  const rememberOpened = useCallback((opened: WorktreeOpened): void => {
    owner.cache.rememberOpened(opened);
    setRefresh((value) => value + 1);
  }, [owner]);

  const branches = owner.cache.branchesFor(workspaces);
  useEffect(() => { if (roster) publishBranches(machineId, branches); });
  useEffect(() => roster ? () => publishBranches(machineId, null) : undefined, [roster, machineId]);

  return { branches, rememberOpened };
}
