/**
 * OMP sessions from the pane's own process when Herdr supplies no usable session path.
 * Herdr deliberately omits recognized agents' argv on WSL to avoid blocking procfs reads.
 * Recover process identity outside the bridge, then use the open transcript or breadcrumb.
 */
import { join, resolve } from "node:path";

import { paneProcessInfo } from "./herdr/client.ts";
import { heldTranscript, runsAgent } from "./gjc-runtime.ts";
import { processEnviron } from "./omo.ts";
import { isWsl, ompProcessMemory } from "./omp-process.ts";

const OMP_EXECUTABLE = /(^|[\\/])omp(?:\.exe|\.[cm]?js)?$/i;

export function isOmpProcess(argv: readonly string[]): boolean {
  return runsAgent(argv, OMP_EXECUTABLE);
}

/**
 * One of omp's own helpers, started in the foreground process group of the omp that started it
 * and holding no session: a worker (`omp __omp_worker_<name>`, such as the speech ones, which are
 * not detached), or the compiled binary running itself as bun to install packages
 * (`omp add --cwd <env> ...` for its eval tool, `omp install --cwd <runtime> ...` for its side
 * runtimes).
 */
export function isOmpHelper(argv: readonly string[]): boolean {
  if (!isOmpProcess(argv)) return false;
  const compiled = OMP_EXECUTABLE.test(argv[0] ?? "");
  // omp sends a first word naming a worker to that worker, never to a session
  if ((argv[compiled ? 1 : 2] ?? "").startsWith("__omp_worker_")) return true;
  return compiled && (argv[1] === "add" || argv[1] === "install") && argv[2] === "--cwd";
}

/**
 * omp's options that take the next word as their value, whatever it looks like. Its other options
 * take at most a word that does not look like an option, so they never hide `--cwd` or a store option.
 */
const VALUE_OPTIONS = new Set([
  "--cwd", "--session-dir", "--config", "--add-dir", "--mode", "--fork", "--provider", "--model", "--smol", "--slow",
  "--goal", "--plan", "--prewalk-into", "--plan-yolo-into", "--max-time", "--service-tier", "--api-key", "--system-prompt",
  "--system-prompt-template", "--append-system-prompt", "--provider-session-id", "--prompt-cache-key", "--models",
  "--tools", "--thinking", "--export", "--hook", "--extension", "-e", "--trusted-extension", "--plugin-dir", "--skills",
  "--approval-mode",
]);

/** What an omp command line says about where it keeps its session: the last of each option wins. */
export interface OmpLaunch { profile: string | null; sessionDir: boolean; cwd: string | null }

/**
 * The store options of omp's own argv (as the process has it, never a shell string), read the way
 * omp 18.8.7 reads them. A first pass takes `--profile` and `--alias` out, up to `--`; a second
 * reads the rest, where an option's value is consumed with it and a free `--` ends the options.
 * `cwd` is null when no `--cwd` names a directory: omp ignores a trailing one without a value and
 * stays where it started on an empty one. null when omp would refuse to start: a profile or alias
 * option without its name.
 */
export function ompLaunch(argv: readonly string[]): OmpLaunch | null {
  let profile: string | null = null;
  const rest: string[] = [];
  // a bun or node interpreter comes first, then omp's script
  for (let at = OMP_EXECUTABLE.test(argv[0] ?? "") ? 1 : 2; at < argv.length; at++) {
    const word = argv[at]!;
    if (word === "--") { rest.push(...argv.slice(at)); break; }
    const option = /^--(?:profile|alias)(?==|$)/.exec(word)?.[0];
    if (option) {
      const value = word === option ? argv[++at] : word.slice(option.length + 1);
      if (!value || word === option && value.startsWith("-")) return null;
      if (option === "--profile") profile = value;
      continue;
    }
    rest.push(word);
    // this pass lets `--plan` take only a word that does not look like an option
    if (VALUE_OPTIONS.has(word) && word !== "--plan" && at + 1 < argv.length) rest.push(argv[++at]!);
  }
  let cwd = "", sessionDir = false;
  for (let at = 0; at < rest.length; at++) {
    let word = rest[at]!;
    let value: string | undefined;
    const equals = word.startsWith("--") ? word.indexOf("=") : -1;
    if (equals > 0) { value = word.slice(equals + 1); word = word.slice(0, equals); }
    if (word === "--") break;
    if (equals < 0 && VALUE_OPTIONS.has(word)) value = rest[++at];
    // a moved store counts even without its value: omp's environment can move it too
    if (word === "--session-dir") sessionDir = true;
    else if (word === "--cwd" && value !== undefined) cwd = value;
  }
  return { profile, sessionDir, cwd: cwd || null };
}

/**
 * The agent directory one omp process keeps its sessions and terminal breadcrumbs in:
 * ~/.omp/agent, or ~/.omp/profiles/<name>/agent under `--profile <name>` or OMP_PROFILE (the flag
 * wins). null when `--session-dir` moved its sessions anywhere at all, the profile name could
 * leave ~/.omp/profiles, or omp would not start with this argv.
 */
export function ompAgentDir(argv: readonly string[], environ: readonly string[] | null, home: string): string | null {
  const launch = ompLaunch(argv);
  if (launch === null || launch.sessionDir) return null;
  const profile = launch.profile ?? (environ?.find((word) => word.startsWith("OMP_PROFILE="))?.slice(12) || null);
  if (profile === null) return join(home, ".omp", "agent");
  return /^[\w.-]+$/.test(profile) && profile !== "." && profile !== ".." ? join(home, ".omp", "profiles", profile, "agent") : null;
}

/**
 * The directory an omp process's `--cwd` names by itself: an absolute value, resolved the way omp
 * resolves it before it changes into it and writes it in its session header. null without one, and
 * for a relative value: omp resolved that against the directory it started in, which nothing
 * records once it has moved, and the result is its live directory already.
 */
export function ompLaunchDir(argv: readonly string[]): string | null {
  const cwd = ompLaunch(argv)?.cwd ?? null;
  if (cwd === null) return null;
  // a Windows path without a drive would take the server's own
  const absolute = process.platform === "win32" ? /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/])/i.test(cwd) : cwd.startsWith("/");
  return absolute ? resolve(cwd) : null;
}

/**
 * The transcript the pane's omp process holds open or last pointed its terminal breadcrumb at, or
 * null. `cwd` is the pane's live directory, herdr's foreground cwd where it reports one: omp changes
 * into its `--cwd` when it starts and into a resumed session's project later, and names that
 * directory in its session header, so the live one is matched first. An absolute `--cwd` is tried
 * only when that finds nothing (herdr reports a directory that is not omp's own, or none), and
 * only when every omp process in the pane started with the same one. omp's helpers count for neither.
 */
export async function ompHeldTranscript(paneId: string, cwd: string, home = process.env["HOME"] ?? ""): Promise<string | null> {
  const info = await paneProcessInfo(paneId).catch(() => null);
  let agentDir: string | null = null;
  const pids: number[] = [];
  const launchDirs = new Set<string | null>();
  const environs = new Map<number, readonly string[]>();
  for (const foreground of info?.foreground_processes ?? []) {
    if (typeof foreground.pid !== "number") continue;
    let argv = Array.isArray(foreground.argv) ? foreground.argv.map(String) : [];
    if (argv.length > 0 && (!isOmpProcess(argv) || isOmpHelper(argv))) continue;
    // Herdr omits a recognized agent's argv on WSL; there, and only there, procfs memory reads
    // may block, so they go through the helper. Elsewhere herdr's argv and a direct read hold.
    const probe = process.platform === "linux" && (argv.length === 0 || isWsl());
    let environ: readonly string[] | undefined;
    if (probe) {
      const memory = await ompProcessMemory(foreground.pid, argv.length === 0);
      if (memory === null) continue;
      if (argv.length === 0) argv = memory.argv;
      environ = memory.environ;
    }
    if (!isOmpProcess(argv) || isOmpHelper(argv)) continue;
    const dir = ompAgentDir(argv, environ ?? processEnviron(foreground.pid), home);
    // a moved store, or two omp processes keeping different ones: nothing says which the pane shows
    if (dir === null || agentDir !== null && dir !== agentDir) return null;
    agentDir = dir;
    pids.push(foreground.pid);
    launchDirs.add(ompLaunchDir(argv));
    if (environ !== undefined) environs.set(foreground.pid, environ);
  }
  if (agentDir === null) return null;
  // a probed process's environment stands in for gjcTerminal's /proc read, which could block too
  const environOf = (pid: number) => environs.get(pid);
  const live = heldTranscript(agentDir, cwd, pids, environOf);
  if (live.found > 0) return live.path;
  const [launchDir] = launchDirs;
  if (launchDirs.size !== 1 || !launchDir || launchDir === cwd) return null;
  return heldTranscript(agentDir, launchDir, pids, environOf).path;
}
