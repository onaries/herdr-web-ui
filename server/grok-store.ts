/** Exact Grok session binding on the machine that owns the pane. */
import { opendirSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import type { HerdrPane } from "../shared/protocol.ts";
import { herdrRpc } from "./herdr/client.ts";
import { runsAgent } from "./gjc-runtime.ts";

const SESSION = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MAX_GROUPS = 4096;
/** The one native build whose held-file evidence was observed. Others have no reader yet. */
const GROK_NATIVE_BUILD = "grok-1.0.50-linux-x86_64";

export interface GrokProcessInfo { foreground_processes?: { pid: number; argv?: string[] }[] }
const GROK_EXECUTABLE = /(^|[\\/])grok(?:-\d[^\\/]*)?(?:\.exe|\.[cm]?js)?$/i;
export function grokPaneProcesses(info: GrokProcessInfo): { pid: number }[] {
  return (info.foreground_processes ?? []).filter((p) => runsAgent(p.argv ?? [], GROK_EXECUTABLE));
}

const inside = (root: string, path: string): boolean => {
  const child = relative(root, path);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
};

/** Search by exact ID, including native hashed cwd groups. Neither cwd nor mtime selects
 * a conversation. Duplicate custom IDs across groups are ambiguous and fail closed. */
export function grokTranscriptPath(home: string, session: string): string | null {
  if (!isAbsolute(home) || !SESSION.test(session)) return null;
  try {
    const store = realpathSync(join(home, "sessions"));
    const groups = opendirSync(store);
    let found: string | null = null;
    let count = 0;
    try {
      for (let group = groups.readSync(); group; group = groups.readSync()) {
        if (++count > MAX_GROUPS) return null;
        if (!group.isDirectory()) continue;
        const candidate = join(store, group.name, session, "updates.jsonl");
        try {
          const path = realpathSync(candidate);
          // Reject a link into another session as well as links outside the store.
          if (path !== candidate || !inside(store, path) || !statSync(path).isFile()) continue;
          if (found !== null) return null;
          found = path;
        } catch { /* no matching file in this group */ }
      }
    } finally { groups.closeSync(); }
    return found;
  } catch { return null; }
}

/** Do not substitute the bridge's home when the pane's environment is unreadable. */
export function grokHomeFromEnvironment(environment: string): string | null {
  const fields = environment.split("\0");
  const explicit = fields.find((field) => field.startsWith("GROK_HOME="))?.slice(10);
  const userHome = fields.find((field) => field.startsWith("HOME="))?.slice(5)
    || fields.find((field) => field.startsWith("USERPROFILE="))?.slice(12);
  const home = explicit || (userHome ? join(userHome, ".grok") : null);
  return home && isAbsolute(home) ? home : null;
}

/** Grok 1.0.50 holds the active events.jsonl and can retain earlier sessions. Its /resume
 * picker does NOT refresh Herdr's SessionStart identity. Multiple held sessions therefore
 * make the current one unknowable; do not select the newest or most recently written. */
export function grokHeldSession(pid: number, home: string): string | null {
  try {
    const store = realpathSync(join(home, "sessions"));
    const fds = opendirSync(`/proc/${pid}/fd`);
    const sessions = new Set<string>();
    let count = 0;
    try {
      for (let fd = fds.readSync(); fd; fd = fds.readSync()) {
        if (++count > 4096) return null;
        let target: string;
        try { target = readlinkSync(`/proc/${pid}/fd/${fd.name}`); } catch { continue; }
        if (basename(target) !== "events.jsonl" || !inside(store, target)) continue;
        const parts = relative(store, target).split(sep);
        if (parts.length !== 3 || !SESSION.test(parts[1]!)) continue;
        if (realpathSync(target) !== target) return null;
        sessions.add(dirname(target));
      }
    } finally { fds.closeSync(); }
    return sessions.size === 1 ? [...sessions][0]! : null;
  } catch { return null; }
}

export async function resolveGrokStore(pane: HerdrPane, configuredHome?: string): Promise<string | null> {
  const session = pane.agent_session;
  if (pane.agent !== "grok" || session?.agent !== "grok" || session.kind !== "id" || session.source !== "herdr:grok" || !SESSION.test(session.value)) return null;
  // The evidence is read from /proc, and the held-set invariant was observed on this exact
  // native build only, including a resume into a session the process had never visited.
  // Every other build and PC gets the terminal view; argv alone does not attest the version.
  if (process.platform !== "linux") return null;
  try {
    const info = await herdrRpc<{ process_info?: GrokProcessInfo }>("pane.process_info", { pane_id: pane.pane_id });
    const processes = grokPaneProcesses(info.process_info ?? {});
    if (processes.length !== 1) return null;
    const owner = processes[0]!;
    if (basename(readlinkSync(`/proc/${owner.pid}/exe`)) !== GROK_NATIVE_BUILD) return null;
    const home = configuredHome ?? grokHomeFromEnvironment(readFileSync(`/proc/${owner.pid}/environ`, "utf8"));
    if (!home) return null;
    const held = grokHeldSession(owner.pid, home);
    const path = grokTranscriptPath(home, session.value);
    return held !== null && path !== null && dirname(path) === held ? path : null;
  } catch { return null; }
}
