import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHerdrUi } from "./herdr-ui.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function config(contents: string | Buffer): string {
  const root = mkdtempSync(join(tmpdir(), "ovis-herdr-ui-"));
  roots.push(root);
  const path = join(root, "config.toml");
  writeFileSync(path, contents);
  return path;
}

describe("herdr's [ui] copy_on_select", () => {
  it("reads the value herdr's config sets", () => {
    expect(readHerdrUi(config("[ui]\ncopy_on_select = false\n"))).toEqual({ copy_on_select: false });
    expect(readHerdrUi(config("[ui]\ncopy_on_select = true\n"))).toEqual({ copy_on_select: true });
    expect(readHerdrUi(config("[ui]\r\ntheme = 'dark'\r\ncopy_on_select = false\r\n"))).toEqual({ copy_on_select: false });
  });

  it("reads it past the byte-order marks herdr strips at the start of a line", () => {
    expect(readHerdrUi(config("\uFEFF[ui]\n\uFEFFcopy_on_select = false\n"))).toEqual({ copy_on_select: false });
  });

  it("is herdr's default (on) for a value that is no boolean, another table, no config or no TOML", () => {
    for (const contents of ["", "[ui]\ntheme = 'dark'", "[other]\ncopy_on_select = false", "[ui]\ncopy_on_select = 'false'", "[ui]\ncopy_on_select = 0", "ui = false", "[ui"]) {
      expect(readHerdrUi(config(contents))).toEqual({ copy_on_select: true });
    }
    const root = mkdtempSync(join(tmpdir(), "ovis-herdr-ui-"));
    roots.push(root);
    expect(readHerdrUi(join(root, "missing.toml"))).toEqual({ copy_on_select: true });
    expect(readHerdrUi(root)).toEqual({ copy_on_select: true });
  });

  it("reads no special file, and no file larger than a config", () => {
    expect(readHerdrUi(config(Buffer.alloc(1024 * 1024 + 1, "#")))).toEqual({ copy_on_select: true });
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "ovis-herdr-ui-"));
    roots.push(root);
    const fifo = join(root, "config.toml");
    Bun.spawnSync(["mkfifo", fifo]);
    // a FIFO with no writer would block a plain read: it is no config, read at once
    expect(readHerdrUi(fifo)).toEqual({ copy_on_select: true });
  });
});
