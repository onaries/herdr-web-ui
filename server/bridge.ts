import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { BRIDGE_PROTOCOL, REMOTE_BUNDLE_VERSION, type BridgeIdentity } from "../shared/machines.ts";
import { HerdrError, herdrSocketPath, ping } from "./herdr/client.ts";
import { OwnerGuardUnavailable, withOwnerGuard } from "./owner-guard.ts";
import { newOwnerRecord, ownerGone, probeProcess, type ProcessBirth } from "./process-owner.ts";
import { attachableIdentity, sidecarAvailable } from "./pty/sidecar.ts";

/** `generation` and `birth` identify the registering process beyond its PID; older bridges wrote neither. */
export interface BridgeDescriptor { managed_remote?: boolean; port: number; token: string; pid: number; generation?: string; birth?: ProcessBirth; socket_path: string; bridge_protocol: number; bundle_version: string }
export function bridgeRegistry(): string { return join(homedir(), ".config/herdr-web-ui/bridges"); }
export function socketPath(): string {
  const path = resolve(herdrSocketPath());
  try { return realpathSync(path); } catch { return path; }
}
export function descriptorPath(socket = socketPath()): string { return join(bridgeRegistry(), createHash("sha256").update(socket).digest("hex") + ".json"); }
/** `sidecar`: whether this bridge can run the PTY sidecar; the PC list reads its terminal lens from the herdr told here. */
export async function bridgeIdentity(sidecar = sidecarAvailable()): Promise<BridgeIdentity> {
  const socket = socketPath();
  let stat;
  try { stat = statSync(socket); } catch (error) {
    // A herdr that is not running leaves no socket (on Windows, no marker). Said by code and
    // without the path: the server that asked shows this to whoever is adding the PC.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new HerdrError("socket_missing", "herdr's socket is missing; herdr is not running for this session");
    throw error;
  }
  const info = attachableIdentity(await ping(), sidecar);
  return { pid: process.pid, managed_remote: process.env["OVIS_REMOTE"] === "1", bridge_protocol: BRIDGE_PROTOCOL, bundle_version: REMOTE_BUNDLE_VERSION, socket_path: socket, socket_id: `${stat.dev}:${stat.ino}`, herdr: info };
}
/**
 * Whether the bridge a descriptor names still runs: a PID now held by a process of another birth
 * does not count. Outside Windows neither does a PID this user may not signal (EPERM), whatever
 * birth was recorded: every bridge in this user's registry runs as this user, so that is someone
 * else's process. The app's own check (`kill -0`, remote-host.ts) takes it for gone too and starts
 * a bridge, which must not then find the old one live. On Windows a logon session of this same user
 * may refuse the probe, so there only the birth decides.
 */
export function descriptorLive(descriptor: Pick<BridgeDescriptor, "pid" | "birth">): boolean {
  if (!Number.isSafeInteger(descriptor.pid) || descriptor.pid <= 0) return false;
  if (process.platform !== "win32" && probeProcess(descriptor.pid) === "denied") return false;
  return !ownerGone(descriptor);
}

/** One reading of the descriptor file; equal readings mean nobody replaced it in between. */
function readDescriptor(path: string): { id: string; text: string } | null {
  try {
    const stat = statSync(path);
    return { id: `${stat.dev}:${stat.ino}:${stat.mtimeMs}`, text: readFileSync(path, "utf8") };
  } catch { return null; }
}
function liveIn(reading: { text: string } | null): boolean {
  if (!reading) return false;
  try { return descriptorLive(JSON.parse(reading.text) as BridgeDescriptor); } catch { return false; /* unreadable descriptor: replace it */ }
}

/**
 * `registered` says whether this server's descriptor was written: it is not while another live
 * bridge holds the descriptor, when the descriptor changed while this one started, or when its
 * guard cannot be taken. `options.path` places the descriptor elsewhere and `options.sampled` runs
 * between reading the old descriptor and taking the guard; both are test seams.
 */
export function registerBridge(port: number, token = randomBytes(32).toString("hex"), options: { path?: string; sampled?(): void } = {}): { token: string; registered: boolean; close(): void } {
  const path = options.path ?? descriptorPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const unregistered = { token, registered: false, close() {} };
  // Registration never overwrites a live bridge. Its credential remains reusable.
  const seen = readDescriptor(path);
  if (liveIn(seen)) return unregistered;
  options.sampled?.();
  const record = newOwnerRecord();
  try {
    const registered = withOwnerGuard(path, () => {
      const now = readDescriptor(path);
      // another bridge registered while this one started: it is the registered one
      if (now?.id !== seen?.id || now?.text !== seen?.text || liveIn(now)) return false;
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ managed_remote: process.env["OVIS_REMOTE"] === "1", port, token, pid: process.pid, generation: record.generation, ...(record.birth ? { birth: record.birth } : {}), socket_path: socketPath(), bridge_protocol: BRIDGE_PROTOCOL, bundle_version: REMOTE_BUNDLE_VERSION } satisfies BridgeDescriptor), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, path);
      return true;
    });
    if (!registered) return unregistered;
  } catch (error) {
    // a guard that could not be released (OwnerGuardReleaseFailed) fails the start: this process
    // must not keep serving on a guard it may still hold
    if (!(error instanceof OwnerGuardUnavailable)) throw error;
    // fails closed: this server runs unregistered and the descriptor is left as it was
    console.error(`This bridge was not registered (descriptor ${path}): ${error.message}`);
    return unregistered;
  }
  return {
    token,
    registered: true,
    close() {
      try {
        withOwnerGuard(path, () => {
          let current: Partial<BridgeDescriptor> | null;
          try { current = JSON.parse(readFileSync(path, "utf8")) as Partial<BridgeDescriptor> | null; }
          catch { return; /* already gone or unreadable: nothing of ours to remove */ }
          if (current?.pid === process.pid && current.generation === record.generation) unlinkSync(path);
        });
      } catch (error) {
        console.error(`The bridge descriptor ${path} may have been left in place: ${error instanceof Error ? error.message : error}`);
      }
    },
  };
}
