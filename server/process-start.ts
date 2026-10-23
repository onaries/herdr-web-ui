import { readFileSync } from "node:fs";

/** `ps -o etime=`: `[[dd-]hh:]mm:ss` since the process started. */
export function parseElapsed(text: string): number | null {
  const match = /^\s*(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)\s*$/.exec(text);
  if (!match) return null;
  const [, days = "0", hours = "0", minutes, seconds] = match;
  return ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes!)) * 60 + Number(seconds!);
}

type StartReading = { readonly started: number; readonly lower: number };
type StartSpawn = (argv: string[], options: {
  readonly stdout: "pipe"; readonly stderr: "ignore"; readonly timeout: number; readonly killSignal: "SIGKILL";
}) => { readonly exitCode: number; readonly stdout: { toString(): string }; readonly exitedDueToTimeout?: boolean };

/** Read a fresh macOS start on every call: a live PID may belong to a replacement process. */
export function createDarwinStartReader(
  spawn: StartSpawn = (argv, options) => Bun.spawnSync(argv, options),
  now: () => number = Date.now,
): (pid: number) => StartReading | null {
  return (pid) => {
    const before = now();
    try {
      const ps = spawn(["/bin/ps", "-o", "etime=", "-p", String(pid)], {
        stdout: "pipe", stderr: "ignore", timeout: 1000, killSignal: "SIGKILL",
      });
      const elapsed = ps.exitCode === 0 && !ps.exitedDueToTimeout ? parseElapsed(ps.stdout.toString()) : null;
      if (elapsed === null) return null;
      return { started: now() - elapsed * 1000, lower: before - (elapsed + 1) * 1000 };
    } catch {
      return null;
    }
  };
}

const darwinStart = createDarwinStartReader();

/**
 * When a process started, in ms since the epoch: Linux counts it in /proc (USER_HZ
 * ticks after boot); macOS has no /proc, so there `ps` tells how long it has run (to the
 * second, which is all the callers compare). null where neither answers.
 */
export function processStartedAt(pid: number): number | null {
  if (process.platform === "darwin") {
    return darwinStart(pid)?.started ?? null;
  }
  return linuxBirth(pid);
}

/**
 * Linux: /proc/stat's `btime` and the start's ticks after boot. The same on every read, so it is the
 * process's identity (pending input compares it exactly); but `btime` is whole seconds and stays
 * where it was when the clock is stepped later, so it may be up to a second before the real start.
 */
function linuxBirth(pid: number): number | null {
  try {
    const ticks = Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").pop()!.split(" ")[19]);
    const boot = Number(readFileSync("/proc/stat", "utf8").match(/^btime (\d+)$/m)?.[1]);
    return Number.isFinite(ticks) && Number.isFinite(boot) ? boot * 1000 + ticks * 10 : null;
  } catch {
    return null;
  }
}

/** Whether `pid` names a running process: signal 0 checks without sending anything, and a refusal means it runs. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * processStartUpperBound without holding the event loop: on macOS `ps` runs as a child that is awaited.
 * Where no start time is known (Windows), null.
 */
export async function processStartUpperBoundAsync(pid: number): Promise<number | null> {
  if (process.platform === "linux") return processStartUpperBound(pid);
  if (process.platform !== "darwin") return null;
  try {
    const ps = Bun.spawn(["/bin/ps", "-o", "etime=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
    const [text, code] = await Promise.all([new Response(ps.stdout).text(), ps.exited]);
    const elapsed = code === 0 ? parseElapsed(text) : null;
    return elapsed === null ? null : Date.now() - elapsed * 1000 + 1000;
  } catch {
    return null;
  }
}

/** An upper bound for comparing a new thread's timestamp, without btime's whole-second loss. */
export function processStartUpperBound(pid: number): number | null {
  if (process.platform !== "linux") {
    const started = processStartedAt(pid);
    return started === null ? null : started + 1000;
  }
  try {
    const ticks = Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").pop()!.split(" ")[19]);
    const uptime = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]);
    // uptime and start ticks truncate to 10ms. Reading the wall clock last and adding
    // one tick bounds the process start from above, rather than admitting older threads.
    return Number.isFinite(ticks) && Number.isFinite(uptime) ? Date.now() - uptime * 1000 + ticks * 10 + 10 : null;
  } catch { return null; }
}

/**
 * Linux: the boot as the wall clock less the uptime, then the start's ticks, each to 10 ms: close to
 * the real start, but a little different on each read, so never an identity. The wall clock is read
 * first: the uptime read after it is at most one tick late.
 */
function linuxReadStart(pid: number): number | null {
  try {
    const now = Date.now();
    const uptime = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]);
    const ticks = Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").pop()!.split(" ")[19]);
    return Number.isFinite(ticks) && Number.isFinite(uptime) ? now - uptime * 1000 + ticks * 10 : null;
  } catch {
    return null;
  }
}

/**
 * A time no later than the process started, in ms since the epoch: what a thread begun since
 * must be no older than. Codex 0.163 creates its thread as its process starts, often in the same
 * millisecond tick on Linux and always in the same second as macOS's `ps` reports; the bound from
 * above (processStartUpperBound, still what a send's process check compares) left such a thread
 * out, and two Codex panes of one directory with short answers both said they could not tell. An older thread let in with it makes two begun
 * since, and two tell nothing.
 */
export function processStartLowerBound(pid: number): number | null {
  if (process.platform === "darwin") {
    return darwinStart(pid)?.lower ?? null;
  }
  if (process.platform !== "linux") return null;
  // the earlier of both readings, less one tick: no later than the real start (the uptime's), nor
  // than the start processStartedAt tells (btime's), so a thread made as the process starts is in
  const starts = [linuxBirth(pid), linuxReadStart(pid)].filter((start): start is number => start !== null);
  return starts.length === 0 ? null : Math.min(...starts) - 10;
}
