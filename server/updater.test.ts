import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NOTES_FILE_LIMIT, readNotesFile, Updater, runCommand, type Release } from "./updater.ts";
import { spawnSync } from "node:child_process";
import { symlinkSync } from "node:fs";
import { HERDR_SOCKET_PATH } from "../shared/protocol.ts";

let directory: string, upstream: string, root: string, stateDir: string;
let updater: Updater;
/** every install step the updater published, in order, repeats left out */
let steps: Array<string | null>;
const git = (cwd: string, ...args: string[]) => runCommand(cwd, ["git", ...args]);
async function commit(contents: string, failBuild = false) {
  writeFileSync(join(upstream, "build-fixture.ts"), failBuild ? "throw new Error('fixture build failure');" :
    `await Bun.write('dist/index.html', ${JSON.stringify(contents)});`);
  await git(upstream, "add", ".");
  await git(upstream, "commit", "-qm", contents);
  return git(upstream, "rev-parse", "HEAD");
}
/** Commit and publish it as a release tag; only tags make an update available. */
async function release(contents: string, tag: string, options: { failBuild?: boolean; annotated?: boolean } = {}) {
  const revision = await commit(contents, options.failBuild);
  await git(upstream, "tag", ...(options.annotated ? ["-a", "-m", tag] : []), tag);
  return revision;
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "herdr-updater-"));
  upstream = join(directory, "upstream"); root = join(directory, "checkout"); stateDir = join(directory, "state");
  mkdirSync(upstream);
  await git(upstream, "init", "-q", "-b", "main");
  await git(upstream, "config", "user.email", "test@example.invalid");
  await git(upstream, "config", "user.name", "Updater test");
  writeFileSync(join(upstream, "package.json"), JSON.stringify({ name: "updater-fixture", scripts: {
    typecheck: "bun --eval 'process.exit(0)'", build: "bun build-fixture.ts",
  } }));
  writeFileSync(join(upstream, ".gitignore"), "node_modules/\ndist/\n");
  await runCommand(upstream, [process.execPath, "install"]);
  await commit("first");
  await git(directory, "clone", "-q", upstream, root);
  steps = [];
  updater = new Updater({ root, stateDir, autoUpdate: false, activate: async (_next, persist) => persist(),
    publish(status) { const step = status.step ?? null; if (steps.at(-1) !== step) steps.push(step); } });
  await updater.initialize();
});

afterEach(() => {
  updater?.stop();
  rmSync(directory, { recursive: true, force: true });
});

/** A real launcher + supervisor + bridge on a free port, serving the fixture checkout. */
async function managedFixture(supervisor?: string, slowHealth = false) {
  updater.stop();
  mkdirSync(join(upstream, "server"), { recursive: true });
  const entry = `
    import { createServer } from ${JSON.stringify(join(import.meta.dir, "index.ts"))};
    import { connectUpdater } from ${JSON.stringify(join(import.meta.dir, "update-api.ts"))};
    ${slowHealth ? `
    // a busy PC: the bridge answers, but its first six health checks outlast the supervisor's 1 s probe
    // timeout, so they are refused on any machine and the start takes about 6.6 s (fixed 800 ms let a
    // fast PC pass the first probe, and the test then exercised nothing)
    const serve = Bun.serve; let slow = 6;
    Bun.serve = (options) => serve({ ...options, async fetch(request, server) {
      if (new URL(request.url).pathname === "/api/health" && slow-- > 0) await Bun.sleep(1200);
      return options.fetch.call(this, request, server);
    } });` : ""}
    const server = createServer({ updates: connectUpdater() });
    process.on('SIGTERM', () => { server.stop(); setTimeout(() => process.exit(0), 50); });
    process.on('disconnect', () => { server.stop(); process.exit(0); });
  `;
  writeFileSync(join(upstream, "server/index.ts"), entry);
  if (supervisor !== undefined) writeFileSync(join(upstream, "server/supervisor.ts"), supervisor);
  await commit("managed initial");
  await git(root, "pull", "--ff-only", "--quiet");
  const reservation = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = reservation.port!; reservation.stop(true);
  const origin = `http://127.0.0.1:${port}`;
  const headers = { authorization: "Bearer test-managed-token", "x-herdr-update": "1" };
  // what the launcher, the supervisor and the bridge print: a failed test prints it
  const log = join(directory, "managed.log");
  const launch = () => {
    // one file for every launch of a test: a separator says which launch printed what
    appendFileSync(log, `--- launch at ${new Date().toISOString()} ---\n`);
    const output = openSync(log, "a");
    try {
      return Bun.spawn([process.execPath, "--eval",
        `import {runManaged} from ${JSON.stringify(join(import.meta.dir, "managed.ts"))}; await runManaged(${JSON.stringify(root)});`], {
        env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", HERDR_WEB_STATE_DIR: stateDir,
          HERDR_WEB_TOKEN: "test-managed-token", HERDR_WEB_AUTO_UPDATE: "0", SUPERVISOR_MARKER: join(directory, "marker") },
        stdout: output, stderr: output,
      });
    } finally {
      closeSync(output);
    }
  };
  const readStatus = async () => {
    try { return await (await fetch(`${origin}/api/updates`, { headers })).json() as typeof updater.status; }
    catch { return null; }
  };
  const until = async (check: () => Promise<boolean>) => {
    const deadline = Date.now() + 12_000;
    while (!await check()) {
      if (Date.now() > deadline) throw new Error(`Managed update timeout: ${JSON.stringify(await readStatus())}`);
      await Bun.sleep(50);
    }
  };
  const request = async (command: string) => {
    const response = await fetch(`${origin}/api/updates/${command}`, { method: "POST", headers });
    expect(response.status).toBe(202);
  };
  const health = async () => (await (await fetch(`${origin}/api/health`)).json()) as { web_ui: { revision: string; boot_id: string } };
  /** Print the update status and the managed processes' output when the test fails, then fail as it did. */
  const explain = async (error: unknown): Promise<never> => {
    console.error(`managed update status: ${JSON.stringify(await readStatus())}`);
    console.error(`managed process output:\n${existsSync(log) ? readFileSync(log, "utf8").slice(-8000) : "(none)"}`);
    throw error;
  };
  return { launch, readStatus, until, request, health, origin, explain };
}
/** A release's own supervisor: records that it ran, then runs the real one (or fails on purpose). */
const releaseSupervisor = (broken = false) => broken ? "process.exit(3);\n" : `
  import { appendFileSync } from "node:fs";
  appendFileSync(process.env.SUPERVISOR_MARKER, "release\\n");
  const { runSupervisor } = await import(${JSON.stringify(join(import.meta.dir, "supervisor.ts"))});
  await runSupervisor(process.env.HERDR_WEB_SOURCE_ROOT);
`;
const liveHerdr = existsSync(process.env["HERDR_SOCKET"] || HERDR_SOCKET_PATH);

describe("managed source updates with real Git repositories and builds", () => {
  it("checks without installing, then builds an exact revision without changing the source", async () => {
    const original = await git(root, "rev-parse", "HEAD");
    writeFileSync(join(upstream, "CHANGELOG.md"), "# Changelog\n\n## [0.2.0] - 2026-10-07\n\n### Added\n- Second.\n");
    const target = await release("second", "v0.2.0");
    await updater.request("check");
    expect(updater.status.available).toBe(true);
    expect(updater.notes).toEqual({ revision: target, releases: [{ version: "0.2.0", date: "2026-10-07", notes: "### Added\n- Second." }], omitted: 0 });
    expect(updater.status.current_revision).toBe(original);
    expect(readdirSync(stateDir).filter(name => name.startsWith("release-"))).toHaveLength(0);
    expect(steps).toEqual([null]);
    await updater.request("install");
    expect(updater.status.error).toBeNull();
    expect(steps).toEqual([null, "download", "dependencies", "typecheck", "build", "restart", null]);
    expect(updater.status.current_revision).toBe(target);
    expect(updater.notes).toEqual({ revision: null, releases: [], omitted: 0 });
    expect(readFileSync(join(updater.release!.directory, "dist/index.html"), "utf8")).toBe("second");
    expect(await git(root, "rev-parse", "HEAD")).toBe(original);
    expect(await git(root, "status", "--porcelain")).toBe("");
    const resumed = new Updater(updater.options);
    expect((await resumed.initialize())?.revision).toBe(target);
    resumed.stop();
  });

  it("tells what an update brings from the release's own changelog, every release since the running one", async () => {
    const manifest = JSON.parse(readFileSync(join(upstream, "package.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(upstream, "package.json"), JSON.stringify({ ...manifest, version: "0.1.0" }));
    await commit("versioned");
    await git(root, "pull", "--ff-only", "--quiet");
    // the notes are there when the status that offers the update is published, not after it
    let offered: unknown = null;
    const versioned = new Updater({ ...updater.options, publish(status) { if (status.available) offered = versioned.notes; } });
    await versioned.initialize();
    expect(versioned.status.current_version).toBe("0.1.0");

    const section = (version: string) => `## [${version}] - 2026-10-07\n\n### Added\n- Release ${version}.\n`;
    writeFileSync(join(upstream, "CHANGELOG.md"), `# Changelog\n\n${section("0.2.0")}`);
    await release("second", "v0.2.0");
    writeFileSync(join(upstream, "CHANGELOG.md"), `# Changelog\n\n${section("0.3.0")}\n${section("0.2.0")}`);
    const third = await release("third", "v0.3.0");
    // main moves on after the release: an entry the install does not bring
    writeFileSync(join(upstream, "CHANGELOG.md"), `# Changelog\n\n## [Unreleased]\n- Later.\n\n${section("0.4.0")}\n${section("0.3.0")}\n${section("0.2.0")}`);
    await commit("unreleased work");
    await versioned.request("check");
    expect(versioned.status.available).toBe(true);
    expect(versioned.notes.releases.map((entry) => [entry.version, entry.notes])).toEqual([
      ["0.3.0", "### Added\n- Release 0.3.0."], ["0.2.0", "### Added\n- Release 0.2.0."],
    ]);
    // the notes name the commit they were read from: the one the status offers
    expect(versioned.notes.revision).toBe(third);
    expect(versioned.status.latest_revision).toBe(third);
    expect(offered).toEqual(versioned.notes);

    // a release that ships no changelog is offered all the same, without notes
    await release("fourth", "v0.5.0");
    await git(upstream, "rm", "-q", "CHANGELOG.md");
    const fifth = await release("fifth", "v0.6.0");
    await versioned.request("check");
    expect(versioned.status.error).toBeNull();
    expect(versioned.status.latest_version).toBe("0.6.0");
    expect(versioned.status.available).toBe(true);
    expect(versioned.notes).toEqual({ revision: fifth, releases: [], omitted: 0 });
    versioned.stop();
  });

  it("tells a release by its summary, and what the update brought once it runs", async () => {
    const manifest = JSON.parse(readFileSync(join(upstream, "package.json"), "utf8")) as Record<string, unknown>;
    const cut = (version: string, sections: string[], summaries: Record<string, Record<string, Record<string, string[]>>> | null) => {
      writeFileSync(join(upstream, "package.json"), JSON.stringify({ ...manifest, version }));
      writeFileSync(join(upstream, "CHANGELOG.md"), `# Changelog\n\n${sections.map((entry) => `## [${entry}] - 2026-10-07\n\n### Added\n- Release ${entry}.\n`).join("\n")}`);
      if (summaries) writeFileSync(join(upstream, "release-summaries.json"), JSON.stringify(summaries));
      else rmSync(join(upstream, "release-summaries.json"), { force: true });
    };
    cut("0.1.0", ["0.1.0"], null);
    await commit("versioned");
    await git(root, "pull", "--ff-only", "--quiet");
    // what the last update brought is there when the status that names the new revision is published
    let told: unknown = null;
    const versioned = new Updater({ ...updater.options, publish(status) { if (status.current_version === "0.2.0" && told === null) told = versioned.installed; } });
    await versioned.initialize();
    // the source checkout: for its commit, the answer is that no update installed it
    const none = { revision: await git(root, "rev-parse", "HEAD"), version: null, previous_version: null, installed_at: null, releases: [], omitted: 0 };
    expect(versioned.installed).toEqual(none);

    const summary = { en: { new: ["A second release."], fixed: ["The first one."] }, ko: { new: ["두 번째 릴리스."], fixed: ["첫 번째 릴리스."] } };
    cut("0.2.0", ["0.2.0", "0.1.0"], { "0.2.0": summary, "0.1.0": { en: { new: ["The first."] } } });
    const second = await release("second", "v0.2.0");
    await versioned.request("check");
    const brought = [{ version: "0.2.0", date: "2026-10-07", notes: "### Added\n- Release 0.2.0.", summary }];
    expect(versioned.notes).toEqual({ revision: second, releases: brought, omitted: 0 });
    expect(versioned.installed).toEqual(none);

    const before = Date.now();
    await versioned.request("install");
    expect(versioned.status.error).toBeNull();
    expect(versioned.installed).toMatchObject({ revision: second, version: "0.2.0", previous_version: "0.1.0", releases: brought, omitted: 0 });
    expect(Date.parse(versioned.installed.installed_at!)).toBeGreaterThanOrEqual(before);
    expect(told).toEqual(versioned.installed);
    // the supervisor the release starts was not there for the install: it reads what that one wrote down
    const resumed = new Updater({ ...versioned.options, publish() {} });
    await resumed.initialize();
    expect(resumed.installed).toEqual(versioned.installed);

    // a build left behind by an install that was cut short is a later version, and no release that ran
    const stray = join(stateDir, "release-stray");
    mkdirSync(stray);
    writeFileSync(join(stray, "package.json"), JSON.stringify({ version: "0.2.5" }));
    // the next update replaces the release that runs, not that build and not the source checkout,
    // and one that wrote no summary is told by its section
    cut("0.3.0", ["0.3.0", "0.2.0", "0.1.0"], null);
    const third = await release("third", "v0.3.0");
    await resumed.request("install");
    expect(resumed.status.error).toBeNull();
    expect(resumed.installed).toMatchObject({ revision: third, version: "0.3.0", previous_version: "0.2.0",
      releases: [{ version: "0.3.0", date: "2026-10-07", notes: "### Added\n- Release 0.3.0." }], omitted: 0 });
    const later = new Updater({ ...versioned.options, publish() {} });
    await later.initialize();
    expect(later.installed).toEqual(resumed.installed);

    // a release installed by a supervisor older than that record: the version it replaced is the
    // newest older build still here, and the time is the record's own
    const record = join(stateDir, "current.json");
    const { previous_version: _previous, installed_at: _at, ...legacy } = JSON.parse(readFileSync(record, "utf8")) as Record<string, unknown>;
    writeFileSync(record, JSON.stringify(legacy));
    const inferred = new Updater({ ...versioned.options, publish() {} });
    await inferred.initialize();
    expect(inferred.installed).toMatchObject({ revision: third, version: "0.3.0", previous_version: "0.2.0" });
    expect(Number.isFinite(Date.parse(inferred.installed.installed_at!))).toBe(true);

    // a file too large to be notes is not read: summaries of that size leave the changelog, a changelog of that size leaves the update
    writeFileSync(join(inferred.release!.directory, "release-summaries.json"), JSON.stringify({ "0.3.0": { en: { new: ["x".repeat(2_100_000)] } } }));
    const unsummarized = new Updater({ ...versioned.options, publish() {} });
    await unsummarized.initialize();
    expect(unsummarized.installed.releases).toEqual([{ version: "0.3.0", date: "2026-10-07", notes: "### Added\n- Release 0.3.0." }]);
    writeFileSync(join(inferred.release!.directory, "CHANGELOG.md"), `## [0.3.0]\n${"- x\n".repeat(600_000)}`);
    const untold = new Updater({ ...versioned.options, publish() {} });
    await untold.initialize();
    expect(untold.installed).toMatchObject({ version: "0.3.0", previous_version: "0.2.0", releases: [], omitted: 0 });
    for (const each of [versioned, resumed, later, inferred, unsummarized, untold]) each.stop();
  });

  it("refuses local changes, detached branches, and an ahead/diverged history", async () => {
    await commit("second");
    writeFileSync(join(root, "user-draft.txt"), "preserve");
    await updater.request("install");
    expect(updater.status.blocked_reason).toContain("local changes");
    expect(readFileSync(join(root, "user-draft.txt"), "utf8")).toBe("preserve");
    rmSync(join(root, "user-draft.txt"));
    await git(root, "checkout", "--detach", "--quiet");
    await updater.request("install");
    expect(updater.status.blocked_reason).toContain("main");
    await git(root, "checkout", "main", "--quiet");
    await git(upstream, "checkout", "--orphan", "replacement", "--quiet");
    await release("unrelated", "v9.0.0");
    await git(upstream, "branch", "-M", "main");
    await updater.request("install");
    expect(updater.status.available).toBe(false);
    expect(updater.status.blocked_reason).toContain("release history");
  });

  it("updates a herdr-managed plugin checkout: shallow, detached, owned by herdr", async () => {
    // What `herdr plugin install` leaves behind: a depth-1 fetch checked out as FETCH_HEAD.
    const plugin = join(directory, "plugin");
    mkdirSync(plugin);
    await git(plugin, "init", "-q");
    await git(plugin, "remote", "add", "origin", `file://${upstream}`);
    await git(plugin, "fetch", "-q", "--depth", "1", "origin", "main");
    await git(plugin, "checkout", "-q", "FETCH_HEAD");
    const original = await git(plugin, "rev-parse", "HEAD");
    const pluginState = join(directory, "plugin-state");
    const make = (pluginCheckout: boolean) => new Updater({ root: plugin, stateDir: pluginState, autoUpdate: false, pluginCheckout,
      publish() {}, activate: async (_next, persist) => persist() });

    const outside = make(false);
    await outside.initialize();
    expect(outside.status.blocked_reason).toContain("main");
    outside.stop();

    const managed = make(true);
    await managed.initialize();
    expect(managed.status.blocked_reason).toBeNull();
    const target = await release("second", "v0.2.0");
    await managed.request("install");
    expect(managed.status.error).toBeNull();
    expect(managed.status.current_revision).toBe(target);
    expect(readFileSync(join(managed.release!.directory, "dist/index.html"), "utf8")).toBe("second");
    expect(await git(plugin, "rev-parse", "HEAD")).toBe(original);
    expect(await git(plugin, "status", "--porcelain")).toBe("");
    managed.stop();
  });

  it("follows only plain vX.Y.Z tags: untagged commits, bundle tags and pre-releases stay put", async () => {
    await commit("untagged work on main");
    await git(upstream, "tag", "remote-v9");
    await git(upstream, "tag", "v1.0.0-rc1");
    await updater.request("check");
    expect(updater.status.error).toBeNull();
    expect(updater.status.available).toBe(false);
    expect(updater.status.latest_version).toBeNull();

    const target = await release("released", "v0.10.0", { annotated: true });
    await release("older", "v0.9.0");
    await git(upstream, "reset", "-q", "--hard", target);
    await updater.request("check");
    expect(updater.status.latest_version).toBe("0.10.0");
    // the annotated tag peels to the commit that builds and health checks report
    expect(updater.status.latest_revision).toBe(target);
    expect(updater.status.available).toBe(true);
    await updater.request("install");
    expect(updater.status.error).toBeNull();
    expect(updater.status.current_revision).toBe(target);
  });

  it("treats a shallow plugin checkout ahead of the latest release as up to date", async () => {
    await git(upstream, "tag", "v0.1.0", "HEAD");
    await commit("unreleased");
    const plugin = join(directory, "plugin");
    mkdirSync(plugin);
    await git(plugin, "init", "-q");
    await git(plugin, "remote", "add", "origin", `file://${upstream}`);
    await git(plugin, "fetch", "-q", "--depth", "1", "origin", "main");
    await git(plugin, "checkout", "-q", "FETCH_HEAD");
    const managed = new Updater({ root: plugin, stateDir: join(directory, "plugin-state"), autoUpdate: false, pluginCheckout: true,
      publish() {}, activate: async (_next, persist) => persist() });
    await managed.initialize();
    await managed.request("check");
    expect(managed.status.error).toBeNull();
    expect(managed.status.blocked_reason).toBeNull();
    expect(managed.status.latest_version).toBe("0.1.0");
    expect(managed.status.available).toBe(false);
    await release("third", "v0.2.0");
    await managed.request("check");
    expect(managed.status.available).toBe(true);
    managed.stop();
  });

  it("leaves the current release intact on build failure and cleans the failed stage", async () => {
    const original = updater.release;
    await release("broken build", "v0.2.0", { failBuild: true });
    await updater.request("install");
    expect(updater.status.phase).toBe("error");
    expect(updater.status.error).toContain("fixture build failure");
    // the failed step is not left standing as if it still ran
    expect(steps).toEqual([null, "download", "dependencies", "typecheck", "build", null]);
    expect(updater.release).toBe(original);
    expect(readdirSync(stateDir).filter(name => name.startsWith("release-"))).toHaveLength(0);
  });

  it("does not persist a candidate that failed startup", async () => {
    updater.options.activate = async () => { throw new Error("health check failed; previous restored"); };
    const original = updater.release;
    await release("bad startup", "v0.2.0");
    await updater.request("install");
    expect(updater.release).toBe(original);
    expect(updater.status.error).toContain("health check failed");
    expect(readdirSync(stateDir)).not.toContain("current.json");
  });

  it("automatically installs when enabled and coalesces overlapping requests", async () => {
    let activations = 0;
    updater.options.autoUpdate = true;
    updater.options.activate = async (_release: Release, persist) => { activations++; persist(); };
    const target = await release("automatic", "v0.2.0");
    await Promise.all([updater.request("check"), updater.request("install"), updater.request("check")]);
    expect(activations).toBe(1);
    expect(updater.status.current_revision).toBe(target);
  });

  it("cancels an update command with a deadline", async () => {
    const start = Date.now();
    await expect(runCommand(root, [process.execPath, "--eval", "setInterval(() => {}, 1000)"], undefined, 100)).rejects.toThrow("timed out");
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("does not repeatedly restart into the same failed automatic update, including after restart", async () => {
    updater.options.autoUpdate = true;
    let attempts = 0;
    updater.options.activate = async () => { attempts++; throw new Error("startup failed"); };
    await release("bad automatic startup", "v0.2.0");
    await updater.request("check");
    await updater.request("check");
    expect(attempts).toBe(1);
    expect(updater.status.error).toContain("previously failed");
    const resumed = new Updater(updater.options);
    await resumed.initialize();
    await resumed.request("check");
    expect(attempts).toBe(1);
    await resumed.request("install");
    expect(attempts).toBe(2);
    resumed.stop();
  });

  // the supervisor's health check pings herdr, so this one needs a live herdr (CI has none)
  it.skipIf(!liveHerdr)("restarts the real bridge over IPC, rolls back a failed boot, and resumes the saved release", async () => {
    const { launch, readStatus, until, request, health, explain } = await managedFixture();
    let processHandle = launch();
    try {
      await until(async () => (await readStatus())?.managed === true);
      const target = await release("managed second", "v0.2.0");
      await request("check");
      await until(async () => (await readStatus())?.available === true);
      await request("install");
      await until(async () => { const s = await readStatus(); return s?.current_revision === target && s.phase === "idle"; });
      expect((await readStatus())?.error).toBeNull();
      expect((await health()).web_ui.revision).toBe(target);

      writeFileSync(join(upstream, "server/index.ts"), "throw new Error('fixture startup failure');");
      await release("broken startup", "v0.3.0");
      await request("check");
      await until(async () => (await readStatus())?.available === true);
      await request("install");
      await until(async () => (await readStatus())?.phase === "error");
      expect((await readStatus())?.current_revision).toBe(target);
      expect((await readStatus())?.error).toContain("Previous version restored");

      processHandle.kill("SIGTERM"); await processHandle.exited;
      processHandle = launch();
      await until(async () => (await readStatus())?.current_revision === target);
      expect((await readStatus())?.phase).toBe("idle");
    } catch (error) {
      await explain(error);
    } finally {
      processHandle.kill("SIGTERM");
      await processHandle.exited;
    }
  }, 30_000);

  it.skipIf(!liveHerdr)("hands over to the installed release's own supervisor", async () => {
    const { launch, readStatus, until, request, health, explain } = await managedFixture(releaseSupervisor());
    const marker = join(directory, "marker");
    const handle = launch();
    try {
      await until(async () => (await readStatus())?.managed === true);
      // the source checkout's supervisor starts first: nothing is installed yet
      expect(existsSync(marker)).toBe(false);
      const target = await release("handover", "v0.2.0");
      await request("check");
      await until(async () => (await readStatus())?.available === true);
      await request("install");
      await until(async () => { const s = await readStatus(); return existsSync(marker) && s?.current_revision === target && s.phase === "idle"; });
      expect(readFileSync(marker, "utf8")).toBe("release\n");
      expect((await health()).web_ui.revision).toBe(target);
      expect((await readStatus())?.error).toBeNull();
      // asserted here and not in `finally`, where it would replace the failure that came first
      handle.kill("SIGTERM");
      expect(await handle.exited).toBe(0);
    } catch (error) {
      await explain(error);
    } finally {
      handle.kill("SIGTERM");
      await handle.exited;
    }
  }, 30_000);

  it.skipIf(!liveHerdr)("installs an update asked for before the bridge's first health check has passed", async () => {
    const { launch, readStatus, until, request, health, explain } = await managedFixture(undefined, true);
    const handle = launch();
    try {
      // the bridge reports "managed" as soon as it runs, seconds before the supervisor's start is over
      await until(async () => (await readStatus())?.managed === true);
      const target = await release("early", "v0.2.0");
      await request("check");
      await until(async () => (await readStatus())?.available === true);
      await request("install");
      await until(async () => { const s = await readStatus(); return s?.current_revision === target && s.phase === "idle"; });
      expect((await readStatus())?.error).toBeNull();
      expect((await health()).web_ui.revision).toBe(target);
    } catch (error) {
      await explain(error);
    } finally {
      handle.kill("SIGTERM");
      await handle.exited;
    }
  }, 30_000);

  it.skipIf(!liveHerdr)("falls back to the previous supervisor when the new one cannot start", async () => {
    const { launch, readStatus, until, request, health, explain } = await managedFixture();
    const handle = launch();
    try {
      await until(async () => (await readStatus())?.managed === true);
      writeFileSync(join(upstream, "server/supervisor.ts"), releaseSupervisor(true));
      const target = await release("broken supervisor", "v0.2.0");
      await request("check");
      await until(async () => (await readStatus())?.available === true);
      await request("install");
      await until(async () => (await readStatus())?.error?.includes("previous one") === true);
      // the bridge that passed its health check keeps serving under the old supervisor
      expect((await readStatus())?.current_revision).toBe(target);
      expect((await health()).web_ui.revision).toBe(target);
      expect(handle.exitCode).toBeNull();
    } catch (error) {
      await explain(error);
    } finally {
      handle.kill("SIGTERM");
      await handle.exited;
    }
  }, 30_000);

  it.skipIf(!liveHerdr)("tells over HTTP that the checkout was replaced under the running server", async () => {
    const { launch, readStatus, until, health, explain } = await managedFixture();
    const handle = launch();
    try {
      await until(async () => /^[0-9a-f]{40}$/.test((await readStatus())?.current_revision ?? ""));
      const running = (await readStatus())?.current_revision;
      // what `herdr plugin install` or `git pull` plus a build does to a checkout that is being served
      const replaced = await commit("replaced checkout");
      await git(root, "pull", "--ff-only", "--quiet");
      // pulled, not built: the server serves the build it runs, which a reload does bring
      expect((await readStatus())?.served_revision ?? null).toBeNull();
      mkdirSync(join(root, "dist"), { recursive: true });
      writeFileSync(join(root, "dist", "build.json"), JSON.stringify({ revision: replaced }));
      // no update check: the bridge reads the build it serves when asked, not every 5 minutes
      expect((await readStatus())?.served_revision).toBe(replaced);
      // the server still runs what it started with: only a restart reports the new commit
      expect((await readStatus())?.current_revision).toBe(running!);
      expect((await health()).web_ui.revision).toBe(running!);
    } catch (error) {
      await explain(error);
    } finally {
      handle.kill("SIGTERM");
      await handle.exited;
    }
  }, 30_000);
});

describe("a release's notes file", () => {
  it("is read whole within its limit, from one descriptor, and only as a regular file", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-notes-file-"));
    try {
      writeFileSync(join(dir, "small.md"), "## [0.1.0]\n- one\n");
      expect(readNotesFile(join(dir, "small.md"))).toBe("## [0.1.0]\n- one\n");
      writeFileSync(join(dir, "large.md"), Buffer.alloc(NOTES_FILE_LIMIT + 1, 0x78));
      expect(() => readNotesFile(join(dir, "large.md"))).toThrow(/not notes|too large/);
      // a symlink is not followed: the release's own file is what is read, not where a link points
      symlinkSync(join(dir, "small.md"), join(dir, "link.md"));
      expect(() => readNotesFile(join(dir, "link.md"))).toThrow();
      // a FIFO would hold the supervisor's synchronous read for a writer that never comes
      if (spawnSync("mkfifo", [join(dir, "fifo.md")]).status === 0) expect(() => readNotesFile(join(dir, "fifo.md"))).toThrow(/not notes/);
      expect(() => readNotesFile(join(dir, "missing.md"))).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
