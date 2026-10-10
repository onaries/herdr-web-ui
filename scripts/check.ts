/**
 * The checks, from one entry point: CI's jobs call it, and so does a developer or an agent
 * before pushing, so both run the same thing.
 *
 *   bun run check fast                  what CI's "Fast checks" job runs: workflow syntax, generated
 *                                       types, typecheck, build, unit tests. No herdr needed.
 *   bun run check integration browser   CI's "Integration and browser" job: a build, then the named
 *                                       lanes side by side (either name alone runs that lane)
 *   bun run check full                  fast, then both lanes
 *   bun run check run [--build] <command…>  any command on the same isolated herdr; --build builds
 *                                           dist/ first (a run without it does not build)
 *
 * Whatever needs herdr runs on a herdr of its own. Its config, its plugin state and the web UI's
 * state live in a directory made for this run (XDG_CONFIG_HOME, XDG_STATE_HOME,
 * HERDR_WEB_STATE_DIR), under a session name made for this run. Nothing reads the user's herdr
 * config, so no plugin installed there starts with the test servers, and two runs on one PC
 * share no socket and no file. The run stops its herdr servers and removes the directory when
 * it ends, also when it is interrupted. CHECK_DIR names a directory to use and keep instead.
 * CHECK_REPORT overrides the durable JSON report path; otherwise the report is in CHECK_DIR or
 * node_modules/.cache/check/<run-id>. The report and streamed logs are outside ephemeral isolation.
 *
 * A few herdr-backed runs at a time on this PC (CHECK_MAX_RUNS, see maxRuns): contract and browser
 * tests are bound by timing, so too many side by side fail each other. Each run holds a slot, a
 * loopback port it listens on (LOCK_PORT and the ports after it), so a run that died holds nothing.
 * A run that finds every slot taken names the holders and exits, and so does a second run in the
 * same checkout, which would share its dist/ and generated types.
 *
 * What a run still shares with the PC: the checkout (`fast` rewrites the generated types file
 * while it checks it, and fast/lane modes build into dist/), herdr's worktree root, and Playwright's
 * browser cache. `run` does not rebuild dist/ unless asked with `--build`.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { availableParallelism, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { finished } from "node:stream/promises";
import { DISPOSABLE_CONFIG_ENV, DISPOSABLE_CONFIG_FILE } from "./disposable-config.ts";
import {
  artifactIdentity,
  artifactUnchangedAfterBuild,
  createRunId,
  initialReport,
  persistReport,
  reportExitCode,
  reportPaths,
  revisionDetails,
  sourceIdentity,
  verificationResult,
  type CheckReport,
  type CheckStep,
  type SourceIdentity,
} from "./check-report.ts";

export const MODES = ["fast", "integration", "browser", "full", "run"] as const;
export type Mode = (typeof MODES)[number];
const LANES = { integration: "bun run test:integration", browser: "bash scripts/ci-browser.sh" } as const;
type Lane = keyof typeof LANES;

const USAGE = "Usage: bun run check fast | integration | browser | integration browser | full | run [--build] <command…>";

/** What to run, from the arguments: the fast steps, the lanes, or one command. */
export function plan(args: readonly string[]): { fast: boolean; lanes: Lane[]; command: string[] | null; build: boolean } {
  const [first, ...rest] = args;
  if (first === "run") {
    const build = rest[0] === "--build";
    const command = rest.slice(build ? 1 : 0);
    if (command[0] === "--") command.shift();
    if (command.length === 0) throw new Error(USAGE);
    return { fast: false, lanes: [], command, build };
  }
  if (args.length === 0 || args.some((arg) => arg === "run" || !(MODES as readonly string[]).includes(arg))) throw new Error(USAGE);
  const full = args.includes("full");
  const lanes = (Object.keys(LANES) as Lane[]).filter((lane) => full || args.includes(lane));
  return { fast: full || args.includes("fast"), lanes, command: null, build: false };
}

/** Herdr-backed commands share the existing per-PC lane lock, including `run` commands. */
export function needsLock(todo: ReturnType<typeof plan>): boolean {
  return todo.lanes.length > 0 || todo.command !== null;
}

/** Keep command arguments useful without persisting common inline credentials. Environment values are never serialized. */
export function sanitizeCommand(command: readonly string[]): string[] {
  const sensitive = /token|secret|password|passwd|api[-_]?key|auth|cookie|credential|bearer/i;
  let redactNext = false;
  const sanitized = command.map((argument) => {
    if (redactNext) { redactNext = false; return "[REDACTED]"; }
    if (/^(?:authorization|cookie):\s*/i.test(argument)) return argument.replace(/:.*/, ":[REDACTED]");
    if (/^--?[^=]+$/.test(argument) && sensitive.test(argument)) { redactNext = true; return argument; }
    const equals = argument.indexOf("=");
    if (equals > 0 && sensitive.test(argument.slice(0, equals))) return `${argument.slice(0, equals)}=[REDACTED]`;
    return argument.replace(/([?&][^=]*(?:token|secret|password|key|auth|credential)[^=]*=)[^&]*/gi, "$1[REDACTED]");
  });
  let remaining = 8_192;
  const bounded: string[] = [];
  for (const argument of sanitized) {
    if (remaining <= 0) { bounded.push("[ARGUMENTS TRUNCATED]"); break; }
    if (argument.length > remaining) {
      bounded.push(`${argument.slice(0, Math.max(0, remaining - 14))}[TRUNCATED]`);
      break;
    }
    bounded.push(argument);
    remaining -= argument.length;
  }
  return bounded;
}

/** actionlint as CI pins it. The archive is checked against its SHA-256 before it is unpacked. */
const ACTIONLINT = { version: "1.7.12", sha256: "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8" };

/** A unix socket's path holds about 104 bytes on macOS and 108 on Linux. */
const SOCKET_PATH_MAX = 100;

/** What a shell inside a herdr pane carries of that herdr: nothing in a run may reach it by these. */
const LIVE_HERDR = ["HERDR_SOCKET", "HERDR_SOCKET_PATH", "HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID"];

export interface Isolation {
  env: Record<string, string>;
  /** where the run's herdr keeps its sessions */
  sessions: string;
  /** removes the directory, unless the caller named it */
  remove: () => void;
}

/**
 * A herdr of the run's own: the environment that points herdr, its plugins and the web UI at one
 * directory, and a session name no other run has.
 */
export function isolate(base: Record<string, string | undefined>, kept: string | undefined = base["CHECK_DIR"]): Isolation {
  if (base["HERDR_TEST_LIVE"] === "1") throw new Error("HERDR_TEST_LIVE=1 runs tests in the herdr you work in; unset it for `bun run check`");
  // short on purpose: the session's socket path has to fit a unix socket address
  const dir = kept ? resolve(kept) : mkdtempSync(join(existsSync("/tmp") ? "/tmp" : tmpdir(), "hwc-"));
  const session = `check-${randomBytes(3).toString("hex")}`;
  const config = join(dir, "config");
  for (const path of [config, join(dir, "state"), join(dir, "web-state")]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`isolated state path is not a real directory: ${path}`);
    if (process.platform !== "win32") chmodSync(path, 0o700);
  }
  // what lets a test write to herdr's per-user plugin registry: this one is the run's own
  writeFileSync(join(config, DISPOSABLE_CONFIG_FILE), "", { mode: 0o600 });
  const sessions = join(config, "herdr", "sessions");
  // the integration lane's workers are `<session>-<n>`
  const socket = join(sessions, `${session}-9`, "herdr.sock");
  if (socket.length > SOCKET_PATH_MAX) {
    if (!kept) rmSync(dir, { recursive: true, force: true });
    throw new Error(`${socket} is too long for a unix socket (${socket.length} > ${SOCKET_PATH_MAX}); set CHECK_DIR to a shorter path`);
  }
  const env: Record<string, string> = {};
  // not what names the herdr this was started from (a pane of the user's): its socket, its pane
  for (const [name, value] of Object.entries(base)) if (value !== undefined && !LIVE_HERDR.includes(name)) env[name] = value;
  Object.assign(env, {
    XDG_CONFIG_HOME: config,
    [DISPOSABLE_CONFIG_ENV]: config,
    XDG_STATE_HOME: join(dir, "state"),
    HERDR_WEB_STATE_DIR: join(dir, "web-state"),
    HERDR_TEST_SESSION: session,
    // One integration file at a time: four at once made the timing-bound contract tests fail in
    // turn on CI's four cores. HERDR_TEST_SHARDS raises it (scripts/ci-tests.ts).
    HERDR_TEST_SHARDS: base["HERDR_TEST_SHARDS"] || "1",
  });
  return { env, sessions, remove: () => { if (!kept) rmSync(dir, { recursive: true, force: true }); } };
}

/** The first loopback port a herdr-backed run listens on while it runs: slot 1. Slot n is LOCK_PORT + n - 1. */
export const LOCK_PORT = 41737;
/** The most slots CHECK_MAX_RUNS may ask for; every run looks at all of them for its own checkout. */
export const MAX_RUNS_LIMIT = 8;

/**
 * How many herdr-backed runs may share this PC: CHECK_MAX_RUNS (1 to 8), else one per eight cores,
 * at least one and at most two. On a 32-core PC two side by side stayed green; with three,
 * machine-conflict-regression.ts lost Chromium screenshots, and with four integration tests
 * that wait on live processes failed (measured for the PR that added slots).
 */
export function maxRuns(env: Record<string, string | undefined>, cores = availableParallelism()): number {
  const asked = env["CHECK_MAX_RUNS"];
  if (asked === undefined || asked === "") return Math.max(1, Math.min(2, Math.floor(cores / 8)));
  const count = /^\d+$/.test(asked) ? Number(asked) : Number.NaN;
  if (!(count >= 1 && count <= MAX_RUNS_LIMIT)) throw new Error(`CHECK_MAX_RUNS must be a whole number from 1 to ${MAX_RUNS_LIMIT}, not "${asked}"`);
  return count;
}

/** What a slot's holder says: its pid (NaN when what listens there is no run) and its checkout, when it names one. */
export type Holder = { heldBy: number; checkout?: string };

/** Asks the holder of a port who it is; null when nothing listens there. */
function ask(port: number): Promise<Holder | null> {
  return new Promise((resolve) => {
    let said = "";
    let refused = false;
    const client = connect(port, "127.0.0.1");
    client.setTimeout(2_000, () => client.destroy());
    client.on("data", (chunk) => { said += chunk.toString(); });
    client.on("error", (error: NodeJS.ErrnoException) => { refused = error.code === "ECONNREFUSED"; });
    client.on("close", () => {
      if (refused) { resolve(null); return; }
      // `<pid>` from a run before slots, `<pid>\n<checkout>` from one since
      const match = /^(\d+)(?:\n([^]+))?$/.exec(said);
      resolve(!match ? { heldBy: Number.NaN } : match[2] ? { heldBy: Number(match[1]), checkout: match[2] } : { heldBy: Number(match[1]) });
    });
  });
}

/**
 * One slot. The lock is a listening loopback port: taking it is one step, and it is free again the
 * moment its run is gone, however it ended, so there is no lock left behind to take over. Whoever
 * holds it answers a connection with its pid and checkout. Resolves with the release, or with who
 * holds it (NaN when something else listens there).
 */
export function lock(port = LOCK_PORT, pid = process.pid, checkout?: string): Promise<{ release: () => void } | Holder> {
  return new Promise((resolve, reject) => {
    const answer = checkout === undefined ? String(pid) : `${pid}\n${checkout}`;
    const server = createServer((socket) => { socket.on("error", () => undefined); socket.end(answer); });
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EADDRINUSE") { reject(error); return; }
      void ask(port).then((holder) => resolve(holder ?? { heldBy: Number.NaN }));
    });
    server.listen(port, "127.0.0.1", () => {
      // the lock must not keep the run alive once its work is done
      server.unref();
      resolve({ release: () => { server.close(); } });
    });
  });
}

export type SlotHolder = Holder & { port: number };

/**
 * Admission is serialized on the port after the slot range. While holding it, claim explicit
 * resources and take a candidate slot, then scan ALL slots again: an earlier holder may have
 * turned over while we asked it. Zero slots claims only resources (fast needs no herdr slot).
 * The admission port also serializes dead-pid marker reclamation, so two reclaimers cannot
 * unlink each other's newly acquired marker. A busy admission port refuses rather than waits.
 */
export async function acquire(
  { slots, checkout, base = LOCK_PORT, pid = process.pid, scan = MAX_RUNS_LIMIT, resources = [], reports = [] }: { slots: number; checkout: string; base?: number; pid?: number; scan?: number; resources?: readonly string[]; reports?: readonly string[] },
): Promise<{ release: () => void; port: number | null } | { refused: "busy" | "same-checkout" | "resource"; holders: SlotHolder[]; resource?: string }> {
  const admissionPort = base + Math.max(slots, scan);
  const admission = await lock(admissionPort, pid, checkout);
  if (!("release" in admission)) return { refused: "busy", holders: [{ ...admission, port: admissionPort }] };
  let taken: { release: () => void; port: number } | null = null;
  const markers: string[] = [];
  let admitted = false;
  const release = (): void => {
    taken?.release();
    for (const marker of markers.splice(0)) rmSync(marker);
  };
  try {
    // A report is written by renaming over its name (check-report.ts), which replaces a symlink
    // there whatever it points to: its lock is the name in its real directory, never the target.
    const claims = [...resources.map((path) => ({ path, report: false })), ...reports.map((path) => ({ path, report: true }))];
    for (const { path, report } of claims) {
      const absolute = resolve(path);
      mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
      const isDir = !report && existsSync(absolute) && statSync(absolute).isDirectory();
      const canonical = isDir ? realpathSync(absolute) : join(realpathSync(dirname(absolute)), basename(absolute));
      const marker = isDir ? join(canonical, ".check-lock") : `${canonical}.check-lock`;
      if (markers.includes(marker)) continue;
      if (existsSync(marker)) {
        // a marker that cannot be read may be a live holder's: only one that was read and is not
        // JSON (a write cut short) is taken over
        const text = readFileSync(marker, "utf8");
        let owner: { pid: number; checkout: string };
        try {
          owner = JSON.parse(text) as { pid: number; checkout: string };
        } catch {
          rmSync(marker, { force: true });
          writeFileSync(marker, JSON.stringify({ pid, checkout }), { flag: "wx", mode: 0o600 });
          markers.push(marker);
          continue;
        }
        if (owner === null || typeof owner !== "object" || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error(`invalid check lock owner: ${marker}`);
        let dead = false;
        try { process.kill(owner.pid, 0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          dead = true;
        }
        if (!dead) return { refused: "resource", resource: canonical, holders: [{ port: admissionPort, heldBy: owner.pid, checkout: owner.checkout }] };
        rmSync(marker);
      }
      writeFileSync(marker, JSON.stringify({ pid, checkout }), { flag: "wx", mode: 0o600 });
      markers.push(marker);
    }
    for (let index = 0; index < slots; index++) {
      const port = base + index;
      const result = await lock(port, pid, checkout);
      if ("release" in result) { taken = { release: result.release, port }; break; }
    }
    const holders: SlotHolder[] = [];
    for (let index = 0; slots > 0 && index < Math.max(slots, scan); index++) {
      const port = base + index;
      if (port === taken?.port) continue;
      const holder = await ask(port);
      if (holder) holders.push({ ...holder, port });
    }
    const same = holders.filter((holder) => holder.checkout === checkout);
    if (same.length > 0) return { refused: "same-checkout", holders: same };
    // a run from before slots names no checkout and counts on having the PC to itself: nothing
    // can say it is not in this checkout, so it is alone until it ends
    const alone = holders.filter((holder) => !Number.isNaN(holder.heldBy) && holder.checkout === undefined);
    if (alone.length > 0) return { refused: "busy", holders: alone };
    if (slots > 0 && (!taken || holders.length >= slots)) return { refused: "busy", holders };
    admitted = true;
    return { release, port: taken?.port ?? null };
  } finally {
    if (!admitted) release();
    admission.release();
  }
}

/** One line per holder for a refusal. */
export function describeHolders(holders: readonly SlotHolder[]): string {
  return holders.map((holder) => Number.isNaN(holder.heldBy)
    ? `port ${holder.port}: something that is no check run`
    : `port ${holder.port}: pid ${holder.heldBy}${holder.checkout ? ` in ${holder.checkout}` : ""}`).join("; ");
}

async function main(): Promise<void> {
  let todo: ReturnType<typeof plan>;
  const args = process.argv.slice(2);
  try { todo = plan(args); } catch (error) { console.error((error as Error).message); process.exit(2); }
  const needsHerdr = needsLock(todo);
  const cwd = process.cwd();
  const runId = createRunId();
  const paths = reportPaths(cwd, process.env, runId);
  const resources: string[] = [];
  if (process.env["CHECK_DIR"]) {
    const dir = resolve(cwd, process.env["CHECK_DIR"]!);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    resources.push(dir);
  }
  const reports = process.env["CHECK_REPORT"] || process.env["CHECK_DIR"] ? [paths.reportPath] : [];
  const cleanups: (() => void)[] = [];
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    for (const step of cleanups.reverse()) try { step(); } catch (error) { console.error(`check: cleanup failed: ${(error as Error).message}`); }
  };
  if (needsHerdr || resources.length > 0 || reports.length > 0) {
    try {
      let slots: number;
      try { slots = needsHerdr ? maxRuns(process.env) : 0; } catch (error) { console.error(`check: ${(error as Error).message}`); process.exit(2); }
      const held = await acquire({ slots, checkout: realpathSync(cwd), resources, reports });
      if ("refused" in held) {
        const message = held.refused === "same-checkout"
          ? `another herdr-backed \`bun run check\` is running in this checkout, and the two would share dist/ and the generated types (${describeHolders(held.holders)}); wait for it to end or use another worktree`
          : held.refused === "resource"
            ? `check resource ${held.resource} is already held (${describeHolders(held.holders)}); use a different CHECK_DIR / CHECK_REPORT or wait for the holder`
            : `herdr-backed check admission is busy or the ${slots}-run limit is reached (${describeHolders(held.holders)}); wait for one to end, or set CHECK_MAX_RUNS (1 to ${MAX_RUNS_LIMIT})`;
        console.error(`check: ${message}`);
        process.exit(1);
      }
      // Keep output ownership through cleanup AND the final report write.
      process.once("exit", held.release);
    } catch (error) {
      console.error(`check: could not acquire the herdr-backed check lock: ${(error as Error).message}`);
      process.exit(1);
    }
  }
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const logDirectory = paths.logDirectory;
  mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(logDirectory, 0o700);
  const sourceExcludes = [paths.reportPath, `${paths.reportPath}.check-lock`, logDirectory];
  if (process.env["CHECK_DIR"]) {
    const checkDirectory = resolve(cwd, process.env["CHECK_DIR"]!);
    const relativeCheckDirectory = relative(cwd, checkDirectory);
    if (relativeCheckDirectory && relativeCheckDirectory !== ".." && !relativeCheckDirectory.startsWith(`..${sep}`) && !isAbsolute(relativeCheckDirectory)) {
      sourceExcludes.push(checkDirectory);
    }
  }
  const bun = process.execPath;
  const specs: { name: string; command: string[] | null }[] = [];
  if (todo.fast) {
    specs.push({ name: "workflow syntax", command: null });
    specs.push({ name: "generated types are fresh", command: [bun, "run", "generate:types", "--check"] });
    specs.push({ name: "typecheck", command: [bun, "run", "typecheck"] });
    specs.push({ name: "build", command: [bun, "run", "build"] });
    specs.push({ name: "unit tests", command: [bun, "run", "test:unit"] });
  }
  if (todo.lanes.length > 0) {
    if (!todo.fast) specs.push({ name: "build", command: [bun, "run", "build"] });
    specs.push({ name: "lanes", command: [bun, "scripts/ci-lanes.ts", ...todo.lanes.map((lane) => `${lane}=${LANES[lane]}`)] });
  }
  if (todo.command) {
    if (todo.build) specs.push({ name: "build", command: [bun, "run", "build"] });
    specs.push({ name: "run", command: todo.command });
  }
  const safeFileName = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "step";
  const reportSteps: CheckStep[] = [];
  const makeStep = (name: string, command: string[] | null): CheckStep => {
    const index = reportSteps.length + 1;
    const prefix = `${String(index).padStart(2, "0")}-${safeFileName(name)}`;
    return {
      name,
      command: command ? sanitizeCommand(command) : null,
      cwd,
      status: "not-run",
      exitCode: null,
      signal: null,
      durationMs: null,
      startedAt: null,
      endedAt: null,
      stdout: join(logDirectory, `${prefix}.stdout.log`),
      stderr: join(logDirectory, `${prefix}.stderr.log`),
      reason: null,
    };
  };
  for (const { name, command } of specs) reportSteps.push(makeStep(name, command));
  const allowedMode = todo.command
    ? ["run", ...(todo.build ? ["--build"] : [])]
    : [...args];
  const unavailableSource = (): SourceIdentity => ({
    head: null,
    branch: null,
    trackedDiffSha256: null,
    untrackedFiles: [],
    untrackedFileCount: null,
    untrackedContentSha256: null,
    untrackedFilesTruncated: null,
    fingerprint: null,
    reason: "source identity has not been captured",
  });
  let sourceStart = unavailableSource();
  const report: CheckReport = initialReport({
    runId,
    mode: allowedMode,
    startedAt,
    source: sourceStart,
    baseBranch: null,
    baseSha: null,
    env: process.env,
    steps: reportSteps,
    logPaths: reportSteps.flatMap((step) => [step.stdout, step.stderr]),
  });
  let reportPersistFailed = false;
  const saveReport = (): void => {
    try { persistReport(paths.reportPath, report, logDirectory); }
    catch (error) {
      reportPersistFailed = true;
      console.error(`check: could not persist report ${paths.reportPath}: ${(error as Error).message}`);
    }
  };
  try { persistReport(paths.reportPath, report, logDirectory); }
  catch (error) {
    console.error(`check: could not create report ${paths.reportPath}: ${(error as Error).message}`);
    cleanup();
    process.exit(1);
  }
  console.log(`check: report ${paths.reportPath}`);
  const nodeVersion = spawnSync("node", ["--version"], { encoding: "utf8", timeout: 5_000 });
  const nodeVersionLine = nodeVersion.stdout?.trim().split(/\r?\n/, 1)[0] ?? "";
  report.toolchain.nodeVersion = nodeVersion.status === 0 && /^v\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(nodeVersionLine) ? nodeVersionLine : null;
  try { sourceStart = sourceIdentity(cwd, sourceExcludes); }
  catch (error) {
    const reason = String((error as Error).message || error).replace(/[\r\n\t]+/g, " ").trim().slice(0, 512) || "source identity could not be captured";
    sourceStart = { ...unavailableSource(), reason };
  }
  report.source.start = sourceStart;
  report.revision = revisionDetails(cwd, process.env, sourceStart);
  if ((process.env["GITHUB_EVENT_NAME"] === "pull_request" || process.env["GITHUB_EVENT_NAME"] === "pull_request_target") && report.revision.headSha === null) {
    report.errors.push("GitHub pull request event did not provide a valid head SHA and branch");
  }
  if (sourceStart.fingerprint === null) {
    report.errors.push(`source identity unavailable at start: ${sourceStart.reason ?? "unknown reason"}`);
  }
  report.browserArtifact.identity = artifactIdentity(join(cwd, "dist"));
  report.browserArtifact.provenance = report.browserArtifact.identity ? "pre-existing-unknown" : "unavailable";
  saveReport();

  let child: ChildProcess | null = null;
  let activeStep: CheckStep | null = null;
  let activeStartedAtMs = 0;
  let activeStepFinished: Promise<void> | null = null;
  let ending = false;
  let interruptedBy: NodeJS.Signals | null = null;
  const finalize = (status: CheckReport["status"], exitCode: number): void => {
    const endedAtMs = Date.now();
    let sourceEnd = unavailableSource();
    try { sourceEnd = sourceIdentity(cwd, sourceExcludes); }
    catch (error) {
      const reason = String((error as Error).message || error).replace(/[\r\n\t]+/g, " ").trim().slice(0, 512) || "source identity could not be captured";
      sourceEnd = { ...unavailableSource(), reason };
    }
    if (sourceEnd.fingerprint === null) {
      report.errors.push(`source identity unavailable at end: ${sourceEnd.reason ?? "unknown reason"}`);
    }
    report.status = status;
    report.exitCode = exitCode;
    report.endedAt = new Date(endedAtMs).toISOString();
    report.durationMs = endedAtMs - startedAtMs;
    report.currentStep = null;
    report.source.end = sourceEnd;
    report.source.unchanged = sourceStart.fingerprint !== null
      ? sourceEnd.fingerprint === null ? false : sourceStart.fingerprint === sourceEnd.fingerprint
      : null;
    report.browserArtifact.finalIdentity = artifactIdentity(join(cwd, "dist"));
    if (report.browserArtifact.buildAttempted && report.browserArtifact.buildThisRun) {
      report.browserArtifact.unchangedAfterBuild = artifactUnchangedAfterBuild(report.browserArtifact.identity, report.browserArtifact.finalIdentity);
      report.browserArtifact.provenance = report.browserArtifact.unchangedAfterBuild === true
        ? "built-this-run"
        : report.browserArtifact.unchangedAfterBuild === false
          ? "modified-after-build"
          : "unavailable";
    } else if (!report.browserArtifact.buildAttempted) {
      report.browserArtifact.provenance = report.browserArtifact.identity && report.browserArtifact.identity === report.browserArtifact.finalIdentity
        ? "pre-existing-unknown"
        : report.browserArtifact.identity || report.browserArtifact.finalIdentity
          ? "unknown"
          : "unavailable";
    } else {
      report.browserArtifact.identity = null;
      report.browserArtifact.provenance = "unavailable";
    }
    report.verification = verificationResult(report.source.unchanged, status, report.browserArtifact.unchangedAfterBuild, report.browserArtifact.buildAttempted && report.browserArtifact.buildThisRun);
    if (report.source.unchanged === null) {
      const reason = sourceStart.fingerprint === null ? sourceStart.reason : sourceEnd.reason;
      if (reason) report.verification.reason = `source identity unavailable: ${reason}`;
    }
    if ((report.browserArtifact.identity || report.browserArtifact.finalIdentity) && !report.evidence.artifacts.includes(resolve(cwd, "dist"))) {
      report.evidence.artifacts.push(resolve(cwd, "dist"));
    }
    saveReport();
  };

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      if (ending) return;
      ending = true;
      interruptedBy = signal;
      report.status = "interrupted";
      report.exitCode = signal === "SIGINT" ? 130 : 143;
      if (activeStep) {
        activeStep.status = "interrupted";
        activeStep.exitCode = null;
        activeStep.signal = signal;
        activeStep.endedAt = new Date().toISOString();
        activeStep.durationMs = Date.now() - activeStartedAtMs;
        activeStep.reason = `interrupted by ${signal}`;
      }
      saveReport();
      void (async () => {
        // The step runs in a process group of its own, and a lane starts processes of its own
        // in it: the whole group gets the signal, and has ended before the herdr and the
        // directory it uses are taken away.
        if (child?.pid !== undefined) await endGroup(child.pid, signal);
        if (activeStepFinished) await activeStepFinished;
        cleanup();
        finalize("interrupted", signal === "SIGINT" ? 130 : 143);
        process.exit(signal === "SIGINT" ? 130 : 143);
      })();
    });
  }

  const getStep = (label: string, command: string[] | null = null): CheckStep => {
    let step = report.steps.find((candidate) => candidate.name === label && candidate.status === "not-run" && candidate.startedAt === null);
    if (!step) {
      step = makeStep(label, command);
      report.steps.push(step);
      report.evidence.logs.push(step.stdout, step.stderr);
    } else if (command) step.command = sanitizeCommand(command);
    return step;
  };
  const recordIssue = (label: string, message: string, status: "failure" | "skipped"): void => {
    const step = getStep(label);
    step.status = status;
    step.reason = message;
    step.startedAt = new Date().toISOString();
    step.endedAt = step.startedAt;
    step.durationMs = 0;
    step.exitCode = status === "failure" ? 1 : null;
    step.signal = null;
    mkdirSync(logDirectory, { recursive: true });
    writeFileSync(step.stdout, "", { mode: 0o600 });
    writeFileSync(step.stderr, status === "failure" ? `${message}\n` : "", { mode: 0o600 });
    if (status === "failure") {
      report.errors.push(message);
      console.error(`check: ${message}`);
    } else console.log(`\n=== ${label}: skipped (${message})`);
    saveReport();
  };

  /** Runs one step in a process group, streaming output both to the console and durable log files. */
  const run = (label: string, command: string[], env: Record<string, string | undefined>, commandCwd = cwd): Promise<number> => {
    const step = getStep(label, command);
    step.cwd = resolve(commandCwd);
    const startedAtMs = Date.now();
    activeStartedAtMs = startedAtMs;
    activeStep = step;
    step.startedAt = new Date(startedAtMs).toISOString();
    step.reason = null;
    report.currentStep = label;
    saveReport();
    console.log(`\n=== ${label}: ${sanitizeCommand(command).join(" ")}`);
    return new Promise((done) => {
      let settled = false;
      let resolveStepFinished!: () => void;
      const stepFinished = new Promise<void>((resolve) => { resolveStepFinished = resolve; });
      activeStepFinished = stepFinished;
      let drainTimer: NodeJS.Timeout | null = null;
      let outputIncomplete = false;
      const stdout = createWriteStream(step.stdout, { flags: "w", mode: 0o600 });
      const stderr = createWriteStream(step.stderr, { flags: "w", mode: 0o600 });
      let logsFailed = false;
      stdout.on("error", (error) => { logsFailed = true; console.error(`check: stdout log failed: ${error.message}`); });
      stderr.on("error", (error) => { logsFailed = true; console.error(`check: stderr log failed: ${error.message}`); });
      const finish = (code: number | null, signal: NodeJS.Signals | null, launchError?: Error): void => {
        if (settled) return;
        settled = true;
        if (drainTimer) clearTimeout(drainTimer);
        child = null;
        if (launchError) {
          console.error(`check: ${command[0]}: ${launchError.message}`);
          stderr.write(`${launchError.message}\n`);
        }
        stdout.end();
        stderr.end();
        void Promise.all([finished(stdout).catch(() => undefined), finished(stderr).catch(() => undefined)]).then(() => {
          const endedAtMs = Date.now();
          step.endedAt = new Date(endedAtMs).toISOString();
          step.durationMs = endedAtMs - startedAtMs;
          step.exitCode = ending ? null : code;
          step.signal = ending ? interruptedBy ?? signal : signal;
          step.status = ending ? "interrupted" : step.exitCode === 0 && !logsFailed ? "success" : "failure";
          if (ending) step.reason = `interrupted by ${interruptedBy ?? signal ?? "signal"}`;
          else if (signal) step.reason = `process terminated by ${signal}`;
          else if (logsFailed) step.reason = "could not persist command output logs";
          else if (outputIncomplete) step.reason = "output may be incomplete: a process left running still held the output";
          report.currentStep = null;
          if (step.status === "failure" && signal) report.errors.push(`${label} terminated by ${signal}`);
          else if (step.status === "failure" && !logsFailed) report.errors.push(`${label} exited with code ${step.exitCode}`);
          if (logsFailed) report.errors.push(`${label} output logs could not be persisted`);
          saveReport();
          activeStep = null;
          activeStepFinished = null;
          resolveStepFinished();
          if (!ending) done(logsFailed && code === 0 ? 1 : step.exitCode ?? 1);
        });
      };
      try {
        const started = spawn(command[0]!, command.slice(1), { stdio: ["inherit", "pipe", "pipe"], env, cwd: commandCwd, detached: true });
        child = started;
        const stdoutStream = started.stdout;
        const stderrStream = started.stderr;
        let stdoutClosed = !stdoutStream;
        let stderrClosed = !stderrStream;
        let exited = false;
        let terminatingGroup = false;
        let exitCode: number | null = null;
        let exitSignal: NodeJS.Signals | null = null;
        const maybeFinishAfterExit = (): void => {
          if (!exited || settled || terminatingGroup) return;
          if (stdoutClosed && stderrClosed) {
            finish(exitCode, exitSignal);
            return;
          }
          if (drainTimer) return;
          drainTimer = setTimeout(() => {
            drainTimer = null;
            if (settled) return;
            outputIncomplete = true;
            terminatingGroup = true;
            stdoutStream?.destroy();
            stderrStream?.destroy();
            void (async () => {
              if (started.pid !== undefined) await endGroup(started.pid, "SIGTERM");
              finish(exitCode, exitSignal);
            })();
          }, OUTPUT_DRAIN_GRACE_MS);
        };
        stdoutStream?.on("data", (chunk: Buffer) => { process.stdout.write(chunk); stdout.write(chunk); });
        stderrStream?.on("data", (chunk: Buffer) => { process.stderr.write(chunk); stderr.write(chunk); });
        stdoutStream?.on("end", () => { stdoutClosed = true; maybeFinishAfterExit(); });
        stdoutStream?.on("close", () => { stdoutClosed = true; maybeFinishAfterExit(); });
        stderrStream?.on("end", () => { stderrClosed = true; maybeFinishAfterExit(); });
        stderrStream?.on("close", () => { stderrClosed = true; maybeFinishAfterExit(); });
        started.once("error", (error) => finish(127, null, error));
        started.once("exit", (code, signal) => {
          exited = true;
          exitCode = code;
          exitSignal = signal;
          maybeFinishAfterExit();
        });
      } catch (error) {
        finish(127, null, error as Error);
      }
    });
  };

  const skip = (label: string, reason: string): void => recordIssue(label, reason, "skipped");
  const build = async (env: Record<string, string | undefined>): Promise<number> => {
    report.browserArtifact.buildAttempted = true;
    report.browserArtifact.identity = null;
    report.browserArtifact.provenance = "unavailable";
    saveReport();
    const code = await run("build", [bun, "run", "build"], env);
    if (code === 0) {
      report.browserArtifact.buildThisRun = true;
      report.browserArtifact.identity = artifactIdentity(join(cwd, "dist"));
      report.browserArtifact.finalIdentity = report.browserArtifact.identity;
      report.browserArtifact.provenance = report.browserArtifact.identity ? "built-this-run" : "unavailable";
      saveReport();
    }
    return code;
  };

  // tests make commits in repositories of their own: an identity for a PC (or a runner) that has none
  const identity = spawnSync("git", ["config", "user.email"], { encoding: "utf8" }).stdout?.trim()
    ? {}
    : { GIT_AUTHOR_NAME: "check", GIT_AUTHOR_EMAIL: "check@example.invalid", GIT_COMMITTER_NAME: "check", GIT_COMMITTER_EMAIL: "check@example.invalid" };
  const plain = { ...process.env, ...identity };

  let code = 0;
  try {
    // A run command shares the same herdr and dist state, so it uses the same lock as named lanes.
    if (todo.fast) {
      const actionlintResult = await actionlint(run, plain, (reason) => skip("workflow syntax", reason), (message) => recordIssue("workflow syntax", message, "failure"));
      code = actionlintResult;
      for (const [label, command] of [
        ["generated types are fresh", [bun, "run", "generate:types", "--check"]],
        ["typecheck", [bun, "run", "typecheck"]],
      ] as const) {
        if (code !== 0 || ending) break;
        code = await run(label, [...command], plain);
      }
      if (code === 0 && !ending) code = await build(plain);
      if (code === 0 && !ending) code = await run("unit tests", [bun, "run", "test:unit"], plain);
    }
    if (code === 0 && needsHerdr && !ending) {
      const herdr = process.env["HERDR_WEB_HERDR_BIN"] || "herdr";
      if (!Bun.which(herdr)) throw new Error("this needs herdr on PATH (or HERDR_WEB_HERDR_BIN)");
      const herdrVersion = spawnSync(herdr, ["--version"], { encoding: "utf8", env: process.env, timeout: 5_000 });
      const herdrVersionLine = herdrVersion.stdout?.trim().split(/\r?\n/, 1)[0] ?? "";
      report.toolchain.herdrVersion = herdrVersion.status === 0 && /^herdr\s+v?\d+(?:\.\d+){1,3}(?:[-+][A-Za-z0-9.-]+)?$/i.test(herdrVersionLine)
        ? herdrVersionLine
        : null;
      saveReport();
      const isolation = isolate(process.env);
      cleanups.push(isolation.remove);
      const env: Record<string, string | undefined> = { ...isolation.env, ...identity };
      const shards = env["HERDR_TEST_SHARDS"]!;
      const shardCount = /^\d+$/.test(shards) ? Number(shards) : Number.NaN;
      report.toolchain.herdrTestShards = Number.isSafeInteger(shardCount) ? shardCount : null;
      saveReport();
      // every session in the run's own config directory is the run's: the browser scripts leave theirs running
      cleanups.push(() => {
        for (const session of existsSync(isolation.sessions) ? readdirSync(isolation.sessions) : []) {
          spawnSync(herdr, ["--session", session, "server", "stop"], { env, stdio: "ignore", timeout: 10_000 });
        }
      });
      console.log(`\ncheck: herdr session ${env["HERDR_TEST_SESSION"]}, config and state in ${resolve(isolation.sessions, "../../..")}`);
      if (todo.command) {
        if (todo.build) code = await build(env);
        if (code === 0 && !ending) code = await run("run", todo.command, env);
      }
      else {
        // the browser scripts serve dist/, and the fast steps have built it already
        if (!todo.fast) code = await build(env);
        if (code === 0) code = await run("lanes", [bun, "scripts/ci-lanes.ts", ...todo.lanes.map((lane) => `${lane}=${LANES[lane]}`)], env);
      }
    }
  } catch (error) {
    const message = (error as Error).message;
    console.error(`check: ${message}`);
    report.errors.push(message);
    code = 1;
  } finally {
    cleanup();
  }
  if (ending) return;
  finalize(code === 0 ? "success" : "failure", code);
  const artifactVerificationRequired = report.browserArtifact.buildAttempted && report.browserArtifact.buildThisRun;
  const finalCode = reportExitCode(code, reportPersistFailed, report.source.unchanged, report.browserArtifact.unchangedAfterBuild, artifactVerificationRequired);
  if (finalCode !== code || reportPersistFailed || report.source.unchanged === false || report.browserArtifact.unchangedAfterBuild === false) {
    code = finalCode;
    report.status = "failure";
    report.exitCode = code;
    if (report.source.unchanged === false && !report.errors.includes("source changed during the check; verification was invalidated")) {
      report.errors.push("source changed during the check; verification was invalidated");
    }
    if (report.browserArtifact.unchangedAfterBuild === false && !report.errors.includes("dist changed after the check build; browser artifact verification was invalidated")) {
      report.errors.push("dist changed after the check build; browser artifact verification was invalidated");
    }
    if (artifactVerificationRequired && report.browserArtifact.unchangedAfterBuild === null) {
      report.errors.push("built dist identity unavailable; cannot verify the built artifact");
    }
    if (reportPersistFailed) {
      if (report.source.unchanged !== false) {
        report.verification = verificationResult(report.source.unchanged, "failure", report.browserArtifact.unchangedAfterBuild, artifactVerificationRequired);
      }
      if (!report.errors.includes("report persistence failed during the check")) report.errors.push("report persistence failed during the check");
    }
    saveReport();
  }
  if (report.steps.length > 1) {
    console.log("");
    for (const step of report.steps) {
      const result = step.status === "success" ? "ok    " : step.status === "skipped" ? "SKIP  " : step.status === "not-run" ? "--    " : "FAILED";
      console.log(`${result} ${step.name}${step.durationMs === null ? "" : ` (${(step.durationMs / 1000).toFixed(1)}s)`}`);
    }
  }
  process.exit(code);
}

/** How long a step's processes get to end after a signal before they are killed. */
const END_GRACE_MS = 5_000;
/** How long to drain inherited output pipes after the direct child exits. */
const OUTPUT_DRAIN_GRACE_MS = 2_000;

/** Signals a process group and waits until no process is left in it, killing what outlasts the grace. */
async function endGroup(group: number, signal: NodeJS.Signals): Promise<void> {
  // only "no such process" says the group is empty: a process that may not be signalled is still there
  const none = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ESRCH";
  const left = (): boolean => { try { process.kill(-group, 0); return true; } catch (error) { return !none(error); } };
  const gone = async (ms: number): Promise<boolean> => {
    for (const deadline = Date.now() + ms; left();) {
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return true;
  };
  try { process.kill(-group, signal); } catch (error) { if (none(error)) return; }
  if (await gone(END_GRACE_MS)) return;
  try { process.kill(-group, "SIGKILL"); } catch (error) { if (none(error)) return; }
  if (!(await gone(2_000))) console.error(`check: processes in step process group ${group} are still running`);
}

/**
 * Workflow syntax, with the release CI pins. It is fetched once into node_modules/.cache; a
 * platform the pin does not cover leaves the check to CI, and says so.
 */
async function actionlint(
  run: (label: string, command: string[], env: Record<string, string | undefined>, cwd?: string) => Promise<number>,
  env: Record<string, string | undefined>,
  skip: (reason: string) => void,
  fail: (message: string) => void,
): Promise<number> {
  if (process.platform !== "linux" || process.arch !== "x64") {
    skip("actionlint is pinned for Linux x64; CI checks workflow syntax on other platforms");
    return 0;
  }
  const dir = join("node_modules", ".cache", `actionlint-${ACTIONLINT.version}`);
  const binary = join(dir, "actionlint");
  if (!existsSync(binary)) {
    const url = `https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT.version}/actionlint_${ACTIONLINT.version}_linux_amd64.tar.gz`;
    let archive: Uint8Array | null = null;
    for (let attempt = 1; attempt <= 3 && !archive; attempt++) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
        if (response.ok) archive = new Uint8Array(await response.arrayBuffer());
      } catch { /* tried again */ }
    }
    if (!archive) { fail(`could not fetch pinned actionlint ${ACTIONLINT.version}`); return 1; }
    const sha256 = createHash("sha256").update(archive).digest("hex");
    if (sha256 !== ACTIONLINT.sha256) { fail(`actionlint ${ACTIONLINT.version} archive did not match its pinned SHA-256`); return 1; }
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "actionlint.tgz"), archive);
    const unpacked = await run("unpack actionlint", ["tar", "xzf", "actionlint.tgz", "actionlint"], env, dir);
    rmSync(join(dir, "actionlint.tgz"), { force: true });
    if (unpacked !== 0) return 1;
  }
  return run("workflow syntax", [binary, "-shellcheck="], env);
}

// last: main() uses every constant above
if (import.meta.main) await main();
