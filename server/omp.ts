/**
 * omp sessions from the pane's own omp process. herdr's agent.get names omp's session file for
 * most panes, but loses some: no session at all, or a Claude session id where omp runs (seen
 * 2026-10-07 on herdr 0.9.3, for omp processes that had been running for days). omp keeps its
 * store the way GJC does, so the process's open transcript or terminal breadcrumb names it then.
 */
import { join } from "node:path";

import { herdrRpc } from "./herdr/client.ts";
import { heldTranscript, runsAgent } from "./gjc-runtime.ts";
import { processEnviron } from "./omo.ts";

const OMP_EXECUTABLE = /(^|[\\/])omp(?:\.exe|\.[cm]?js)?$/i;

export function isOmpProcess(argv: readonly string[]): boolean {
  return runsAgent(argv, OMP_EXECUTABLE);
}

/**
 * The agent directory one omp process keeps its sessions and terminal breadcrumbs in:
 * ~/.omp/agent, or ~/.omp/profiles/<name>/agent under `--profile <name>` or OMP_PROFILE (the flag
 * wins). null when `--session-dir` moved its sessions anywhere at all, or the profile name could
 * leave ~/.omp/profiles.
 */
export function ompAgentDir(argv: readonly string[], environ: readonly string[] | null, home: string): string | null {
  let profile = environ?.find((word) => word.startsWith("OMP_PROFILE="))?.slice(12) || null;
  for (let at = 1; at < argv.length; at++) {
    const word = argv[at]!;
    if (word === "--session-dir" || word.startsWith("--session-dir=")) return null;
    if (word === "--profile") profile = argv[at + 1] ?? "";
    else if (word.startsWith("--profile=")) profile = word.slice(10);
  }
  if (profile === null) return join(home, ".omp", "agent");
  return /^[\w.-]+$/.test(profile) && profile !== "." && profile !== ".." ? join(home, ".omp", "profiles", profile, "agent") : null;
}

/** The transcript the pane's omp process holds open or last pointed its terminal breadcrumb at, or null. */
export async function ompHeldTranscript(paneId: string, cwd: string, home = process.env["HOME"] ?? ""): Promise<string | null> {
  const info = await herdrRpc<{ process_info?: { foreground_processes?: { pid?: unknown; argv?: unknown }[] } }>(
    "pane.process_info", { pane_id: paneId },
  ).catch(() => null);
  let agentDir: string | null = null;
  const pids: number[] = [];
  for (const process of info?.process_info?.foreground_processes ?? []) {
    const argv = Array.isArray(process.argv) ? process.argv.map(String) : [];
    if (typeof process.pid !== "number" || !isOmpProcess(argv)) continue;
    const dir = ompAgentDir(argv, processEnviron(process.pid), home);
    // a moved store, or two omp processes keeping different ones: nothing says which the pane shows
    if (dir === null || agentDir !== null && dir !== agentDir) return null;
    agentDir = dir;
    pids.push(process.pid);
  }
  return agentDir === null ? null : heldTranscript(agentDir, cwd, pids).path;
}
