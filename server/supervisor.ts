/**
 * The supervisor owns builds and bridge restarts; herdr continues to own every PTY.
 * server/managed.ts launches it from the active release, so an update replaces this code too:
 * after an install passes its health check the supervisor exits with HANDOVER_EXIT and the
 * launcher starts the new release's supervisor. `root` is always the source checkout.
 */
import "./adopt-legacy-env.ts";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_PORT } from "../shared/protocol.ts";
import { readUpdateIpcRequest } from "../shared/update.ts";
import { defaultStateDir, HANDOVER_EXIT, moveLegacyStateDir, updateStateDir } from "./update-state.ts";
import { herdrSocketPath } from "./herdr/client.ts";
import { acquireOwnerDirectory } from "./owner-guard.ts";
import { Updater, type Release } from "./updater.ts";

export async function runSupervisor(root = resolve(import.meta.dir, "..")) {
  root = resolve(root);
  const port = Number(process.env["PORT"] ?? DEFAULT_PORT);
  const host = process.env["HOST"] ?? "127.0.0.1";
  const probeHost = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "[::1]" : host.includes(":") ? `[${host}]` : host;
  const origin = `http://${probeHost}:${port}`;
  moveLegacyStateDir();
  const appStateDir = resolve(defaultStateDir());
  const socketPath = resolve(herdrSocketPath());
  const stateDir = updateStateDir(root, port);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  // A crash or a forced Windows shutdown skips lock cleanup, and the old PID may belong to
  // someone else by now: the lock records the owner's birth, so only a provably gone owner is replaced.
  const lock = acquireOwnerDirectory(join(stateDir, "supervisor.lock"), {
    running: "A managed server is already running for this checkout and port.",
    starting: "Another server is starting. Try again.",
  });
  let child: ReturnType<typeof Bun.spawn> | null = null;
  let active: Release | null = null;
  let switching = true, stopping = false;
  // The bridge answers before its first health check has passed here. An install taken in that
  // gap stopped the bridge under the check, and the start failed: commands wait for the start.
  const started = Promise.withResolvers<void>();
  const publish = () => {
    if (updater.status.phase === "error") console.error(`Update failed: ${updater.status.error}`);
    // revision_bound_install: this supervisor reads `update-install-revision` and installs only the revision it names
    try { child?.send({ type: "update-status", status: { ...updater.status, revision_bound_install: true }, notes: updater.notes, installed: updater.installed }); } catch { /* bridge restarting */ }
  };
  async function stopChild() {
    const prior = child;
    child = null;
    if (!prior || prior.exitCode !== null) return;
    prior.kill("SIGTERM");
    const timer = setTimeout(() => prior.kill("SIGKILL"), 6000);
    await prior.exited;
    clearTimeout(timer);
  }
  async function launch(release: Release | null) {
    if (stopping) throw new Error("Server is stopping");
    const bootId = crypto.randomUUID();
    const candidate = Bun.spawn([process.execPath, "server/index.ts"], {
      cwd: release?.directory ?? root, windowsHide: true, stdin: "ignore", stdout: "inherit", stderr: "inherit",
      env: { ...process.env, OVIS_MANAGED: "1", OVIS_BOOT_ID: bootId,
        OVIS_STATE_DIR: appStateDir, HERDR_SOCKET: socketPath,
        OVIS_REVISION: release?.revision ?? "" },
      ipc(message) {
        if (message?.type === "update-status-request") publish();
        // an unbound `install` (an older bridge's) is refused: an install names the revision offered
        const request = readUpdateIpcRequest(message);
        if (request) {
          // a browser's Check or Update is a user's own request: it does not wait the unshallow
          // backoff out, the 5-minute timer does
          void started.promise.then(() => updater.request(request.command, true, request.command === "install" ? request.expected_revision : undefined));
        }
      },
      onExit(proc, code) {
        if (child === proc && !switching && !stopping) {
          console.error(`Bridge exited unexpectedly (${code}).`);
          void shutdown(1);
        }
      },
    });
    child = candidate;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !stopping && candidate.exitCode === null) {
      try {
        const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) });
        const body = await response.json() as { web_ui?: { boot_id?: string } };
        if (response.ok && body.web_ui?.boot_id === bootId) { publish(); return; }
      } catch { /* wait for this exact bridge, never mistake another port owner for it */ }
      await Bun.sleep(100);
    }
    await stopChild();
    throw new Error("The new bridge failed its startup health check.");
  }
  const pluginRoot = process.env["HERDR_PLUGIN_ROOT"];
  // only a launcher-started supervisor can hand over: run directly, it keeps serving the update itself
  const launched = typeof process.send === "function";
  const updater = new Updater({ root, stateDir, autoUpdate: process.env["OVIS_AUTO_UPDATE"] === "1", publish,
    pluginCheckout: pluginRoot !== undefined && resolve(pluginRoot) === root,
    notice: process.env["OVIS_SUPERVISOR_FALLBACK"]
      ? "The updated supervisor failed to start, so the previous one is running this version. The next update tries again."
      : undefined,
    async afterInstall() {
      // a fallback supervisor hands over too: afterInstall only follows a newer release, never the one that failed
      if (!launched || stopping) return;
      console.log("Update installed; handing over to the new supervisor.");
      await shutdown(HANDOVER_EXIT);
    },
    async activate(next, commit) {
      switching = true;
      try {
        await stopChild();
        try { await launch(next); commit(); }
        catch (error) {
          await stopChild();
          await launch(active);
          throw new Error(`${error instanceof Error ? error.message : error} Previous version restored.`);
        }
        active = next;
      } finally { switching = false; }
    },
  });
  async function shutdown(code: number) {
    if (stopping) return;
    stopping = true; updater.stop();
    await stopChild();
    lock.release();
    process.exit(code);
  }
  process.on("SIGTERM", () => void shutdown(0));
  process.on("SIGINT", () => void shutdown(0));
  try {
    active = await updater.initialize();
    try { await launch(active); }
    catch (error) {
      if (!active || active.directory === root) throw error;
      console.error("Saved release failed; starting the source checkout.", error);
      rmSync(join(stateDir, "current.json"), { force: true });
      active = await updater.initialize();
      await launch(active);
    }
    switching = false;
    started.resolve();
    updater.start();
    process.send?.({ type: "supervisor-ready" });
    console.log(`Managed updates: ${updater.status.auto_update ? "automatic install" : "automatic checks, install from Settings"}`);
  } catch (error) {
    console.error(error);
    await shutdown(1);
  }
}

if (import.meta.main) await runSupervisor(process.env["OVIS_SOURCE_ROOT"] || resolve(import.meta.dir, ".."));
