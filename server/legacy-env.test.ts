import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptLegacyEnv, mergeEnvLayers, ovisName, withLegacyNames } from "./legacy-env.ts";
import { updateStateDir } from "./update-state.ts";

describe("settings under their names from before the rename", () => {
  it("fill an unset OVIS_* variable", () => {
    const env: Record<string, string | undefined> = { HERDR_WEB_TOKEN: "old", HERDR_WEB_UI_REF: "v1.2.3", HERDR_SOCKET: "/s" };
    adoptLegacyEnv(env);
    expect(env["OVIS_TOKEN"]).toBe("old");
    expect(env["OVIS_REF"]).toBe("v1.2.3");
    // herdr's own variables are not the app's
    expect(Object.keys(env).filter((name) => name.startsWith("OVIS_")).sort()).toEqual(["OVIS_REF", "OVIS_TOKEN"]);
  });

  it("never override a variable set under the new name", () => {
    const env: Record<string, string | undefined> = { HERDR_WEB_TOKEN: "old", OVIS_TOKEN: "new" };
    adoptLegacyEnv(env);
    expect(env["OVIS_TOKEN"]).toBe("new");
  });

  it("map only the app's own prefix", () => {
    expect(ovisName("HERDR_WEB_STATE_DIR")).toBe("OVIS_STATE_DIR");
    expect(ovisName("HERDR_TEST_SESSION")).toBeNull();
  });

  it("are handed back to a bridge from before the rename", () => {
    expect(withLegacyNames({ OVIS_BOOT_ID: "b", OVIS_REF: "v1", HERDR_SOCKET: "/s" }))
      .toEqual({ OVIS_BOOT_ID: "b", HERDR_WEB_BOOT_ID: "b", OVIS_REF: "v1", HERDR_WEB_UI_REF: "v1", HERDR_SOCKET: "/s" });
  });

  it("let a settings file's old name win over the parent's, as the file always did", () => {
    // herdr started the plugin with the token it was given first; the user then changed it in the plugin's env file
    const merged = mergeEnvLayers([{ HERDR_WEB_TOKEN: "first" }, { HERDR_WEB_TOKEN: "changed" }]);
    expect(merged["OVIS_TOKEN"]).toBe("changed");
    expect(mergeEnvLayers([{ OVIS_TOKEN: "parent" }, { HERDR_WEB_TOKEN: "file" }])["OVIS_TOKEN"]).toBe("file");
    expect(mergeEnvLayers([{ HERDR_WEB_TOKEN: "parent" }, { OVIS_TOKEN: "file" }])["OVIS_TOKEN"]).toBe("file");
  });
});

describe("a supervisor started by the launcher of an install from before the rename", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  const git = (cwd: string, ...args: string[]): string => {
    const run = spawnSync("git", ["-c", "user.email=test@example.invalid", "-c", "user.name=Ovis test", ...args], { cwd, encoding: "utf8" });
    if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
    return run.stdout.trim();
  };
  const port = 59_997;

  /**
   * What a v0.4.13 install looks like right after it installed the next release: its source
   * checkout, and under the old state dir the release the launcher starts the supervisor of.
   */
  function installedRelease() {
    const directory = mkdtempSync(join(tmpdir(), "ovis-legacy-launcher-"));
    roots.push(directory);
    const root = join(directory, "checkout"), config = join(directory, "config");
    mkdirSync(root);
    git(root, "init", "-q", "-b", "main");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "legacy-launcher-fixture", version: "0.4.13" }));
    git(root, "add", ".");
    git(root, "commit", "-qm", "0.4.13");
    const updates = updateStateDir(root, port, join(config, "herdr-web-ui"));
    const release = join(updates, "release-next");
    mkdirSync(updates, { recursive: true });
    git(directory, "clone", "-q", root, release);
    git(release, "commit", "-q", "--allow-empty", "-m", "next");
    writeFileSync(join(updates, "current.json"), JSON.stringify({ directory: release,
      revision: git(release, "rev-parse", "HEAD"), source_revision: git(root, "rev-parse", "HEAD") }));
    return { directory, root, config, release };
  }

  type Launch = { cwd: string; stateDir: string; managed: string; revision: string };
  /**
   * Runs this checkout's supervisor under `launcherEnv` until it is ready and returns every bridge
   * it started, each as that bridge reads its settings: the source checkout's is 0.4.13's, which
   * reads them under the names from before the rename. A `failing` release exits at once.
   */
  async function startBridge(directory: string, config: string, launcherEnv: Record<string, string>, failing = false): Promise<Launch[]> {
    const record = join(directory, "bridge.json");
    const script = join(directory, "supervisor-stand-in.ts");
    // the bridge without a bridge: its start is recorded and its health check answered; every
    // other process (the updater's git) runs for real
    writeFileSync(script, `
      import { writeFileSync } from "node:fs";
      const realSpawn = Bun.spawn;
      const launches = [];
      let bootId = "";
      Bun.spawn = ((argv, options) => {
        if (argv[1] !== "server/index.ts") return realSpawn(argv, options);
        const old = options.cwd === process.env.HERDR_WEB_SOURCE_ROOT;
        const read = (name) => options.env[old ? name.replace("OVIS_", "HERDR_WEB_") : name];
        launches.push({ cwd: options.cwd, stateDir: read("OVIS_STATE_DIR"), managed: read("OVIS_MANAGED"), revision: read("OVIS_REVISION") });
        writeFileSync(${JSON.stringify(record)}, JSON.stringify(launches));
        if (${failing} && !old) return { exitCode: 1, kill() {}, exited: Promise.resolve(1), send() {} };
        // a bridge told another boot id never passes the health check: the supervisor would wait
        // its whole deadline out and then fail
        if (read("OVIS_BOOT_ID") !== options.env.OVIS_BOOT_ID) {
          console.error(\`the bridge in \${options.cwd} cannot answer the boot id it was given\`);
          process.exit(3);
        }
        bootId = options.env.OVIS_BOOT_ID;
        return { exitCode: null, kill() {}, exited: Promise.resolve(0), send() {} };
      }) as typeof Bun.spawn;
      globalThis.fetch = (async () => ({ ok: true, json: async () => ({ web_ui: { boot_id: bootId } }) })) as unknown as typeof fetch;
      const { runSupervisor } = await import(${JSON.stringify(join(import.meta.dir, "supervisor.ts"))});
      await runSupervisor(process.env.OVIS_SOURCE_ROOT);
      process.exit(0);
    `);
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("OVIS_") && !name.startsWith("HERDR_WEB_")));
    const child = Bun.spawn([process.execPath, script], { env: { ...env, ...launcherEnv, XDG_CONFIG_HOME: config,
      PORT: String(port), HOST: "127.0.0.1", HERDR_SOCKET: join(directory, "herdr.sock"), OVIS_AUTO_UPDATE: "0" },
    stdout: "pipe", stderr: "pipe" });
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000); // a wedged stand-in must not hang the run
    try {
      const code = await child.exited;
      if (code !== 0 || !existsSync(record)) throw new Error(`the supervisor exited ${code}:\n${(await output).join("\n")}`);
      return JSON.parse(readFileSync(record, "utf8")) as Launch[];
    } finally {
      clearTimeout(timer);
    }
  }

  it("runs the release it installed and keeps the state where that launcher looks", async () => {
    // the v0.4.13 launcher names the checkout HERDR_WEB_SOURCE_ROOT, and it finds the active
    // release, at every start and every handover after the next install, only under the old
    // state dir: moved away, the update came back as the source checkout's old version
    const { directory, root, config, release } = installedRelease();
    const [bridge, ...more] = await startBridge(directory, config, { HERDR_WEB_SOURCE_ROOT: root });
    expect(more).toEqual([]);
    expect(bridge!.cwd).toBe(release);
    expect(bridge!.stateDir).toBe(join(config, "herdr-web-ui"));
    expect(lstatSync(join(config, "herdr-web-ui")).isDirectory()).toBe(true);
  }, 20_000);

  it("falls back from a release that fails to the 0.4.13 checkout, telling its bridge what it reads", async () => {
    // after a second update, the 0.4.13 launcher's own fallback is the previous release's
    // supervisor, which starts the source checkout the same way: a bridge that cannot answer
    // the boot id or is not told it is managed leaves the app down or unable to update
    const { directory, root, config, release } = installedRelease();
    const launches = await startBridge(directory, config, { HERDR_WEB_SOURCE_ROOT: root }, true);
    expect(launches.map((launch) => launch.cwd)).toEqual([release, root]);
    expect(launches[1]).toEqual({ cwd: root, stateDir: join(config, "herdr-web-ui"), managed: "1", revision: git(root, "rev-parse", "HEAD") });
  }, 20_000);

  it("moves the state dir once a launcher of this version starts it", async () => {
    const { directory, root, config } = installedRelease();
    const [bridge] = await startBridge(directory, config, { OVIS_SOURCE_ROOT: root, OVIS_LAUNCHER: "1" });
    expect(bridge!.stateDir).toBe(join(config, "ovis"));
    expect(lstatSync(join(config, "herdr-web-ui")).isSymbolicLink()).toBe(true);
  }, 20_000);
});
