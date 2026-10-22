import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { descriptorLive, registerBridge, type BridgeDescriptor } from "./bridge.ts";
import { guardLibrary, guardPath, OwnerGuardReleaseFailed } from "./owner-guard.ts";
import { readProcessBirth } from "./process-owner.ts";

let root = "", path = "";
/** A well-formed birth no running process has: this platform's form, at the epoch. */
const earlierBirth = { platform: process.platform, value: process.platform === "linux" ? `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:1` : process.platform === "darwin" ? "Thu Jan 1 00:00:00 1970" : "1" };
const others: Bun.Subprocess<"pipe", "ignore", "ignore">[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bridge-registry-"));
  path = join(root, "bridges", "socket.json");
  mkdirSync(join(root, "bridges"));
});
afterEach(async () => {
  for (const other of others.splice(0)) { other.stdin.end(); await other.exited; }
  rmSync(root, { recursive: true, force: true });
});

/** A live process other than this one, blocked on its stdin until the test ends. */
function other() {
  const child = Bun.spawn([process.execPath, "-e", "for await (const _ of console) break;"], { stdin: "pipe", stdout: "ignore", stderr: "ignore", windowsHide: true });
  others.push(child);
  return child;
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** Signal 0 to `pid` is refused (EPERM), as another user's or a protected process refuses it; every other PID is probed for real. */
function refusing(pid: number) {
  const kill = process.kill.bind(process);
  return spyOn(process, "kill").mockImplementation(((target: number, signal?: NodeJS.Signals | number) => {
    if (target === pid) throw Object.assign(new Error(`kill ${target} EPERM`), { code: "EPERM" });
    return kill(target, signal);
  }) as typeof process.kill);
}
function descriptor(fields: Partial<BridgeDescriptor> & { pid: number }): string {
  return JSON.stringify({ port: 1, token: "old-bridge-secret", socket_path: "/old.sock", bridge_protocol: 1, bundle_version: "old", ...fields });
}
const read = () => JSON.parse(readFileSync(path, "utf8")) as BridgeDescriptor;

describe("bridge registration", () => {
  it("registers its PID with a birth and a generation", () => {
    const registration = registerBridge(4242, "new-token", { path });
    expect(registration.registered).toBe(true);
    const registered = read();
    expect(registered).toMatchObject({ port: 4242, token: "new-token", pid: process.pid, birth: { platform: process.platform } });
    expect(registered.generation).toBeString();
    expect(descriptorLive(registered)).toBe(true);
    registration.close();
    expect(existsSync(path)).toBe(false);
    expect(existsSync(guardPath(path))).toBe(true);
  });

  it("replaces a descriptor whose PID another process now holds", () => {
    // regression (fails on main, which took any live PID for the bridge): a reused PID
    const reused = other();
    writeFileSync(path, descriptor({ pid: reused.pid, generation: "crashed", birth: earlierBirth }));
    registerBridge(4242, "new-token", { path });
    expect(read()).toMatchObject({ port: 4242, pid: process.pid });
    expect(alive(reused.pid)).toBe(true);
  });

  it("replaces a descriptor whose PID a process it may not signal now holds", () => {
    // regression: a refused probe (EPERM) once kept the descriptor, so after a reboot that handed
    // the old bridge's PID to another user's process, no bridge could register (main replaced it)
    const reused = other();
    const reading = readProcessBirth(reused.pid);
    if (reading.state !== "identified") throw new Error(`no birth for ${reused.pid}`);
    const refused = refusing(reused.pid);
    try {
      writeFileSync(path, descriptor({ pid: reused.pid, generation: "crashed", birth: earlierBirth }));
      expect(registerBridge(4242, "new-token", { path }).registered).toBe(true);
      expect(read()).toMatchObject({ port: 4242, pid: process.pid });
      // a bridge runs as this user, which may always signal it: outside Windows, a refused probe
      // names someone else's process even under its recorded birth or an older version's PID-only
      // descriptor. On Windows another logon session of this user refuses it too, so the birth decides.
      const windows = process.platform === "win32";
      for (const fields of [{ birth: reading.birth }, {}]) {
        writeFileSync(path, descriptor({ pid: reused.pid, generation: "refused", ...fields }));
        expect(descriptorLive(read())).toBe(windows);
        expect(registerBridge(4243, "next-token", { path }).registered).toBe(!windows);
        expect(read().pid).toBe(windows ? reused.pid : process.pid);
      }
    } finally { refused.mockRestore(); }
    expect(alive(reused.pid)).toBe(true);
  });

  it("keeps a live bridge's descriptor, and an older version's whose PID runs", () => {
    const bridge = other();
    const reading = readProcessBirth(bridge.pid);
    if (reading.state !== "identified") throw new Error(`no birth for ${bridge.pid}`);
    for (const text of [descriptor({ pid: bridge.pid, generation: "live", birth: reading.birth }), descriptor({ pid: bridge.pid })]) {
      writeFileSync(path, text);
      const registration = registerBridge(4242, "new-token", { path });
      expect(registration.registered).toBe(false);
      expect(readFileSync(path, "utf8")).toBe(text);
      registration.close();
      expect(readFileSync(path, "utf8")).toBe(text);
    }
  });

  it("keeps a live bridge's descriptor whose recorded birth is malformed", () => {
    // regression: a missing, numeric or empty birth once read as another process's, and the live
    // bridge's descriptor and credential were overwritten
    const bridge = other();
    for (const birth of [{ platform: process.platform }, { platform: process.platform, value: 7 }, { platform: process.platform, value: "" }, { platform: process.platform, value: "an earlier process" }, null]) {
      const text = descriptor({ pid: bridge.pid, generation: "live", birth: birth as never });
      writeFileSync(path, text);
      const registration = registerBridge(4242, "new-token", { path });
      expect(readFileSync(path, "utf8")).toBe(text);
      expect(descriptorLive(JSON.parse(text))).toBe(true);
      registration.close();
      expect(readFileSync(path, "utf8")).toBe(text);
    }
    expect(alive(bridge.pid)).toBe(true);
  });

  it("refuses a descriptor that changed after it was sampled", () => {
    const reused = other(), bridge = other();
    const reading = readProcessBirth(bridge.pid);
    if (reading.state !== "identified") throw new Error(`no birth for ${bridge.pid}`);
    // the replacement may itself look stale: a changed sample is never replaced
    for (const replacement of [descriptor({ pid: bridge.pid, generation: "won", birth: reading.birth }), descriptor({ pid: reused.pid, generation: "other", birth: earlierBirth })]) {
      writeFileSync(path, descriptor({ pid: reused.pid, generation: "crashed", birth: earlierBirth }));
      const registration = registerBridge(4242, "new-token", { path, sampled() { writeFileSync(path, replacement); } });
      expect(registration.registered).toBe(false);
      expect(readFileSync(path, "utf8")).toBe(replacement);
      registration.close();
      expect(readFileSync(path, "utf8")).toBe(replacement);
    }
    expect(readdirSync(join(root, "bridges")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("does not remove another generation's descriptor on close", () => {
    const registration = registerBridge(4242, "new-token", { path });
    const later = JSON.stringify({ ...read(), generation: "a later registration" });
    writeFileSync(path, later);
    registration.close();
    expect(readFileSync(path, "utf8")).toBe(later);
  });

  it("fails a registration whose guard was not released, and logs a close that was not clean", () => {
    // one failing native call: the POSIX unlock, or Windows' UnlockFileEx; the real close still runs
    const fail = () => {
      if (process.platform === "win32") guardLibrary.windows = (calls) => ({ ...calls, UnlockFileEx: (...args: Parameters<typeof calls.UnlockFileEx>) => (calls.UnlockFileEx(...args), 0) });
      else guardLibrary.posix = (calls) => ({ ...calls, flock: (fd, operation) => operation === 8 ? -1 : calls.flock(fd, operation) });
    };
    const restore = () => { delete guardLibrary.posix; delete guardLibrary.windows; };
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      fail();
      expect(() => registerBridge(4242, "new-token", { path })).toThrow(OwnerGuardReleaseFailed);
      restore();
      rmSync(path);
      const registration = registerBridge(4242, "new-token", { path });
      fail();
      registration.close();
      expect(String(logged.mock.calls[0]?.[0])).toStartWith(`The bridge descriptor ${path} may have been left in place: ${guardPath(path)} was not released cleanly: unlocking failed`);
      expect(String(logged.mock.calls[0]?.[0])).not.toContain("new-token");
    } finally {
      restore();
      logged.mockRestore();
    }
    // the guard was handed back by its close: registration works again
    registerBridge(4243, "next-token", { path }).close();
  });

  it("fails closed when the guard is unavailable", () => {
    const reused = other();
    const stale = descriptor({ pid: reused.pid, generation: "crashed", birth: earlierBirth });
    writeFileSync(path, stale);
    const original = guardLibrary.path;
    const logged = spyOn(console, "error").mockImplementation(() => {});
    guardLibrary.path = join(root, "missing-libc.so.6");
    let message = "";
    try {
      const registration = registerBridge(4242, "new-token", { path });
      expect(registration.registered).toBe(false);
      registration.close();
      message = String(logged.mock.calls[0]?.[0]);
    } finally {
      guardLibrary.path = original;
      logged.mockRestore();
    }
    expect(readFileSync(path, "utf8")).toBe(stale);
    expect(message).toStartWith(`This bridge was not registered (descriptor ${path}): the file lock could not be loaded`);
    expect(message).not.toContain("old-bridge-secret");
    expect(message).not.toContain("new-token");
  });
});
