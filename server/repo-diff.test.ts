import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { parsePatchFiles } from "@pierre/diffs";

import type { ApiError, RepoDiffFileList, RepoDiffFilePatch } from "../shared/protocol.ts";
import { DeviceStore } from "./devices.ts";
import { createServer } from "./index.ts";
import { REPO_DIFF_CONTEXT_LINES, REPO_DIFF_MAX_FILES, REPO_DIFF_MAX_LIST_BYTES, REPO_DIFF_MAX_PATCH_BYTES, repoDiffFile, repoDiffFiles } from "./repo-diff.ts";

/**
 * Real git repositories in a temp folder: the routes are only as right as what git prints, so a
 * stand-in git would prove nothing here. The developer's own git configuration is kept out, for
 * the fixtures and for the code under test alike.
 */
process.env["GIT_CONFIG_GLOBAL"] = "/dev/null";
process.env["GIT_CONFIG_NOSYSTEM"] = "1";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "herdr-repo-diff-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

function repository(name: string): string {
  const root = join(scratch, name);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  return root;
}

const query = (values: Record<string, string> = {}) => new URLSearchParams(values);
const lines = (count: number, prefix = "line") => Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}\n`).join("");
/** Runs `body` with `name` set to `value` for the code under test, then puts it back as it was. */
async function withEnvironment<T>(name: string, value: string, body: () => Promise<T>): Promise<T> {
  const inherited = process.env[name];
  process.env[name] = value;
  try {
    return await body();
  } finally {
    if (inherited === undefined) delete process.env[name];
    else process.env[name] = inherited;
  }
}
/** What Pierre makes of a patch: the parser the diff view uses, told to throw on anything malformed. */
const parsed = (patch: string | null) => parsePatchFiles(patch ?? "", undefined, true).flatMap((entry) => entry.files);

const UNICODE = "dir with space/ünï 文件.txt";

describe("workspace and staged changes", () => {
  let root: string;
  beforeAll(() => {
    root = repository("changes");
    mkdirSync(join(root, "dir with space"));
    writeFileSync(join(root, "keep.txt"), "a\nb\nc\n");
    writeFileSync(join(root, "gone.txt"), "going\n");
    writeFileSync(join(root, "moved-from.txt"), lines(12));
    writeFileSync(join(root, "pic.bin"), new Uint8Array([0, 1, 2, 3, 0, 255]));
    writeFileSync(join(root, UNICODE), "eins\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "first");
    // staged: a rename with an edit, and a new file
    git(root, "mv", "moved-from.txt", "moved-to.txt");
    writeFileSync(join(root, "moved-to.txt"), lines(12).replace("line 3\n", "line three\n"));
    writeFileSync(join(root, "staged-new.txt"), "fresh\n");
    git(root, "add", "moved-to.txt", "staged-new.txt");
    // unstaged
    writeFileSync(join(root, "keep.txt"), "a\nB\nc\nd\n");
    rmSync(join(root, "gone.txt"));
    writeFileSync(join(root, "pic.bin"), new Uint8Array([9, 0, 9, 0]));
    writeFileSync(join(root, UNICODE), "zwei\n");
    writeFileSync(join(root, "new file.txt"), "one\ntwo\n");
    writeFileSync(join(root, "blob.bin"), new Uint8Array([1, 0, 2, 0]));
  });

  it("lists unstaged and untracked files with status, counts and the repository they are in", async () => {
    const list = await repoDiffFiles(root, query());
    expect(list.repository).toEqual({ root, branch: "main", head: git(root, "rev-parse", "HEAD").trim(), detached: false, unborn: false });
    expect(list).toMatchObject({ scope: "workspace", base: null, head: null, total: 6, truncated: false, limits: { max_files: REPO_DIFF_MAX_FILES, max_list_bytes: REPO_DIFF_MAX_LIST_BYTES } });
    expect(list.files).toEqual([
      { path: "blob.bin", old_path: null, status: "untracked", additions: null, deletions: null, binary: null },
      { path: UNICODE, old_path: null, status: "modified", additions: 1, deletions: 1, binary: false },
      { path: "gone.txt", old_path: null, status: "deleted", additions: 0, deletions: 1, binary: false },
      { path: "keep.txt", old_path: null, status: "modified", additions: 2, deletions: 1, binary: false },
      { path: "new file.txt", old_path: null, status: "untracked", additions: null, deletions: null, binary: null },
      { path: "pic.bin", old_path: null, status: "modified", additions: null, deletions: null, binary: true },
    ]);
  });

  it("answers the same list from a folder below the repository's top", async () => {
    const list = await repoDiffFiles(join(root, "dir with space"), query());
    expect(list.repository.root).toBe(root);
    expect(list.files.map((file) => file.path)).toContain("keep.txt");
  });

  it("lists staged files apart, a rename with where it came from", async () => {
    const list = await repoDiffFiles(root, query({ scope: "staged" }));
    expect(list.files).toEqual([
      { path: "moved-to.txt", old_path: "moved-from.txt", status: "renamed", additions: 1, deletions: 1, binary: false },
      { path: "staged-new.txt", old_path: null, status: "added", additions: 1, deletions: 0, binary: false },
    ]);
  });

  it("gives each text file one whole patch Pierre parses: edit, deletion, untracked, addition, rename", async () => {
    const edit = await repoDiffFile(root, query({ path: "keep.txt" }));
    expect(edit).toMatchObject({ unavailable: null, truncated: false, file: { path: "keep.txt", status: "modified", additions: 2, deletions: 1 }, limits: { max_patch_bytes: REPO_DIFF_MAX_PATCH_BYTES, context_lines: REPO_DIFF_CONTEXT_LINES } });
    expect(edit.patch).toStartWith("diff --git a/keep.txt b/keep.txt\n");
    expect(parsed(edit.patch).map((file) => [file.name, file.type, file.hunks.length])).toEqual([["keep.txt", "change", 1]]);

    const deleted = await repoDiffFile(root, query({ path: "gone.txt" }));
    expect(parsed(deleted.patch).map((file) => [file.name, file.type])).toEqual([["gone.txt", "deleted"]]);

    const untracked = await repoDiffFile(root, query({ path: "new file.txt" }));
    expect(untracked.file).toEqual({ path: "new file.txt", old_path: null, status: "untracked", additions: null, deletions: null, binary: false });
    expect(parsed(untracked.patch).map((file) => [file.name, file.type, file.additionLines])).toEqual([["new file.txt", "new", ["one\n", "two\n"]]]);

    const added = await repoDiffFile(root, query({ scope: "staged", path: "staged-new.txt" }));
    expect(parsed(added.patch).map((file) => [file.name, file.type])).toEqual([["staged-new.txt", "new"]]);

    const renamed = await repoDiffFile(root, query({ scope: "staged", path: "moved-to.txt", old_path: "moved-from.txt" }));
    expect(renamed.file).toMatchObject({ status: "renamed", old_path: "moved-from.txt" });
    expect(parsed(renamed.patch).map((file) => [file.name, file.prevName, file.type])).toEqual([["moved-to.txt", "moved-from.txt", "rename-changed"]]);
  });

  it("keeps a path with spaces and non-ASCII letters as it is, in the list and in the patch", async () => {
    const answer = await repoDiffFile(root, query({ path: UNICODE }));
    expect(answer.file.path).toBe(UNICODE);
    expect(answer.patch).toStartWith(`diff --git a/${UNICODE} b/${UNICODE}\n`);
    expect(parsed(answer.patch).map((file) => [file.name, file.deletionLines, file.additionLines])).toEqual([[UNICODE, ["eins\n"], ["zwei\n"]]]);
  });

  it("says a binary file is binary instead of sending a patch, tracked or not", async () => {
    for (const path of ["pic.bin", "blob.bin"]) {
      const answer = await repoDiffFile(root, query({ path }));
      expect(answer).toMatchObject({ patch: null, unavailable: "binary", truncated: false, file: { path, binary: true } });
    }
  });

  it("refuses a path that is not one inside the repository, and one where nothing changed", async () => {
    for (const path of ["", "../outside.txt", "/etc/hosts", "a//b", "dir/../keep.txt", "./keep.txt", "keep.txt\0"]) {
      await expect(repoDiffFile(root, query({ path }))).rejects.toMatchObject({ code: "invalid_path", status: 400 });
    }
    await expect(repoDiffFile(root, query({ path: "keep.txt", old_path: "../x" }))).rejects.toMatchObject({ code: "invalid_path", status: 400 });
    // pathspec magic and globs are read as plain names
    for (const path of ["staged-new.txt", "*.txt", ":(glob)**", ":/keep.txt"]) {
      await expect(repoDiffFile(root, query({ path }))).rejects.toMatchObject({ code: "not_found", status: 404 });
    }
  });

  it("refuses an unknown scope, and revisions outside the commit scope", async () => {
    await expect(repoDiffFiles(root, query({ scope: "everything" }))).rejects.toMatchObject({ code: "invalid_scope", status: 400 });
    await expect(repoDiffFiles(root, query({ scope: "staged", base: "HEAD" }))).rejects.toMatchObject({ code: "invalid_revision", status: 400 });
  });

  it("refuses an unrelated old path instead of returning another file's patch first", async () => {
    await expect(repoDiffFile(root, query({ path: "keep.txt", old_path: UNICODE }))).rejects.toMatchObject({ code: "invalid_path", status: 400 });
  });

  it("refuses stale rename metadata after the original path is reused", async () => {
    const root = repository("reused-rename-path");
    writeFileSync(join(root, "old.txt"), lines(12));
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "first");
    git(root, "mv", "old.txt", "new.txt");
    writeFileSync(join(root, "old.txt"), "replacement\n");
    git(root, "add", ".");
    await expect(repoDiffFile(root, query({ scope: "staged", path: "new.txt", old_path: "old.txt" }))).rejects.toMatchObject({ code: "invalid_path", status: 400 });
    const answer = await repoDiffFile(root, query({ scope: "staged", path: "new.txt" }));
    expect(parsed(answer.patch).map((file) => file.name)).toEqual(["new.txt"]);
  });
});

describe("comparing two commits", () => {
  let root: string;
  let first: string;
  let second: string;
  beforeAll(() => {
    root = repository("commits");
    writeFileSync(join(root, "a.txt"), "one\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "first");
    first = git(root, "rev-parse", "HEAD").trim();
    writeFileSync(join(root, "a.txt"), "one\ntwo\n");
    writeFileSync(join(root, "b.txt"), "new\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "second");
    second = git(root, "rev-parse", "HEAD").trim();
    git(root, "tag", "v1", first);
    // uncommitted work is no part of a comparison between commits
    writeFileSync(join(root, "a.txt"), "dirty\n");
  });

  it("lists and patches what differs between the two, named as full hashes", async () => {
    const comparisons: Record<string, string>[] = [{ base: "HEAD~1" }, { base: "v1", head: "main" }, { base: first, head: second }];
    for (const revisions of comparisons) {
      const list = await repoDiffFiles(root, query({ scope: "commit", ...revisions }));
      expect(list).toMatchObject({ scope: "commit", base: first, head: second, total: 2, truncated: false });
      expect(list.files.map((file) => [file.path, file.status, file.additions, file.deletions])).toEqual([["a.txt", "modified", 1, 0], ["b.txt", "added", 1, 0]]);
    }
    const answer = await repoDiffFile(root, query({ scope: "commit", base: first, head: second, path: "a.txt" }));
    expect(answer).toMatchObject({ base: first, head: second, unavailable: null });
    expect(parsed(answer.patch).map((file) => [file.name, file.additionLines.includes("two\n"), file.additionLines.includes("dirty\n")])).toEqual([["a.txt", true, false]]);
    expect((await repoDiffFiles(root, query({ scope: "commit", base: second, head: second }))).files).toEqual([]);
  });

  it("refuses a revision that is an option, a range or malformed, and one that names no commit", async () => {
    const marker = join(scratch, "option-ran");
    for (const base of [`--output=${marker}`, "-p", "HEAD..main", "HEAD:a.txt", "HEAD main", "", "x".repeat(201)]) {
      await expect(repoDiffFiles(root, query({ scope: "commit", base }))).rejects.toMatchObject({ code: "invalid_revision", status: 400 });
    }
    expect(existsSync(marker)).toBeFalse();
    await expect(repoDiffFiles(root, query({ scope: "commit" }))).rejects.toMatchObject({ code: "invalid_revision", status: 400 });
    await expect(repoDiffFiles(root, query({ scope: "commit", base: "no-such-branch" }))).rejects.toMatchObject({ code: "revision_not_found", status: 404 });
    await expect(repoDiffFile(root, query({ scope: "commit", base: first, head: "deadbeef", path: "a.txt" }))).rejects.toMatchObject({ code: "revision_not_found", status: 404 });
  });
});

describe("repositories in an unusual state", () => {
  it("reads a repository with no commit yet: nothing, then untracked, then staged", async () => {
    const root = repository("unborn");
    const empty = await repoDiffFiles(root, query());
    expect(empty.repository).toEqual({ root, branch: "main", head: null, detached: false, unborn: true });
    expect(empty).toMatchObject({ files: [], total: 0, truncated: false });
    writeFileSync(join(root, "first.txt"), "hello\n");
    expect((await repoDiffFiles(root, query())).files.map((file) => [file.path, file.status])).toEqual([["first.txt", "untracked"]]);
    git(root, "add", "first.txt");
    expect((await repoDiffFiles(root, query({ scope: "staged" }))).files).toEqual([{ path: "first.txt", old_path: null, status: "added", additions: 1, deletions: 0, binary: false }]);
    const staged = await repoDiffFile(root, query({ scope: "staged", path: "first.txt" }));
    expect(parsed(staged.patch).map((file) => [file.name, file.type])).toEqual([["first.txt", "new"]]);
    await expect(repoDiffFiles(root, query({ scope: "commit", base: "HEAD" }))).rejects.toMatchObject({ code: "revision_not_found", status: 404 });
  });

  it("reads a detached HEAD and a clean tree", async () => {
    const root = repository("detached");
    writeFileSync(join(root, "a.txt"), "one\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "first");
    const head = git(root, "rev-parse", "HEAD").trim();
    git(root, "checkout", "-q", "--detach");
    const list = await repoDiffFiles(root, query());
    expect(list.repository).toEqual({ root, branch: null, head, detached: true, unborn: false });
    expect(list).toMatchObject({ files: [], total: 0, truncated: false });
  });

  it("says a folder outside any repository is not one, and that a conflicted file has no unified patch", async () => {
    const plain = join(scratch, "plain");
    mkdirSync(plain);
    await expect(repoDiffFiles(plain, query())).rejects.toMatchObject({ code: "not_a_repository", status: 409 });
    await expect(repoDiffFile(plain, query({ path: "a.txt" }))).rejects.toMatchObject({ code: "not_a_repository", status: 409 });
    await expect(repoDiffFiles(join(scratch, "missing"), query())).rejects.toMatchObject({ code: "not_a_repository", status: 409 });

    const root = repository("conflict");
    writeFileSync(join(root, "c.txt"), "base\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "base");
    git(root, "checkout", "-q", "-b", "side");
    writeFileSync(join(root, "c.txt"), "side\n");
    git(root, "commit", "-q", "-a", "-m", "side");
    git(root, "checkout", "-q", "main");
    writeFileSync(join(root, "c.txt"), "main\n");
    git(root, "commit", "-q", "-a", "-m", "main");
    expect(Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-C", root, "merge", "side"], { stdout: "ignore", stderr: "ignore" }).exitCode).toBe(1);
    expect((await repoDiffFiles(root, query())).files).toEqual([{ path: "c.txt", old_path: null, status: "unmerged", additions: null, deletions: null, binary: null }]);
    expect(await repoDiffFile(root, query({ path: "c.txt" }))).toMatchObject({ patch: null, unavailable: "unmerged", truncated: false });
  });
});

describe("bounds", () => {
  let root: string;
  const names = Array.from({ length: 30 }, (_, index) => `f${String(index).padStart(2, "0")}.txt`);
  beforeAll(() => {
    root = repository("bounds");
    writeFileSync(join(root, "big.txt"), lines(400));
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "first");
    writeFileSync(join(root, "big.txt"), lines(400, "changed"));
    for (const name of names) writeFileSync(join(root, name), "x\n");
  });

  it("cuts a list at the file cap and says how many there were", async () => {
    const list = await repoDiffFiles(root, query(), { maxFiles: 5 });
    expect(list).toMatchObject({ total: 31, truncated: true, limits: { max_files: 5 } });
    expect(list.files.map((file) => file.path)).toEqual(["big.txt", ...names.slice(0, 4)]);
  });

  it("cuts a list at the byte cap on a whole name, with the total unknown", async () => {
    const list = await repoDiffFiles(root, query(), { maxListBytes: 64 });
    expect(list).toMatchObject({ total: null, truncated: true, limits: { max_list_bytes: 64 } });
    expect(list.files.length).toBeGreaterThan(0);
    expect(list.files.length).toBeLessThan(31);
    for (const file of list.files) expect(["big.txt", ...names]).toContain(file.path);
  });

  it("sends no part of a patch past the cap, for a tracked and an untracked file", async () => {
    const whole = await repoDiffFile(root, query({ path: "big.txt" }));
    expect(parsed(whole.patch).map((file) => [file.name, file.additionLines.length])).toEqual([["big.txt", 400]]);
    const capped = await repoDiffFile(root, query({ path: "big.txt" }), { maxPatchBytes: 512 });
    expect(capped).toMatchObject({ patch: null, unavailable: "too_large", truncated: true, file: { path: "big.txt", additions: 400, deletions: 400 }, limits: { max_patch_bytes: 512 } });
    writeFileSync(join(root, "f00.txt"), lines(200));
    expect(await repoDiffFile(root, query({ path: "f00.txt" }), { maxPatchBytes: 512 })).toMatchObject({ patch: null, unavailable: "too_large", truncated: true });
    // the file fits and its patch (headers, a `+` per line) does not
    writeFileSync(join(root, "f01.txt"), "y\n".repeat(250));
    expect(await repoDiffFile(root, query({ path: "f01.txt" }), { maxPatchBytes: 512 })).toMatchObject({ patch: null, unavailable: "too_large", truncated: true });
  });

  it("does not follow an untracked link out of the repository", async () => {
    const secret = join(scratch, "secret.txt");
    writeFileSync(secret, "do not read\n");
    symlinkSync(secret, join(root, "link.txt"));
    expect(await repoDiffFile(root, query({ path: "link.txt" }))).toMatchObject({ patch: null, unavailable: "unsupported", truncated: false });
  });

  it("stops a git that does not answer by its deadline, and says when there is no git", async () => {
    const hung = join(scratch, "hung-git");
    writeFileSync(hung, "#!/bin/sh\nexec sleep 30\n");
    chmodSync(hung, 0o755);
    await expect(repoDiffFiles(root, query(), { git: hung, deadlineMs: 50 })).rejects.toMatchObject({ code: "git_timeout", status: 504 });
    await expect(repoDiffFiles(root, query(), { git: join(scratch, "no-git-here") })).rejects.toMatchObject({ code: "git_unavailable", status: 503 });
  });

  it("runs none of the programs a repository's configuration names", async () => {
    const hooked = repository("hooked");
    const marker = join(scratch, "program-ran");
    const program = join(scratch, "program.sh");
    writeFileSync(program, `#!/bin/sh\ntouch '${marker}'\n[ -f "$1" ] && cat "$1"\nexit 0\n`);
    chmodSync(program, 0o755);
    writeFileSync(join(hooked, ".gitattributes"), "*.txt diff=marker\n");
    writeFileSync(join(hooked, "a.txt"), "one\n");
    git(hooked, "add", ".");
    git(hooked, "commit", "-q", "-m", "first");
    writeFileSync(join(hooked, "a.txt"), "two\n");
    writeFileSync(join(hooked, "b.txt"), "new\n");
    git(hooked, "config", "diff.external", program);
    git(hooked, "config", "diff.marker.textconv", program);
    git(hooked, "config", "core.fsmonitor", program);
    // git before 2.36 reads core.fsmonitor=false as a hook named `false`, found on PATH
    const onPath = join(scratch, "on-path");
    mkdirSync(onPath);
    writeFileSync(join(onPath, "false"), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    chmodSync(join(onPath, "false"), 0o755);
    rmSync(marker, { force: true });
    const spawn = spyOn(Bun, "spawn");
    try {
      await withEnvironment("PATH", `${onPath}${delimiter}${process.env["PATH"] ?? ""}`, async () => {
        expect((await repoDiffFiles(hooked, query())).files.map((file) => file.path)).toEqual(["a.txt", "b.txt"]);
        for (const path of ["a.txt", "b.txt"]) expect((await repoDiffFile(hooked, query({ path }))).patch).toStartWith(`diff --git a/${path} b/${path}\n`);
      });
      // the stand-in above only runs on git before 2.36, so the value itself is checked on any git
      const argvs = (spawn.mock.calls as unknown as [string[]][]).map(([argv]) => argv).filter((argv) => argv[0] === "git");
      expect(argvs.length).toBeGreaterThan(0);
      for (const argv of argvs) {
        expect(argv[argv.indexOf("core.fsmonitor=") - 1]).toBe("-c");
        expect(argv).not.toContain("core.fsmonitor=false");
      }
    } finally {
      spawn.mockRestore();
    }
    expect(existsSync(marker)).toBeFalse();
  });

  it("reads the repository asked about, not a common directory the server inherited", async () => {
    const own = repository("own-common");
    writeFileSync(join(own, "a.txt"), "one\n");
    git(own, "add", ".");
    git(own, "commit", "-q", "-m", "first");
    writeFileSync(join(own, "a.txt"), "two\n");
    writeFileSync(join(own, "b.txt"), "new\n");
    const foreign = repository("foreign-common");
    // that repository has no commit to compare with, and its info/exclude would leave b.txt out
    mkdirSync(join(foreign, ".git", "info"), { recursive: true });
    writeFileSync(join(foreign, ".git", "info", "exclude"), "b.txt\n");
    const head = git(own, "rev-parse", "HEAD").trim();
    await withEnvironment("GIT_COMMON_DIR", join(foreign, ".git"), async () => {
      const list = await repoDiffFiles(own, query());
      expect(list.repository.head).toBe(head);
      expect(list.files.map((file) => file.path)).toEqual(["a.txt", "b.txt"]);
      expect((await repoDiffFile(own, query({ path: "a.txt" }))).patch).toContain("\n+two\n");
    });
  });
});

describe("GET /api/workspace/diff/*", () => {
  let root: string;
  let server: ReturnType<typeof createServer>;
  let base: string;
  let watchCookie: string;
  const stateDir = mkdtempSync(join(tmpdir(), "herdr-repo-diff-state-"));
  const owner = { authorization: "Bearer test-repo-diff" };
  beforeAll(() => {
    root = repository("http");
    writeFileSync(join(root, "a.txt"), "one\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "first");
    writeFileSync(join(root, "a.txt"), "two\n");
    const store = new DeviceStore(stateDir);
    const watchToken = store.pair(store.startPairing().code, "Watch", "watch")!.token;
    // a first pairing is a device only once its cookie came back: that return is what saves it
    expect(store.match(watchToken)).not.toBeNull();
    watchCookie = `ovis_device=${watchToken}`;
    server = createServer({ port: 0, stateDir, token: "test-repo-diff", tailscaleOwner: null, machines: false });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => { server.stop(); rmSync(stateDir, { recursive: true, force: true }); });

  const files = (search: string, headers: Record<string, string> = owner, method = "GET") => fetch(`${base}/api/workspace/diff/files?${search}`, { method, headers });
  const directory = () => `directory=${encodeURIComponent(root)}`;

  it("discovers repositories through the HTTP route with the same read protections", async () => {
    const url = `${base}/api/workspace/diff/repositories?${directory()}&children=1&depth=2`;
    const response = await fetch(url, { headers: owner });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ roots: [root], truncated: false });
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: { ...owner, "sec-fetch-site": "cross-site" } })).status).toBe(403);
    for (const path of ["workspace/diff/repositories", "machines/local/workspace/diff/repositories", "machines/pc1/workspace/diff/repositories"]) {
      expect((await fetch(`${base}/api/${path}?${directory()}`, { headers: { cookie: watchCookie } })).status).toBe(403);
    }
    expect((await fetch(url, { method: "POST", headers: { ...owner, "x-herdr-machine": "1" } })).status).toBe(400);
  });

  it("answers a named folder's list and one file's patch, never cached", async () => {
    const listed = await files(directory());
    expect(listed.status).toBe(200);
    expect(listed.headers.get("cache-control")).toBe("private, no-store");
    const list = await listed.json() as RepoDiffFileList;
    expect(list.repository.root).toBe(root);
    expect(list.files).toEqual([{ path: "a.txt", old_path: null, status: "modified", additions: 1, deletions: 1, binary: false }]);
    const response = await fetch(`${base}/api/workspace/diff/file?${directory()}&path=a.txt`, { headers: owner });
    expect(response.status).toBe(200);
    const answer = await response.json() as RepoDiffFilePatch;
    expect(parsed(answer.patch).map((file) => [file.name, file.type])).toEqual([["a.txt", "change"]]);
  });

  it("refuses bad input in the error envelope", async () => {
    const cases: [string, number, string][] = [
      ["", 400, "missing_directory"],
      ["directory=relative%2Ffolder", 400, "invalid_cwd"],
      [`directory=${encodeURIComponent(join(scratch, "nowhere"))}`, 400, "invalid_cwd"],
      [`directory=${encodeURIComponent(scratch)}`, 409, "not_a_repository"],
      [`${directory()}&scope=all`, 400, "invalid_scope"],
      [`${directory()}&scope=commit&base=--output%3D%2Ftmp%2Fx`, 400, "invalid_revision"],
      [`${directory()}&scope=commit&base=nope`, 404, "revision_not_found"],
    ];
    for (const [search, status, code] of cases) {
      const response = await files(search);
      expect([search, response.status]).toEqual([search, status]);
      const body = await response.json() as ApiError;
      expect(body.error.code).toBe(code);
      expect(typeof body.error.message).toBe("string");
    }
    for (const [path, status, code] of [["..%2Fx", 400, "invalid_path"], ["", 400, "invalid_path"], ["absent.txt", 404, "not_found"]] as const) {
      const response = await fetch(`${base}/api/workspace/diff/file?${directory()}&path=${path}`, { headers: owner });
      expect(response.status).toBe(status);
      expect((await response.json() as ApiError).error.code).toBe(code);
    }
    const posted = await files(directory(), { ...owner, "x-herdr-machine": "1" }, "POST");
    expect(posted.status).toBe(400);
    expect((await posted.json() as ApiError).error.code).toBe("method_not_allowed");
  });

  it("is closed to a stranger, to another site's page and to a device that can only watch", async () => {
    expect((await files(directory(), {})).status).toBe(401);
    const crossSite = await files(directory(), { ...owner, "sec-fetch-site": "cross-site" });
    expect(crossSite.status).toBe(403);
    expect((await crossSite.json() as ApiError).error.code).toBe("cross_site");
    expect((await fetch(`${base}/api/session`, { headers: { cookie: watchCookie } })).status).not.toBe(401);
    for (const path of ["workspace/diff/files", "workspace/diff/file", "machines/pc1/workspace/diff/files", "machines/pc1/workspace/diff/file", "machines/local/workspace/diff/file"]) {
      const response = await fetch(`${base}/api/${path}?${directory()}&path=a.txt`, { headers: { cookie: watchCookie } });
      expect([path, response.status]).toEqual([path, 403]);
      expect((await response.json() as ApiError).error.code).toBe("read_only");
    }
  });
});
