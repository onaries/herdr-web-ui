import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquire, describeHolders, isolate, lock, maxRuns, needsLock, plan, sanitizeCommand } from "./check.ts";

const made: string[] = [];
afterEach(() => { for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true }); });
const scratch = (): string => { const dir = mkdtempSync(join(tmpdir(), "hwc-test-")); made.push(dir); return dir; };
const git = (cwd: string, ...args: string[]): void => {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
};

describe("plan", () => {
  it("reads the modes: the fast steps, the lanes, both, or one command", () => {
    expect(plan(["fast"])).toEqual({ fast: true, lanes: [], command: null, build: false });
    expect(plan(["browser"])).toEqual({ fast: false, lanes: ["browser"], command: null, build: false });
    expect(plan(["browser", "integration"])).toEqual({ fast: false, lanes: ["integration", "browser"], command: null, build: false });
    expect(plan(["full"])).toEqual({ fast: true, lanes: ["integration", "browser"], command: null, build: false });
    expect(plan(["run", "bun", "test", "./a.test.ts"])).toEqual({ fast: false, lanes: [], command: ["bun", "test", "./a.test.ts"], build: false });
    expect(plan(["run", "--build", "bun", "scripts/browser-qa.ts"])).toEqual({ fast: false, lanes: [], command: ["bun", "scripts/browser-qa.ts"], build: true });
    expect(plan(["run", "--build", "--", "bun", "scripts/browser-qa.ts"])).toEqual({ fast: false, lanes: [], command: ["bun", "scripts/browser-qa.ts"], build: true });
  });

  it("refuses what it does not know instead of running something else", () => {
    for (const args of [[], ["quick"], ["fast", "run"], ["run"]]) expect(() => plan(args)).toThrow("Usage");
  });

  it("uses the existing lock for herdr-backed run commands and never serializes inline credentials", () => {
    expect(needsLock(plan(["run", "bun", "test", "./a.contract.test.ts"]))).toBe(true);
    expect(needsLock(plan(["fast"]))).toBe(false);
    expect(sanitizeCommand(["bun", "--api-token", "private", "--access-token=value", "https://example.test/?token=secret"]))
      .toEqual(["bun", "--api-token", "[REDACTED]", "--access-token=[REDACTED]", "https://example.test/?token=[REDACTED]"]);
  });
});

describe("isolate", () => {
  it("points herdr, its plugins and the web UI at one directory of the run's own, under its own session name", () => {
    const first = isolate({ PATH: "/bin", XDG_CONFIG_HOME: "/home/someone/.config" });
    const second = isolate({ PATH: "/bin" });
    try {
      expect(first.env["PATH"]).toBe("/bin");
      expect(first.env["XDG_CONFIG_HOME"]).not.toBe("/home/someone/.config");
      for (const name of ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "HERDR_WEB_STATE_DIR"]) {
        expect(existsSync(first.env[name]!)).toBe(true);
        expect(first.env[name]).not.toBe(second.env[name]);
      }
      expect(first.sessions).toBe(join(first.env["XDG_CONFIG_HOME"]!, "herdr", "sessions"));
      expect(first.env["HERDR_TEST_SESSION"]).toMatch(/^check-[0-9a-f]{6}$/);
      expect(first.env["HERDR_TEST_SESSION"]).not.toBe(second.env["HERDR_TEST_SESSION"]);
      if (process.platform !== "win32") {
        for (const name of ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "HERDR_WEB_STATE_DIR"]) expect(statSync(first.env[name]!).mode & 0o777).toBe(0o700);
      }
      // one integration file at a time unless asked otherwise
      expect(first.env["HERDR_TEST_SHARDS"]).toBe("1");
      expect(isolate({ HERDR_TEST_SHARDS: "4" }, scratch()).env["HERDR_TEST_SHARDS"]).toBe("4");
    } finally {
      const dir = join(first.env["XDG_CONFIG_HOME"]!, "..");
      first.remove();
      second.remove();
      expect(existsSync(dir)).toBe(false);
    }
  });

  it("keeps a directory the caller named, and refuses one too long for a socket", () => {
    const kept = scratch();
    const isolation = isolate({}, kept);
    expect(isolation.env["XDG_CONFIG_HOME"]).toBe(join(kept, "config"));
    isolation.remove();
    expect(existsSync(join(kept, "config"))).toBe(true);
    expect(() => isolate({}, join(scratch(), "a".repeat(80)))).toThrow("too long for a unix socket");
  });

  it("refuses to run in the herdr the user works in, and hands on nothing that names it", () => {
    expect(() => isolate({ HERDR_TEST_LIVE: "1" }, scratch())).toThrow("HERDR_TEST_LIVE");
    // as a shell inside one of the user's panes has them
    const { env } = isolate({ HERDR_SOCKET: "/live.sock", HERDR_SOCKET_PATH: "/live.sock", HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_TAB_ID: "w1:t1", HERDR_WORKSPACE_ID: "w1", HERDR_WEB_HERDR_BIN: "/bin/herdr" }, scratch());
    expect(Object.keys(env).filter((name) => name.startsWith("HERDR_")).sort()).toEqual(["HERDR_TEST_DISPOSABLE_CONFIG", "HERDR_TEST_SESSION", "HERDR_TEST_SHARDS", "HERDR_WEB_HERDR_BIN", "HERDR_WEB_STATE_DIR"]);
  });
});

describe("lock", () => {
  /** a port nothing listens on: asked of the system, then given back */
  const freePort = async (): Promise<number> => {
    const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = probe.port;
    probe.stop(true);
    return port;
  };

  it("lets one run in, names the run that holds it, and is free again once released", async () => {
    const port = await freePort();
    const first = await lock(port, 111);
    expect("release" in first).toBe(true);
    expect(await lock(port, 222)).toEqual({ heldBy: 111 });
    (first as { release: () => void }).release();
    const next = await lock(port, 222);
    expect("release" in next).toBe(true);
    (next as { release: () => void }).release();
  });

  it("says so when something that is no run listens on the port", async () => {
    const other = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open(socket) { socket.end("hello"); }, data() {} } });
    try {
      expect(await lock(other.port, 222)).toEqual({ heldBy: Number.NaN });
    } finally {
      other.stop(true);
    }
  });

  it("is free again once the run that held it is killed", async () => {
    const port = await freePort();
    const holder = Bun.spawn([process.execPath, "-e", `const { lock } = await import(${JSON.stringify(fileURLToPath(new URL("./check.ts", import.meta.url)))}); await lock(${port}, 111, "/a"); console.log("HELD"); setInterval(() => {}, 1000);`], { stdout: "pipe" });
    try {
      const reader = holder.stdout.getReader();
      let said = "";
      while (!said.includes("HELD")) {
        const { value, done } = await reader.read();
        if (done) throw new Error("the holder ended before it held the lock");
        said += new TextDecoder().decode(value);
      }
      expect(await lock(port, 222)).toEqual({ heldBy: 111, checkout: "/a" });
      holder.kill("SIGKILL");
      await holder.exited;
      const next = await lock(port, 222);
      expect("release" in next).toBe(true);
      (next as { release: () => void }).release();
    } finally {
      holder.kill("SIGKILL");
    }
  });
});

describe("slots", () => {
  /** `count` consecutive ports nothing listens on, held for a moment to make sure, then given back */
  const freeRange = async (count: number): Promise<number> => {
    for (let attempt = 0; attempt < 50; attempt++) {
      const base = 20_000 + Math.floor(Math.random() * 30_000);
      const held: { stop: (force?: boolean) => void }[] = [];
      try {
        for (let index = 0; index <= count; index++) held.push(Bun.listen({ hostname: "127.0.0.1", port: base + index, socket: { data() {} } }));
        return base;
      } catch { /* taken: another base */ } finally {
        for (const listener of held) listener.stop(true);
      }
    }
    throw new Error("no free port range");
  };
  const release = (result: Awaited<ReturnType<typeof acquire>> | Awaited<ReturnType<typeof lock>>): void => {
    if ("release" in result) result.release();
  };

  it("takes the first free slot when another checkout holds an earlier one", async () => {
    const base = await freeRange(3);
    const other = await lock(base, 111, "/other");
    try {
      const mine = await acquire({ slots: 3, scan: 3, base, pid: 222, checkout: "/mine" });
      expect(mine).toMatchObject({ port: base + 1 });
      expect(await lock(base + 1, 333)).toEqual({ heldBy: 222, checkout: "/mine" });
      release(mine);
    } finally {
      release(other);
    }
  });

  it("refuses when every slot is taken and names each holder", async () => {
    const base = await freeRange(3);
    const first = await lock(base, 111, "/a");
    const second = await lock(base + 1, 333, "/c");
    try {
      const refused = await acquire({ slots: 2, scan: 3, base, pid: 222, checkout: "/b" });
      expect(refused).toEqual({ refused: "busy", holders: [{ port: base, heldBy: 111, checkout: "/a" }, { port: base + 1, heldBy: 333, checkout: "/c" }] });
      expect(describeHolders((refused as { holders: Parameters<typeof describeHolders>[0] }).holders)).toBe(`port ${base}: pid 111 in /a; port ${base + 1}: pid 333 in /c`);
      // what it refused it does not keep: the third port is still free
      const third = await lock(base + 2, 444);
      expect("release" in third).toBe(true);
      release(third);
    } finally {
      release(first);
      release(second);
    }
  });

  it("refuses a second run in the same checkout while slots are free, also past its own slot count", async () => {
    const base = await freeRange(3);
    const same = await lock(base + 2, 111, "/mine");
    try {
      const refused = await acquire({ slots: 2, scan: 3, base, pid: 222, checkout: "/mine" });
      expect(refused).toEqual({ refused: "same-checkout", holders: [{ port: base + 2, heldBy: 111, checkout: "/mine" }] });
      // the slot it took on the way is given back
      const first = await lock(base, 333);
      expect("release" in first).toBe(true);
      release(first);
      const elsewhere = await acquire({ slots: 2, scan: 3, base, pid: 222, checkout: "/elsewhere" });
      expect(elsewhere).toMatchObject({ port: base });
      release(elsewhere);
    } finally {
      release(same);
    }
  });

  it("reads CHECK_MAX_RUNS as 1 to 8, else one slot per eight cores, from 1 to 2", () => {
    expect(maxRuns({}, 32)).toBe(2);
    expect(maxRuns({}, 64)).toBe(2);
    expect(maxRuns({}, 16)).toBe(2);
    expect(maxRuns({}, 15)).toBe(1);
    expect(maxRuns({}, 4)).toBe(1);
    expect(maxRuns({ CHECK_MAX_RUNS: "" }, 32)).toBe(2);
    expect(maxRuns({ CHECK_MAX_RUNS: "1" }, 32)).toBe(1);
    expect(maxRuns({ CHECK_MAX_RUNS: "8" }, 4)).toBe(8);
    for (const value of ["0", "9", "-1", "1.5", "two", " 3"]) expect(() => maxRuns({ CHECK_MAX_RUNS: value }, 32)).toThrow("CHECK_MAX_RUNS");
  });

  it("refuses the paused contender when an earlier holder turns over to its checkout", async () => {
    const base = await freeRange(4);
    let resume: () => void = () => {};
    let observed: () => void = () => {};
    const paused = new Promise<void>((resolve) => { observed = resolve; });
    const old = createServer((socket) => {
      resume = () => socket.end("111\n/other");
      old.close();
      observed();
    });
    await new Promise<void>((resolve) => old.listen(base, "127.0.0.1", resolve));
    let replacement: Awaited<ReturnType<typeof lock>> | undefined;
    const contender = acquire({ slots: 2, scan: 3, base, pid: 222, checkout: "/mine" });
    try {
      await paused;
      replacement = await lock(base, 333, "/mine");
      expect("release" in replacement).toBe(true);
      resume();
      const result = await contender;
      try {
        expect(result).toMatchObject({ refused: "same-checkout", holders: [{ port: base, heldBy: 333, checkout: "/mine" }] });
      } finally { release(result); }
    } finally {
      resume();
      old.close();
      if (replacement) release(replacement);
    }
  });

  it("counts a higher slot when a new run lowers the PC-wide capacity", async () => {
    const base = await freeRange(4);
    const higher = await lock(base + 1, 111, "/other");
    try {
      const result = await acquire({ slots: 1, scan: 3, base, pid: 222, checkout: "/mine" });
      try {
        expect(result).toEqual({ refused: "busy", holders: [{ port: base + 1, heldBy: 111, checkout: "/other" }] });
      } finally { release(result); }
      const first = await lock(base, 333);
      expect("release" in first).toBe(true);
      release(first);
    } finally { release(higher); }
  });

  for (const resource of ["CHECK_DIR", "CHECK_REPORT"]) {
    it(`refuses different checkouts sharing a canonical ${resource}`, async () => {
      const base = await freeRange(4);
      const dir = scratch();
      const alias = join(scratch(), "alias");
      symlinkSync(dir, alias, process.platform === "win32" ? "junction" : "dir");
      const path = resource === "CHECK_DIR" ? dir : join(dir, "report.json");
      const aliasPath = resource === "CHECK_DIR" ? alias : join(alias, "report.json");
      const first = await acquire({ slots: 2, scan: 3, base, checkout: "/first", resources: [path] });
      try {
        expect("release" in first).toBe(true);
        const second = await acquire({ slots: 2, scan: 3, base, checkout: "/second", resources: [aliasPath] });
        try { expect(second).toMatchObject({ refused: "resource" }); }
        finally { release(second); }
      } finally { release(first); }
      const next = await acquire({ slots: 2, scan: 3, base, checkout: "/second", resources: [aliasPath] });
      expect("release" in next).toBe(true);
      release(next);
    });
  }

  it("reclaims only a dead owner's marker and rolls back partial resource claims", async () => {
    const base = await freeRange(3);
    const dir = scratch();
    const finished = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" });
    expect(finished.status).toBe(0);
    const marker = join(dir, ".check-lock");
    writeFileSync(marker, JSON.stringify({ pid: Number(finished.stdout.trim()), checkout: "/dead" }));
    const first = await acquire({ slots: 0, scan: 3, base, checkout: "/first", resources: [dir] });
    try {
      expect("release" in first).toBe(true);
      expect(JSON.parse(readFileSync(marker, "utf8")).pid).toBe(process.pid);
      const free = join(scratch(), "report.json");
      const refused = await acquire({ slots: 0, scan: 3, base, checkout: "/second", resources: [free, dir] });
      try {
        expect(refused).toMatchObject({ refused: "resource" });
        expect(existsSync(`${free}.check-lock`)).toBe(false);
        expect(existsSync(marker)).toBe(true);
      } finally { release(refused); }
    } finally { release(first); }
    expect(existsSync(marker)).toBe(false);
  });

  it("recovers from a corrupt resource marker instead of crashing", async () => {
    const base = await freeRange(3);
    const dir = scratch();
    const marker = join(dir, ".check-lock");
    writeFileSync(marker, "{ truncated");
    const result = await acquire({ slots: 0, scan: 3, base, checkout: "/mine", resources: [dir] });
    try {
      expect("release" in result).toBe(true);
      expect(JSON.parse(readFileSync(marker, "utf8")).pid).toBe(process.pid);
    } finally { release(result); }
    expect(existsSync(marker)).toBe(false);
  });

  it("locks a file resource by its name, not a symlink target that renameSync replaces", async () => {
    const base = await freeRange(3);
    const dir = scratch();
    const target = join(dir, "previous.json");
    const link = join(dir, "latest.json");
    writeFileSync(target, "{}");
    symlinkSync(target, link);
    const first = await acquire({ slots: 0, scan: 3, base, checkout: "/first", reports: [link] });
    try {
      expect("release" in first).toBe(true);
      // Simulate persistReport replacing the symlink with a regular file
      rmSync(link);
      writeFileSync(link, '{"replaced": true}');
      const second = await acquire({ slots: 0, scan: 3, base, checkout: "/second", reports: [link] });
      try { expect(second).toMatchObject({ refused: "resource" }); }
      finally { release(second); }
    } finally { release(first); }
  });

  it("locks a report by its name when the name is a symlink to a directory", async () => {
    const base = await freeRange(3);
    const dir = scratch();
    const target = join(dir, "previous");
    const link = join(dir, "latest.json");
    mkdirSync(target);
    symlinkSync(target, link);
    const first = await acquire({ slots: 0, scan: 3, base, checkout: "/first", reports: [link] });
    try {
      expect("release" in first).toBe(true);
      expect(existsSync(join(target, ".check-lock"))).toBe(false);
      // persistReport's rename puts a regular file where the symlink was
      rmSync(link);
      writeFileSync(link, '{"replaced": true}');
      const second = await acquire({ slots: 0, scan: 3, base, checkout: "/second", reports: [link] });
      try { expect(second).toMatchObject({ refused: "resource" }); }
      finally { release(second); }
    } finally { release(first); }
  });

  it("leaves a marker it cannot read where it is, and does not claim the resource", async () => {
    const base = await freeRange(3);
    const dir = scratch();
    const marker = join(dir, ".check-lock");
    // a read that fails for a reason other than its content, whoever runs the test: the name
    // exists and can be unlinked, but reading it answers EISDIR
    mkdirSync(join(dir, "elsewhere"));
    symlinkSync(join(dir, "elsewhere"), marker);
    await expect(acquire({ slots: 0, scan: 3, base, checkout: "/mine", resources: [dir] })).rejects.toThrow();
    expect(lstatSync(marker).isSymbolicLink()).toBe(true);
  });

  it("leaves the PC to a run from before slots, which names no checkout", async () => {
    const base = await freeRange(3);
    const old = await lock(base, 111);
    if (!("release" in old)) throw new Error("the first slot was free");
    try {
      const refused = await acquire({ slots: 2, scan: 3, base, checkout: "/mine" });
      try { expect(refused).toEqual({ refused: "busy", holders: [{ port: base, heldBy: 111 }] }); }
      finally { release(refused); }
      // the candidate slot it took while asking is free again
      const next = await lock(base + 1, 222, "/other");
      expect("release" in next).toBe(true);
      if ("release" in next) next.release();
    } finally { old.release(); }
  });

  it("serializes simultaneous admission without leaving a candidate slot behind", async () => {
    const base = await freeRange(3);
    const results = await Promise.all([
      acquire({ slots: 1, scan: 3, base, checkout: "/first" }),
      acquire({ slots: 1, scan: 3, base, checkout: "/second" }),
    ]);
    try { expect(results.filter((result) => "release" in result)).toHaveLength(1); }
    finally { for (const result of results) release(result); }
    const next = await acquire({ slots: 1, scan: 3, base, checkout: "/third" });
    expect("release" in next).toBe(true);
    release(next);
  });
});

describe("check CLI", () => {
  it.skipIf(process.platform !== "linux" || process.arch !== "x64")("fails closed when source identity is lost after the fast checks", () => {
    const cwd = scratch();
    git(cwd, "init", "-q");
    git(cwd, "config", "user.name", "check test");
    git(cwd, "config", "user.email", "check@example.invalid");
    writeFileSync(join(cwd, ".gitignore"), "node_modules/\n.check/\ndist/\n");
    const noOp = 'node -e "process.exit(0)" --';
    const fixtureBuild = 'node -e "const fs=require(\'node:fs\');fs.mkdirSync(\'dist\',{recursive:true});fs.writeFileSync(\'dist/index.html\',\'fixture\')"';
    writeFileSync(join(cwd, "package.json"), JSON.stringify({
      name: "check-cli-fixture",
      scripts: {
        "generate:types": noOp,
        typecheck: noOp,
        build: fixtureBuild,
        "test:unit": noOp,
      },
    }));
    git(cwd, "add", ".gitignore", "package.json");
    git(cwd, "commit", "-qm", "fixture");

    const actionlintDirectory = join(cwd, "node_modules", ".cache", "actionlint-1.7.12");
    mkdirSync(actionlintDirectory, { recursive: true });
    const actionlint = join(actionlintDirectory, "actionlint");
    writeFileSync(actionlint, "#!/bin/sh\nexit 0\n");
    chmodSync(actionlint, 0o755);

    const env: Record<string, string | undefined> = { ...process.env, CHECK_DIR: ".check" };
    delete env["CHECK_REPORT"];
    delete env["GITHUB_EVENT_NAME"];
    delete env["GITHUB_EVENT_PATH"];
    const runCheck = () => spawnSync(process.execPath, [fileURLToPath(new URL("./check.ts", import.meta.url)), "fast"], {
      cwd,
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
    git(cwd, "init", "-q", "nested");
    writeFileSync(join(cwd, "nested", "source.txt"), "nested repository fixture");
    const initialUnknown = runCheck();
    expect(initialUnknown.status).toBe(1);
    const initialReport = JSON.parse(readFileSync(join(cwd, ".check", "report.json"), "utf8")) as {
      source: { unchanged: boolean | null; start: { fingerprint: string | null; reason: string | null } };
      verification: { status: string };
      errors: string[];
    };
    expect(initialReport.source.unchanged).toBeNull();
    expect(initialReport.source.start.fingerprint).toBeNull();
    expect(initialReport.source.start.reason).toContain("nested/");
    expect(initialReport.verification.status).toBe("unknown");
    expect(initialReport.errors.some((error) => error.includes("source identity unavailable at start") && error.includes("nested/"))).toBe(true);

    rmSync(join(cwd, "nested"), { recursive: true });
    writeFileSync(join(cwd, "package.json"), JSON.stringify({
      name: "check-cli-fixture",
      scripts: {
        "generate:types": noOp,
        typecheck: noOp,
        build: fixtureBuild,
        "test:unit": "git init -q nested && node -e \"require('node:fs').writeFileSync('nested/source.txt','fixture')\"",
      },
    }));
    const result = runCheck();

    expect(result.status).toBe(1);
    const report = JSON.parse(readFileSync(join(cwd, ".check", "report.json"), "utf8")) as {
      status: string;
      exitCode: number;
      revision: { head: string | null; testedSha: string | null; headSha: string | null };
      source: { unchanged: boolean | null; end: { fingerprint: string | null; reason: string | null } };
      verification: { status: string };
      errors: string[];
    };
    expect(report.status).toBe("failure");
    expect(report.exitCode).toBe(1);
    expect(report.source.unchanged).toBe(false);
    expect(report.source.end.fingerprint).toBeNull();
    expect(report.source.end.reason).toContain("nested/");
    expect(report.errors.some((error) => error.includes("source identity unavailable at end") && error.includes("nested/"))).toBe(true);
    expect(report.verification.status).toBe("invalidated");
    expect(report.revision.testedSha).toBe(report.revision.head);
    expect(report.revision.headSha).toBe(report.revision.testedSha);

    rmSync(join(cwd, "nested"), { recursive: true });
    rmSync(join(cwd, "dist"), { recursive: true });
    writeFileSync(join(cwd, "package.json"), JSON.stringify({
      name: "check-cli-fixture",
      scripts: { "generate:types": noOp, typecheck: noOp, build: noOp, "test:unit": noOp },
    }));
    const missingBuild = runCheck();
    expect(missingBuild.status).toBe(1);
    const missingBuildReport = JSON.parse(readFileSync(join(cwd, ".check", "report.json"), "utf8"));
    expect(missingBuildReport.source.unchanged).toBe(true);
    expect(missingBuildReport.browserArtifact.buildThisRun).toBe(true);
    expect(missingBuildReport.verification.status).toBe("unknown");
    expect(missingBuildReport.errors).toContain("built dist identity unavailable; cannot verify the built artifact");
  });
});
