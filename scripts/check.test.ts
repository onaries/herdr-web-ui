import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isolate, lock, needsLock, plan, sanitizeCommand } from "./check.ts";

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
    expect(Object.keys(env).filter((name) => name.startsWith("HERDR_")).sort()).toEqual(["HERDR_TEST_SESSION", "HERDR_TEST_SHARDS", "HERDR_WEB_HERDR_BIN", "HERDR_WEB_STATE_DIR"]);
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

    const env = { ...process.env, CHECK_DIR: ".check" };
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
