import { useEffect, type ReactNode } from "react";
import { WorkerPoolContext } from "@pierre/diffs/react";
import { WorkerPoolManager } from "@pierre/diffs/worker";

import { createIdleLease } from "../lib/idleLease.ts";
import { HIGHLIGHTER_OPTIONS, POOL_OPTIONS } from "../lib/sourceTheme.ts";

/** How long the workers stay after the last virtualized source or diff closes. */
const IDLE_MS = 30_000;

/**
 * One worker pool for the whole app, kept in this lazy chunk (the app shell never imports the
 * package): every RepoDiff and VirtualSource shares it (plain ones for its windowed rows), and a closed viewer releases it
 * instead of ending it, so a reopen within the idle time finds warm workers and their highlight
 * cache. The highlighter's theme is the app's CSS-variables theme, the same in light and dark, so
 * a theme switch never re-initialises a worker.
 */
const pool = createIdleLease(
  () => new WorkerPoolManager(POOL_OPTIONS, HIGHLIGHTER_OPTIONS),
  (manager) => { manager.terminate(); },
  IDLE_MS,
);

export function DiffWorkerPool({ children }: { children: ReactNode }) {
  const manager = pool.get();
  useEffect(() => pool.hold(), [manager]);
  return <WorkerPoolContext value={manager}>{children}</WorkerPoolContext>;
}
