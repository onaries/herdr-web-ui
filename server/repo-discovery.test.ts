import { afterAll, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoDiffFile, repoDiffFiles, repoDiffRepositories, repoDiffResponse } from "./repo-diff.ts";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ovis-repos-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  expect(result.exitCode).toBe(0);
}
function repo(path: string): string {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-q", "-b", "main");
  return path;
}
const query = (depth = 2, children = true) => new URLSearchParams({ children: children ? "1" : "0", depth: String(depth) });

it("finds ignored repositories through exactly the chosen depth, without entering directory symlinks or node_modules", async () => {
  const root = repo(join(scratch, "depth"));
  const one = repo(join(root, "one"));
  const two = repo(join(one, "two"));
  const three = repo(join(two, "three"));
  const four = repo(join(three, "four"));
  repo(join(four, "five"));
  repo(join(root, "node_modules", "ignored"));
  const outside = repo(join(scratch, "outside"));
  symlinkSync(outside, join(root, "linked"), "dir");
  symlinkSync(root, join(one, "cycle"), "dir");
  writeFileSync(join(root, ".gitignore"), "one/\n");
  expect(await repoDiffRepositories(root, query(4, false))).toEqual({ roots: [root], truncated: false });
  const expected = [root, one, two, three, four];
  for (const depth of [1, 2, 3, 4]) expect(await repoDiffRepositories(root, query(depth))).toEqual({ roots: expected.slice(0, depth + 1).sort(), truncated: false });
  expect(await repoDiffRepositories(join(one, "two"), query(1, false))).toEqual({ roots: [two], truncated: false });
});

it("discovers gitfile worktrees and opens each repository's own identically named file", async () => {
  const root = repo(join(scratch, "worktree-source"));
  writeFileSync(join(root, "same.txt"), "original\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "fixture");
  const folder = join(scratch, "worktrees");
  mkdirSync(folder);
  const worktree = join(folder, "child");
  git(root, "worktree", "add", "-q", "-b", "child", worktree);
  writeFileSync(join(root, "same.txt"), "source edit\n");
  writeFileSync(join(worktree, "same.txt"), "worktree edit\n");
  expect(await repoDiffRepositories(folder, query())).toEqual({ roots: [worktree], truncated: false });
  for (const [directory, text] of [[root, "source edit"], [worktree, "worktree edit"]]) {
    const list = await repoDiffFiles(directory!, new URLSearchParams());
    const patch = await repoDiffFile(directory!, new URLSearchParams({ path: list.files[0]!.path }));
    expect(patch.repository.root).toBe(directory!);
    expect(patch.patch).toContain(`+${text}`);
  }
});

it("answers an empty folder, rejects malformed scan settings, and reports the entry budget", async () => {
  const folder = join(scratch, "empty");
  mkdirSync(folder);
  expect(await repoDiffRepositories(folder, query())).toEqual({ roots: [], truncated: false });
  for (const depth of ["0", "5", "2.5", "02", "Infinity", ""]) {
    const response = await repoDiffResponse("repositories", folder, new URLSearchParams({ depth }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_depth" } });
  }
  expect((await repoDiffResponse("repositories", folder, new URLSearchParams({ children: "yes" }))).status).toBe(400);
  for (let index = 0; index < 10_001; index++) writeFileSync(join(folder, String(index)), "");
  expect((await repoDiffRepositories(folder, query())).truncated).toBe(true);
});
