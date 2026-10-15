/** Build in a private checkout. The source tree and the serving build stay intact. */
import { spawn } from "node:child_process";
import { closeSync, constants, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHECKOUT_CHANGED_REASON, noInstalledNotes, noUpdateNotes, unmanagedUpdateStatus, type InstalledNotes, type UpdateCommand, type UpdateNotes, type UpdateStatus } from "../shared/update.ts";
import { compareVersions, releaseNotes, releaseSummaries, SUMMARIES_FILE } from "./release-notes.ts";

export interface Release {
  directory: string; revision: string; source_revision: string;
  /**
   * The version this release replaced and when, written by the supervisor that installed it.
   * Absent from a release installed by a supervisor older than these fields.
   */
  previous_version?: string | null; installed_at?: string;
}
/** A release's files are read whole: one larger than this is not notes (the bound `runCommand` puts on what Git prints). */
export const NOTES_FILE_LIMIT = 2_000_000;

/**
 * A release's own CHANGELOG.md or release-summaries.json, read from one descriptor: a regular
 * file within NOTES_FILE_LIMIT, or nothing. A file that grows between a look and the read, a
 * symlink, a FIFO or a device would otherwise make the supervisor's synchronous read unbounded.
 */
export function readNotesFile(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > NOTES_FILE_LIMIT) throw new Error(`${path} is not notes`);
    const buffer = Buffer.alloc(NOTES_FILE_LIMIT + 1);
    let read = 0;
    for (;;) {
      const bytes = readSync(fd, buffer, read, buffer.length - read, read);
      if (bytes === 0) break;
      read += bytes;
      if (read > NOTES_FILE_LIMIT) throw new Error(`${path} is too large to be notes`);
    }
    return buffer.toString("utf8", 0, read);
  } finally { closeSync(fd); }
}
const SHA = /^[0-9a-f]{40,64}$/;
/** A release is a plain `vX.Y.Z` tag: `remote-v*` bundle tags and pre-releases never qualify. */
const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

function packageVersion(directory: string): string | null {
  try {
    const version = (JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as { version?: unknown }).version;
    return typeof version === "string" ? version : null;
  } catch { return null; }
}

/** Commands use argv, bounded output/time, and a separate group for cancellation. */
export function runCommand(cwd: string, argv: string[], signal?: AbortSignal, timeout = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd, detached: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    });
    let output = "", errors = "", failure: string | null = null;
    const cancel = (reason: string) => {
      failure = reason;
      if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
    };
    const abort = () => cancel("Update cancelled");
    const timer = setTimeout(() => cancel(`${argv[0]} timed out`), timeout);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", data => { output += data; if (output.length > 2_000_000) cancel("Command output too large"); });
    child.stderr.on("data", data => { errors = (errors + data).slice(-8000); });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    child.on("error", error => { cleanup(); reject(error); });
    child.on("close", code => {
      cleanup();
      if (code === 0 && !failure) resolve(output.trim());
      else reject(new Error(failure ?? `${argv.slice(0, 3).join(" ")} failed: ${errors.trim() || code}`));
    });
  });
}

export class Updater {
  readonly controller = new AbortController();
  status: UpdateStatus = { ...unmanagedUpdateStatus(), managed: true, blocked_reason: null };
  release: Release | null = null;
  /** What the available update brings; set before the status that offers it is published. */
  notes: UpdateNotes = noUpdateNotes();
  /** What the last update brought; set with the release that runs. */
  installed: InstalledNotes = noInstalledNotes();
  private busy = false;
  private timer?: ReturnType<typeof setInterval>;
  private initialTimer?: ReturnType<typeof setTimeout>;
  private sourceRevision = "";
  private failedRevision: string | null = null;

  constructor(readonly options: {
    root: string; stateDir: string; autoUpdate: boolean;
    /** herdr's `plugin install` checks out a shallow, detached commit it owns; that HEAD is
     * accepted when it is an ancestor of origin/main (a user's own detached checkout is not). */
    pluginCheckout?: boolean;
    /** Runs once a release is installed and active; the supervisor hands itself over here. */
    afterInstall?: (release: Release) => void | Promise<void>;
    /** A standing problem to report in every status (a supervisor that fell back to its predecessor). */
    notice?: string;
    activate: (release: Release, commit: () => void) => Promise<void>;
    publish: (status: UpdateStatus) => void;
  }) { this.status.auto_update = options.autoUpdate; this.status.error = options.notice ?? null; }

  private git(...args: string[]) { return runCommand(this.options.root, ["git", ...args], this.controller.signal); }
  private patch(patch: Partial<UpdateStatus>) {
    this.status = { ...this.status, ...patch };
    this.options.publish(this.status);
  }

  async initialize(): Promise<Release | null> {
    mkdirSync(this.options.stateDir, { recursive: true, mode: 0o700 });
    try {
      const failed = JSON.parse(readFileSync(join(this.options.stateDir, "failed.json"), "utf8")) as { revision?: string };
      if (failed.revision && SHA.test(failed.revision)) this.failedRevision = failed.revision;
    } catch { /* no failed automatic candidate */ }
    try {
      this.sourceRevision = await this.git("rev-parse", "HEAD");
      if (!SHA.test(this.sourceRevision)) throw new Error("Invalid source revision");
      this.release = { directory: this.options.root, revision: this.sourceRevision, source_revision: this.sourceRevision };
      const reason = await this.sourceBlock();
      if (!reason) {
        try {
          const saved = JSON.parse(readFileSync(join(this.options.stateDir, "current.json"), "utf8")) as Release;
          // Only directories created by this updater may be resumed.
          if (saved.source_revision === this.sourceRevision && SHA.test(saved.revision) &&
              saved.directory.startsWith(join(this.options.stateDir, "release-")) &&
              await runCommand(saved.directory, ["git", "rev-parse", "HEAD"]) === saved.revision) this.release = saved;
        } catch { /* missing/stale release: use the source checkout */ }
      }
      this.installed = this.brought(this.release);
      this.patch({ current_revision: this.release.revision, current_version: packageVersion(this.release.directory), blocked_reason: reason });
    } catch {
      this.patch({ managed: false, blocked_reason: "Updates require a Git checkout on the main branch." });
    }
    return this.release;
  }

  /**
   * What the update that installed `release` brought: its own changelog and summaries, from the
   * version it replaced. For the source checkout, which no update installed, the answer is that
   * there is none. The replaced version is the one the installing supervisor wrote down; a
   * supervisor older than that record left none, and then it is the newest older build still
   * here, since an install keeps the release it replaces and the source checkout stays.
   */
  private brought(release: Release): InstalledNotes {
    const none = { ...noInstalledNotes(), revision: release.revision };
    if (release.directory === this.options.root) return none;
    const version = packageVersion(release.directory);
    if (!version) return none;
    let previous: string | null = null;
    if (release.installed_at !== undefined) previous = typeof release.previous_version === "string" ? release.previous_version : null;
    else {
      const builds = [this.options.root];
      try {
        for (const entry of readdirSync(this.options.stateDir, { withFileTypes: true })) {
          if (entry.isDirectory() && entry.name.startsWith("release-")) builds.push(join(this.options.stateDir, entry.name));
        }
      } catch { /* the source checkout alone */ }
      for (const directory of builds) {
        const other = directory === release.directory ? null : packageVersion(directory);
        if (!other || !((compareVersions(version, other) ?? 0) > 0)) continue;
        if (previous === null || (compareVersions(other, previous) ?? 0) > 0) previous = other;
      }
    }
    if (previous === null || previous === version) return none;
    let installed_at: string | null = typeof release.installed_at === "string" ? release.installed_at : null;
    if (installed_at === null) {
      try { installed_at = statSync(join(this.options.stateDir, "current.json")).mtime.toISOString(); } catch { /* not told */ }
    }
    const read = (file: string) => readNotesFile(join(release.directory, file));
    let notes: Omit<UpdateNotes, "revision"> = { releases: [], omitted: 0 };
    try {
      const changelog = read("CHANGELOG.md");
      // a release that ships no summaries is told by its changelog alone
      let summaries = "";
      try { summaries = read(SUMMARIES_FILE); } catch { /* none */ }
      notes = releaseNotes(changelog, previous, version, undefined, releaseSummaries(summaries));
    } catch { /* a release without a changelog: the update is told without notes */ }
    return { revision: release.revision, version, previous_version: previous, installed_at, ...notes };
  }

  private async sourceBlock(): Promise<string | null> {
    const branch = await this.git("branch", "--show-current");
    if (branch !== "main" && !(branch === "" && this.options.pluginCheckout)) return "Switch the source checkout to main to update.";
    if (await this.git("status", "--porcelain", "--untracked-files=all")) return "The source checkout has local changes. Commit or move them before updating.";
    if (await this.git("rev-parse", "HEAD") !== this.sourceRevision) return CHECKOUT_CHANGED_REASON;
    return null;
  }

  start() {
    // One check per supervisor, independent of tabs. No network calls in createServer tests.
    this.initialTimer = setTimeout(() => void this.request("check"), 10_000);
    this.timer = setInterval(() => void this.request("check"), 5 * 60_000);
  }
  stop() {
    clearTimeout(this.initialTimer); clearInterval(this.timer); this.controller.abort();
  }

  private async discover() {
    this.patch({ phase: "checking", error: this.options.notice ?? null, available: false, blocked_reason: null });
    const reason = await this.sourceBlock();
    if (reason) { this.patch({ blocked_reason: reason, checked_at: new Date().toISOString() }); return; }
    // Only published releases update installs: commits pushed to main without a tag stay put.
    await this.git("fetch", "--no-tags", "origin", "+refs/tags/v*:refs/tags/v*");
    const tags = (await this.git("for-each-ref", "--sort=-v:refname", "--format=%(refname:short)", "refs/tags/v*"))
      .split("\n").filter((tag) => RELEASE_TAG.test(tag));
    const checked_at = new Date().toISOString();
    const latest = tags[0];
    if (!latest) {
      this.notes = noUpdateNotes();
      this.patch({ latest_revision: null, latest_version: null, checked_at, blocked_reason: null, available: false });
      return;
    }
    // ^{commit} peels an annotated tag to the commit the build and the health check report
    const target = await this.git("rev-parse", `${latest}^{commit}`);
    if (!SHA.test(target)) throw new Error("Invalid update revision");
    const current = this.release!.revision;
    let block: string | null = null;
    let available = false;
    if (target !== current) {
      if (await this.ancestor(current, target)) available = true;
      // running ahead of the latest release (a development checkout) is simply up to date
      else if (!await this.ancestor(target, current)) {
        block = "The running version is not part of the release history; automatic downgrade is disabled.";
      }
    }
    // the notes of the last check stay readable while this one runs; they change with its answer
    this.notes = available ? await this.changes(target, latest.slice(1)) : noUpdateNotes();
    this.patch({ latest_revision: target, latest_version: latest.slice(1), checked_at, blocked_reason: block, available });
  }

  /**
   * The release's own CHANGELOG.md, as fetched with its tag: never the checkout's, which is older,
   * and never main's, whose unreleased entries the install does not bring. A release without one
   * (or with one that cannot be read) is offered without notes.
   */
  private async changes(revision: string, version: string): Promise<UpdateNotes> {
    try {
      const changelog = await this.git("show", `${revision}:CHANGELOG.md`);
      // a release older than the summaries has no such file: its notes are told as they are
      const summaries = await this.git("show", `${revision}:${SUMMARIES_FILE}`).catch(() => "");
      return { revision, ...releaseNotes(changelog, this.status.current_version, version, undefined, releaseSummaries(summaries)) };
    } catch { return { ...noUpdateNotes(), revision }; }
  }

  /** herdr's plugin checkout is shallow: fetch the missing history once before calling two commits unrelated. */
  private async ancestor(older: string, newer: string): Promise<boolean> {
    const test = () => this.git("merge-base", "--is-ancestor", older, newer).then(() => true, () => false);
    if (await test()) return true;
    if (await this.git("rev-parse", "--is-shallow-repository") !== "true") return false;
    await this.git("fetch", "--no-tags", "--unshallow", "origin");
    return test();
  }

  async request(command: UpdateCommand): Promise<void> {
    if (this.busy || !this.status.managed || this.controller.signal.aborted) return;
    this.busy = true;
    let stage: string | null = null;
    let attempted: string | null = null;
    try {
      await this.discover();
      if ((command === "install" || this.options.autoUpdate) && this.status.available) {
        const revision = this.status.latest_revision!;
        if (command === "check" && revision === this.failedRevision) {
          this.patch({ phase: "error", error: "Automatic installation of this revision previously failed. Use Update and restart to retry, or wait for a newer revision." });
          return;
        }
        attempted = revision;
        this.patch({ phase: "building", step: "download" });
        stage = mkdtempSync(join(this.options.stateDir, "release-"));
        const run = (args: string[], timeout?: number) => runCommand(stage!, args, this.controller.signal, timeout);
        await run(["git", "clone", "--quiet", "--no-checkout", "--no-hardlinks", this.options.root, "."]);
        await run(["git", "fetch", "--quiet", this.options.root, revision]);
        await run(["git", "checkout", "--quiet", "--detach", revision]);
        // The clone's origin must keep pointing at the user's chosen upstream.
        await run(["git", "remote", "set-url", "origin", await this.git("remote", "get-url", "origin")]);
        this.patch({ step: "dependencies" });
        await run([process.execPath, "install", "--frozen-lockfile"], 180_000);
        this.patch({ step: "typecheck" });
        await run([process.execPath, "run", "typecheck"], 120_000);
        this.patch({ step: "build" });
        await run([process.execPath, "run", "build"], 120_000);
        const reason = await this.sourceBlock();
        if (reason) throw new Error(reason);
        this.controller.signal.throwIfAborted();
        const previous = this.release;
        // what it replaces, on record for the supervisor the release starts: that one was not here for the install
        const next: Release = { directory: stage, revision, source_revision: this.sourceRevision,
          previous_version: previous ? packageVersion(previous.directory) : null, installed_at: new Date().toISOString() };
        this.patch({ phase: "restarting", step: "restart" });
        await this.options.activate(next, () => {
          const file = join(this.options.stateDir, "current.json");
          writeFileSync(`${file}.tmp`, JSON.stringify(next), { mode: 0o600 });
          renameSync(`${file}.tmp`, file);
        });
        this.release = next;
        stage = null;
        this.notes = noUpdateNotes();
        // a supervisor that stays (one run directly, without the launcher) tells it from here on
        this.installed = this.brought(next);
        this.patch({ current_revision: revision, current_version: packageVersion(next.directory), available: false });
        this.failedRevision = null;
        rmSync(join(this.options.stateDir, "failed.json"), { force: true });
        for (const entry of readdirSync(this.options.stateDir, { withFileTypes: true })) {
          const directory = join(this.options.stateDir, entry.name);
          if (entry.isDirectory() && entry.name.startsWith("release-") && directory !== next.directory && directory !== previous?.directory) {
            rmSync(directory, { recursive: true, force: true });
          }
        }
        // before "idle": a supervisor that hands over exits here, so "idle" with the new revision
        // only ever comes from the supervisor that will keep running it
        try { await this.options.afterInstall?.(next); }
        catch (error) { console.error("afterInstall failed", error); }
      }
      this.patch({ phase: "idle", step: null });
    } catch (error) {
      if (attempted && !this.controller.signal.aborted) {
        this.failedRevision = attempted;
        try {
          writeFileSync(join(this.options.stateDir, "failed.json"), JSON.stringify({ revision: attempted }), { mode: 0o600 });
        } catch { /* the in-memory guard still prevents repeated automatic restarts */ }
      }
      this.patch({ phase: "error", step: null, error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (stage) rmSync(stage, { recursive: true, force: true });
      this.busy = false;
    }
  }
}
