/** Agy owns one presence lock for the conversation currently displayed in this process. */
import { readFileSync, opendirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { HerdrPane } from "../shared/protocol.ts";
import { paneProcessInfo } from "./herdr/client.ts";

export interface AgyStore { root: string; session: string; path: string; pid: number; started: string }
const LOCK = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.lock$/i;

/** Only paths held by the selected process are candidates; directory contents aren't evidence. */
export function agyStoreFromLocks(paths: readonly string[]): Pick<AgyStore, "root" | "session" | "path"> | null {
  const locks = new Set<string>();
  for (const path of paths) {
    if (basename(dirname(path)) !== "presence" || !LOCK.test(basename(path))) continue;
    try {
      const canonical = realpathSync(path);
      if (basename(dirname(canonical)) !== "presence" || !LOCK.test(basename(canonical)) || !statSync(canonical).isFile()) return null;
      locks.add(canonical);
    } catch { return null; }
  }
  if (locks.size !== 1) return null;
  const lock = [...locks][0]!;
  try {
    const root = dirname(dirname(lock));
    const session = basename(lock, ".lock");
    const path = join(root, "brain", session, ".system_generated", "logs", "transcript_full.jsonl");
    return { root, session, path };
  } catch { return null; }
}

/** Stable process birth identity; elapsed-time estimates drift between reads on macOS. */
async function processIdentity(pid: number): Promise<{ started: string } | null> {
  try {
    if (process.platform === "linux") {
      const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").pop()!.split(" ");
      const ticks = fields[19];
      if (!ticks || !/^\d+$/.test(ticks)) return null;
      return { started: `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${ticks}` };
    }
    if (process.platform === "darwin") {
      const child = Bun.spawn(["/bin/ps", "-o", "lstart=", "-p", String(pid)], {
        stdout: "pipe", stderr: "ignore", timeout: 1000, env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      });
      const started = (await new Response(child.stdout).text()).trim();
      return await child.exited === 0 && started ? { started } : null;
    }
  } catch { /* gone or unreadable owner */ }
  return null;
}

async function heldPaths(pid: number): Promise<string[]> {
  if (process.platform === "darwin") {
    const child = Bun.spawn(["/usr/sbin/lsof", "-nPbw", "-a", "-p", String(pid), "-Fn"], { stdout: "pipe", stderr: "ignore", timeout: 3000 });
    const text = await new Response(child.stdout).text();
    if (await child.exited !== 0 || text.length > 1024 * 1024) return [];
    return text.split("\n").filter((line) => line.startsWith("n")).map((line) => line.slice(1));
  }
  if (process.platform !== "linux") return [];
  const dir = opendirSync(`/proc/${pid}/fd`);
  const paths: string[] = [];
  try {
    let count = 0;
    for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
      if (++count > 4096) return [];
      try { paths.push(readlinkSync(`/proc/${pid}/fd/${entry.name}`)); } catch { /* closed during enumeration */ }
    }
  } finally { dir.closeSync(); }
  return paths;
}

export async function resolveAgyStore(pane: HerdrPane): Promise<AgyStore | null> {
  try {
    const info = await paneProcessInfo(pane.pane_id);
    const owners = (info?.foreground_processes ?? []).filter((p) => (p.name === "agy" || p.name === "agy-native") && Number.isSafeInteger(p.pid) && p.pid > 1);
    if (owners.length !== 1) return null;
    const pid = owners[0]!.pid;
    const before = await processIdentity(pid);
    const store = agyStoreFromLocks(await heldPaths(pid));
    const after = await processIdentity(pid);
    return before && store && before.started === after?.started ? { ...store, pid, started: before.started } : null;
  } catch { return null; }
}

export function sameAgyStore(a: AgyStore, b: AgyStore | null): boolean {
  return b !== null && a.pid === b.pid && a.started === b.started && a.path === b.path;
}
