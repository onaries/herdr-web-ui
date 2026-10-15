import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { servedRevision } from "./update-api.ts";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("the served build's revision", () => {
  it("reads the commit dist/build.json names, as it is now", async () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-served-revision-"));
    directories.push(directory);
    const read = servedRevision(directory, 0);
    // no build yet, or one older than the file
    expect(await read()).toBeNull();
    mkdirSync(join(directory, "dist"));
    writeFileSync(join(directory, "dist", "build.json"), JSON.stringify({ revision: "a".repeat(40) }));
    expect(await read()).toBe("a".repeat(40));
    // what a plugin reinstall or a `git pull` and a build does under the running server
    writeFileSync(join(directory, "dist", "build.json"), JSON.stringify({ revision: "b".repeat(40) }));
    expect(await read()).toBe("b".repeat(40));
  });

  it("counts only a build written after the server started", async () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-served-before-"));
    directories.push(directory);
    mkdirSync(join(directory, "dist"));
    writeFileSync(join(directory, "dist", "build.json"), JSON.stringify({ revision: "a".repeat(40) }));
    // a pull without a build, then a restart: the build predates the server, and a restart cannot change it
    expect(await servedRevision(directory, Date.now() + 60_000)()).toBeNull();
    expect(await servedRevision(directory, 0)()).toBe("a".repeat(40));
  });

  it("answers null for a file that names no commit", async () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-served-garbage-"));
    directories.push(directory);
    mkdirSync(join(directory, "dist"));
    const read = servedRevision(directory, 0);
    for (const body of ["not json", "{}", JSON.stringify({ revision: null }), JSON.stringify({ revision: "../../etc" })]) {
      writeFileSync(join(directory, "dist", "build.json"), body);
      expect(await read()).toBeNull();
    }
  });
});
